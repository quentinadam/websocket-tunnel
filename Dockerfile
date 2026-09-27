FROM denoland/deno:2.9.7

WORKDIR /app
COPY deno.json deno.lock protocol.ts words.ts server.ts ./
RUN deno cache server.ts

# Run unprivileged: listen on 8000 inside the container and map host port 443 (TLS) or 80
# (plain HTTP, when no certificate is set) to it.
USER deno
ENV PORT=8000
EXPOSE 8000

CMD ["run", "--allow-net=0.0.0.0:8000", "--allow-env=CERTIFICATE,PRIVATE_KEY,BASE_DOMAIN,PORT", "server.ts"]
