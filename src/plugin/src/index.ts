import { hostname, arch, platform } from "node:os";

import { Bridge } from "./bridge.js";
import {
  ensureIdentity,
  normalizeServer,
  readConfig,
  tunnelUrl,
  writeConfig,
  type PluginConfig,
} from "./config.js";
import { LocalHarness, harnessVersion, type HarnessContext } from "./harness.js";
import type { HelloMeta } from "./protocol.js";
import { TunnelClient, type TunnelState } from "./tunnel.js";
import { pluginVersion } from "./version.js";

/** Minimal shape of an incoming Node request; the harness passes the real one. */
interface RequestLike {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  on: (event: string, listener: (...args: unknown[]) => void) => unknown;
  socket?: { remoteAddress?: string };
}

/** Minimal shape of an outgoing Node response. */
interface ResponseLike {
  writeHead: (status: number, headers?: Record<string, string | string[]>) => unknown;
  end: (body?: string | Buffer) => unknown;
}

/** The slice of the Cordis context this plugin uses. */
interface PluginContext extends HarnessContext {
  effect: (fn: () => unknown, label?: string) => void;
  webServer: {
    port?: number;
    register: (route: { kind: "exact" | "prefix"; path: string; handler: RouteHandler }) => () => void;
  };
}

type RouteHandler = (req: RequestLike, res: ResponseLike) => void | Promise<void>;

/** Stable Cordis plugin name. */
export const name = "dshoo";

/** The plugin disappears with the web server it extends. */
export const inject = ["webServer"];

/** Live connection state reported to the settings page. */
interface Status {
  state: TunnelState;
  detail: string;
  instanceId: string;
  connectedAt: number;
  guiPort: number;
}

/** Largest configuration payload accepted from the browser. */
const MAX_BODY_BYTES = 64 * 1024;

/** How long to wait for the harness web server to bind its port. */
const PORT_WAIT_MS = 20_000;

/**
 * Remote access for this harness installation.
 *
 * The plugin keeps one outbound tunnel to a dshoo server. Every browser request
 * the server receives for this instance is replayed here against the local
 * harness, so the operator sees this process's real GUI rather than a second,
 * thinner view of it.
 *
 * The tunnel lives with the plugin, not with the settings page: closing the
 * page, switching sections, or reloading the GUI leaves the connection alone.
 */
export function apply(ctx: PluginContext): void {
  const log = (message: string): void => {
    ctx.logger?.info?.(`dshoo: ${message}`);
  };
  const warn = (message: string): void => {
    ctx.logger?.warn?.(`dshoo: ${message}`);
  };

  const harness = new LocalHarness(ctx, log);
  const status: Status = {
    state: "idle",
    detail: "",
    instanceId: "",
    connectedAt: 0,
    guiPort: harness.port() ?? 0,
  };

  let tunnel: TunnelClient | undefined;
  let bridge: Bridge | undefined;
  let prefix = "";

  /** A configuration is worth dialling only with an address and credentials. */
  function ready(config: PluginConfig): boolean {
    return config.server !== "" && config.username !== "" && config.password !== "";
  }

  /** Start (or restart) the tunnel and keep it running until stop(). */
  function connect(config = readConfig()): void {
    stop();
    if (!ready(config)) {
      status.state = "error";
      status.detail = config.server === ""
        ? "请先填写服务器地址"
        : "请填写服务器用户名与密码";
      return;
    }
    const url = tunnelUrl(config.server);
    const meta: HelloMeta = {
      key: config.instanceKey,
      name: config.name !== "" ? config.name : hostname(),
      hostname: hostname(),
      os: platform(),
      arch: arch(),
      dshVersion: harnessVersion(),
      pid: process.pid,
      guiPort: harness.port() ?? 0,
      pluginVersion,
    };

    const client: TunnelClient = new TunnelClient(url, config.username, config.password, {
      hello: () => meta,
      onFrame: (frame) => bridge?.onFrame(frame),
      // A new socket restarts stream ids from 1, so drop everything the old
      // socket had in flight before dialling.
      onDial: () => {
        bridge?.reset();
      },
      onState: (state, detail) => {
        status.state = state;
        status.detail = detail ?? "";
        if (state === "connected") {
          status.instanceId = client.instanceId ?? "";
          status.connectedAt = Date.now();
          status.guiPort = harness.port() ?? 0;
          // The server assigns the URL prefix this instance lives under; the
          // index rewrite and the proxy both need it.
          prefix = status.instanceId === "" ? "" : `/i/${status.instanceId}`;
          log(`connected to ${config.server} as instance ${status.instanceId}`);
        }
        if (state === "reconnecting") {
          warn(`tunnel lost (${detail ?? "unknown"}), reconnecting automatically`);
        }
      },
    }, log);

    bridge = new Bridge({
      harness,
      prefix: () => prefix,
      send: (frame) => client.send(frame),
      log: (message) => warn(message),
    });
    tunnel = client;
    client.start();
    log(`connecting to ${config.server} (${url})`);
  }

  /** Stop the tunnel and everything it had in flight. */
  function stop(): void {
    if (tunnel !== undefined) {
      tunnel.stop();
      tunnel = undefined;
    }
    bridge?.reset();
    bridge = undefined;
    prefix = "";
    status.state = "idle";
    status.detail = "";
    status.instanceId = "";
    status.connectedAt = 0;
  }

  /** The JSON the settings page renders from. */
  function snapshot(): Record<string, unknown> {
    const config = readConfig();
    return {
      config: {
        server: config.server,
        username: config.username,
        name: config.name,
        enabled: config.enabled,
        hasPassword: config.password !== "",
      },
      status: {
        state: status.state,
        detail: status.detail,
        instanceId: status.instanceId,
        prefix,
        connectedAt: status.connectedAt,
        guiPort: harness.port() ?? 0,
      },
      runtime: {
        hostname: hostname(),
        platform: platform(),
        arch: arch(),
        dshVersion: harnessVersion(),
        pluginVersion,
      },
    };
  }

  /**
   * Apply one settings submission.
   *
   * Every field is saved as it arrives, so the page has no save button. The
   * only actions are `connect` and `disconnect`; a plain save re-dials the
   * tunnel only when the address or account changed, because the name and the
   * rest take effect on the next handshake anyway.
   */
  function applySettings(input: Record<string, unknown>): Record<string, unknown> {
    const before = readConfig();
    const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
    const patch: Partial<PluginConfig> = {};
    let invalidServer = false;

    if (input.server !== undefined) {
      const server = normalizeServer(text(input.server));
      if (server === "" && text(input.server) !== "") invalidServer = true;
      patch.server = server;
    }
    if (input.username !== undefined) patch.username = text(input.username);
    if (input.name !== undefined) patch.name = text(input.name);
    if (input.clearPassword === true) {
      patch.password = "";
    } else if (typeof input.password === "string" && input.password !== "") {
      patch.password = input.password;
    }

    const after = Object.keys(patch).length > 0 ? writeConfig(patch) : before;
    const action = typeof input.action === "string" ? input.action : "";

    if (invalidServer) {
      status.state = "error";
      status.detail = "服务器地址无效，请填写 http(s):// 地址";
    } else if (action === "disconnect") {
      writeConfig({ enabled: false });
      stop();
      log("disconnected by the operator");
    } else if (action === "connect") {
      if (!ready(after)) {
        status.state = "error";
        status.detail = after.server === "" ? "请先填写服务器地址" : "请填写服务器用户名与密码";
      } else {
        writeConfig({ enabled: true });
        connect(readConfig());
      }
    } else if (after.enabled && ready(after)) {
      const connectionChanged = before.server !== after.server
        || before.username !== after.username
        || before.password !== after.password;
      if (connectionChanged) connect(after);
    }

    return { ok: true, ...snapshot() };
  }

  /** Guard against cross-origin writes: the page is same-origin with the API. */
  function trusted(req: RequestLike): boolean {
    const origin = headerValue(req, "origin");
    if (origin === undefined || origin === "") return true;
    const host = headerValue(req, "host");
    if (host === undefined) return false;
    try {
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  }

  async function handleState(req: RequestLike, res: ResponseLike): Promise<void> {
    if (!trusted(req)) {
      writeJSON(res, 403, { error: "forbidden" });
      return;
    }
    if ((req.method ?? "GET").toUpperCase() === "GET") {
      writeJSON(res, 200, snapshot());
      return;
    }
    if ((req.method ?? "").toUpperCase() !== "POST") {
      writeJSON(res, 405, { error: "method not allowed" });
      return;
    }
    try {
      const body = await readJSON(req);
      writeJSON(res, 200, applySettings(body));
    } catch (error) {
      writeJSON(res, 400, { error: (error as Error).message });
    }
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: "exact", path: "/remote-access/api/state", handler: handleState }),
    "dshoo: settings api",
  );

  ctx.effect(() => () => {
    stop();
  }, "dshoo: tunnel");

  /**
   * Reconnect a configured instance by itself once the GUI is serving. The
   * operator's last choice is the stored `enabled` flag, so a manual disconnect
   * keeps the tunnel down across restarts.
   */
  const initial = ensureIdentity();
  status.guiPort = harness.port() ?? 0;
  if (initial.enabled && ready(initial)) {
    const deadline = Date.now() + PORT_WAIT_MS;
    const attempt = (): void => {
      if (harness.port() !== undefined) {
        connect(readConfig());
        return;
      }
      if (Date.now() > deadline) {
        status.state = "error";
        status.detail = "本机 dsh web 端口未就绪，未能自动连接";
        warn(status.detail);
        return;
      }
      setTimeout(attempt, 250).unref?.();
    };
    setTimeout(attempt, 250).unref?.();
  }
}

function headerValue(req: RequestLike, name: string): string | undefined {
  const raw = req.headers[name] ?? req.headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0];
  return typeof raw === "string" ? raw : undefined;
}

function writeJSON(res: ResponseLike, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

/** Read and parse a bounded JSON request body. */
function readJSON(req: RequestLike): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    req.on("data", (...args: unknown[]) => {
      const chunk = args[0];
      if (!Buffer.isBuffer(chunk)) return;
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(new Error("请求体过大"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (text === "") {
        resolve({});
        return;
      }
      try {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          reject(new Error("请求体必须是 JSON 对象"));
          return;
        }
        resolve(parsed as Record<string, unknown>);
      } catch {
        reject(new Error("请求体不是合法 JSON"));
      }
    });
    req.on("error", () => {
      reject(new Error("读取请求体失败"));
    });
  });
}
