#!/usr/bin/env bash
# Deploy the live (production) CommonForge platform Workers.
#
#   scripts/deploy-live.sh [migrate] [worker] [preview] [runner]
#       (default: worker preview runner, in that order; `migrate` only when named)
#
#   migrate  apply the D1 migrations to the production database (remote), through the generated
#            config: the committed wrangler.jsonc only has a placeholder database_id. Run it before
#            a `worker` deploy that needs new migrations.
#
# The committed wrangler*.jsonc are templates with a placeholder sender and D1 id: this deployment's
# own values come from the environment or apps/worker/.dev.vars (a non-empty value in the
# environment wins for the settings below) and scripts/live-config.mjs writes them into git-ignored
# wrangler.deploy-live{,-preview}.jsonc, refusing anything missing or still a placeholder:
# COMMONFORGE_EMAIL_FROM, COMMONFORGE_D1_DATABASE_ID, COMMONFORGE_LIVE_BASE, and optionally
# COMMONFORGE_LIVE_APP_URL / COMMONFORGE_LIVE_PREVIEW_URL and the custom domains
# COMMONFORGE_LIVE_APP_DOMAIN / COMMONFORGE_LIVE_PREVIEW_DOMAIN (see scripts/live-config-core.mjs).
# `runner` alone needs only the URL settings (it deploys wrangler.runner.jsonc, which has no D1 or sender).
# The live URLs are passed as --var so the templates keep their local-dev defaults.
# Credentials come from apps/worker/.dev.vars (CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID).
# Container images need Docker; if the user is not in the docker group, a `sudo -n docker`
# wrapper is used. After deploying the runner, its active version must have a container image.
set -euo pipefail
cd "$(dirname "$0")/.."
targets=("$@")
set --
[ ${#targets[@]} -eq 0 ] && targets=(worker preview runner)
for t in "${targets[@]}"; do case "$t" in migrate|worker|preview|runner) ;; *) echo "unknown target: $t" >&2; exit 2 ;; esac; done
# deployment settings already in the environment win over apps/worker/.dev.vars (credentials do not)
LOAD_DEV_VARS_KEEP_ENV="COMMONFORGE_EMAIL_FROM COMMONFORGE_D1_DATABASE_ID COMMONFORGE_CI_D1_DATABASE_ID COMMONFORGE_LIVE_BASE COMMONFORGE_LIVE_APP_URL COMMONFORGE_LIVE_PREVIEW_URL COMMONFORGE_LIVE_APP_DOMAIN COMMONFORGE_LIVE_PREVIEW_DOMAIN COMMONFORGE_ADMIN_EMAILS" \
  source scripts/load-dev-vars.sh >/dev/null

# writes the live configs and prints the app and preview URLs; refuses before anything is built.
# The runner alone needs only the URLs (no sender or D1 id).
if printf '%s\n' "${targets[@]}" | grep -qxE 'migrate|worker|preview'; then
  urls="$(node scripts/live-config.mjs)"
else
  urls="$(node scripts/live-config.mjs --urls-only)"
fi
read -r WORKER_URL PREVIEW_URL <<<"$urls"

if ! docker info >/dev/null 2>&1 && sudo -n docker info >/dev/null 2>&1; then
  wrap="$(mktemp -d)/docker"
  printf '#!/bin/sh\nexec sudo -n docker "$@"\n' >"$wrap"
  chmod +x "$wrap"
  export WRANGLER_DOCKER_BIN="$wrap"
fi

# The worker deploy replaces its vars: refuse before the (slow) build rather than after it.
if printf '%s\n' "${targets[@]}" | grep -qx worker; then
  [ -n "${COMMONFORGE_ADMIN_EMAILS:-}" ] || { echo "COMMONFORGE_ADMIN_EMAILS is not set (apps/worker/.dev.vars): nobody could create organizations" >&2; exit 1; }
fi

if printf '%s\n' "${targets[@]}" | grep -qxE 'worker|preview|runner'; then pnpm build >/dev/null; fi
cd apps/worker
for t in "${targets[@]}"; do
  case "$t" in
    migrate)
      # the database by its name in the generated config (whose database_id is the real one)
      db="$(node -e 'const c=require("fs").readFileSync(process.argv[1],"utf8"); console.log(JSON.parse(c.replace(/^\/\/.*$/gm,"")).d1_databases[0].database_name)' wrangler.deploy-live.jsonc)"
      pnpm exec wrangler d1 migrations apply "$db" --remote -c wrangler.deploy-live.jsonc ;;
    worker)
      pnpm exec wrangler deploy -c wrangler.deploy-live.jsonc \
        --var "COMMONFORGE_APP_URL:${WORKER_URL}" \
        --var "COMMONFORGE_PUBLIC_URL:${WORKER_URL}" \
        --var "COMMONFORGE_PREVIEW_URL:${PREVIEW_URL}" \
        --var "COMMONFORGE_ADMIN_EMAILS:${COMMONFORGE_ADMIN_EMAILS}" ;;
    preview)
      pnpm exec wrangler deploy -c wrangler.deploy-live-preview.jsonc ;;
    runner)
      pnpm exec wrangler deploy -c wrangler.runner.jsonc \
        --var "COMMONFORGE_WORKER_URL:${WORKER_URL}" \
        --var "COMMONFORGE_PREVIEW_URL:${PREVIEW_URL}" ;;
    *) echo "unknown target: $t" >&2; exit 2 ;;
  esac
done

# The runner must keep its container: a version created outside `wrangler deploy` (e.g. a
# dashboard settings change) can drop it, and every job then fails to start.
if printf '%s\n' "${targets[@]}" | grep -qx runner; then
  pnpm exec wrangler containers list 2>/dev/null | grep -q commonforge-runner \
    || { echo "runner container application missing" >&2; exit 1; }
fi
# migrate alone deploys nothing: no health check
printf '%s\n' "${targets[@]}" | grep -qxE 'worker|preview|runner' || exit 0
health="$(curl -fsS "${WORKER_URL}/health" || echo FAILED)"
echo "health: ${health}"
# The live platform is the production deployment in send mode (review m4: /health says so).
if printf '%s\n' "${targets[@]}" | grep -qx worker; then
  printf '%s' "${health}" | grep -q '"deployment":"production"' && printf '%s' "${health}" | grep -q '"emailMode":"send"' \
    || { echo "refusing: ${WORKER_URL}/health is not the production deployment in email send mode" >&2; exit 1; }
fi
# Fault injection (apps/worker/src/chaos.ts) must never be active on the live platform.
if printf '%s' "${health}" | grep -q '"chaos"'; then
  echo "refusing: ${WORKER_URL}/health reports active chaos flags (COMMONFORGE_CHAOS); unset them and redeploy" >&2
  exit 1
fi
