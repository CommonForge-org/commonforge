#!/usr/bin/env bash
# Remove what scripts/bootstrap.sh created for a NON-PRODUCTION deployment (Task 24).
#
#   scripts/teardown.sh --name <name>                 list what would be deleted (nothing is deleted)
#   scripts/teardown.sh --name <name> --yes           delete it, then verify nothing is left
#   options: --env-file <file> (credentials, as bootstrap.sh), --keep-state (keep the local keys)
#
# Only what the deployment's state records is deleted (review I3, I3a):
# ${COMMONFORGE_STATE_DIR:-~/.config/commonforge/deployments}/<name>/deployment.json is bound to one
# Cloudflare account and records the identity of the queues, D1, R2 bucket, Workers and container
# applications that bootstrap.sh created (or was told to --adopt). Without that file, on another
# account, or when any recorded resource on the account is no longer the recorded one, nothing is
# deleted. Also deleted: the resources only this deployment's Worker creates, named
# <name>-o-<12 hex org id>[-…]: release Workers, KV namespaces, and the Artifacts namespaces
# <name>-o-<org id>-{canonical,tasks,editions} with every repo in them.
#
# Order: queue consumers; the Workers; the release Workers; their container applications; the queues;
# D1; R2 (emptied first); KV; Artifacts repos, then namespaces. Then the generated
# apps/worker/wrangler.deploy-<name>*.jsonc and the local state (keys) unless --keep-state.
#
# Production and the CI deployment are refused by name (commonforge*, ci, cfci, cfapp, prod, ...): there
# is no flag that tears them down. Credentials: CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID (and
# CF_API_TOKEN for Artifacts, default CLOUDFLARE_API_TOKEN); never echoed.
set -euo pipefail
die() { printf 'teardown: %s\n' "$1" >&2; exit "${2:-1}"; }
NAME_RE='^[a-z][a-z0-9]{2,15}$'

name="" yes=0 env_file="" keep_state=0
value() { [ -n "${2:-}" ] && [ "${2#-}" = "$2" ] || die "$1 needs a value (not an option)" 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --name) value "$1" "${2:-}"; name="$2"; shift 2 ;;
    --yes) yes=1; shift ;;
    --env-file) value "$1" "${2:-}"; env_file="$2"; shift 2 ;;
    --keep-state) keep_state=1; shift ;;
    --production) die "production is never torn down by this script" 2 ;;
    -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1 (see --help)" 2 ;;
  esac
done
# the name is checked before anything else runs (review I2)
[ -n "$name" ] || die "--name <name> is required" 2
[[ "$name" =~ $NAME_RE ]] || die "refusing deployment name \"$name\": 3-16 lowercase letters and digits, starting with a letter" 2
if [ -n "$env_file" ]; then # relative to the caller's directory
  [ -f "$env_file" ] || die "--env-file $env_file not found"
  env_file="$(cd "$(dirname "$env_file")" && pwd)/$(basename "$env_file")"
fi

cd "$(dirname "$0")/.."
REPO="$(pwd)"
D() { node "$REPO/scripts/bootstrap/deployment.mjs" "$@"; }
D names "$name" >/dev/null # refuses production / CI / reserved names
if [ -n "$env_file" ]; then
  # shellcheck disable=SC1091
  source scripts/load-dev-vars.sh "$env_file" >/dev/null 2>&1 || die "cannot load $env_file"
fi
[ -n "${CLOUDFLARE_API_TOKEN:-}" ] && [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] || die "export CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID"

STATE_DIR="${COMMONFORGE_STATE_DIR:-$HOME/.config/commonforge/deployments}/$name"
[ -f "$STATE_DIR/deployment.json" ] || die "no state for $name ($STATE_DIR/deployment.json): this script deletes only what bootstrap.sh recorded, so nothing is deleted"
CONFIGS=("apps/worker/wrangler.deploy-$name.jsonc" "apps/worker/wrangler.deploy-$name-preview.jsonc" "apps/worker/wrangler.deploy-$name-runner.jsonc")

echo "== deployment $name on account ${CLOUDFLARE_ACCOUNT_ID:0:6}… (recorded in $STATE_DIR)"
D inventory "$name" --owned
local_files=()
for f in "${CONFIGS[@]}"; do [ -e "$f" ] && local_files+=("$f"); done
[ "$keep_state" = 0 ] && local_files+=("$STATE_DIR")
echo "  local           ${local_files[*]:--}"

if [ "$yes" = 0 ]; then
  echo
  echo "Nothing was deleted. Rerun with --yes to delete everything listed above (irreversible: the D1 data, R2 objects and Artifacts repos are gone)."
  exit 1
fi

echo
echo "== deleting"
D teardown "$name" --yes

echo
echo "== verify (nothing this deployment recorded is left)"
# R2/queue deletion is eventually consistent for a few seconds: re-check before failing.
# The state is still in place here, so a failed run can be repeated.
for _ in 1 2 3 4 5 6; do
  if D inventory "$name" --owned --expect-empty; then
    rm -f "${CONFIGS[@]}"
    [ "$keep_state" = 1 ] || rm -rf "$STATE_DIR"
    echo "teardown: done, nothing of $name is left"
    exit 0
  fi
  sleep 10
done
die "resources of $name remain (listed above); the state is kept: rerun scripts/teardown.sh --name $name --yes"
