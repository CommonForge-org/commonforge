#!/usr/bin/env bash
# Runs ONE demo-agents orchestrator for scene 4 and timestamps its stderr, line by line, into
# public/clips/orchestrator.log ("<epoch ms> <line>"); `pnpm casts` then splits that log into one
# asciinema cast per agent lane. Only the orchestrator's `agent-N: …` lines are live; the agents
# themselves run non-interactively and their output lands in per-step logs under the run dir.
#
#   pnpm capture:terminals                      the orchestrator, configured from the environment
#   pnpm capture:terminals --dry-run            the orchestrator with --dry-run (scripted edits; rehearsal)
#   pnpm capture:terminals -- <command> [args]  any command instead (rehearsals, tests)
#
# Only a live orchestrator run writes to public/clips/. A rehearsal (any command after `--`, or an
# orchestrator with --dry-run, also via CAPTURE_DEMO_ARGS) defaults to video/.capture/rehearsal/,
# so rehearsal lines can never become scene 4 casts by accident.
#
# Environment for the default command (see README "Capture day"):
#   CAPTURE_BASE_URL, CAPTURE_OWNER_SESSION_FILE, CAPTURE_CLIENT_SESSION_FILE (required)
#   CAPTURE_ORG, CAPTURE_PROJECT (default: seed-output.json)
#   CAPTURE_RUN_DIR (default: a new temp dir; must be outside any git work tree)
#   CAPTURE_EVIDENCE_DIR (default: <repo>/evidence/demo-runs/<UTC timestamp>; a dry run:
#     video/.capture/rehearsal/evidence/<UTC timestamp>)
#   CAPTURE_DEMO_ARGS (extra orchestrator flags, e.g. "--model sonnet --budget-usd 3")
#   CAPTURE_TERMINALS_LOG (default: public/clips/orchestrator.log; rehearsals:
#     video/.capture/rehearsal/orchestrator.log)
# An existing log is kept as orchestrator.<UTC timestamp>.log, never overwritten.
set -euo pipefail

VIDEO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(cd "$VIDEO_DIR/.." && pwd)"
REHEARSAL_DIR="$VIDEO_DIR/.capture/rehearsal"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
RUN_DIR=""
EVIDENCE_DIR=""
REHEARSAL=0
DRY_RUN=""

case "${1:-}" in
  --) shift; REHEARSAL=1 ;;
  --dry-run) shift; DRY_RUN="--dry-run"; REHEARSAL=1 ;;
esac
[ "$#" -gt 0 ] && REHEARSAL=1
case " ${CAPTURE_DEMO_ARGS:-} " in *" --dry-run "*) REHEARSAL=1 ;; esac

if [ "$#" -eq 0 ]; then
  seed() { node -e 'try { const v = require(process.argv[1])[process.argv[2]]; if (v) process.stdout.write(String(v)); } catch {}' "$VIDEO_DIR/seed-output.json" "$1"; }
  : "${CAPTURE_BASE_URL:?set CAPTURE_BASE_URL to the live Worker origin}"
  : "${CAPTURE_OWNER_SESSION_FILE:?set CAPTURE_OWNER_SESSION_FILE to the owner cforge session.json}"
  : "${CAPTURE_CLIENT_SESSION_FILE:?set CAPTURE_CLIENT_SESSION_FILE to the client cforge session.json}"
  ORG="${CAPTURE_ORG:-$(seed orgId)}"
  PROJECT="${CAPTURE_PROJECT:-$(seed projectId)}"
  if [ -z "$ORG" ] || [ -z "$PROJECT" ]; then
    echo "capture-terminals: set CAPTURE_ORG and CAPTURE_PROJECT or run the seeder first" >&2
    exit 2
  fi
  MAIN="$REPO/apps/demo-agents/dist/main.js"
  if [ ! -f "$MAIN" ]; then
    echo "capture-terminals: $MAIN is missing; run \`pnpm build\` at the repo root first" >&2
    exit 2
  fi
  RUN_DIR="${CAPTURE_RUN_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/commonforge-demo-XXXXXX")}"
  if [ "$REHEARSAL" -eq 1 ]; then
    EVIDENCE_DIR="${CAPTURE_EVIDENCE_DIR:-$REHEARSAL_DIR/evidence/$STAMP}"
  else
    EVIDENCE_DIR="${CAPTURE_EVIDENCE_DIR:-$REPO/evidence/demo-runs/$STAMP}"
  fi
  # the orchestrator reads the owner session from CFORGE_CONFIG_DIR
  CFORGE_CONFIG_DIR="$(cd "$(dirname "$CAPTURE_OWNER_SESSION_FILE")" && pwd)"
  export CFORGE_CONFIG_DIR
  CLIENT_DIR="$(cd "$(dirname "$CAPTURE_CLIENT_SESSION_FILE")" && pwd)"
  # shellcheck disable=SC2086 # CAPTURE_DEMO_ARGS is a list of flags
  set -- node "$MAIN" --api-url "$CAPTURE_BASE_URL" --org "$ORG" --project "$PROJECT" \
    --agents 1,2,3 --client-edition edition --client-config-dir "$CLIENT_DIR" --gate api \
    --run-dir "$RUN_DIR" --evidence-dir "$EVIDENCE_DIR" $DRY_RUN ${CAPTURE_DEMO_ARGS:-}
fi

if [ "$REHEARSAL" -eq 1 ]; then
  LOG="${CAPTURE_TERMINALS_LOG:-$REHEARSAL_DIR/orchestrator.log}"
  echo "capture-terminals: rehearsal; logging to $LOG (never final footage)" >&2
else
  LOG="${CAPTURE_TERMINALS_LOG:-$VIDEO_DIR/public/clips/orchestrator.log}"
fi
LOG_DIR="$(dirname "$LOG")"
RUN_JSON="$LOG_DIR/orchestrator-run.json"

mkdir -p "$LOG_DIR"
if [ -e "$LOG" ]; then
  KEPT="$LOG_DIR/orchestrator.$STAMP.log"
  [ -e "$KEPT" ] && KEPT="$LOG_DIR/orchestrator.$STAMP.$$.log"
  mv "$LOG" "$KEPT"
  echo "capture-terminals: kept the previous log as $KEPT" >&2
fi
: >"$LOG"

write_run() {
  local finished="$1" code="$2"
  shift 2
  node -e '
    const [file, started, finished, code, runDir, evidenceDir, log, ...command] = process.argv.slice(1);
    require("fs").writeFileSync(file, JSON.stringify({
      startedAt: started, finishedAt: finished || null, exitCode: code === "" ? null : Number(code),
      log, runDir: runDir || null, evidenceDir: evidenceDir || null, command,
    }, null, 2) + "\n");
  ' "$RUN_JSON" "$STARTED" "$finished" "$code" "$RUN_DIR" "$EVIDENCE_DIR" "$LOG" "$@"
}
STARTED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
COMMAND=("$@")
write_run "" "" "${COMMAND[@]}"
echo "capture-terminals: logging stderr of: ${COMMAND[*]}" >&2
[ -n "$RUN_DIR" ] && echo "capture-terminals: run dir $RUN_DIR (step logs in $RUN_DIR/logs)" >&2

# Each stderr line is stamped on arrival, appended to the log and echoed to this terminal.
STAMPER='
  const rl = require("readline").createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => { process.stdout.write(`${Date.now()} ${line}\n`); process.stderr.write(`${line}\n`); });
'
set +e
{ "${COMMAND[@]}" 2>&1 1>&3 3>&- | node -e "$STAMPER" >>"$LOG"; } 3>&1
STATUS=("${PIPESTATUS[@]}")
set -e
CODE="${STATUS[0]}"
[ "$CODE" -eq 0 ] && [ "${STATUS[1]}" -ne 0 ] && CODE="${STATUS[1]}"
write_run "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$CODE" "${COMMAND[@]}"
echo "capture-terminals: exit $CODE; log $LOG" >&2
exit "$CODE"
