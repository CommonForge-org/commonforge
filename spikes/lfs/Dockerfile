# LFS spike image: like spikes/sandbox-runner, plus git-lfs.
FROM docker.io/library/node:22-trixie-slim
RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates git git-lfs coreutils \
  && rm -rf /var/lib/apt/lists/* \
  && git lfs install --system
COPY --from=docker.io/cloudflare/sandbox:1.0.0 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
RUN mkdir -p /workspace
WORKDIR /workspace
CMD ["sleep", "infinity"]
