#!/usr/bin/env bash
# Scene 8 terminal pane: the UI has no restore-then-publish path, so the restored version goes
# through the same release gate by API: prepare → publish approval (owner) → deploy → /version.
#   CAPTURE_ACCEPTED_VERSION  the version to release (default: the project's current accepted version)
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
BODY="$(jq -cn --arg v "${CAPTURE_ACCEPTED_VERSION:-}" 'if $v == "" then {} else {acceptedVersionId: $v} end')"

show "curl -X POST \"\$API/orgs/$ORG/projects/$PROJECT/releases\" -d '$BODY'"
RELEASE="$(json POST "/orgs/$ORG/projects/$PROJECT/releases" "$BODY")"
echo "$RELEASE" | jq '{releaseId, acceptedVersionId, state, buildState}'
RID="$(echo "$RELEASE" | jq -r .releaseId)"

show "curl \"\$API/orgs/$ORG/releases/$RID\"   # until the sandbox build is prepared"
prepared() {
  RELEASE="$(api GET "/orgs/$ORG/releases/$RID")"
  case "$(echo "$RELEASE" | jq -r .buildState)" in failed) echo "$RELEASE" | jq .error >&2; exit 1 ;; esac
  echo "$RELEASE" | jq -e '.state == "prepared" and .buildState == "built"' >/dev/null
}
poll 900 3 prepared
echo "$RELEASE" | jq '{state, buildState, outputDigest}'
DIGEST="$(echo "$RELEASE" | jq -r .outputDigest)"

show "curl -X POST \"\$API/orgs/$ORG/releases/$RID/publish-approvals\" -d '{\"outputDigest\":\"${DIGEST:0:12}…\"}'"
json POST "/orgs/$ORG/releases/$RID/publish-approvals" "$(jq -cn --arg d "$DIGEST" '{outputDigest: $d}')" | jq '{approvalId, role, approvedAt}'

KEY="restore-release-$(date -u +%Y%m%d%H%M%S)"
show "curl -X POST \"\$API/orgs/$ORG/releases/$RID/deploy\" -d '{\"idempotencyKey\":\"$KEY\"}'"
json POST "/orgs/$ORG/releases/$RID/deploy" "$(jq -cn --arg k "$KEY" '{idempotencyKey: $k}')" | jq '{releaseId, attempt}'

show "curl \"\$API/orgs/$ORG/releases/$RID\"   # until the live version is observed"
settled() {
  RELEASE="$(api GET "/orgs/$ORG/releases/$RID")"
  echo "$RELEASE" | jq -e '.live or (.state | IN("failed", "partial", "recovery_required"))' >/dev/null
}
poll 900 3 settled
echo "$RELEASE" | jq '{status, live, health, deployments: [.deployments[] | {workerName, url}]}'
[ "$(echo "$RELEASE" | jq -r .live)" = "true" ] || exit 1
for URL in $(echo "$RELEASE" | jq -r '.deployments[].url // empty'); do
  show "curl $URL/version"
  curl -sS "$URL/version"
  echo
done
