# @commonforge-org/demo-agents

Three agent sessions that work on the "Demo Client / Customer Portal" project at the same time,
through the real CommonForge task protocol (PRD §14.4, plan §C.1 rows 5–9, AT-05, AT-07).

| Agent | Task(s) | What it does | Demo beat |
|---|---|---|---|
| agent-1 (developer) | one task writing `api`, `website`, `requirements`, reading `brand-assets` (R2) | Step 1 adds `breakdown { gross, discount }` to `GET /quote` and renders it, with a view test under the shared anchor. It submits `api` and `website`. The trusted gate then **fails** the strict `/quote` contract (`$.breakdown is not declared in the contract`). Step 2 is a follow-up agent run that declares `breakdown` in `requirements/contracts/quote.schema.json` and submits `requirements`. The gate **passes**. | Multi-resource Change (one task, three candidates). Contract failure, then the fix. |
| agent-2 (client edition) | website only (`readMounts: []`) | Adds a "what the price covers" note, with its view test under the **same anchor**. | Same-file textual conflict with agent 1 (`tests/quote-view.test.ts`). |
| agent-3 (brand/docs) | one task writing `website` + `requirements` (Git) and `brand-assets` (R2) | Regenerates the logo in violet with the fixture generator, updates `styles.css` and requirements R4.2. The harness uploads the same PNG to the task's R2 asset workspace through the lease-only asset API (`stage` → `upload` → `commit` → freeze), with the same lease. | Logo/asset change, with both copies identical in Git and R2. |

## How a run works

1. **Setup (owner).** The orchestrator uses the owner's `cforge login` session (read from
   `CFORGE_CONFIG_DIR` or the default cforge config dir). It creates one task per agent with
   `POST /api/orgs/:org/projects/:pid/tasks` and explicit `readMounts` (agent 1: `brand-assets`;
   agents 2 and 3: none), then waits until the tasks are provisioned.
2. **Start (within 2 s).** All agents start in the same tick. Each start takes the task lease,
   so the API records `task.started`. The pipeline then runs:
   `cforge checkout <task> <dir> --json` (asset mounts are downloaded with the lease through
   `GET /api/tasks/:id/assets/file`) → agent CLI (one or more phases) →
   `cforge submit --mount … --commit … --tool … --json`, which pushes, freezes and records
   `task.candidate_frozen`.
3. **Gate (agent 1).** By default (`--gate api`), the gate creates a proposal from the task's
   frozen candidates, waits for `prepared`, and calls `POST …/integrate`. It reads the outcome from
   `proposal.integrated` / `proposal.integration_failed` and from the proposal's integration
   record. `--gate local` instead runs the same `/quote` contract check on the agent's workspace,
   for rehearsal only.
4. **Conflict probe.** For every resource that two agents submitted, the harness runs
   `git merge-tree --write-tree` on their submitted commits, fetched from the local mounts into a
   scratch repo.
5. **Evidence.** `GET /api/orgs/:org/events` is read and written out:
   - `evidence/concurrency.json`: the AT-05 timestamps as **recorded by the API**, the overlap
     window and the launch spread.
   - `evidence/demo-run.json`: the full report, including the gate attempts, conflicts, the asset
     manifest, per-phase agent output, cost and logs.

`evidence/dry-run-sample/` holds the output of a dry run against the fake stack. It is labelled
`DRY-RUN` and is **not** live evidence.

## Running it

```sh
pnpm build
cforge login --email you@example.com          # the owner session, against the target API
node apps/demo-agents/dist/main.js \
  --api-url https://<worker> --org <orgId> --project <projectId> \
  [--agents 1,3] [--client-edition off|edition|task-fallback] [--gate api|local] \
  [--model sonnet] [--budget-usd 3] [--step-timeout-min 5] [--retries 1] \
  [--cli 3=codex --allow-codex] [--dry-run] [--run-dir <dir>] [--evidence-dir <dir>]
node apps/demo-agents/dist/main.js --help      # pre-flight: proves the command line parses
```

Run it from the repository root, so a relative `--evidence-dir` lands where you expect. With pnpm,
`pnpm --filter @commonforge-org/demo-agents demo -- …` also works: pnpm 12 passes the literal `--`
through, and the orchestrator ignores a leading `--`. Relative paths then resolve under
`apps/demo-agents/`.

- **Agents.** Without `--client-edition`, agents 1 and 3 run.
  - `--client-edition edition` runs agent 2 through a client Workspace Edition (Task 21,
    `src/edition.ts`). Before the clock starts the owner finds or creates the website edition
    (fixtures/README.md policy), publishes a fresh build and grants it to the client
    (`--client-config-dir`, the client's own `cforge login`; without it the owner plays the
    client). The client starts an update and downloads the edition ZIP into
    `<run-dir>/agent-2/ws/website/`: no git, no lease, no api source. The agent edits it, the
    client sends back a partial ZIP of the changed files, and the server turns it into a
    candidate in a fresh task workspace and a proposal. An edition return is a client upload,
    not a leased task, so agent 2 is left out of the AT-05 `task.started` overlap evidence and
    out of the local conflict probe (its conflict with agent 1 shows at integration).
  - `--client-edition task-fallback` runs agent 2 as a website-only task (no api source, no
    requirements). The report labels it as a stand-in.
- **Defaults.** Model `sonnet`, 5-minute timeout per agent step, and one retry per failed step. A
  retry first resets the step's writable mounts (`git reset --hard HEAD && git clean -fd`, with
  hooks, signing and ssh disabled).
- **Run dir.** It defaults to a new directory under `$TMPDIR`. A `--run-dir` inside the
  repository checkout, or inside any git work tree, is refused: agent CLIs run there and must not
  see repo files such as `apps/worker/.dev.vars` or parent `CLAUDE.md` context.
- **Evidence.**
  - A live run writes `<repo>/evidence/{concurrency,demo-run}.json`.
  - A `--dry-run` defaults to `<repo>/evidence/dry-run/`.
  - A dry run never overwrites a `concurrency.json` whose `mode` is `live`.
  - The AT-05 start figure is `apiStart`: the spread of the API's `task.started` records over
    every task. `launch` is the orchestrator's own clock, and is diagnostic only.
- **`--dry-run`** replaces the agent CLI with deterministic scripted edits that match the prompts
  (`src/dry-run.ts`). The evidence is labelled `mode: "dry-run"`.
- **Project shape.** The project must mount `website`, `api`, `requirements` (Artifacts) and
  `brand-assets` (R2), as in `fixtures/README.md`.

### Live gate prerequisite: the `/quote` contract policy

`--gate api` relies on the integration runner checking the server-owned contract. Set it once as
owner, filling in the resource ids from `cforge project show <projectId> --json`:

```sh
curl -sS -X PUT "$API/api/orgs/$ORG/projects/$PROJECT/policy" \
  -H "authorization: Bearer $OWNER_SESSION" -H "content-type: application/json" -d @- <<'JSON'
{
  "checks": [
    { "checkId": "quote-contract", "mountName": "website", "command": "pnpm exec vitest run tests/quote-contract.test.ts", "timeoutSeconds": 300 }
  ],
  "contracts": [
    {
      "contractId": "quote",
      "version": "1",
      "producerResource": "<api resourceId>",
      "consumerResource": "<website resourceId>",
      "schema": { "resourceId": "<requirements resourceId>", "path": "contracts/quote.schema.json" },
      "producerOutput": { "mountName": "api", "command": "node scripts/quote-sample.ts" }
    }
  ],
  "rules": ["GET /quote responses must match requirements/contracts/quote.schema.json"]
}
JSON
```

Both entries use commands on the runner's allowlist (no shell, no quotes; `apps/runner/src/commands.ts`).
If the project policy already has other fields (`release`, `preview`, `publishRoles`, `approvalRoles`),
send them too: a `PUT` replaces the whole policy.

- **`checks`: the fixture's own contract test**, in the website mount. It imports the sibling api
  source (`../api/src/app.ts`, which needs `hono` from `api/node_modules`) and validates real
  `/quote` responses against `../requirements/contracts/quote.schema.json`. The runner installs
  every mount's dependencies from its committed `pnpm-lock.yaml` before the checks
  (`apps/runner/README.md`, "Dependency installs"), so this check works even though checks run
  with no network in the Sandbox.
- **`contracts`: the runner's trusted contract check.** `node scripts/quote-sample.ts` prints one
  quote priced by the api mount's `src/pricing.ts` (Node's TypeScript stripping, no install).
  The runner reads the schema from git, never from the checkout, and validates in its own process.
  `scripts/quote-sample.ts` is part of `fixtures/api` from this follow-up on. A project whose
  canonical api repo was seeded before that needs the file merged first (an ordinary task and
  proposal), or the policy without the `contracts` entry: the check alone gives the same
  fail-then-pass.

Attempt 1 fails because the quote now carries `breakdown` and the strict schema does not declare it
(both the check and the contract fail; the integration reports `contract_failed`). Attempt 2
passes once the requirements candidate declares `breakdown`.

### Rehearsal checklist (before the recording)

1. `pnpm --filter @commonforge-org/demo-agents test` passes (dry-run against the fake stack).
2. A dry run against the deployed Worker:
   `node apps/demo-agents/dist/main.js … --dry-run --gate local --client-edition task-fallback`.
   This checks provisioning, leases, checkout, submit, the asset upload and the events. Evidence
   goes to `evidence/dry-run/`.
3. The same dry run with `--gate api`, once the policy above is set and the runner is up.
   - Attempt 1 must fail and attempt 2 must pass.
   - The attempt-1 candidates must stay `frozen`/`prepared`, so that the second proposal can
     include them.
4. A live run with real agents and `--gate local`, then a live run with `--gate api`. The last one
   writes `evidence/concurrency.json`: check `apiStart.withinTwoSeconds` and
   `overlap.allConcurrent`.

## Security

- **Agent cforge processes get only their task lease.** Each one gets exactly: `PATH`, a private
  `HOME` with a git identity, a private `CFORGE_CONFIG_DIR`, `CFORGE_API_URL`,
  `CFORGE_LEASE_TOKEN` and `CFORGE_LEASE_API_URL`. The owner session stays in the orchestrator
  process. Git tokens are minted per request by the cforge credential helper and are never stored.
- **The model process gets no CommonForge credential at all**, not even the lease. The harness
  runs checkout and submit around it. Its environment is an **allowlist**:
  - always: `PATH HOME USER LOGNAME SHELL LANG LANGUAGE LC_* TERM COLORTERM NO_COLOR TZ TMPDIR XDG_*`,
    plus proxy and CA variables;
  - claude also gets `ANTHROPIC_*` and `CLAUDE_*`;
  - codex also gets `OPENAI_*`.
- **claude (default)** runs in the workspace root as:

  ```
  claude -p <prompt> --restricted --tools Read,Edit,Write,Glob,Grep
    --allowedTools Read Edit Write Glob Grep --permission-mode dontAsk --permission-prompts none
    --strict-mcp-config --no-session-persistence --output-format json --max-budget-usd <n> --model sonnet
  ```

  - `--restricted` removes Bash, code-running tools and WebFetch, ignores user, project and local
    settings, and confines the file tools to the working directory.
  - `dontAsk` denies anything not in `--allowedTools`. No permission mode auto-approves shell
    commands.
- **Agent 3** also gets `Bash`, plus exactly one allowed command, matched with no wildcard:
  `Bash(node <runDir>/tools/brand-logo.mjs --color=#7c3aed)`. `brand-logo.mjs`
  (`src/logo-tool.ts`) is a 0444 wrapper outside the workspace. It:
  - accepts only `--color=#rrggbb`;
  - always writes `<cwd>/website/public/logo.png`, and refuses a symlinked target or a
    `website/public` that resolves outside the cwd;
  - runs a 0444 copy of the fixture generator.

  A live probe confirmed that other commands (`ls`, `mkdir`, the wrapper with a path) are
  denied.
- **codex is opt-in.** It needs `--cli N=codex` **and** `--allow-codex`, and prints a warning at
  start. It runs as:

  ```
  codex exec --sandbox workspace-write --cd <root> --skip-git-repo-check --ephemeral
    --ignore-user-config --ignore-rules --color never -c mcp_servers={} -c approval_policy="never"
    -c shell_environment_policy.inherit="core" <prompt>
  ```

  It runs with `CODEX_HOME` set to a throwaway 0700 directory holding only a copy of `auth.json`,
  deleted afterwards. No operator config, hooks, plugins or MCP servers load. Writes are confined
  to the workspace, and there is no network. **Remaining caveat:** the codex sandbox does not
  confine reads, so any file the user can read is readable.
- **The local contract gate** runs agent-written code (`api/src/pricing.ts`) in a child `node` with
  a PATH-only environment and a throwaway `HOME`. Use it for rehearsal only; the trusted gate is
  the integration runner.

## Tests

`pnpm --filter @commonforge-org/demo-agents test` runs the orchestrator with dry-run agents
against the CLI's fake CommonForge (`apps/cli/test/fake-commonforge.ts`), extended in
`test/demo-fake.ts`. The fake serves real bare git repositories behind a token-checking
smart-HTTP front. The tests drive the **built** `cforge` binary as a subprocess, exactly as a live
run does. They prove:

- the overlap (AT-05), from the fake API's event timestamps;
- the contract failure, then the fix;
- the AT-07 textual conflict;
- both logo copies;
- that the `brand-assets` R2 mount is checked out with the lease alone (agents 1 and 3), and
  never reaches agent 2;
- that agents hold only their lease, with no owner session or git token anywhere under the run
  directory.

No model is called in the tests.

## Known gaps

- **Agent 2 in edition mode is not part of the AT-05 overlap evidence** (no task lease, so no
  `task.started`); its report entry carries the edition, session, return and proposal ids.
