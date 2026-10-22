/**
 * Wire protocol shared with the dshoo server.
 *
 * Control messages (hello, hello-ack) are WebSocket text frames carrying JSON.
 * Everything else is a binary frame: one type byte, a big-endian 32-bit stream
 * id, then the payload. A stream id covers one proxied HTTP request or one
 * proxied WebSocket.
 */

export const FrameReqHead = 1;
export const FrameReqBody = 2;
export const FrameReqEnd = 3;
export const FrameResHead = 4;
export const FrameResBody = 5;
export const FrameResEnd = 6;
export const FrameWSOpen = 7;
export const FrameWSText = 8;
export const FrameWSBinary = 9;
export const FrameWSClose = 10;
export const FrameError = 11;

export const HEADER_SIZE = 5;

/** One decoded frame. `payload` is a view into the received buffer. */
export interface Frame {
  type: number;
  id: number;
  payload: Buffer;
}

/** Encode one frame for the tunnel socket. */
export function encodeFrame(type: number, id: number, payload?: Buffer | string): Buffer {
  const body = payload === undefined
    ? Buffer.alloc(0)
    : typeof payload === "string"
      ? Buffer.from(payload, "utf8")
      : payload;
  const out = Buffer.allocUnsafe(HEADER_SIZE + body.length);
  out[0] = type;
  out.writeUInt32BE(id >>> 0, 1);
  body.copy(out, HEADER_SIZE);
  return out;
}

/** Decode one binary tunnel frame. */
export function decodeFrame(data: Buffer): Frame {
  if (data.length < HEADER_SIZE) throw new Error("dshoo: short tunnel frame");
  return {
    type: data[0]!,
    id: data.readUInt32BE(1),
    payload: data.subarray(HEADER_SIZE),
  };
}

/** What this installation reports about itself when it connects. */
export interface HelloMeta {
  key: string;
  name: string;
  hostname: string;
  os: string;
  arch: string;
  dshVersion: string;
  pid: number;
  guiPort: number;
  pluginVersion: string;
}

/** The server's answer to {@link HelloMeta}. */
export interface HelloAck {
  type: "hello-ack";
  instanceId: string;
  prefix: string;
  serverTime: number;
}

/** JSON body of a request head frame. */
export interface RequestHead {
  method: string;
  path: string;
  headers: Record<string, string[]>;
}

/** JSON body of a response head frame. */
export interface ResponseHead {
  status: number;
  headers: Record<string, string[]>;
}

/** JSON body of a WebSocket-open frame. */
export interface SocketOpen {
  path: string;
  headers: Record<string, string[]>;
  protocol?: string[];
}

/** Convert a Node header bag into the JSON-safe form used on the wire. */
export function serializeHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[key] = Array.isArray(value) ? value.map(String) : [String(value)];
  }
  return out;
}
