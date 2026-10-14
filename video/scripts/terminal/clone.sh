#!/usr/bin/env bash
# Scene 2 terminal pane: the client's credentials reach the edition only. With a read token from the
# client's edition session, cloning the canonical website repository is denied, cloning the edition
# works, and the edition's history is one fresh commit (nothing of production's history).
#   CAPTURE_CLIENT_SESSION_FILE  the client's cforge session.json (API calls run as the client)
#   CAPTURE_EDITION              the edition id (default: seed-output.json editionId)
#   CAPTURE_CANONICAL_REMOTE     the canonical website remote (default: seed-output.json canonicalRemotes.website)
#   GIT                          the git command (default: git)
# The edition token goes to git only through its environment (http.extraHeader), never argv or output.
: "${CAPTURE_CLIENT_SESSION_FILE:?set CAPTURE_CLIENT_SESSION_FILE to the client cforge session.json}"
export CAPTURE_SESSION_FILE="$CAPTURE_CLIENT_SESSION_FILE"
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
EDITION="${CAPTURE_EDITION:-$(seed editionId)}"
CANONICAL="${CAPTURE_CANONICAL_REMOTE:-$(jq -r '.canonicalRemotes.website // empty' "$VIDEO_DIR/seed-output.json" 2>/dev/null || true)}"
[ -n "$EDITION" ] || { echo "set CAPTURE_EDITION or run the seeder first" >&2; exit 2; }
[ -n "$CANONICAL" ] || { echo "set CAPTURE_CANONICAL_REMOTE or reseed (seed-output.json canonicalRemotes.website)" >&2; exit 2; }
read -r -a GIT_CMD <<<"${GIT:-git}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
# a clean git: no user or system config, no prompts, no stored credentials
export HOME="$WORK" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0

show "curl \"\$API/orgs/$ORG/editions/$EDITION/sessions\"   # the client's update session"
SID="$(api GET "/orgs/$ORG/editions/$EDITION/sessions" | jq -r '.sessions | sort_by(.createdAt) | last | .sessionId // empty')"
if [ -z "$SID" ]; then
  show "curl -X POST \"\$API/orgs/$ORG/editions/$EDITION/sessions\" -d '{\"title\":\"Clone check\"}'"
  SID="$(json POST "/orgs/$ORG/editions/$EDITION/sessions" '{"title":"Clone check"}' | jq -r .sessionId)"
fi
show "curl -X POST \"\$API/orgs/$ORG/edition-sessions/$SID/credential\"   # the client's read token"
CRED="$(json POST "/orgs/$ORG/edition-sessions/$SID/credential" '{"ttlSeconds":600}')"
echo "$CRED" | jq '{scope, expiresAt, remoteUrl, branch}'
EDITION_REMOTE="$(echo "$CRED" | jq -r .remoteUrl)"
BRANCH="$(echo "$CRED" | jq -r '.branch // "main"')"
EDITION_TOKEN="$(echo "$CRED" | jq -r .secret)"
unset CRED

with_token() {
  GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=http.extraHeader GIT_CONFIG_VALUE_0="Authorization: Bearer $EDITION_TOKEN" \
    GIT_CONFIG_KEY_1=credential.helper GIT_CONFIG_VALUE_1= "${GIT_CMD[@]}" "$@"
}

show "git clone $CANONICAL website-production   # the client's token, production repository"
if with_token clone -q "$CANONICAL" "$WORK/website-production" 2>&1; then
  echo "UNEXPECTED: the client's token cloned the production repository" >&2
  exit 1
fi
note "denied: the client's token never reaches the production repository"

show "git clone --branch $BRANCH $EDITION_REMOTE website"
with_token clone -q --branch "$BRANCH" "$EDITION_REMOTE" "$WORK/website" 2>&1
show "cd website && git log --oneline"
HISTORY="$("${GIT_CMD[@]}" -C "$WORK/website" log --oneline)"
echo "$HISTORY"
COMMITS="$(printf '%s\n' "$HISTORY" | grep -c . || true)"
[ "$COMMITS" -eq 1 ] || { echo "expected one fresh commit in the edition, found $COMMITS" >&2; exit 1; }
note "one fresh commit: no production history in the client's copy"
