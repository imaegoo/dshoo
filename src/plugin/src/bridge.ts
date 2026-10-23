import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import WebSocket from "ws";

import {
  FrameError,
  FrameReqBody,
  FrameReqEnd,
  FrameReqHead,
  FrameResBody,
  FrameResEnd,
  FrameResHead,
  FrameWSBinary,
  FrameWSClose,
  FrameWSOpen,
  FrameWSText,
  encodeFrame,
  serializeHeaders,
  type Frame,
  type RequestHead,
  type ResponseHead,
  type SocketOpen,
} from "./protocol.js";
import type { LocalHarness } from "./harness.js";

/** Request headers that describe one hop and must not be relayed. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "cookie",
  "origin",
  "sec-fetch-site",
  "sec-fetch-mode",
  "sec-fetch-dest",
]);

/** Response headers the browser must not receive from the instance. */
const DROP_RESPONSE = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-security-policy",
  "content-security-policy-report-only",
  "x-frame-options",
  "set-cookie",
]);

/** Largest request body the plugin will buffer before failing the stream. */
const MAX_REQUEST_BYTES = 64 * 1024 * 1024;
/** Largest HTML document that gets rewritten before being sent. */
const MAX_REWRITE_BYTES = 16 * 1024 * 1024;

/** Local endpoints the HUD uses; they never reach the harness. */
const HUD_PING_PATH = "/__dshoo/ping";
const HUD_SCRIPT_PATH = "/__dshoo/hud.js";

/** A request whose head arrived but whose body is still streaming in. */
interface PendingRequest {
  method: string;
  path: string;
  headers: Record<string, string[]>;
  chunks: Buffer[];
  bytes: number;
}

/** Callbacks the bridge needs from its owner. */
export interface BridgeDeps {
  harness: LocalHarness;
  /** URL prefix the server assigned to this instance, for example "/i/ab12". */
  prefix(): string;
  /** Send one already-encoded frame to the server. */
  send(frame: Buffer): boolean;
  log(message: string): void;
}

/**
 * Turns tunnel frames into requests against the local harness, and the answers
 * back into frames.
 *
 * Every server-side browser action — page load, API call, WebSocket — arrives
 * here as a stream and is replayed against `127.0.0.1:<gui port>` with the
 * cookie the harness minted for this process.
 */
export class Bridge {
  private readonly pending = new Map<number, PendingRequest>();
  private readonly active = new Map<number, ClientRequest>();
  private readonly sockets = new Map<number, WebSocket>();

  constructor(private readonly deps: BridgeDeps) {}

  /** Stop everything in flight; used when the tunnel closes. */
  reset(): void {
    for (const request of this.active.values()) {
      request.destroy();
    }
    this.active.clear();
    for (const socket of this.sockets.values()) {
      socket.terminate();
    }
    this.sockets.clear();
    this.pending.clear();
  }

  /** Dispatch one frame from the server. */
  onFrame(frame: Frame): void {
    switch (frame.type) {
      case FrameReqHead:
        this.beginRequest(frame);
        return;
      case FrameReqBody:
        this.appendBody(frame);
        return;
      case FrameReqEnd:
        void this.finishRequest(frame.id);
        return;
      case FrameWSOpen:
        void this.openSocket(frame);
        return;
      case FrameWSText:
      case FrameWSBinary: {
        const socket = this.sockets.get(frame.id);
        if (socket !== undefined && socket.readyState === WebSocket.OPEN) {
          socket.send(frame.payload, { binary: frame.type === FrameWSBinary });
        }
        return;
      }
      case FrameWSClose: {
        const socket = this.sockets.get(frame.id);
        if (socket !== undefined) {
          this.closeSocket(frame.id, socket, 1000, "");
        }
        return;
      }
      case FrameError: {
        // The operator went away; abandon the upstream work for this stream.
        this.pending.delete(frame.id);
        const request = this.active.get(frame.id);
        if (request !== undefined) {
          request.destroy();
          this.active.delete(frame.id);
        }
        const socket = this.sockets.get(frame.id);
        if (socket !== undefined) socket.terminate();
        return;
      }
      default:
        this.deps.log(`ignoring unknown frame type ${String(frame.type)}`);
    }
  }

  // ---- HTTP ----

  private beginRequest(frame: Frame): void {
    let head: RequestHead;
    try {
      head = JSON.parse(frame.payload.toString("utf8")) as RequestHead;
    } catch {
      this.fail(frame.id, "无法解析请求头");
      return;
    }
    this.pending.set(frame.id, {
      method: typeof head.method === "string" ? head.method : "GET",
      path: typeof head.path === "string" && head.path !== "" ? head.path : "/",
      headers: head.headers ?? {},
      chunks: [],
      bytes: 0,
    });
  }

  private appendBody(frame: Frame): void {
    const request = this.pending.get(frame.id);
    if (request === undefined) return;
    request.bytes += frame.payload.length;
    if (request.bytes > MAX_REQUEST_BYTES) {
      this.pending.delete(frame.id);
      this.fail(frame.id, "请求体超过插件允许的大小");
      return;
    }
    request.chunks.push(frame.payload);
  }

  private async finishRequest(id: number): Promise<void> {
    const request = this.pending.get(id);
    if (request === undefined) return;
    this.pending.delete(id);
    const path = request.path.split("?")[0] ?? "";
    if (this.answerLocally(id, path)) return;
    const port = this.deps.harness.port();
    if (port === undefined) {
      this.fail(id, "本机 dsh web 服务尚未监听");
      return;
    }
    const wantsHtml = request.path === "/" || request.path.startsWith("/?")
      || (request.headers["accept"] ?? []).some((value) => value.includes("text/html"));
    if (wantsHtml) {
      request.headers["accept-encoding"] = ["identity"];
    }
    try {
      await this.perform(id, request, port, true);
    } catch (error) {
      this.fail(id, (error as Error).message);
    }
  }

  /**
   * Answer the HUD's two endpoints without touching the harness.
   *
   * The latency probe must cross the tunnel to mean anything, so it is served
   * here rather than in the browser: the round trip the browser measures is
   * exactly browser → server → tunnel → plugin.
   */
  private answerLocally(id: number, path: string): boolean {
    // Match by suffix: the HUD is injected into any page the harness serves, so
    // it may be asked from a route deeper than the instance root.
    if (path.endsWith(HUD_PING_PATH)) {
      this.sendHead(id, 204, { "cache-control": ["no-store"] });
      this.deps.send(encodeFrame(FrameResEnd, id));
      return true;
    }
    if (path.endsWith(HUD_SCRIPT_PATH)) {
      const body = Buffer.from(hudScript(), "utf8");
      this.sendHead(id, 200, {
        "content-type": ["text/javascript; charset=utf-8"],
        "content-length": [String(body.length)],
        "cache-control": ["no-store"],
      });
      this.deps.send(encodeFrame(FrameResBody, id, body));
      this.deps.send(encodeFrame(FrameResEnd, id));
      return true;
    }
    return false;
  }

  private async perform(id: number, pending: PendingRequest, port: number, mayRetry: boolean): Promise<void> {
    const cookie = await this.deps.harness.sessionCookie();
    return new Promise<void>((resolve) => {
      let settled = false;
      const settle = (): void => {
        if (settled) return;
        settled = true;
        this.active.delete(id);
        resolve();
      };

      const headers: Record<string, string | string[]> = {};
      for (const [key, values] of Object.entries(pending.headers)) {
        const lower = key.toLowerCase();
        if (HOP_BY_HOP.has(lower)) continue;
        headers[lower] = values.length === 1 ? values[0] ?? "" : values;
      }
      headers["host"] = this.deps.harness.authority();
      headers["origin"] = this.deps.harness.origin();
      headers["cookie"] = cookie;
      headers["x-forwarded-prefix"] = this.deps.prefix();

      const request = httpRequest({
        host: "127.0.0.1",
        port,
        method: pending.method,
        path: pending.path,
        headers,
      });
      this.active.set(id, request);

      request.on("error", (error) => {
        if (settled) return;
        settle();
        this.fail(id, `本机 dsh 请求失败：${error.message}`);
      });

      request.on("response", (response: IncomingMessage) => {
        void this.relayResponse(id, pending, response, mayRetry, settle);
      });

      if (pending.chunks.length > 0) {
        request.end(Buffer.concat(pending.chunks));
      } else {
        request.end();
      }
    });
  }

  private async relayResponse(
    id: number,
    pending: PendingRequest,
    response: IncomingMessage,
    mayRetry: boolean,
    settle: () => void,
  ): Promise<void> {
    const status = response.statusCode ?? 502;
    const contentType = String(response.headers["content-type"] ?? "");
    const isHtml = contentType.startsWith("text/html");

    // The harness answers 401 when its session cookie is missing or stale.
    if (status === 401 && mayRetry) {
      response.resume();
      settle();
      this.deps.harness.invalidate();
      const port = this.deps.harness.port();
      if (port !== undefined) {
        try {
          await this.perform(id, pending, port, false);
        } catch (error) {
          this.fail(id, (error as Error).message);
        }
      }
      return;
    }

    const headers: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(serializeHeaders(response.headers))) {
      if (DROP_RESPONSE.has(key.toLowerCase())) continue;
      headers[key] = value;
    }
    headers["cache-control"] = ["no-store"];

    if (isHtml) {
      // The document is rewritten, so it is fetched uncompressed and its
      // length and encoding are ours to set. Everything else is relayed
      // byte-for-byte, including its own content-encoding.
      delete headers["content-encoding"];
      delete headers["content-length"];
      try {
        const body = await readAll(response);
        const rewritten = rewriteIndex(body.toString("utf8"), this.deps.prefix());
        const payload = Buffer.from(rewritten, "utf8");
        this.sendHead(id, status, { ...headers, "content-length": [String(payload.length)] });
        if (payload.length > 0) this.deps.send(encodeFrame(FrameResBody, id, payload));
        this.deps.send(encodeFrame(FrameResEnd, id));
      } catch (error) {
        this.fail(id, (error as Error).message);
      }
      settle();
      return;
    }

    this.sendHead(id, status, headers);
    response.on("data", (chunk: Buffer) => {
      this.push(id, chunk, response);
    });
    response.on("end", () => {
      this.deps.send(encodeFrame(FrameResEnd, id));
      settle();
    });
    response.on("aborted", () => {
      settle();
    });
    response.on("error", (error) => {
      this.fail(id, `本机 dsh 响应中断：${error.message}`);
      settle();
    });
  }

  /**
   * Forward one response chunk, pausing the upstream read while the tunnel
   * queue is full so a slow operator link cannot buffer a whole download here.
   */
  private push(id: number, chunk: Buffer, response: IncomingMessage): void {
    if (this.deps.send(encodeFrame(FrameResBody, id, chunk))) return;
    response.pause();
    let attempts = 0;
    const retry = (): void => {
      if (this.deps.send(encodeFrame(FrameResBody, id, chunk))) {
        response.resume();
        return;
      }
      attempts += 1;
      if (attempts > 200) {
        this.fail(id, "隧道拥塞，响应已中止");
        response.destroy();
        return;
      }
      setTimeout(retry, 50);
    };
    setTimeout(retry, 50);
  }

  private sendHead(id: number, status: number, headers: Record<string, string[]>): void {
    const head: ResponseHead = { status, headers };
    this.deps.send(encodeFrame(FrameResHead, id, JSON.stringify(head)));
  }

  private fail(id: number, message: string): void {
    this.deps.send(encodeFrame(FrameError, id, JSON.stringify({ message })));
    this.pending.delete(id);
    this.active.delete(id);
    this.sockets.delete(id);
  }

  // ---- WebSocket ----

  private async openSocket(frame: Frame): Promise<void> {
    const id = frame.id;
    let open: SocketOpen;
    try {
      open = JSON.parse(frame.payload.toString("utf8")) as SocketOpen;
    } catch {
      this.fail(id, "无法解析 WebSocket 打开请求");
      return;
    }
    const port = this.deps.harness.port();
    if (port === undefined) {
      this.fail(id, "本机 dsh web 服务尚未监听");
      return;
    }
    let cookie: string;
    try {
      cookie = await this.deps.harness.sessionCookie();
    } catch (error) {
      this.fail(id, (error as Error).message);
      return;
    }

    const target = `ws://127.0.0.1:${String(port)}${open.path}`;
    const socket = new WebSocket(target, {
      headers: {
        cookie,
        origin: this.deps.harness.origin(),
      },
      perMessageDeflate: false,
      handshakeTimeout: 20_000,
      maxPayload: 64 * 1024 * 1024,
    });
    this.sockets.set(id, socket);

    socket.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      this.deps.send(encodeFrame(isBinary ? FrameWSBinary : FrameWSText, id, buffer));
    });

    socket.on("close", (code: number, reason: Buffer) => {
      this.sockets.delete(id);
      this.deps.send(encodeFrame(FrameWSClose, id, JSON.stringify({ code, reason: reason.toString() })));
    });

    socket.on("error", (error: Error) => {
      this.sockets.delete(id);
      this.deps.send(encodeFrame(FrameError, id, JSON.stringify({ message: error.message })));
    });
  }

  private closeSocket(id: number, socket: WebSocket, code: number, reason: string): void {
    this.sockets.delete(id);
    try {
      socket.close(code, reason);
    } catch {
      socket.terminate();
    }
  }
}

/** Read a whole response body with a size cap. */
async function readAll(response: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of response) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    bytes += buffer.length;
    if (bytes > MAX_REWRITE_BYTES) {
      throw new Error("页面超过插件允许的重写大小");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * Rewrite the harness index so its absolute asset and module URLs live under
 * the instance prefix the server assigned.
 *
 * The harness already emits relative URLs for the shell bundle; only the module
 * loader table is absolute, and the browser resolves it literally. The remote
 * page also gets the HUD: it is injected here, so opening the harness locally
 * never shows it.
 */
export function rewriteIndex(html: string, prefix: string): string {
  if (prefix === "") return html;
  const rewritten = html
    .replace(/(\s(?:src|href)=")\/(?!\/)/gu, `$1${prefix}/`)
    .replace(/"\/plugins\//gu, `"${prefix}/plugins/`)
    .replace(/"\/assets\//gu, `"${prefix}/assets/`);
  return injectHud(rewritten, prefix);
}

/** The browser script the remote page loads, served from the plugin. */
export function hudScript(): string {
  return `(${installHud.toString()})();`;
}

/** Put the HUD's script tag just before the closing body tag, once. */
function injectHud(html: string, prefix: string): string {
  if (html.includes(HUD_SCRIPT_PATH)) return html;
  const tag = `<script src="${prefix}${HUD_SCRIPT_PATH}" defer></script>`;
  const closing = /<\/body>/iu.exec(html);
  if (closing === null) return `${html}${tag}`;
  return `${html.slice(0, closing.index)}${tag}${html.slice(closing.index)}`;
}

/**
 * Back button and latency pill for pages opened through a dshoo server.
 *
 * This function is serialised with `toString()` and runs in the browser, so it
 * must stay self-contained: no references to module scope, no imports. The
 * latency is measured by asking this plugin for a 204 over the tunnel; the
 * number therefore covers browser → server → tunnel and nothing else.
 */
function installHud(): void {
  if (document.getElementById("dshoo-hud") !== null) return;

  const host = document.createElement("div");
  host.id = "dshoo-hud";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>
:host {
  all: initial;
  position: fixed;
  top: 16px;
  left: 16px;
  z-index: 2147483647;
  display: block;
  color-scheme: light dark;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
    "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif;
  font-size: 12.5px;
  line-height: 1;
  -webkit-font-smoothing: antialiased;
}
.hud {
  display: inline-flex;
  align-items: center;
  height: 32px;
  padding: 0 10px 0 4px;
  border-radius: 999px;
  background: rgba(255, 255, 255, .72);
  border: .5px solid rgba(0, 0, 0, .08);
  box-shadow: 0 1px 2px rgba(0, 0, 0, .06), 0 6px 20px rgba(0, 0, 0, .07);
  -webkit-backdrop-filter: blur(16px) saturate(1.25);
  backdrop-filter: blur(16px) saturate(1.25);
  -webkit-user-select: none;
  user-select: none;
}
.back {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 24px;
  padding: 0 7px 0 4px;
  border-radius: 6px;
  color: #61666b;
  text-decoration: none;
  font-size: 12.5px;
}
.back:hover { background: rgba(0, 0, 0, .05); color: #0f1115; }
.back svg { display: block; }
.sep { width: 1px; height: 12px; margin: 0 8px 0 4px; background: rgba(0, 0, 0, .07); flex: none; }
.lat { display: inline-flex; align-items: center; gap: 7px; color: #adb2b8; }
.bars { display: inline-flex; align-items: flex-end; gap: 2px; height: 11px; }
.bars i { width: 3px; border-radius: 1px; background: currentColor; opacity: .22; }
.bars i:nth-child(1) { height: 5px; }
.bars i:nth-child(2) { height: 8px; }
.bars i:nth-child(3) { height: 11px; }
.num {
  font-variant-numeric: tabular-nums;
  font-weight: 500;
  font-size: 12.5px;
  color: #0f1115;
  min-width: 3ch;
  text-align: right;
  letter-spacing: -.01em;
}
.unit { font-size: 10px; color: #81858c; margin-left: 1px; }
.hud[data-state="good"] .lat { color: #22c55e; }
.hud[data-state="good"] .bars i { opacity: 1; }
.hud[data-state="warn"] .lat { color: #f59e0b; }
.hud[data-state="warn"] .bars i:nth-child(-n+2) { opacity: 1; }
.hud[data-state="bad"] .lat { color: #ec1313; }
.hud[data-state="bad"] .bars i:nth-child(1) { opacity: 1; }
.hud[data-state="idle"] .num { color: #adb2b8; }
@media (prefers-color-scheme: dark) {
  .hud {
    background: rgba(27, 27, 28, .70);
    border-color: rgba(255, 255, 255, .12);
    box-shadow: 0 1px 2px rgba(0, 0, 0, .35), 0 8px 24px rgba(0, 0, 0, .25);
  }
  .back { color: #cfd3d6; }
  .back:hover { background: rgba(255, 255, 255, .08); color: #f9fafb; }
  .sep { background: rgba(255, 255, 255, .10); }
  .num { color: #f9fafb; }
  .unit { color: #adb2b8; }
  .hud[data-state="idle"] .num { color: #81858c; }
  .hud[data-state="bad"] .lat { color: #f25a5a; }
}
@media (max-width: 620px) {
  .hud { padding: 0 9px 0 3px; }
  .back { padding: 0 5px; }
  .back span { display: none; }
  .unit { display: none; }
}
</style>
<div class="hud" data-state="idle">
  <a class="back" href="/" title="返回实例列表" aria-label="返回实例列表">
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M15 18l-6-6 6-6"></path>
    </svg>
    <span>返回</span>
  </a>
  <span class="sep" aria-hidden="true"></span>
  <span class="lat" role="status" aria-label="链路延迟未知">
    <span class="bars" aria-hidden="true"><i></i><i></i><i></i></span>
    <span class="num">—</span><span class="unit">ms</span>
  </span>
</div>`;

  const hud = root.querySelector(".hud") as HTMLElement | null;
  const num = root.querySelector(".num") as HTMLElement | null;
  const lat = root.querySelector(".lat") as HTMLElement | null;
  if (hud === null || num === null || lat === null) return;
  document.body.appendChild(host);

  const samples: number[] = [];
  let failures = 0;
  let timer: number | undefined;
  let running = false;
  let first = true;
  let started = false;

  const median = (values: number[]): number => {
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] ?? 0;
  };

  const render = (value: number | undefined): void => {
    if (value === undefined || !Number.isFinite(value)) {
      hud.setAttribute("data-state", "idle");
      num.textContent = "—";
      lat.setAttribute("aria-label", "链路延迟未知");
      return;
    }
    const ms = Math.max(1, Math.min(99999, Math.round(value)));
    hud.setAttribute("data-state", ms <= 120 ? "good" : ms <= 300 ? "warn" : "bad");
    num.textContent = String(ms);
    lat.setAttribute("aria-label", `链路延迟 ${String(ms)} 毫秒`);
    lat.setAttribute("title", `链路延迟 ${String(ms)} 毫秒`);
  };

  const schedule = (delay = 5000): void => {
    if (document.visibilityState === "hidden") return;
    timer = window.setTimeout(() => { void probe(); }, delay);
  };

  const probe = async (): Promise<void> => {
    if (running || document.visibilityState === "hidden") return;
    running = true;
    const controller = new AbortController();
    const guard = window.setTimeout(() => { controller.abort(); }, 10000);
    const startedAt = performance.now();
    let next = 5000;
    try {
      const base = location.pathname.replace(/\/+$/u, "");
      const url = `${base}/__dshoo/ping?t=${String(Date.now())}`;
      const response = await fetch(url, {
        cache: "no-store",
        credentials: "same-origin",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(String(response.status));
      await response.arrayBuffer();
      // Resource Timing strips main-thread scheduling out of the number: while
      // the harness boots, a `performance.now()` delta can read 150ms on a 3ms
      // link.
      const entries = performance.getEntriesByName(url);
      const entry = entries[entries.length - 1] as PerformanceResourceTiming | undefined;
      const measured = entry !== undefined && entry.responseStart > 0
        ? entry.responseStart - entry.requestStart
        : performance.now() - startedAt;
      if (first) {
        // The first probe races the page's own boot traffic on the shared
        // tunnel; keep it out of the average and measure again in a second.
        first = false;
        next = 1000;
      } else {
        samples.push(measured);
        if (samples.length > 3) samples.shift();
        failures = 0;
        render(median(samples));
      }
    } catch {
      failures += 1;
      if (failures >= 2) render(undefined);
    } finally {
      window.clearTimeout(guard);
      running = false;
      schedule(next);
    }
  };

  const start = (): void => {
    if (started) return;
    started = true;
    void probe();
  };
  if (document.readyState === "complete") {
    window.setTimeout(start, 200);
  } else {
    window.addEventListener("load", start, { once: true });
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      window.clearTimeout(timer);
      void probe();
    }
  });
  window.addEventListener("online", () => { void probe(); });
}
