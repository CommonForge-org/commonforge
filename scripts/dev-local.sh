#!/usr/bin/env bash
# Run CommonForge locally with no Cloudflare account and no credentials.
#
#   scripts/dev-local.sh                 # http://127.0.0.1:8799
#   PORT=8813 scripts/dev-local.sh       # another port
#   ADMIN_EMAIL=me@example.test scripts/dev-local.sh
#
# This is the stack the local-stack e2e suite runs (apps/web/e2e/stack/global-setup.ts): the real
# control-plane Worker under `wrangler dev -c apps/worker/wrangler.e2e.jsonc`, serving the real
# web app from apps/web/dist on the same origin. D1, Durable Objects, R2 and queues are local
# (miniflare). Cloudflare Artifacts, the integration runner and the Cloudflare API are in-memory
# fakes (apps/worker/e2e/stack.ts; docs/LIMITATIONS.md), so their state is lost when the Worker
# stops: every start therefore begins from an empty database.
#
# Sign-in emails are not sent: the magic link is printed to this terminal (and the log file) as
#   [commonforge dev] magic link for <email>: http://127.0.0.1:<port>/auth/verify?token=cfm_...
# Only ADMIN_EMAIL (default owner@agency.e2e.test) may create an organization.
#
# apps/worker/.dev.vars is never read (--env-file e2e/no-secrets.env) and Cloudflare credentials
# in your shell are blanked for wrangler. Stop with Ctrl-C.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
worker="$repo/apps/worker"
port="${PORT:-8799}"
admin="${ADMIN_EMAIL:-owner@agency.e2e.test}"
url="http://127.0.0.1:$port"
state="$worker/.wrangler/dev-local"
log="$worker/.wrangler/dev-local.log"

case "$port" in '' | *[!0-9]*) echo "dev-local.sh: PORT must be a number" >&2; exit 2 ;; esac
case "$admin" in *[[:space:]]* | '') echo "dev-local.sh: ADMIN_EMAIL must be one address (or @domain)" >&2; exit 2 ;; esac

if curl -fsS -o /dev/null --max-time 2 "$url/health" 2>/dev/null; then
  echo "dev-local.sh: $url is already serving; stop it first or set PORT" >&2
  exit 1
fi

# never hand real credentials to the local stack
export CLOUDFLARE_API_TOKEN="" CLOUDFLARE_ACCOUNT_ID="" CF_API_TOKEN="" CF_ACCOUNT_ID="" WRANGLER_SEND_METRICS=false

if [ "${SKIP_BUILD:-}" != "1" ]; then
  echo "dev-local.sh: building the web app and the packages the Worker uses..." >&2
  (cd "$repo" && pnpm exec turbo run build --filter=@commonforge-org/web --filter="@commonforge-org/worker^..." --output-logs=errors-only)
fi
[ -f "$repo/apps/web/dist/index.html" ] || { echo "dev-local.sh: apps/web/dist is missing; run without SKIP_BUILD=1" >&2; exit 1; }

rm -rf "$state"
mkdir -p "$state"
cd "$worker"
pnpm exec wrangler d1 migrations apply commonforge-e2e --local -c wrangler.e2e.jsonc --persist-to "$state" --env-file e2e/no-secrets.env >/dev/null

cat >&2 <<EOF

CommonForge (local, no credentials) is starting on $url
  Sign in with:  $admin   (the only address allowed to create an organization)
  Magic links:   printed below as "[commonforge dev] magic link for <email>: <link>"
                 (also in ${log#"$repo/"}); open the link in the browser
  CLI:           cforge login --api-url $url --email $admin
                 then paste the link printed below
  Faked:         Artifacts, the integration runner and the Cloudflare API (in memory)
Stop with Ctrl-C.

EOF

pnpm exec wrangler dev -c wrangler.e2e.jsonc --env-file e2e/no-secrets.env --persist-to "$state" \
  --ip 127.0.0.1 --port "$port" --show-interactive-dev-session=false \
  --var "COMMONFORGE_APP_URL:$url" --var "COMMONFORGE_PUBLIC_URL:$url" --var "COMMONFORGE_ADMIN_EMAILS:$admin" \
  2>&1 | tee "$log"
