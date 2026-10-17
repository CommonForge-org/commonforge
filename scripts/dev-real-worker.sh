#!/usr/bin/env bash
# Disposable real Worker + local Git smart HTTP + Node runner. No cloud credentials or fakes.
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo"
export CLOUDFLARE_API_TOKEN="" CLOUDFLARE_ACCOUNT_ID="" CF_API_TOKEN="" CF_ACCOUNT_ID="" WRANGLER_SEND_METRICS=false
if [ "${SKIP_BUILD:-}" != "1" ]; then
  pnpm exec turbo run build --filter=@commonforge-org/web --filter='@commonforge-org/runner^...' --output-logs=errors-only >&2
fi
exec pnpm --filter @commonforge-org/runner exec tsx src/g1-dev-worker.ts
