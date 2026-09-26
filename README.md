# websocket-tunnel

A minimal, self-hosted alternative to ngrok: expose a local HTTP service on a public HTTPS URL through a server you
control.

- The **server** listens on your base domain (e.g. `example.com`). Clients connect to it over a websocket and are each
  given a random public hostname such as `https://brave-otter.example.com`.
- The **client** runs next to your local service. HTTP requests arriving at its public hostname are forwarded over the
  websocket, replayed against the local service, and the response is streamed back.

The client reconnects automatically and asks for the same hostname again, so the URL stays stable across reconnects.
Request and response bodies are streamed in both directions. Websocket upgrades are not tunnelled.

## Requirements: a base domain on Cloudflare

You need a domain dedicated to the tunnel (the examples below use `example.com`). The server answers on the apex domain,
which is where clients connect, and on every first-level subdomain, one per tunnel.

In the Cloudflare dashboard for that domain:

1. **DNS → Records**, add two records, both **Proxied** (orange cloud):

   | Type    | Name | Content                   |
   | ------- | ---- | ------------------------- |
   | `A`     | `@`  | your server's public IPv4 |
   | `CNAME` | `*`  | `example.com`             |

   The `A` record points the apex at your server, and the wildcard `CNAME` sends every `<name>.example.com` to the apex.

2. Choose how Cloudflare connects to your server (the _origin_). Visitors always get HTTPS from Cloudflare either way.

   - **With an origin certificate (recommended):** traffic between Cloudflare and your server is encrypted too.
     - **SSL/TLS → Origin Server → Create Certificate**: keep the default hostnames (`example.com` and `*.example.com`)
       and save the certificate and private key as `origin.pem` and `origin-key.pem`. The server uses them to serve
       HTTPS on port 443.
     - **SSL/TLS → Overview**: set the encryption mode to **Full (strict)**.
   - **Without a certificate:** the server speaks plain HTTP on port 80, and traffic between Cloudflare and your server
     is unencrypted.
     - **SSL/TLS → Overview**: set the encryption mode to **Flexible**.

Cloudflare's free Universal SSL certificate covers the apex and first-level subdomains, so the base domain should be the
apex of the zone. Using a subdomain like `tunnel.example.com` as the base domain would require an Advanced Certificate
for `*.tunnel.example.com`.

## Running the server

The server image is published on Docker Hub as
[`quentinadam/websocket-tunnel`](https://hub.docker.com/r/quentinadam/websocket-tunnel). On the machine the `A` record
points to, with an origin certificate:

```sh
docker run -d --name websocket-tunnel --restart unless-stopped \
  -p 443:8443 \
  -e BASE_DOMAIN=example.com \
  -e CERTIFICATE="$(cat origin.pem)" \
  -e PRIVATE_KEY="$(cat origin-key.pem)" \
  quentinadam/websocket-tunnel
```

Or without a certificate (plain HTTP, Cloudflare in **Flexible** mode):

```sh
docker run -d --name websocket-tunnel --restart unless-stopped \
  -p 80:8443 \
  -e BASE_DOMAIN=example.com \
  quentinadam/websocket-tunnel
```

The container runs unprivileged and listens on port 8443, so host port 443 (HTTPS) or 80 (HTTP) is mapped to it.

| Variable      | Description                                                                                                                 |
| ------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `BASE_DOMAIN` | Required. Clients connect to `wss://BASE_DOMAIN`; tunnels are served at `<name>.BASE_DOMAIN`.                               |
| `CERTIFICATE` | Optional. PEM certificate (e.g. the Cloudflare Origin CA certificate). Literal `\n` is accepted in place of newlines.       |
| `PRIVATE_KEY` | Optional. PEM private key matching the certificate. If either this or `CERTIFICATE` is missing, the server uses plain HTTP. |
| `PORT`        | Listening port. Set to 8443 in the Docker image; otherwise defaults to 443 with a certificate and 80 without.               |

Visiting `https://example.com` in a browser shows the number of active tunnels.

## Running the client

With [Deno](https://deno.com) installed, run the client straight from GitHub, pointing it at your base domain and at the
local service to expose:

```sh
PORT=3000 deno run --allow-net --allow-env \
  https://raw.githubusercontent.com/quentinadam/websocket-tunnel/main/client.ts wss://example.com
```

It prints the public URL once connected:

```
tunnel open: https://brave-otter.example.com -> http://127.0.0.1:3000
```

| Variable     | Description                                                                                |
| ------------ | ------------------------------------------------------------------------------------------ |
| `PORT`       | Required. Port of the local service.                                                       |
| `HOSTNAME`   | Host of the local service (default `127.0.0.1`).                                           |
| `NAME`       | Request a specific subdomain, e.g. `NAME=myapp` for `myapp.example.com` (granted if free). |
| `SERVER_URL` | Server URL, used when it isn't passed as an argument.                                      |

Deno caches the remote script; add `--reload` to pick up a newer version.
