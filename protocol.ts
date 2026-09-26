// Wire protocol shared by server.ts and client.ts.
//
// Every websocket message is binary: [type: u8][id: 16-byte uuid][payload...]
//   ASSIGNED (0)  server -> client  payload: utf-8 public hostname (id is all zeros)
//   REQUEST  (1)  server -> client  payload: JSON RequestHead
//   RESPONSE (2)  client -> server  payload: JSON ResponseHead
//   DATA     (3)  both directions   payload: body bytes (request body s->c, response body c->s)
//   END      (4)  both directions   end of body
//   ABORT    (5)  both directions   cancel the exchange (visitor went away, upstream failed, ...)

export const ASSIGNED = 0, REQUEST = 1, RESPONSE = 2, DATA = 3, END = 4, ABORT = 5;

export type RequestHead = { method: string; path: string; headers: [string, string][]; body: boolean };
export type ResponseHead = { status: number; statusText: string; headers: [string, string][] };

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

export const encodeJson = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
export const decodeJson = <T>(payload: Uint8Array): T => JSON.parse(new TextDecoder().decode(payload));

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
