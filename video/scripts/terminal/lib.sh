# Shared helpers for the terminal-pane scripts recorded with record-cast. Source it; do not run it.
# Shown commands use $CF_TOKEN literally: the token is read from the session file and handed to
# curl on a file descriptor, never on the command line or in the output.
set -euo pipefail

VIDEO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REPO="$(cd "$VIDEO_DIR/.." && pwd)"

: "${CAPTURE_BASE_URL:?set CAPTURE_BASE_URL to the live Worker origin}"
# The persona whose session the API calls use: the owner by default; a script acting as another
# persona (clone.sh: the client) sets CAPTURE_SESSION_FILE before sourcing this file.
SESSION_FILE="${CAPTURE_SESSION_FILE:-${CAPTURE_OWNER_SESSION_FILE:-}}"
[ -n "$SESSION_FILE" ] || { echo "set CAPTURE_OWNER_SESSION_FILE to the owner cforge session.json" >&2; exit 2; }
for tool in curl jq; do command -v "$tool" >/dev/null || { echo "$tool is required" >&2; exit 2; }; done

API="${CAPTURE_BASE_URL%/}/api"
seed() { jq -r --arg k "$1" '.[$k] // empty' "$VIDEO_DIR/seed-output.json" 2>/dev/null || true; }
ORG="${CAPTURE_ORG:-$(seed orgId)}"
PROJECT="${CAPTURE_PROJECT:-$(seed projectId)}"
[ -n "$ORG" ] && [ -n "$PROJECT" ] || { echo "set CAPTURE_ORG and CAPTURE_PROJECT or run the seeder first" >&2; exit 2; }
CF_TOKEN="$(jq -r .sessionToken "$SESSION_FILE")"
case "$CF_TOKEN" in cfs_*) ;; *) echo "$SESSION_FILE has no cfs_ session token" >&2; exit 2 ;; esac

# Prints a command as the viewer should read it.
show() { printf '\n\033[1;32m$\033[0m \033[1m%s\033[0m\n' "$*"; }
note() { printf '\033[2m# %s\033[0m\n' "$*"; }

# api METHOD PATH [curl args…]: JSON request with the owner's bearer token; prints the body,
# fails on HTTP errors with the API's error body.
api() {
  local method="$1" path="$2" out status
  shift 2
  out="$(mktemp)"
  status="$(curl -sS -o "$out" -w '%{http_code}' -X "$method" "$API$path" \
    -H @<(printf 'Authorization: Bearer %s\n' "$CF_TOKEN") "$@")"
  if [ "${status:0:1}" != "2" ]; then
    echo "HTTP $status: $(cat "$out")" >&2
    rm -f "$out"
    return 1
  fi
  cat "$out"
  rm -f "$out"
}

json() { api "$1" "$2" -H 'content-type: application/json' --data "$3"; }

# poll SECONDS INTERVAL CMD…: reruns CMD until it succeeds or SECONDS pass.
poll() {
  local limit="$1" every="$2" deadline
  shift 2
  deadline=$(($(date +%s) + limit))
  until "$@"; do
    [ "$(date +%s)" -lt "$deadline" ] || { echo "timed out after ${limit}s" >&2; return 1; }
    sleep "$every"
  done
}
