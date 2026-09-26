FROM denoland/deno:2.9.7

WORKDIR /app
COPY deno.json deno.lock protocol.ts words.ts server.ts ./
RUN deno cache server.ts

# Run unprivileged: listen on 8443 inside the container and map host port 443 (TLS) or 80
# (plain HTTP, when no certificate is set) to it.
USER deno
ENV PORT=8443
EXPOSE 8443

CMD ["run", "--allow-net=0.0.0.0:8443", "--allow-env=CERTIFICATE,PRIVATE_KEY,BASE_DOMAIN,PORT", "server.ts"]
