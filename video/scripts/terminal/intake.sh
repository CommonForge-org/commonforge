#!/usr/bin/env bash
# Scene 1 terminal pane: the client's hand-off folder goes through ZIP intake and the dry-run
# inventory appears (nested repos kept, node_modules excluded, the large video routed to R2, the
# fake .env blocked by name). Intake has no screen yet, so this is the API call. It stops at the
# inventory: confirming would create resources in the demo org.
#   CAPTURE_INTAKE_DIR  the hand-off folder (two repos, a ZIP prototype, a brand folder)
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
: "${CAPTURE_INTAKE_DIR:?set CAPTURE_INTAKE_DIR to the client hand-off folder}"
command -v zip >/dev/null || { echo "zip is required" >&2; exit 2; }
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
NAME="$(basename "$CAPTURE_INTAKE_DIR")"

show "ls $NAME"
ls -1 "$CAPTURE_INTAKE_DIR"
show "zip -qr $NAME.zip $NAME"
(cd "$(dirname "$CAPTURE_INTAKE_DIR")" && zip -qr "$WORK/$NAME.zip" "$NAME")
ls -lh "$WORK/$NAME.zip" | awk '{print $5, $NF}' | sed "s#$WORK/##"

show "curl -X POST \"\$API/orgs/$ORG/intake/zip?name=$NAME.zip\" -H \"Authorization: Bearer \$CF_TOKEN\" --data-binary @$NAME.zip"
STARTED="$(api POST "/orgs/$ORG/intake/zip?name=$NAME.zip" -H 'content-type: application/zip' --data-binary "@$WORK/$NAME.zip")"
echo "$STARTED" | jq '{intakeId, state, sha256}'
ID="$(echo "$STARTED" | jq -r .intakeId)"

show "curl \"\$API/orgs/$ORG/intake/$ID\"   # until the inventory is ready"
inventoried() {
  INTAKE="$(api GET "/orgs/$ORG/intake/$ID")"
  case "$(echo "$INTAKE" | jq -r .state)" in failed) echo "$INTAKE" | jq .error >&2; exit 1 ;; esac
  echo "$INTAKE" | jq -e '.plan != null' >/dev/null
}
poll 600 3 inventoried
note "dry run: nothing has been imported yet"
echo "$INTAKE" | jq -r '.plan.placements[] | "\(.provider | ascii_downcase)\t\(.resourceName)\t\(.files) files\t\(.bytes) bytes\t\(.reason)"' | column -t -s $'\t'
show "jq '.plan.excluded' # excluded or blocked, with the reason (contents never read)"
echo "$INTAKE" | jq -r '.plan.excluded[] | "\(.path)\t\(.reason)"' | column -t -s $'\t'
