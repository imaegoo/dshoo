import WebSocket from "ws";

import { decodeFrame, encodeFrame, type Frame, type HelloAck, type HelloMeta } from "./protocol.js";
import { pluginVersion } from "./version.js";

/** Observable phases of the plugin's outbound tunnel. */
export type TunnelState = "idle" | "connecting" | "connected" | "reconnecting" | "error";

/** Callbacks the plugin supplies to the tunnel owner. */
export interface TunnelHandlers {
  /** Called for every binary frame the server sends. */
  onFrame(frame: Frame): void;
  /** Called when connectivity changes. */
  onState(state: TunnelState, detail?: string): void;
  /** Builds the hello payload, called once per connection attempt. */
  hello(): HelloMeta;
  /**
   * Called before every connection attempt. Stream ids restart at 1 on the
   * server for each new socket, so anything still in flight on the previous
   * socket must be dropped before the new one is dialled.
   */
  onDial?(): void;
}

/** Keepalive tuning, overridable so tests do not have to wait ten seconds. */
export interface TunnelOptions {
  /** Interval between keepalive pings, in milliseconds. */
  heartbeatInterval?: number;
  /** How long one ping may stay unanswered before the socket is dropped. */
  heartbeatTimeout?: number;
}

/** Retry cadence while a connection cannot be established. */
const RETRY_DELAY = 10_000;
/** A connection that served for this long earns an immediate retry when it drops. */
const HEALTHY_CONNECTION_MS = 2_000;
/** Delay after a healthy connection was cut, for example by a gateway. */
const QUICK_RETRY_DELAY = 1_000;
/** Consecutive quick retries allowed before falling back to the steady cadence. */
const MAX_QUICK_RETRIES = 3;
/** Interval between keepalive pings on a live tunnel. */
const HEARTBEAT_INTERVAL = 10_000;
/** How long a keepalive ping may stay unanswered before the socket is dropped. */
const HEARTBEAT_TIMEOUT = 5_000;

/**
 * Wait before the next dial.
 *
 * A gateway that caps WebSocket lifetime cuts a perfectly healthy connection;
 * retrying that immediately turns a five-minute timeout into a one-second blip
 * instead of a ten-second outage. A connection that never came up keeps the
 * steady cadence, and so does one that dropped straight after a quick retry,
 * so a server that rejects every socket cannot cause a busy loop.
 * @param wasHealthy - whether the connection that just dropped had served for
 *   at least {@link HEALTHY_CONNECTION_MS}.
 * @param quickAttempts - consecutive quick retries already spent.
 * @returns the delay in milliseconds.
 */
export function retryDelayMs(wasHealthy: boolean, quickAttempts: number): number {
  return wasHealthy && quickAttempts < MAX_QUICK_RETRIES ? QUICK_RETRY_DELAY : RETRY_DELAY;
}

/**
 * Outbound WebSocket to a dshoo server.
 *
 * The tunnel is the instance's only inbound path: an operator opens the
 * instance from the server UI, the server asks for a stream over this socket,
 * and the answer travels back the same way. Nothing listens publicly on this
 * machine.
 */
export class TunnelClient {
  private socket?: WebSocket;
  private reconnectTimer?: NodeJS.Timeout;
  private attempt = 0;
  private ack?: HelloAck;
  private stopped = true;
  private detail = "";
  /** When the current socket completed its handshake, if it did. */
  private connectedAt?: number;
  /** Whether the connection that just dropped had been healthy. */
  private wasHealthy = false;
  /** Consecutive quick retries spent since the last healthy connection. */
  private quickAttempts = 0;
  /** Timer that keeps proving the socket is still there. */
  private heartbeatTimer?: NodeJS.Timeout;
  /** Deadline for the server to acknowledge a fresh socket. */
  private helloTimeout?: NodeJS.Timeout;
  /** Why the watchdog dropped the socket, shown instead of a generic code. */
  private closeReason = "";

  constructor(
    private readonly url: string,
    private readonly username: string,
    private readonly password: string,
    private readonly handlers: TunnelHandlers,
    private readonly log: (message: string) => void,
    private readonly options: TunnelOptions = {},
  ) {}

  /** Server-assigned instance id, available after the first successful connect. */
  get instanceId(): string | undefined {
    return this.ack?.instanceId;
  }

  /** True while the socket is open and acknowledged. */
  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN && this.ack !== undefined;
  }

  /** Open the tunnel and keep it open until {@link stop}. */
  start(): void {
    this.stopped = false;
    this.open();
  }

  /** Close the tunnel and cancel any pending reconnect. */
  stop(): void {
    this.stopped = true;
    this.attempt = 0;
    this.stopHeartbeat();
    this.clearHello();
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    const socket = this.socket;
    this.socket = undefined;
    this.ack = undefined;
    if (socket !== undefined) {
      // Aborting a dial makes `ws` emit "WebSocket was closed before the
      // connection was established"; without a listener that error would
      // surface as an uncaught exception in the harness host.
      socket.removeAllListeners();
      socket.on("error", () => {});
      try {
        if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
        else socket.close(1000, "stopped");
      } catch {
        // Closing an already-closed socket is not an error worth surfacing.
      }
    }
  }

  /** Send one frame; returns false when the tunnel is not usable. */
  send(frame: Buffer): boolean {
    const socket = this.socket;
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) return false;
    // Bound the outbound queue so a slow operator link cannot grow without
    // limit. A dropped chunk fails the proxied request, which is correct.
    if (socket.bufferedAmount > 32 * 1024 * 1024) return false;
    socket.send(frame, { binary: true });
    return true;
  }

  private open(): void {
    if (this.stopped) return;
    const authorization = `Basic ${Buffer.from(`${this.username}:${this.password}`, "utf8").toString("base64")}`;
    this.handlers.onState(this.attempt === 0 ? "connecting" : "reconnecting", this.detail);
    // The previous socket is gone; forget its streams before the new one can
    // reuse the same ids.
    this.handlers.onDial?.();
    this.connectedAt = undefined;

    const socket = new WebSocket(this.url, {
      headers: {
        authorization,
        "user-agent": `dsh-plugin-dshoo/${pluginVersion}`,
      },
      handshakeTimeout: 20_000,
      perMessageDeflate: false,
      maxPayload: 64 * 1024 * 1024,
    });
    this.socket = socket;

    this.clearHello();
    this.helloTimeout = setTimeout(() => {
      if (this.ack === undefined) {
        this.log("server did not acknowledge the connection in time");
        socket.terminate();
      }
    }, 20_000);

    socket.on("open", () => {
      // stop() may have been called while the handshake was in flight.
      if (this.socket !== socket) return;
      socket.send(JSON.stringify(this.handlers.hello()), { binary: false });
    });

    socket.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      if (!isBinary) {
        this.handleControl(buffer);
        return;
      }
      if (this.ack === undefined) return;
      try {
        this.handlers.onFrame(decodeFrame(buffer));
      } catch (error) {
        this.log(`bad frame: ${(error as Error).message}`);
      }
    });

    socket.on("close", (code: number) => {
      if (this.socket !== socket) return;
      this.clearHello();
      this.stopHeartbeat();
      this.socket = undefined;
      this.ack = undefined;
      const lived = this.connectedAt === undefined ? 0 : Date.now() - this.connectedAt;
      this.connectedAt = undefined;
      this.wasHealthy = lived >= HEALTHY_CONNECTION_MS;
      // A connection that lasted resets the flapping guard.
      if (this.wasHealthy) this.quickAttempts = 0;
      const reason = this.closeReason;
      this.closeReason = "";
      this.detail = reason !== "" ? reason : code === 1006 ? "连接被中断" : `连接关闭（${code}）`;
      this.scheduleReconnect();
    });

    socket.on("error", (error: Error) => {
      this.clearHello();
      this.detail = describeError(error);
      if (!this.stopped) this.log(`tunnel error: ${this.detail}`);
    });

    // A server that rejects the credentials answers 401 before upgrading.
    socket.on("unexpected-response", (_request, response) => {
      this.clearHello();
      this.detail = response.statusCode === 401
        ? "服务器拒绝了用户名或密码"
        : `服务器返回 ${response.statusCode ?? "未知状态"}`;
      this.log(`tunnel rejected: ${this.detail}`);
      response.resume();
      socket.terminate();
    });
  }

  /** Cancel the handshake deadline; safe to call more than once. */
  private clearHello(): void {
    if (this.helloTimeout !== undefined) {
      clearTimeout(this.helloTimeout);
      this.helloTimeout = undefined;
    }
  }

  private handleControl(data: Buffer): void {
    let message: unknown;
    try {
      message = JSON.parse(data.toString("utf8"));
    } catch {
      return;
    }
    if (typeof message !== "object" || message === null) return;
    const ack = message as Partial<HelloAck> & { type?: string };
    if (ack.type === "hello-ack" && typeof ack.instanceId === "string") {
      this.ack = {
        type: "hello-ack",
        instanceId: ack.instanceId,
        prefix: typeof ack.prefix === "string" ? ack.prefix : "",
        serverTime: typeof ack.serverTime === "number" ? ack.serverTime : 0,
      };
      this.attempt = 0;
      this.connectedAt = Date.now();
      this.detail = "";
      this.startHeartbeat();
      this.handlers.onState("connected");
    }
  }

  /**
   * Start proving that the socket still reaches the server.
   *
   * A dead peer is not always reported: when a laptop's Wi-Fi drops, or a NAT
   * mapping expires, the local socket can stay ESTABLISHED forever while every
   * packet is silently dropped. The server closes its side after its own ping
   * times out, but this process would keep showing "connected" until something
   * tried to write. A ping every few seconds turns that into a prompt error.
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    const interval = this.options.heartbeatInterval ?? HEARTBEAT_INTERVAL;
    this.heartbeatTimer = setInterval(() => this.probe(), interval);
    this.heartbeatTimer.unref?.();
  }

  /** Stop the keepalive timer; safe to call when none is running. */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  /** Send one ping and drop the socket when the pong does not come back. */
  private probe(): void {
    const socket = this.socket;
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) return;
    const timeout = this.options.heartbeatTimeout ?? HEARTBEAT_TIMEOUT;
    let settled = false;
    const onPong = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.off("pong", onPong);
    };
    const deadline = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.off("pong", onPong);
      if (this.socket !== socket) return;
      this.closeReason = "服务器长时间没有响应";
      this.log("keepalive timed out; dropping the tunnel");
      // terminate() rather than close(): a half-open socket would never
      // complete the closing handshake.
      socket.terminate();
    }, timeout);
    socket.once("pong", onPong);
    try {
      socket.ping();
    } catch {
      onPong();
      socket.terminate();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.handlers.onState("reconnecting", this.detail);
    const delay = retryDelayMs(this.wasHealthy, this.quickAttempts);
    if (delay === QUICK_RETRY_DELAY) this.quickAttempts += 1;
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.open();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  /** Send one frame if possible; convenience for the bridge. */
  trySend(type: number, id: number, payload?: Buffer | string): boolean {
    return this.send(encodeFrame(type, id, payload));
  }
}

/** Short, operator-readable description of a connection error. */
function describeError(error: Error & { code?: string }): string {
  const code = error.code ?? "";
  if (code === "ECONNREFUSED") return "无法连接到服务器（连接被拒绝）";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "无法解析服务器地址";
  if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") return "连接服务器超时";
  if (code === "CERT_HAS_EXPIRED" || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE") return "服务器证书无效";
  if (code === "ECONNRESET") return "连接被重置";
  return error.message || "连接失败";
}
