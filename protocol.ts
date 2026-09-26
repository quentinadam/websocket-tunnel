// Wire protocol shared by server.ts and client.ts.
//
// Every websocket message is binary: [type: u8][id: 16-byte uuid][payload...]
//   ASSIGNED (0)  server -> client  payload: utf-8 public hostname (id is all zeros)
//   REQUEST  (1)  server -> client  payload: JSON RequestHead
//   RESPONSE (2)  client -> server  payload: JSON ResponseHead
//   DATA     (3)  both directions   payload: body bytes (request body s->c, response body c->s)
//   END      (4)  both directions   end of body
//   ABORT    (5)  both directions   cancel the exchange (visitor went away, upstream failed, ...)
//
// Websocket exchanges reuse the same framing:
//   WS_OPEN   (6)   server -> client  payload: JSON RequestHead (body is false, protocols requested)
//   WS_ACCEPT (7)   client -> server  payload: JSON WsAccept, the local websocket is open
//   WS_TEXT   (8)   both directions   payload: utf-8 text message
//   WS_BINARY (9)   both directions   payload: binary message
//   WS_CLOSE  (10)  both directions   payload: JSON WsClose
// A WS_OPEN the client can't satisfy is answered with ABORT, and the visitor gets a 502.

export const ASSIGNED = 0, REQUEST = 1, RESPONSE = 2, DATA = 3, END = 4, ABORT = 5;
export const WS_OPEN = 6, WS_ACCEPT = 7, WS_TEXT = 8, WS_BINARY = 9, WS_CLOSE = 10;

export type RequestHead = {
  method: string;
  path: string;
  headers: [string, string][];
  body: boolean;
  protocols?: string[];
};
export type ResponseHead = { status: number; statusText: string; headers: [string, string][] };
export type WsAccept = { protocol: string };
export type WsClose = { code?: number; reason?: string };

const NIL_ID = '00000000-0000-0000-0000-000000000000';

export function encode(type: number, id: string = NIL_ID, payload?: Uint8Array): Uint8Array {
  const out = new Uint8Array(17 + (payload?.length ?? 0));
  out[0] = type;
  const hex = id.replaceAll('-', '');
  for (let i = 0; i < 16; i++) out[1 + i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  if (payload) out.set(payload, 17);
  return out;
}

export function decode(data: ArrayBuffer): { type: number; id: string; payload: Uint8Array } {
  const bytes = new Uint8Array(data);
  const hex = Array.from(bytes.subarray(1, 17), (b) => b.toString(16).padStart(2, '0')).join('');
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return { type: bytes[0], id, payload: bytes.subarray(17) };
}

export function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

export function decodeJson<T>(payload: Uint8Array): T {
  return JSON.parse(new TextDecoder().decode(payload));
}

// Headers that describe a single hop and must not be forwarded.
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'host',
]);

export function forwardableHeaders(headers: Headers): [string, string][] {
  return [...headers].filter(([name]) => !HOP_BY_HOP.has(name));
}

// Handshake headers the websocket implementation on each side generates itself.
export function forwardableWsHeaders(headers: Headers): [string, string][] {
  return forwardableHeaders(headers).filter(([name]) => !name.startsWith('sec-websocket-'));
}

// WebSocket.close() only accepts 1000 or 3000-4999; other codes (1001, 1006, ...) become a plain close.
export function closeSocket(ws: WebSocket, { code, reason }: WsClose = {}) {
  if (ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) return;
  if (code === 1000 || (code !== undefined && code >= 3000 && code <= 4999)) ws.close(code, reason);
  else ws.close();
}

// Sends a websocket message event's data as a WS_TEXT or WS_BINARY frame.
export function encodeWsMessage(id: string, data: unknown): Uint8Array {
  if (typeof data === 'string') return encode(WS_TEXT, id, new TextEncoder().encode(data));
  return encode(WS_BINARY, id, new Uint8Array(data as ArrayBuffer));
}
