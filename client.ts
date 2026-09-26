// Tunnel client: connects to the tunnel server, gets a public hostname, and replays the
// HTTP requests it receives against http://$HOSTNAME:$PORT. Reconnects automatically and
// asks for the same hostname again. See protocol.ts for the wire format.
//
// Usage: HOSTNAME=127.0.0.1 PORT=3000 deno run --allow-net --allow-env client.ts wss://example.com
// Env: SERVER_URL can replace the argument; NAME to request a specific subdomain (granted if free).

import {
  ABORT,
  ASSIGNED,
  DATA,
  decode,
  decodeJson,
  encode,
  encodeJson,
  END,
  forwardableHeaders,
  REQUEST,
  type RequestHead,
  RESPONSE,
  type ResponseHead,
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

let retryDelay = 1000;

function connect() {
  const url = new URL(serverUrl);
  if (name) url.searchParams.set('name', name);
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  const exchanges = new Map<string, Exchange>();

  ws.onopen = () => {
    retryDelay = 1000;
  };

  ws.onmessage = (e) => {
    if (!(e.data instanceof ArrayBuffer)) return;
    const { type, id, payload } = decode(e.data);
    if (type === ASSIGNED) {
      const host = new TextDecoder().decode(payload);
      name = host.split('.')[0];
      console.log(`tunnel open: https://${host} -> ${target}`);
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
    console.log(`disconnected, reconnecting in ${retryDelay / 1000}s`);
    setTimeout(connect, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 30_000);
  };
  ws.onerror = () => {/* onclose handles reconnection */};
}

connect();
