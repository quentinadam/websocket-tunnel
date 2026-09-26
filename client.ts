// Tunnel client: connects to the tunnel server, gets a public hostname, and replays the
// HTTP requests and websocket connections it receives against http://$HOSTNAME:$PORT
// (ws:// for websockets). Reconnects automatically and
// asks for the same hostname again. See protocol.ts for the wire format.
//
// Usage: HOSTNAME=127.0.0.1 PORT=3000 deno run --allow-net --allow-env client.ts wss://example.com
// Env: SERVER_URL can replace the argument; NAME to request a specific subdomain (granted if free).

import {
  ABORT,
  ASSIGNED,
  closeSocket,
  DATA,
  decode,
  decodeJson,
  encode,
  encodeJson,
  encodeWsMessage,
  END,
  forwardableHeaders,
  REQUEST,
  type RequestHead,
  RESPONSE,
  type ResponseHead,
  WS_ACCEPT,
  WS_BINARY,
  WS_CLOSE,
  WS_OPEN,
  WS_TEXT,
  type WsClose,
} from './protocol.ts';

const serverUrl = Deno.args[0] ?? Deno.env.get('SERVER_URL');
const targetHost = Deno.env.get('HOSTNAME') ?? '127.0.0.1';
const targetPort = Number(Deno.env.get('PORT'));
if (!serverUrl || !targetPort) {
  console.error('usage: HOSTNAME=<host> PORT=<port> deno run --allow-net --allow-env client.ts <wss://server>');
  Deno.exit(1);
}
const target = `http://${targetHost}:${targetPort}`;
let name = Deno.env.get('NAME');

type Exchange = { abort: AbortController; body?: ReadableStreamDefaultController<Uint8Array> };

function send(ws: WebSocket, data: Uint8Array) {
  if (ws.readyState === WebSocket.OPEN) ws.send(data);
}

async function handleRequest(ws: WebSocket, exchanges: Map<string, Exchange>, id: string, head: RequestHead) {
  const exchange: Exchange = { abort: new AbortController() };
  exchanges.set(id, exchange);
  const body = head.body
    ? new ReadableStream<Uint8Array>({
      start: (c) => {
        exchange.body = c;
      },
    })
    : null;
  const headers = new Headers();
  for (const [k, v] of head.headers) headers.append(k, v);
  // fetch() transparently decompresses gzip/br bodies but keeps the content-encoding header,
  // unless the request asks for identity: then bytes pass through untouched either way.
  headers.set('accept-encoding', 'identity');

  let responded = false;
  try {
    const res = await fetch(target + head.path, {
      method: head.method,
      headers,
      body,
      redirect: 'manual',
      signal: exchange.abort.signal,
    });
    const response: ResponseHead = {
      status: res.status,
      statusText: res.statusText,
      headers: forwardableHeaders(res.headers),
    };
    send(ws, encode(RESPONSE, id, encodeJson(response)));
    responded = true;
    console.log(`${head.method} ${head.path} -> ${res.status}`);
    if (res.body) { for await (const chunk of res.body) send(ws, encode(DATA, id, chunk)); }
    send(ws, encode(END, id));
  } catch (err) {
    if (exchange.abort.signal.aborted) return; // server cancelled it
    console.error(`${head.method} ${head.path} failed: ${err}`);
    if (responded) return send(ws, encode(ABORT, id));
    const error: ResponseHead = { status: 502, statusText: 'Bad Gateway', headers: [['content-type', 'text/plain']] };
    send(ws, encode(RESPONSE, id, encodeJson(error)));
    send(ws, encode(DATA, id, new TextEncoder().encode(`tunnel client could not reach ${target}: ${err}\n`)));
    send(ws, encode(END, id));
  } finally {
    exchanges.delete(id);
  }
}

// Opens the visitor's websocket against the local service and relays it over the tunnel.
function openSocket(ws: WebSocket, sockets: Map<string, WebSocket>, id: string, head: RequestHead) {
  let local: WebSocket;
  try {
    local = new WebSocket(`ws://${targetHost}:${targetPort}${head.path}`, {
      protocols: head.protocols,
      headers: head.headers,
    });
  } catch (err) {
    console.error(`WS ${head.path} failed: ${err}`);
    return send(ws, encode(ABORT, id));
  }
  local.binaryType = 'arraybuffer';
  sockets.set(id, local);
  let opened = false;
  local.onopen = () => {
    opened = true;
    console.log(`WS ${head.path} -> open`);
    send(ws, encode(WS_ACCEPT, id, encodeJson({ protocol: local.protocol })));
  };
  local.onmessage = (e) => send(ws, encodeWsMessage(id, e.data));
  local.onclose = (e) => {
    // Still registered: the local service closed first (or refused), so tell the server.
    if (sockets.get(id) !== local) return;
    sockets.delete(id);
    if (opened) send(ws, encode(WS_CLOSE, id, encodeJson({ code: e.code, reason: e.reason })));
    else {
      console.error(`WS ${head.path} failed: ${target} refused the websocket or is unreachable`);
      send(ws, encode(ABORT, id));
    }
  };
  local.onerror = () => {/* onclose reports it */};
}

let retryDelay = 1000;

function connect() {
  const url = new URL(serverUrl);
  if (name) url.searchParams.set('name', name);
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  const exchanges = new Map<string, Exchange>();
  const sockets = new Map<string, WebSocket>();

  ws.onopen = () => {
    retryDelay = 1000;
  };

  ws.onmessage = (e) => {
    if (!(e.data instanceof ArrayBuffer)) return;
    const { type, id, payload } = decode(e.data);
    const socket = sockets.get(id);
    if (socket) {
      if (type === WS_TEXT && socket.readyState === WebSocket.OPEN) socket.send(new TextDecoder().decode(payload));
      else if (type === WS_BINARY && socket.readyState === WebSocket.OPEN) socket.send(payload.slice());
      else if (type === WS_CLOSE || type === ABORT) {
        // Forget it first so its onclose doesn't echo a WS_CLOSE back.
        sockets.delete(id);
        closeSocket(socket, type === WS_CLOSE ? decodeJson<WsClose>(payload) : {});
      }
      return;
    }
    if (type === ASSIGNED) {
      const host = new TextDecoder().decode(payload);
      name = host.split('.')[0];
      console.log(`tunnel open: https://${host} -> ${target}`);
    } else if (type === WS_OPEN) {
      openSocket(ws, sockets, id, decodeJson<RequestHead>(payload));
    } else if (type === REQUEST) {
      handleRequest(ws, exchanges, id, decodeJson<RequestHead>(payload));
    } else if (type === DATA) {
      try {
        exchanges.get(id)?.body?.enqueue(payload.slice());
      } catch { /* request already failed */ }
    } else if (type === END) {
      try {
        exchanges.get(id)?.body?.close();
      } catch { /* request already failed */ }
    } else if (type === ABORT) {
      const exchange = exchanges.get(id);
      if (!exchange) return;
      console.log(`request ${id} cancelled by visitor`);
      exchange.abort.abort();
      exchanges.delete(id);
    }
  };

  ws.onclose = () => {
    for (const exchange of exchanges.values()) exchange.abort.abort();
    for (const socket of sockets.values()) closeSocket(socket);
    sockets.clear();
    console.log(`disconnected, reconnecting in ${retryDelay / 1000}s`);
    setTimeout(connect, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 30_000);
  };
  ws.onerror = () => {/* onclose handles reconnection */};
}

connect();
