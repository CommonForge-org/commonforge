#!/usr/bin/env bash
# Real source/provider/Node-runner preview and isolated behavioral bridge. No cloud credentials.
# --serve retains the preview and signed bridge; default performs a bounded rehearsal then exits.
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo"
export CLOUDFLARE_API_TOKEN="" CLOUDFLARE_ACCOUNT_ID="" CF_API_TOKEN="" CF_ACCOUNT_ID="" WRANGLER_SEND_METRICS=false
if [ "${SKIP_BUILD:-}" != "1" ]; then
  pnpm exec turbo run build --filter='@commonforge-org/runner^...' --output-logs=errors-only >&2
fi
exec pnpm --filter @commonforge-org/runner exec tsx src/g1-real-local.ts "$@"
