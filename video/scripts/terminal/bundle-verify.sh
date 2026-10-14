#!/usr/bin/env bash
# Scene 8 terminal pane: export the project with the CLI and verify every git bundle with plain
# git. Uses the owner's cforge session (CFORGE_CONFIG_DIR = the session file's directory).
#   CFORGE  the cforge command (default: node <repo>/apps/cli/dist/index.js)
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
CFORGE_CONFIG_DIR="$(cd "$(dirname "$CAPTURE_OWNER_SESSION_FILE")" && pwd)"
export CFORGE_CONFIG_DIR
read -r -a CFORGE_CMD <<<"${CFORGE:-node $REPO/apps/cli/dist/index.js}"
OUT="$(mktemp -d)/customer-portal-export"
trap 'rm -rf "$(dirname "$OUT")"' EXIT

show "cforge export $PROJECT --org $ORG --out customer-portal-export"
"${CFORGE_CMD[@]}" export "$PROJECT" --org "$ORG" --out "$OUT"
show "ls customer-portal-export"
(cd "$OUT" && find . -type f | sed 's#^\./##' | sort)
# git verifies a bundle against a repository: an empty one shows the bundle is self-contained
show "git init -q check && cd check"
git init -q "$OUT/check"
for BUNDLE in $(cd "$OUT" && find . -name '*.bundle' -not -path './check/*' | sed 's#^\./##' | sort); do
  show "git bundle verify ../$BUNDLE"
  (cd "$OUT/check" && git bundle verify "../$BUNDLE")
done
