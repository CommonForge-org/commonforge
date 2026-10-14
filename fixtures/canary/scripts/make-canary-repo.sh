#!/usr/bin/env bash
# Builds the AT-26 canary repository: a git repo whose OLD commit contains a
# CANARY_SECRET in .env and a hidden-module/ directory, both removed from HEAD.
# A fresh-history client edition built from HEAD must contain neither the
# secret string nor any hidden-module/ path in any object it serves.
#
#   fixtures/canary/scripts/make-canary-repo.sh [out-dir]
#
# Default out-dir: fixtures/canary/out/canary-repo (git-ignored). The repo is
# generated at run time so this monorepo never commits a nested .git. Author,
# committer and dates are pinned, so commit shas are stable for a given git
# version and secret value. A bare copy is written next to it (<out-dir>.git)
# for pushing to an Artifacts remote.
#
# Env: CANARY_SECRET_VALUE overrides the secret (default below).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out="${1:-$(cd "$here/.." && pwd)/out/canary-repo}"
secret="${CANARY_SECRET_VALUE:-cfcanary-3b9e1f7c-d2a4-4e8b-9c61-5a0f2e7d8b13}"

rm -rf "$out" "$out.git"
mkdir -p "$out"
cd "$out"

export GIT_AUTHOR_NAME="Demo Client Dev" GIT_AUTHOR_EMAIL="dev@demo-client.invalid"
export GIT_COMMITTER_NAME="Demo Client Dev" GIT_COMMITTER_EMAIL="dev@demo-client.invalid"
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
git init -q -b main .
git config commit.gpgsign false

commit() {
  export GIT_AUTHOR_DATE="$1" GIT_COMMITTER_DATE="$1"
  git add -A
  git commit -q -m "$2"
}

# --- commit 1: secret + hidden module present ------------------------------
mkdir -p src hidden-module
cat > README.md <<'MD'
# Demo Client quote engine

Internal pricing service for the Customer Portal.
MD
cat > src/quote.ts <<'TS'
export function unitPrice(plan: "starter" | "team" | "enterprise"): number {
  return { starter: 12, team: 29, enterprise: 59 }[plan];
}
TS
printf 'CANARY_SECRET=%s\nDATABASE_URL=postgres://demo:demo@db.demo-client.invalid/portal\n' "$secret" > .env
cat > hidden-module/margin-model.ts <<'TS'
// CONFIDENTIAL: internal margin model. Must never reach a client edition.
export const HIDDEN_MODULE_MARKER = "hidden-module-canary-7d1e";
export const TARGET_MARGIN = { starter: 0.62, team: 0.71, enterprise: 0.78 };
TS
cat > hidden-module/README.md <<'MD'
Confidential pricing internals (canary).
MD
commit "2026-09-01T10:00:00Z" "initial import with internal pricing module"

# --- commit 2: secret and hidden module removed ----------------------------
git rm -q -r --cached .env hidden-module
rm -rf .env hidden-module
printf '.env\n' > .gitignore
commit "2026-09-02T10:00:00Z" "remove secrets and internal pricing module"

# --- commit 3: ordinary public change on HEAD ------------------------------
cat >> README.md <<'MD'

## Public surface

`src/quote.ts` exposes per-seat list prices. Discounts are applied by the api.
MD
commit "2026-09-03T10:00:00Z" "document public quote surface"

git clone -q --bare . "$out.git"

# --- self-check -------------------------------------------------------------
# Capture output first: grep -q exiting early would SIGPIPE git under pipefail.
head_paths="$(git ls-tree -r --name-only HEAD)"
history_patch="$(git log --all -p)"
history_paths="$(git log --all --name-only --format=)"
if grep -Eq '^(\.env|hidden-module/)' <<<"$head_paths"; then
  echo "make-canary-repo: HEAD still contains canary paths" >&2; exit 1
fi
grep -qF "CANARY_SECRET=$secret" <<<"$history_patch" || { echo "make-canary-repo: secret missing from history" >&2; exit 1; }
grep -q '^hidden-module/' <<<"$history_paths" || { echo "make-canary-repo: hidden-module missing from history" >&2; exit 1; }

echo "CANARY_REPO=$out"
echo "CANARY_BARE=$out.git"
echo "CANARY_SECRET_VALUE=$secret"
echo "CANARY_HIDDEN_PATH=hidden-module/"
echo "CANARY_HIDDEN_MARKER=hidden-module-canary-7d1e"
echo "CANARY_SECRET_COMMIT=$(git rev-list --max-parents=0 HEAD)"
echo "CANARY_HEAD=$(git rev-parse HEAD)"
