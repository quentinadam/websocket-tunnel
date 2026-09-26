// Tunnel server: clients connect over websocket to https://BASE_DOMAIN and are given a
// random <word>-<word>.BASE_DOMAIN hostname. HTTP requests arriving for that hostname
// are forwarded over the websocket to the client, which replays them against its local
// service and streams the response back. See protocol.ts for the wire format.
//
// Usage:
//   BASE_DOMAIN=example.com CERTIFICATE="$(cat origin.pem)" PRIVATE_KEY="$(cat origin-key.pem)" \
//     deno run --allow-net --allow-env server.ts
// Env: BASE_DOMAIN (required): clients connect to wss://BASE_DOMAIN, tunnels get <name>.BASE_DOMAIN.
//      CERTIFICATE / PRIVATE_KEY (required): PEM contents, e.g. a Cloudflare Origin CA certificate.
//        Literal "\n" sequences are accepted in place of newlines.
//      PORT (default 443).

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
import { WORDS } from './words.ts';

const BASE_DOMAIN = Deno.env.get('BASE_DOMAIN')?.toLowerCase();
const pem = (name: string) => Deno.env.get(name)?.replaceAll('\\n', '\n');
const CERTIFICATE = pem('CERTIFICATE');
const PRIVATE_KEY = pem('PRIVATE_KEY');
if (!BASE_DOMAIN || !CERTIFICATE || !PRIVATE_KEY) {
  console.error('BASE_DOMAIN, CERTIFICATE and PRIVATE_KEY must be set');
  Deno.exit(1);
}
const PORT = Number(Deno.env.get('PORT') ?? 443);

type Exchange = {
  respond: (response: Response) => void;
  responded: boolean;
  body?: ReadableStreamDefaultController<Uint8Array>;
};
type Tunnel = { name: string; ws: WebSocket; exchanges: Map<string, Exchange> };

const tunnels = new Map<string, Tunnel>();
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);
const VALID_NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

function randomWord(): string {
  const [n] = crypto.getRandomValues(new Uint32Array(1));
  return WORDS[n % WORDS.length];
}

function randomName(): string {
  while (true) {
    const name = `${randomWord()}-${randomWord()}`;
    if (!tunnels.has(name)) return name;
  }
}

const text = (body: string, status = 200) =>
  new Response(body + '\n', { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });

function send(ws: WebSocket, data: Uint8Array) {
  if (ws.readyState === WebSocket.OPEN) ws.send(data);
}

// Settles an exchange that won't complete normally: a 502 if no response was sent yet,
// otherwise the response body is errored so the visitor sees a truncated response.
function fail(tunnel: Tunnel, id: string) {
  const exchange = tunnel.exchanges.get(id);
  if (!exchange) return;
  tunnel.exchanges.delete(id);
  if (!exchange.responded) exchange.respond(text('tunnel client failed to respond', 502));
  else {try {
      exchange.body?.error(new Error('tunnel aborted'));
    } catch { /* already closed */ }}
}

// The visitor went away: tell the client to stop, and drop the exchange quietly.
function cancel(tunnel: Tunnel, id: string) {
  const exchange = tunnel.exchanges.get(id);
  if (!exchange) return;
  tunnel.exchanges.delete(id);
  send(tunnel.ws, encode(ABORT, id));
  if (!exchange.responded) exchange.respond(text('cancelled', 499));
  else {try {
      exchange.body?.close();
    } catch { /* already closed */ }}
}

function handleControl(req: Request): Response {
  if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    return text(`tunnel server: ${tunnels.size} active tunnel(s)`);
  }
  const wanted = new URL(req.url).searchParams.get('name')?.toLowerCase();
  const name = wanted && VALID_NAME.test(wanted) && !tunnels.has(wanted) ? wanted : randomName();
  const { socket: ws, response } = Deno.upgradeWebSocket(req, { idleTimeout: 30 });
  ws.binaryType = 'arraybuffer';
  const tunnel: Tunnel = { name, ws, exchanges: new Map() };
  tunnels.set(name, tunnel);

  ws.onopen = () => {
    console.log(`[${name}] client connected`);
    send(ws, encode(ASSIGNED, undefined, new TextEncoder().encode(`${name}.${BASE_DOMAIN}`)));
  };

  ws.onmessage = (e) => {
    if (!(e.data instanceof ArrayBuffer)) return;
    const { type, id, payload } = decode(e.data);
    const exchange = tunnel.exchanges.get(id);
    if (!exchange) return;
    if (type === RESPONSE && !exchange.responded) {
      const head = decodeJson<ResponseHead>(payload);
      const headers = new Headers();
      for (const [k, v] of head.headers) headers.append(k, v);
      exchange.responded = true;
      if (NULL_BODY_STATUSES.has(head.status)) {
        exchange.respond(new Response(null, { status: head.status, statusText: head.statusText, headers }));
        return;
      }
      const body = new ReadableStream<Uint8Array>({
        start: (controller) => {
          exchange.body = controller;
        },
        cancel: () => cancel(tunnel, id),
      });
      exchange.respond(new Response(body, { status: head.status, statusText: head.statusText, headers }));
    } else if (type === DATA) {
      try {
        exchange.body?.enqueue(payload.slice());
      } catch { /* stream cancelled */ }
    } else if (type === END) {
      tunnel.exchanges.delete(id);
      try {
        exchange.body?.close();
      } catch { /* stream cancelled */ }
    } else if (type === ABORT) {
      fail(tunnel, id);
    }
  };

  ws.onclose = () => {
    console.log(`[${name}] client disconnected`);
    if (tunnels.get(name) === tunnel) tunnels.delete(name);
    for (const id of [...tunnel.exchanges.keys()]) fail(tunnel, id);
  };

  return response;
}

function forward(
  tunnel: Tunnel,
  req: Request,
  info: Deno.ServeHandlerInfo,
  host: string,
): Promise<Response> | Response {
  if (req.headers.get('upgrade')) return text('websocket upgrades are not supported through the tunnel', 501);
  const id = crypto.randomUUID();
  const url = new URL(req.url);
  const headers = forwardableHeaders(req.headers);
  headers.push(['x-forwarded-host', host]);
  if (!req.headers.has('x-forwarded-proto')) headers.push(['x-forwarded-proto', url.protocol.slice(0, -1)]);
  const head: RequestHead = { method: req.method, path: url.pathname + url.search, headers, body: req.body !== null };

  return new Promise<Response>((respond) => {
    tunnel.exchanges.set(id, { respond, responded: false });
    send(tunnel.ws, encode(REQUEST, id, encodeJson(head)));
    console.log(`[${tunnel.name}] ${req.method} ${head.path}`);

    // Settles once the response is fully delivered; rejects if the visitor disconnects first.
    info.completed.catch(() => cancel(tunnel, id));

    if (req.body) {
      (async () => {
        for await (const chunk of req.body!) {
          if (!tunnel.exchanges.has(id)) return;
          send(tunnel.ws, encode(DATA, id, chunk));
        }
        send(tunnel.ws, encode(END, id));
      })().catch(() => cancel(tunnel, id));
    }
  });
}

Deno.serve({ port: PORT, cert: CERTIFICATE, key: PRIVATE_KEY }, (req, info) => {
  // req.url carries the Host header (HTTP/1.1) or :authority (HTTP/2).
  const host = new URL(req.url).hostname.toLowerCase();
  if (host === BASE_DOMAIN) return handleControl(req);
  if (host.endsWith(`.${BASE_DOMAIN}`)) {
    const tunnel = tunnels.get(host.slice(0, -BASE_DOMAIN.length - 1));
    return tunnel ? forward(tunnel, req, info, host) : text(`no tunnel at ${host}`, 404);
  }
  return text(`unknown host ${host}`, 404);
});
