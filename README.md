# websocket-tunnel

A minimal, self-hosted alternative to ngrok: expose a local HTTP service on a public HTTPS URL through a server you
control.

- The **server** listens on your base domain (e.g. `example.com`). Clients connect to it over a websocket and are each
  given a random public hostname such as `https://brave-otter.example.com`.
- The **client** runs next to your local service. HTTP requests arriving at its public hostname are forwarded over the
  websocket, replayed against the local service, and the response is streamed back.

The client reconnects automatically and asks for the same hostname again, so the URL stays stable across reconnects.
Request and response bodies are streamed in both directions, and websocket connections are relayed too (text and binary
messages, subprotocols, close codes).

## Requirements: a base domain on Cloudflare

You need a domain dedicated to the tunnel (the examples below use `example.com`). No domain? See
[Without a domain: sslip.io and Caddy](#without-a-domain-sslipio-and-caddy). The server answers on the apex domain,
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

## Without a domain: sslip.io and Caddy

You can run the server without buying a domain by using [sslip.io](https://sslip.io), a free DNS service where
`1-2-3-4.sslip.io` and every subdomain of it (e.g. `brave-otter.1-2-3-4.sslip.io`) resolve to the IP `1.2.3.4`. Use your
server's IP, written with dashes, as the base domain: no DNS setup is needed.

Since Cloudflare isn't involved, [Caddy](https://caddyserver.com) sits in front of the server and serves HTTPS with
Let's Encrypt certificates. sslip.io doesn't support wildcard certificates, so Caddy uses
[on-demand TLS](https://caddyserver.com/docs/automatic-https#on-demand-tls) to obtain a certificate for each hostname
the first time it is visited. Caddy only does this after asking the server's `/check` endpoint, which allows the base
domain and the hostnames of connected tunnels. This keeps random subdomains from triggering certificate requests.

Caddy's `caddy reverse-proxy` command can serve a single fixed hostname without a config file, but on-demand TLS
requires a short `Caddyfile`:

```caddyfile
{
	on_demand_tls {
		ask http://websocket-tunnel:8443/check
	}
}

https:// {
	tls {
		on_demand
	}
	reverse_proxy websocket-tunnel:8443
}
```

Then, with ports 80 and 443 open on the server (Let's Encrypt validates each hostname over port 80), and replacing
`1-2-3-4` with your server's IP:

```sh
docker network create websocket-tunnel

docker run -d --name websocket-tunnel --restart unless-stopped \
  --network websocket-tunnel \
  -e BASE_DOMAIN=1-2-3-4.sslip.io \
  quentinadam/websocket-tunnel

docker run -d --name caddy --restart unless-stopped \
  --network websocket-tunnel \
  -p 80:80 -p 443:443 \
  -v "$PWD/Caddyfile:/etc/caddy/Caddyfile" \
  -v caddy_data:/data \
  caddy
```

The tunnel server speaks plain HTTP on the private Docker network and publishes no ports; Caddy terminates TLS. The
`caddy_data` volume keeps the certificates across restarts. Clients then connect with `wss://1-2-3-4.sslip.io`.

Let's Encrypt limits how many certificates can be issued for sslip.io, and that limit is shared by all its users.
Setting `NAME` on the client keeps the same hostname, and therefore the same certificate, across runs instead of
requesting a new one for each random name. If issuance is rate limited, [nip.io](https://nip.io) works the same way
(`1-2-3-4.nip.io`).

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
