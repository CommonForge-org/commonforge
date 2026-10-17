#!/usr/bin/env bash
# Real Git + Worker + Node execution + browser. Task-owned state and no cloud credentials.
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo"
g1_artifacts="$repo/.g1-artifacts/local-ci"
mkdir -p "$g1_artifacts"
chmod 700 "$g1_artifacts"
export PORT="${PORT:-8899}" PREVIEW_PORT="${PREVIEW_PORT:-8900}"
setsid scripts/dev-real-worker.sh >"$g1_artifacts/launcher.jsonl" 2>"$g1_artifacts/worker.log" &
g1_pid=$!
trap 'kill -- -"$g1_pid" 2>/dev/null || true; wait "$g1_pid" 2>/dev/null || true' EXIT INT TERM
for ((g1_wait=0;g1_wait<120;g1_wait++)); do
  if rg -q '"mode":"real-local-worker"' "$g1_artifacts/launcher.jsonl"; then break; fi
  if ! kill -0 "$g1_pid" 2>/dev/null; then echo 'G1 real-local startup failed; inspect private .g1-artifacts/local-ci/worker.log' >&2; exit 1; fi
  sleep 1
done
g1_operator=$(node --input-type=module -e 'import{readFileSync}from"node:fs";const lines=readFileSync(process.argv[1],"utf8").split("\n");const s=lines.find(l=>l.startsWith("{\"mode\":\"real-local-worker\""));if(!s)process.exit(1);process.stdout.write(JSON.parse(s).operatorFile)' "$g1_artifacts/launcher.jsonl")
g1_ready=0
for ((g1_wait=0;g1_wait<120;g1_wait++)); do
  if curl --fail --silent --max-time 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then g1_ready=1; break; fi
  if ! kill -0 "$g1_pid" 2>/dev/null; then break; fi
  sleep 1
done
if [ "$g1_ready" != 1 ]; then echo 'G1 real Worker did not become ready; inspect the task-private worker log' >&2; exit 1; fi
pnpm --filter @commonforge-org/runner exec tsx src/g1-worker-rehearsal.ts "$g1_operator" "$g1_artifacts/worker.log" --preview >"$g1_artifacts/report.json"
g1_session=$(node --input-type=module -e 'import{readFileSync}from"node:fs";import{join}from"node:path";process.stdout.write(join(JSON.parse(readFileSync(process.argv[1],"utf8")).root,"owner-session.json"))' "$g1_artifacts/report.json")
pnpm --filter @commonforge-org/runner exec tsx src/g1-pending-review.ts "$g1_session" "$g1_operator" >"$g1_artifacts/review-report.json"
COMMONFORGE_NATIVE_REQUIRE_PREVIEW=1 COMMONFORGE_NATIVE_REVIEW_REPORT="$g1_artifacts/review-report.json" COMMONFORGE_NATIVE_URL="http://127.0.0.1:$PORT" COMMONFORGE_NATIVE_LOG="$g1_artifacts/worker.log" COMMONFORGE_NATIVE_SESSION_FILE="$g1_session" pnpm --filter @commonforge-org/web exec playwright test -c playwright.native.config.ts
node --input-type=module - "$g1_artifacts/report.json" <<'JS'
import {readFileSync,writeFileSync} from 'node:fs';
const path=process.argv[2],report=JSON.parse(readFileSync(path,'utf8'));
delete report.root;delete report.workerUrl;
report.gates.browserOwnerJourney='pass';
writeFileSync(path,JSON.stringify(report,null,2)+'\n');
JS
printf 'G1 real-local API and browser checks passed. Report: .g1-artifacts/local-ci/report.json\n'
