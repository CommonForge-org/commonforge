# Task 3 spike runner image: Debian trixie + Node 22 + git + the @cloudflare/sandbox
# 1.0 helper (sandbox-shim). `cloudflare/sandbox:<ver>` is a scratch image that
# only ships the shim; in 1.0 you copy it into your own base (docs: /sandbox/reference).
# No credentials are baked in: tokens arrive per exec() via env, or are injected
# on egress by the Worker (interceptOutboundHttps).
FROM docker.io/library/node:22-trixie-slim

RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*

COPY --from=docker.io/cloudflare/sandbox:1.0.0 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
COPY static-server.mjs /opt/spike/static-server.mjs

RUN mkdir -p /workspace
WORKDIR /workspace
CMD ["sleep", "infinity"]
