// Tunnel server: clients connect over websocket to https://BASE_DOMAIN and are given a
// random <word>-<word>.BASE_DOMAIN hostname. HTTP requests arriving for that hostname
// are forwarded over the websocket to the client, which replays them against its local
// service and streams the response back. Websocket connections are relayed the same way.
// See protocol.ts for the wire format.
//
// Usage:
//   BASE_DOMAIN=example.com CERTIFICATE="$(cat origin.pem)" PRIVATE_KEY="$(cat origin-key.pem)" \
//     deno run --allow-net --allow-env server.ts
// Env: BASE_DOMAIN (required): clients connect to wss://BASE_DOMAIN, tunnels get <name>.BASE_DOMAIN.
//      CERTIFICATE / PRIVATE_KEY (optional): PEM contents, e.g. a Cloudflare Origin CA certificate.
//        Literal "\n" sequences are accepted in place of newlines. If either is missing, the
//        server speaks plain HTTP (e.g. behind a proxy that terminates TLS).
//      PORT (default 443 with TLS, 80 without).
// Requests to any other host at /check?domain=<hostname> answer 200 if a certificate may be issued
// for <hostname> (the base domain or a connected tunnel), 403 otherwise: Caddy's on-demand TLS `ask`.

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
  forwardableWsHeaders,
  REQUEST,
  type RequestHead,
  RESPONSE,
  type ResponseHead,
  WS_ACCEPT,
  WS_BINARY,
  WS_CLOSE,
  WS_OPEN,
  WS_TEXT,
  type WsAccept,
  type WsClose,
} from './protocol.ts';
import { WORDS } from './words.ts';

const BASE_DOMAIN = Deno.env.get('BASE_DOMAIN')?.toLowerCase();
const pem = (name: string) => Deno.env.get(name)?.replaceAll('\\n', '\n');
const CERTIFICATE = pem('CERTIFICATE');
const PRIVATE_KEY = pem('PRIVATE_KEY');
if (!BASE_DOMAIN) {
  console.error('BASE_DOMAIN must be set');
  Deno.exit(1);
}
const TLS = CERTIFICATE && PRIVATE_KEY ? { cert: CERTIFICATE, key: PRIVATE_KEY } : undefined;
if (!TLS) console.warn('CERTIFICATE or PRIVATE_KEY not set, serving plain HTTP');
const PORT = Number(Deno.env.get('PORT') ?? (TLS ? 443 : 80));

type Exchange = {
  respond: (response: Response) => void;
  responded: boolean;
  body?: ReadableStreamDefaultController<Uint8Array>;
};
// A visitor websocket: waits for the client to open the local websocket (accept/reject), then
// relays messages. Messages arriving before the visitor socket is open are queued.
type Socket = {
  accept: (protocol: string) => void;
  reject: () => void;
  ws?: WebSocket;
  pending: (string | Uint8Array)[];
  close?: WsClose;
};
type Tunnel = { name: string; ws: WebSocket; exchanges: Map<string, Exchange>; sockets: Map<string, Socket> };

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
  const tunnel: Tunnel = { name, ws, exchanges: new Map(), sockets: new Map() };
  tunnels.set(name, tunnel);

  ws.onopen = () => {
    console.log(`[${name}] client connected`);
    send(ws, encode(ASSIGNED, undefined, new TextEncoder().encode(`${name}.${BASE_DOMAIN}`)));
  };

  ws.onmessage = (e) => {
    if (!(e.data instanceof ArrayBuffer)) return;
    const { type, id, payload } = decode(e.data);
    const socket = tunnel.sockets.get(id);
    if (socket) return handleSocketMessage(tunnel, id, socket, type, payload);
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
    for (const socket of tunnel.sockets.values()) {
      if (socket.ws) closeSocket(socket.ws);
      else socket.reject();
    }
    tunnel.sockets.clear();
  };

  return response;
}

const pathOf = (req: Request) => {
  const url = new URL(req.url);
  return url.pathname + url.search;
};

function forwardedHeaders(req: Request, host: string, headers: [string, string][]): [string, string][] {
  headers.push(['x-forwarded-host', host]);
  if (!req.headers.has('x-forwarded-proto')) {
    headers.push(['x-forwarded-proto', new URL(req.url).protocol.slice(0, -1)]);
  }
  return headers;
}

// The client opens the local websocket before the visitor's upgrade is accepted, so a refusal
// can still be answered with a regular HTTP error.
function forwardSocket(tunnel: Tunnel, req: Request, host: string): Promise<Response> {
  const id = crypto.randomUUID();
  const protocols = req.headers.get('sec-websocket-protocol')?.split(',').map((p) => p.trim()).filter(Boolean);
  const head: RequestHead = {
    method: 'GET',
    path: pathOf(req),
    headers: forwardedHeaders(req, host, forwardableWsHeaders(req.headers)),
    body: false,
    protocols,
  };

  return new Promise<Response>((respond) => {
    const timeout = setTimeout(() => {
      if (tunnel.sockets.get(id) !== socket || socket.ws) return;
      tunnel.sockets.delete(id);
      send(tunnel.ws, encode(ABORT, id));
      respond(text('tunnel client did not open the websocket in time', 504));
    }, 30_000);

    const socket: Socket = {
      pending: [],
      reject: () => {
        clearTimeout(timeout);
        tunnel.sockets.delete(id);
        respond(text('tunnel client could not open the websocket', 502));
      },
      accept: (protocol) => {
        clearTimeout(timeout);
        let upgraded;
        try {
          upgraded = Deno.upgradeWebSocket(req, { protocol: protocol || undefined });
        } catch (err) {
          // Malformed upgrade request (e.g. no sec-websocket-key): close the local side too.
          tunnel.sockets.delete(id);
          send(tunnel.ws, encode(ABORT, id));
          return respond(text(`invalid websocket request: ${err}`, 400));
        }
        const { socket: ws, response } = upgraded;
        ws.binaryType = 'arraybuffer';
        socket.ws = ws;
        ws.onopen = () => {
          for (const data of socket.pending) ws.send(data);
          socket.pending = [];
          if (socket.close) closeSocket(ws, socket.close);
        };
        ws.onmessage = (e) => send(tunnel.ws, encodeWsMessage(id, e.data));
        ws.onclose = (e) => {
          // Still registered: the visitor closed first, so tell the client.
          if (tunnel.sockets.get(id) !== socket) return;
          tunnel.sockets.delete(id);
          send(tunnel.ws, encode(WS_CLOSE, id, encodeJson({ code: e.code, reason: e.reason })));
        };
        respond(response);
      },
    };
    tunnel.sockets.set(id, socket);
    send(tunnel.ws, encode(WS_OPEN, id, encodeJson(head)));
    console.log(`[${tunnel.name}] WS ${head.path}`);
  });
}

function handleSocketMessage(tunnel: Tunnel, id: string, socket: Socket, type: number, payload: Uint8Array) {
  const ws = socket.ws;
  if (type === WS_ACCEPT && !ws) {
    socket.accept(decodeJson<WsAccept>(payload).protocol);
  } else if (type === ABORT && !ws) {
    socket.reject();
  } else if ((type === WS_TEXT || type === WS_BINARY) && ws) {
    const data = type === WS_TEXT ? new TextDecoder().decode(payload) : payload.slice();
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
    else if (ws.readyState === WebSocket.CONNECTING) socket.pending.push(data);
  } else if (type === WS_CLOSE || type === ABORT) {
    // The local side closed: forget the socket so its onclose doesn't echo a WS_CLOSE back.
    tunnel.sockets.delete(id);
    const close = type === WS_CLOSE ? decodeJson<WsClose>(payload) : {};
    if (!ws) socket.reject();
    else if (ws.readyState === WebSocket.CONNECTING) socket.close = close;
    else closeSocket(ws, close);
  }
}

function forward(
  tunnel: Tunnel,
  req: Request,
  info: Deno.ServeHandlerInfo,
  host: string,
): Promise<Response> | Response {
  const upgrade = req.headers.get('upgrade')?.toLowerCase();
  if (upgrade === 'websocket') return forwardSocket(tunnel, req, host);
  if (upgrade) return text(`${upgrade} upgrades are not supported through the tunnel`, 501);
  const id = crypto.randomUUID();
  const head: RequestHead = {
    method: req.method,
    path: pathOf(req),
    headers: forwardedHeaders(req, host, forwardableHeaders(req.headers)),
    body: req.body !== null,
  };

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

const tunnelFor = (host: string) =>
  host.endsWith(`.${BASE_DOMAIN}`) ? tunnels.get(host.slice(0, -BASE_DOMAIN.length - 1)) : undefined;

// Permission endpoint for on-demand TLS in a reverse proxy (Caddy's `ask`): allows certificates
// only for the base domain and the hostnames of connected tunnels.
function handleCheck(url: URL): Response {
  const domain = url.searchParams.get('domain')?.toLowerCase() ?? '';
  return domain === BASE_DOMAIN || tunnelFor(domain) ? text('ok') : text(`${domain} not allowed`, 403);
}

Deno.serve({ port: PORT, ...TLS }, (req, info) => {
  // req.url carries the Host header (HTTP/1.1) or :authority (HTTP/2).
  const url = new URL(req.url);
  const host = url.hostname.toLowerCase();
  if (host === BASE_DOMAIN) return handleControl(req);
  if (host.endsWith(`.${BASE_DOMAIN}`)) {
    const tunnel = tunnelFor(host);
    return tunnel ? forward(tunnel, req, info, host) : text(`no tunnel at ${host}`, 404);
  }
  if (url.pathname === '/check') return handleCheck(url);
  return text(`unknown host ${host}`, 404);
});
