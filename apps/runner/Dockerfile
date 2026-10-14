# syntax=docker/dockerfile:1
# CommonForge integration runner image (Sandbox container, plan §0.3 A3 / spikes/sandbox-runner).
#
#   sudo docker build -f apps/runner/Dockerfile -t commonforge-runner .     # from the repo root
#
# Base: node:22-trixie-slim + git + ca-certificates + the @cloudflare/sandbox 1.0 shim (the
# cloudflare/sandbox image is a scratch image that only ships the shim). No credentials are baked
# in: by default the runner uses egress mode (the Worker's outbound interceptor adds the Artifacts
# bearer, so no token is ever inside the container).
#
# What check isolation does and does NOT give (see README.md, "Isolation"):
# - check commands run as the unprivileged `cfcheck` user (uid 10001) in a checkout outside the
#   job directories: they cannot read the runner's environment or /proc, nor touch the repositories
#   the runner pushes from, and every cfcheck process is killed before any push;
# - BUT in egress mode the injected bearer applies to every request leaving the container, so a
#   check that can reach the network could talk to the job's repositories with the job's
#   credential. COMMONFORGE_RUNNER_CHECK_NETWORK=auto runs checks in a network namespace without
#   routes when the container allows it (needs CAP_SYS_ADMIN; plain Docker and possibly the
#   Sandbox runtime do not), and otherwise logs a warning. The egress gateway MUST therefore enforce
#   the job scope itself (README.md, "Requirements for Task 22").
# Run one container per job (instance type standard-1, never `lite`) and destroy it afterwards.
#
# Task 22 additions:
# - a pinned wrangler (global, root-owned) for `release-deploy`: release jobs deploy the stored,
#   digest-checked outputs with THIS wrangler, never a candidate's node_modules/.bin/wrangler. In
#   egress mode it gets a placeholder token; the gateway injects the account token for
#   release-deploy jobs only (apps/worker/src/sandbox/gateway.ts).
# - `dist/preview-host.js`: the private-preview host (apps/worker/src/preview) runs the api bundle
#   with fixture bindings only, as cfcheck, in a container without internet.

FROM docker.io/library/node:22-trixie-slim AS build
RUN npm install -g pnpm@12.5.1
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile --filter "@commonforge-org/runner..." \
 && pnpm --filter "@commonforge-org/runner..." run build \
 && pnpm --filter @commonforge-org/runner deploy --prod /out \
 && rm -rf /out/src /out/test

FROM docker.io/library/node:22-trixie-slim
RUN apt-get update \
 && apt-get install --yes --no-install-recommends ca-certificates git \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g pnpm@12.5.1 wrangler@4.147.0 \
 && useradd --system --uid 10001 --user-group --home-dir /nonexistent --shell /usr/sbin/nologin cfcheck \
 && mkdir -p /workspace/jobs /workspace/checks \
 && chmod 0700 /workspace/jobs \
 && chmod 0711 /workspace /workspace/checks
COPY --from=docker.io/cloudflare/sandbox:1.0.0 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
COPY --from=build /out /opt/commonforge-runner
RUN ln -s /opt/commonforge-runner/dist/main.js /usr/local/bin/commonforge-runner \
 && chmod 0755 /opt/commonforge-runner/dist/main.js

ENV NODE_ENV=production \
    COMMONFORGE_RUNNER_WORK_DIR=/workspace/jobs \
    COMMONFORGE_RUNNER_CREDENTIALS=egress \
    COMMONFORGE_RUNNER_CA=/etc/cloudflare/certs/cloudflare-containers-ca.crt \
    COMMONFORGE_RUNNER_KIND=sandbox \
    COMMONFORGE_RUNNER_CHECKS_DIR=/workspace/checks \
    COMMONFORGE_RUNNER_CHECK_UID=10001 \
    COMMONFORGE_RUNNER_CHECK_GID=10001 \
    COMMONFORGE_RUNNER_CHECK_NETWORK=auto \
    COMMONFORGE_RUNNER_WRANGLER=/usr/local/bin/wrangler \
    WRANGLER_SEND_METRICS=false
WORKDIR /workspace
# The Sandbox DO execs `commonforge-runner run - --worker-url <worker>` with the delivery on stdin.
CMD ["sleep", "infinity"]
