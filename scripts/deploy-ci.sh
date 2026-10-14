#!/usr/bin/env bash
# Deploy the CI copy of the CommonForge platform on the production Cloudflare account (workers.dev).
#
#   scripts/deploy-ci.sh [setup] [secrets] [migrate] [worker] [preview] [runner]
#       (default: migrate runner preview worker)
#
# Owner-approved (Task 23): Workers commonforge-ci-{worker,preview,runner}; D1 commonforge-ci;
# queues <name>-ci; R2 commonforge-assets-ci; Artifacts prefix commonforge-ci; release Workers
# cfci-<orgId>-<name>. It runs COMMONFORGE_EMAIL_MODE=log (as may non-production scripts/bootstrap.sh deployments).
# The configs are generated from the production templates by scripts/ci-config.mjs (which refuses any
# production resource name) into git-ignored apps/worker/wrangler.deploy-ci*.jsonc, from
# COMMONFORGE_LIVE_BASE, COMMONFORGE_CI_D1_DATABASE_ID, COMMONFORGE_EMAIL_FROM and production's
# COMMONFORGE_D1_DATABASE_ID (apps/worker/.dev.vars; CI's id must differ from it); this script never
# deploys a production config. Before `migrate` or `worker` it checks with Cloudflare (wrangler d1 info,
# read-only) that COMMONFORGE_CI_D1_DATABASE_ID is the database named commonforge-ci.
#
#   setup    create the queues, D1 database and R2 bucket if missing (idempotent)
#   secrets  set missing secrets: random session/job/preview keys (kept 0600 in
#            ${COMMONFORGE_CI_SECRETS:-~/.config/commonforge-ci/secrets.env}), CF_ACCOUNT_ID,
#            CF_API_TOKEN, COMMONFORGE_DEPLOY_API_TOKEN and (when set) JEV_API_KEY from apps/worker/.dev.vars.
#            Never printed.
#   migrate  apply D1 migrations to commonforge-ci (remote)
#
# Credentials come from apps/worker/.dev.vars (CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID).
# Container images need Docker; if the user is not in the docker group, a `sudo -n docker`
# wrapper is used. After deploying the runner, its container application must exist.
set -euo pipefail
cd "$(dirname "$0")/.."
targets=("$@")
set --
# DEV_VARS=<path> reads another checkout's .dev.vars (a worktree has none of its own).
# Deployment settings already in the environment win over the file (credentials do not).
LOAD_DEV_VARS_KEEP_ENV="COMMONFORGE_LIVE_BASE COMMONFORGE_CI_D1_DATABASE_ID COMMONFORGE_D1_DATABASE_ID COMMONFORGE_EMAIL_FROM" \
  source scripts/load-dev-vars.sh ${DEV_VARS:+"$DEV_VARS"} >/dev/null

[ -n "${COMMONFORGE_LIVE_BASE:-}" ] || { echo "COMMONFORGE_LIVE_BASE is not set (apps/worker/.dev.vars): the account's <subdomain>.workers.dev" >&2; exit 1; }
BASE="$COMMONFORGE_LIVE_BASE"
WORKER_URL="https://commonforge-ci-worker.${BASE}"
PREVIEW_URL="https://commonforge-ci-preview.${BASE}"
QUEUES=(commonforge-steps-ci commonforge-runner-jobs-ci commonforge-outbox-ci commonforge-outbox-dlq-ci commonforge-artifacts-events-ci)
SECRETS_FILE="${COMMONFORGE_CI_SECRETS:-$HOME/.config/commonforge-ci/secrets.env}"

if ! docker info >/dev/null 2>&1 && sudo -n docker info >/dev/null 2>&1; then
  wrap="$(mktemp -d)/docker"
  printf '#!/bin/sh\nexec sudo -n docker "$@"\n' >"$wrap"
  chmod +x "$wrap"
  export WRANGLER_DOCKER_BIN="$wrap"
fi

# runner before worker (a new worker may issue jobs only the new runner understands); on the very
# first deploy run `worker` first: the runner's service binding needs it to exist.
[ ${#targets[@]} -eq 0 ] && targets=(migrate runner preview worker)

# every target but `setup` (which creates the database COMMONFORGE_CI_D1_DATABASE_ID names) needs the configs
needs_config=0
for t in "${targets[@]}"; do [ "$t" != setup ] && needs_config=1; done
[ "$needs_config" = 1 ] && node scripts/ci-config.mjs
grep -q '"COMMONFORGE_EMAIL_MODE": "send"' apps/worker/wrangler.jsonc || { echo "production config is not in send mode" >&2; exit 1; }

needs_build=0
for t in "${targets[@]}"; do case "$t" in worker|preview|runner) needs_build=1 ;; esac; done
[ "$needs_build" = 1 ] && pnpm build >/dev/null

cd apps/worker
W=(pnpm exec wrangler)

TMPFILES=()
trap 'rm -f "${TMPFILES[@]}"' EXIT

# $1 config, then secret NAMEs whose values are in the environment (exported); only names not yet
# set on the Worker are sent. Values never reach a command line (review m3): node reads them from
# its environment and writes a 0600 temp file that `wrangler secret bulk` reads; the trap removes it.
set_secrets() {
  local cfg="$1"; shift
  local have tmp
  have="$("${W[@]}" secret list -c "$cfg" 2>/dev/null || echo '[]')"
  tmp="$(umask 077; mktemp)"; TMPFILES+=("$tmp")
  printf '%s' "$have" | SECRET_NAMES="$*" node -e '
    let raw = ""; process.stdin.on("data", (d) => (raw += d)).on("end", () => {
      const have = new Set(JSON.parse(raw || "[]").map((s) => s.name));
      const out = {};
      for (const k of process.env.SECRET_NAMES.split(" ").filter(Boolean)) {
        if (have.has(k)) continue;
        if (!process.env[k]) { console.error(`missing value for ${k}`); process.exit(1); }
        out[k] = process.env[k];
      }
      process.stdout.write(JSON.stringify(out));
    });' >"$tmp"
  if [ "$(head -c 2 "$tmp")" != "{}" ]; then
    echo "setting $(node -e 'console.log(Object.keys(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))).join(", "))' "$tmp") on ${cfg}"
    "${W[@]}" secret bulk "$tmp" -c "$cfg" >/dev/null
  fi
  rm -f "$tmp"
}

# Review M1: before anything touches the CI database (migrate) or binds it (worker), ask Cloudflare
# what the configured COMMONFORGE_CI_D1_DATABASE_ID actually is. `d1 info <name> -c <config>` resolves
# the name through the config's binding, so it looks up the configured id and prints that database's
# real name: anything but commonforge-ci (production's database, say) is refused. Read-only.
check_ci_database() {
  local info
  info="$("${W[@]}" d1 info commonforge-ci --json -c wrangler.deploy-ci.jsonc 2>/dev/null)" \
    || { echo "refusing: could not look up the CI database (wrangler d1 info commonforge-ci)" >&2; exit 1; }
  printf '%s' "$info" | CI_D1_ID="$COMMONFORGE_CI_D1_DATABASE_ID" node -e '
    let raw = ""; process.stdin.on("data", (d) => (raw += d)).on("end", () => {
      let db;
      try { db = JSON.parse(raw.slice(raw.indexOf("{"))); } catch { console.error("refusing: wrangler d1 info did not return JSON"); process.exit(1); }
      const want = process.env.CI_D1_ID.toLowerCase();
      if (db.name !== "commonforge-ci" || String(db.uuid).toLowerCase() !== want) {
        console.error(`refusing: COMMONFORGE_CI_D1_DATABASE_ID (${want}) is not the database named commonforge-ci (Cloudflare says: "${db.name}", ${db.uuid})`);
        process.exit(1);
      }
    });'
}
if printf '%s\n' "${targets[@]}" | grep -qxE 'migrate|worker'; then check_ci_database; fi

for t in "${targets[@]}"; do
  case "$t" in
    setup)
      existing="$("${W[@]}" queues list 2>/dev/null)"
      for qn in "${QUEUES[@]}"; do grep -q " $qn " <<<"$existing" || "${W[@]}" queues create "$qn"; done
      "${W[@]}" d1 list 2>/dev/null | grep -q " commonforge-ci " || { "${W[@]}" d1 create commonforge-ci; echo "put the new database_id into apps/worker/.dev.vars as COMMONFORGE_CI_D1_DATABASE_ID" >&2; exit 1; }
      "${W[@]}" r2 bucket list 2>/dev/null | grep -q "commonforge-assets-ci" || "${W[@]}" r2 bucket create commonforge-assets-ci ;;
    secrets)
      if [ ! -f "$SECRETS_FILE" ]; then
        (umask 077; mkdir -p "$(dirname "$SECRETS_FILE")"
         { echo "COMMONFORGE_SESSION_SECRET=$(openssl rand -hex 32)"
           echo "COMMONFORGE_RUNNER_JOB_KEY=$(openssl rand -hex 32)"
           echo "COMMONFORGE_PREVIEW_KEY=$(openssl rand -hex 32)"; } >"$SECRETS_FILE")
      fi
      chmod 600 "$SECRETS_FILE"; chmod 700 "$(dirname "$SECRETS_FILE")"
      set -a
      # shellcheck disable=SC1090
      source "$SECRETS_FILE"
      set +a
      export CF_ACCOUNT_ID CF_API_TOKEN
      export COMMONFORGE_DEPLOY_API_TOKEN="$CF_API_TOKEN"
      set_secrets wrangler.deploy-ci.jsonc COMMONFORGE_SESSION_SECRET COMMONFORGE_RUNNER_JOB_KEY COMMONFORGE_PREVIEW_KEY CF_ACCOUNT_ID CF_API_TOKEN COMMONFORGE_DEPLOY_API_TOKEN
      # The classifier key (staging promotions), when .dev.vars has one; without it CI's classifier
      # answers not_configured and every classify path goes to a developer.
      if [ -n "${JEV_API_KEY:-}" ]; then export JEV_API_KEY; set_secrets wrangler.deploy-ci.jsonc JEV_API_KEY; fi
      set_secrets wrangler.deploy-ci-preview.jsonc COMMONFORGE_PREVIEW_KEY ;;
    migrate)
      "${W[@]}" d1 migrations apply commonforge-ci --remote -c wrangler.deploy-ci.jsonc ;;
    worker)
      "${W[@]}" deploy -c wrangler.deploy-ci.jsonc ;;
    preview)
      "${W[@]}" deploy -c wrangler.deploy-ci-preview.jsonc ;;
    runner)
      "${W[@]}" deploy -c wrangler.deploy-ci-runner.jsonc ;;
    *) echo "unknown target: $t" >&2; exit 2 ;;
  esac
done

# The runner must keep its container (see deploy-live.sh).
if printf '%s\n' "${targets[@]}" | grep -qx runner; then
  "${W[@]}" containers list 2>/dev/null | grep -q commonforge-ci-runner \
    || { echo "CI runner container application missing" >&2; exit 1; }
fi
health="$(curl -fsS "${WORKER_URL}/health" || echo FAILED)"
echo "health: ${health}"
if printf '%s\n' "${targets[@]}" | grep -qx worker; then
  printf '%s' "${health}" | grep -q '"deployment":"ci"' || { echo "the CI worker's /health does not say deployment ci" >&2; exit 1; }
fi
echo "preview: ${PREVIEW_URL}"
# Unlike deploy-live.sh, active chaos flags are allowed here (CI only: COMMONFORGE_CHAOS plus
# COMMONFORGE_CHAOS_ALLOW_DEPLOYED=inject-faults, for the fault suite); say so loudly.
if printf '%s' "${health}" | grep -q '"chaos"'; then
  echo "note: the CI worker has ACTIVE chaos flags (fault injection); clear them before an e2e or rehearsal run" >&2
fi
