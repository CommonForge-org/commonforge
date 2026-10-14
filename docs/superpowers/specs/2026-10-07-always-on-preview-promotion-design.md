# Always-on staging and promotion to production: design

**Status:** approved in conversation on 2026-10-07; this document is the written record.
**Scope:** clients landing tasks in a long-lived staging environment, per-task promotion to
production with a review gate (path levels, a migration veto, a risk classifier, developer
approval), and how staging and its demo data are kept.
**Deadline:** all phases before the competition deadline (2026-10-14 23:59 PDT), with a cut line at
the end of 2026-10-11 (§11).

## 1. Why

CommonForge should let clients with AI agents work on their own projects, with developer oversight
only for the changes that are genuinely risky. Today a client cannot move anything forward alone:

- Client work arrives through edition returns, and protected paths **block** a change outright
  (`packages/core/src/edition.ts:140-143`); no one can approve it through.
- Integrate, preview and accept are owner/developer actions; previews are per proposal, built on
  request, and expire (`apps/worker/src/services/previews.ts`).
- Publishing is gated by one role list per project (`publishRoles`, default owner), whatever the
  release contains.
- A preview app's data is a hard-coded, empty, in-memory KV (`apps/runner/src/preview-host.ts:96-102`).

The target experience, in the owner's words: staging is a sandbox copy of production (code,
database, API, everything). Clients may change anything there, including database migrations and
API changes. If it breaks it is only staging and can be rolled back. When a change is ready, the
client promotes that task to production; simple changes go straight through, risky ones wait for a
developer, who may first rework the task on staging.

## 2. Decisions

| Topic | Decision |
|---|---|
| What "staging" is | A long-lived deployed app built from **main plus every landed, unpromoted task**, in landing order (approach 1: derived, not its own history) |
| Production line | `main` stays exactly what production runs; a task enters `main` only when it is promoted |
| Unit of work | A task. Its change set is the unit of landing, revision, rollback and promotion |
| Landing | Free for the task's client: submitting a task in a staging-mode project lands it. No developer step |
| Checks on staging | Run and shown, but do not block landing. Required checks block promotion |
| Staging data | **Demo data only**: own D1/KV, migrations plus a seed kept in the repo. Production data never enters staging |
| Side effects | Webhook and email URLs in staging point at a capture sink. Nothing reaches real providers |
| Staging URL | Unlisted but public on workers.dev (`cfapp-<org>-<name>-staging`), like production `cfapp-*` Workers |
| Promotion granularity | Per task (with its unpromoted dependencies), not staging as a whole |
| Promotion gate | Path levels `self` / `classify` / `developer`; a deterministic migration veto; a risk classifier that can only clear; fail closed |
| Classifier | A port with two adapters, Jev (TypeSafe) and OpenAI Decisions API; Jev is the live one first |
| Approval lifetime | Bound to the promotion set's change-set hashes, not to `main`; survives unrelated promotions |
| PRD reversal | PRD v0.2 :628 says "no automatic low-risk publish engine is in P0". The owner reversed this on 2026-10-07: `self` and `classifier` clearances publish without a developer |
| Previews | In staging mode, staging replaces per-proposal previews. Other projects keep previews unchanged |
| Editions | Staging-mode projects use client tasks instead of the edition ZIP round trip. Editions remain for other projects |
| Production rollback | Unchanged: restore an earlier version and publish it. Taking one task out of production is a new task that reverts it |
| Video | The client scenes are rewritten around three tasks (§12) if the work is verified live by the cut line |

## 3. Turning it on

An owner switches **staging mode** on per project (the presence of a valid `staging` section in the
project policy, §6). With it off, every flow behaves as today. The demo org's project turns it on.

## 4. Task lifecycle and roles

### Client tasks

A client starts a task from the web UI or with `cforge`. Their agent gets a task workspace exactly
as developer agents do (lease, `-tasks` repo, short-TTL tokens, freeze on submit). The workspace
covers every folder the owner opened to that client, **protected paths included**. Secret patterns
(`**/.env*`) and the always-protected segments (`.git`, `.commonforge`, `.vibecontrol`) are still
excluded.

A new task's workspace is seeded from the **current staging revision**, not from `main`, so the
agent sees every landed task. The task's change set is the difference between that starting point
and its frozen candidate.

### States

| State | Meaning |
|---|---|
| Working | The agent is editing; snapshots can be saved and resumed |
| Checking | Submitted: being merged onto staging, built, deployed; checks run |
| **In staging** | Live on the staging site with the other landed tasks |
| Couldn't land | Conflicts with staging, or the build, deploy or health check failed. Reason shown; previous staging kept |
| Pending approval | Promotion requested and the gate (§7) needs a developer or owner |
| Promoting | Being merged into `main` and released to production |
| Couldn't go live | The promotion build, checks or production release failed. The task stays in staging; reason shown |
| **Live** | In production |
| Rolled back | Removed from staging. Its change set is kept and it can be landed again |

**Landing** needs a clean merge onto the current staging, a successful build and deploy, and a
passing `/version` health check on staging. Check results are recorded on the task; failing checks
do not prevent landing.

**Revising.** The client or a developer saves a new revision of the same task (a new candidate in
the same task workspace). Staging is rebuilt with it. This is how a developer "fixes it on staging"
before promoting. A new revision invalidates any clearance for that task (§7).

### Who can do what

| Action | Client | Developer | Owner | Viewer |
|---|---|---|---|---|
| Start a task, work on it with an agent | ✓ | ✓ | ✓ | |
| Land, revise, roll back from staging | own tasks | any | any | |
| Request promotion | own tasks | any | any | |
| Promote without approval | when the gate allows | when the gate allows | always | |
| Approve a pending promotion | | ✓ | ✓ | |
| Reset staging data to the seed | ✓ | ✓ | ✓ | |
| Edit the `staging` policy section | | | ✓ | |
| Open staging, see task states | ✓ | ✓ | ✓ | ✓ |

"Own tasks" means tasks the client started. An owner's promotion is recorded as a `developer`
clearance by the owner.

**Authorization change.** In staging-mode projects, clients may create tasks and hold leases on task
workspaces for the folders opened to them. They still never write canonical repos or refs, including
the staging ref. The AT-16/17 security tests change from "clients never write" to exactly this rule.

## 5. Building staging

### Composition

The ledger records each **staging revision** as `{ mainSha per resource, landings: [{ taskId,
changeSetHash }...] }` in landing order. Every land, revision, rollback and promotion creates a new
staging revision. Builds are serialized per project; while one runs, further requests coalesce so
only the newest composition is built next.

### Build

A runner job `staging-build` checks out `main` and three-way merges each landing's change set onto
it in order, then pushes the result to `refs/commonforge/staging` on the canonical repos. Only signed
runner jobs may write that ref; `main` is never touched. If the newly landing task does not merge
cleanly, it becomes "Couldn't land" with the conflicting files listed, and the previous staging
revision stays current.

### Dependencies between tasks

When task B lands, it is recorded as **depending on** every earlier unpromoted landing that changed
any file B also changes. Dependencies that are not visible in files (B uses a component A added in
another file) are caught by the promotion build (§7 step 2), which names the likely task.

### Deploy

`staging-deploy` reuses the release pipeline (release-build, release-deploy, derived `/version`
health check) against target `cfapp-<org>-<name>-staging`, with the staging environment (§6) and no
publish approval. A failed deploy or health check keeps the previous staging live. Staging lives on
its own workers.dev origin, separate from the app, the API, previews and production.

## 6. Staging environment and demo data

### Resources

Staging has its own D1 databases and KV namespaces, created through the existing
`POST deploy-resources` and named with a `-staging` suffix. Production bindings and secrets are never
placed in the staging environment. Outbound webhook and email URL variables point at the
**capture sink** (§8).

### Policy section

```ts
staging?: {
  environment: { [targetId]: { vars?, kv?, d1? } }   // staging-only bindings
  migrations?: { d1Binding: string; mountName: string; dir: string }   // e.g. api, migrations/
  seed?: { mountName: string; d1?: string[]; kv?: { binding: string; file: string }[] }
  promotion: {
    rules: { paths: string[]; level: "self" | "classify" | "developer" }[]
    classifier: { provider: "jev" | "openai-decisions" | "none"; threshold: number }  // default 0.9
  }
}
```

Owner-only, like the rest of the project policy; saving bumps `policy_revision`.

### Migrations, seed and reset

- Every staging deploy applies migrations with `wrangler d1 migrations apply` before the code goes
  live.
- **Reset** recreates the staging resources, applies all migrations from scratch, then loads the
  seed (SQL files into D1, JSON files into KV). Clients, developers and owners can trigger it.
- **Automatic reset:** before each deploy the list of migrations already applied to staging is
  compared with the new staging's migration list. If the applied list is no longer a prefix of it
  (a migration was removed by a rollback, edited by a revision, or reordered by a promotion), staging
  resets first, since an applied migration cannot be undone in place. The UI says the data was reset
  and why.

### Demo fixture changes

The Customer Portal's `api` gains a D1 `contacts` table, `migrations/0001_init.sql` and a `seed/`
folder. The demo project's policy fills in `staging`: website copy and CSS are `self`, api code and
migrations are `classify`, wrangler config, package manifests, lockfiles and CI are `developer`.

## 7. Promotion

### Levels

A changed path takes the level of the first matching rule; unmatched paths are `developer`. A
promotion's level is the strictest level across every path in the promotion set.

### Steps

1. **Request.** The client clicks Promote on a task. If it depends on unpromoted tasks, the UI lists
   them and the promotion set includes them.
2. **Promotion build.** `promotion-build` (reusing `integrate`) merges the set's change sets onto the
   **current `main`** and runs the build and every required check: the exact combination production
   will run. Failure gives "Couldn't go live" with the reason; an unresolved symbol added by another
   landed task is reported as "probably needs task X".
3. **Migration veto (deterministic).** New migration files are parsed. Only `CREATE TABLE`,
   `CREATE INDEX` and `ALTER TABLE … ADD COLUMN` that is nullable or has a default count as additive.
   Anything else (`DROP`, `RENAME`, `UPDATE`, `DELETE`, any other statement, or a change to an
   existing migration file) forces `developer`. The classifier cannot override the veto.
4. **Classifier** (only for `classify`, only when the veto passed). Input: the task description, the
   changed files with their levels, the diff (capped at 64 KiB; migration SQL always in full) and the
   check results. Typed questions:
   - risk: `low | medium | high`
   - migration: `none | additive | destructive`
   - API change: `none | backward_compatible | breaking`
   - touches auth or payments: `yes | no`

   It clears the promotion only if every answer is the safe one (`low`, `none`/`additive`,
   `none`/`backward_compatible`, `no`) with probability at or above the threshold. An error, a
   timeout (5 s) or provider `none` means `developer`. The provider, model, answers, probabilities
   and an input digest are stored as evidence on the promotion.
5. **Decision.** Cleared promotions proceed. Otherwise the task shows **"Production update pending
   approval"** with a plain-language reason ("changes the database structure"), and developers and
   owners get a Needs-you item with the diff, the level of each path, the classifier's answers and
   the check results. They can Approve or **Send back to staging** (the task returns to In staging
   with their note).
6. **Accept and release.** The clearance (`self`, `classifier` or `developer`) is a typed ledger
   record that satisfies both acceptance and the publish approval; `publishRoles` does not apply in
   staging mode. Acceptance merges the set into `main` through the existing `planCommit`. The release
   then **applies production D1 migrations before deploying code**; a failed migration stops the
   release before any code changes. The automatic code rollback stays as today; it does not undo
   migrations, which is safe for additive ones, and destructive ones always had a developer.
7. **Afterwards.** Staging is rebuilt on the new `main` without the promoted landings.

Promotions are serialized per project through the existing deploy lock.

### Clearance lifetime

A clearance is bound to the promotion set's change-set hashes and the policy revision. It survives
unrelated changes to `main` (the build and checks rerun, nobody approves again). A new revision of
any task in the set voids it. A policy change re-evaluates pending clearances under the new rules; a
`developer` approval is kept only if the set's level did not rise.

## 8. Components and interfaces

### `packages/core` (pure)

- `promotion-level.ts`: `(rules, changedPaths) → { level, perPath: [{ path, level, rule }] }`.
- `migration-lint.ts`: `(previousFiles, nextFiles, sqlByFile) → { kind: "additive" | "destructive",
  offending: [{ file, statement }] }`.
- `staging-schemas.ts`: zod schemas for staging revisions, landings, promotions, clearances and the
  `staging` policy section.

### Ledger (`packages/ledger`, OrgLedger DO)

New records `StagingRevision`, `Landing`, `Promotion`, `Clearance { kind: "self" | "classifier" |
"developer", changeSetHashes, policyRevision, principal, evidenceRef }`. `planCommit` accepts a valid
clearance where it now requires an approval. New conformance scenarios: clearance bound to change
sets, stale change set refused, clearance surviving an unrelated promotion, policy change
re-evaluation.

### Risk classifier port (Worker)

```ts
interface RiskClassifier {
  classify(input: RiskInput): Promise<{
    provider: string; model: string;
    answers: { risk; migration; apiChange; authOrPayments };
    probabilities: Record<string, Record<string, number>>;
  }>;
}
```

Adapters `jev` (live first), `openai-decisions`, `none`, and a fake for tests. API keys live in Worker
secrets only (`JEV_API_KEY`, `OPENAI_API_KEY`), never in policy.

### Worker services and routes

- `services/staging.ts`: land (a client's `submit` in staging mode), revise, roll back, rebuild queue,
  reset.
- `services/promotions.ts`: request, build, gate, approve, send back, execute.
- Routes: `GET /api/projects/:id/staging`, `POST /api/projects/:id/staging/reset`,
  `POST /api/tasks/:id/rollback`, `POST /api/tasks/:id/promote`, `GET /api/promotions/:id`,
  `POST /api/promotions/:id/approve`, `POST /api/promotions/:id/send-back`,
  `GET /api/projects/:id/staging/sent`.
- **Capture sink:** `POST /sink/<token>` on the Worker. It records the request (method, path,
  headers without credentials, body up to 64 KiB) and never forwards anything. Per-project token,
  rate limited, 7-day retention.

### Runner jobs

- `staging-build`: merge the landings onto `main`, push `refs/commonforge/staging`.
- `staging-deploy`: release-build and release-deploy with the staging target, D1 migrations, seed on
  a fresh database.
- `staging-reset`.
- `promotion-build`: `integrate` over the promotion set on `main`.
- `release-deploy` gains a "D1 migrations first" step.

### Web

- **Client:** a Tasks board (Working · In staging · Waiting for approval · Live). Each card offers
  Open in staging, Promote, Roll back, and shows the plain-language state and reason. A staging
  header shows the link, when it last changed, **Reset demo data**, and **Sent from staging** (what
  the capture sink received).
- **Developer:** pending promotions in Needs-you; a review screen with the diff, the level of each
  path, the classifier's answers and confidence, the checks, and Approve / Send back to staging.
- **Owner:** Settings → Policy gains a Staging section. Review levels are an editable table;
  migrations, seed and classifier use forms if time allows, otherwise JSON like Preview and Release.
- `apps/web/src/api/fake.ts` mirrors all of it for fixture mode and the video's dry runs.

### CLI

`cforge` gains client task start in staging-mode projects; `cforge submit` lands. No new commands are
required for the demo.

## 9. Errors

| Failure | Behaviour |
|---|---|
| Staging build, deploy or health check fails | Previous staging stays live; task "Couldn't land" with the reason; transient 503s retry under the existing policy |
| Several lands queued | Rebuilds coalesce; only the newest composition is built |
| Classifier error, timeout, low confidence | `developer`; never fails open |
| `main` moved during a promotion | Promotion build reruns on the new `main`; the clearance survives (§7) |
| Production migration fails | Release stops before code changes; task "Couldn't go live", stays in staging |
| Policy changed while a promotion is pending | Pending clearances re-evaluated (§7) |
| Capture sink abuse | Per-project token, body cap, rate limit, 7-day retention |

## 10. Tests

- **Core:** table-driven tests for promotion levels and migration linting (including `ADD COLUMN …
  NOT NULL` without a default, multi-statement files, comments, edited existing files).
- **Ledger:** the conformance scenarios in §8.
- **Worker:** service and route tests with the fake runner and fake classifier. Security tests: a
  client never writes a canonical ref or the staging ref; a client cannot approve, or self-promote a
  `developer`-level set; the classifier fails closed; clearances are bound to change sets and policy
  revision.
- **Runner:** real-git tests for staging merge order, conflicts, dependency detection, the promotion
  build, and the migrations-first release step.
- **Web:** component tests; a Playwright fixture journey through the three demo tasks.
- **Live:** the CI live e2e on `commonforge-ci-*` gains the three tasks with real D1 migrations and a
  real staging Worker; a live Jev test runs when `JEV_API_KEY` is present.

## 11. Delivery

Each phase merges to `main` on its own and stays inert unless a project has staging mode on.

| Phase | Target | Contents |
|---|---|---|
| 1 | Oct 7–8 | Core schemas and pure logic; ledger records; client task authorization; staging build and deploy with D1 migrations, seed, reset, capture sink; land and roll back |
| 2 | Oct 8–9 | Promotion build, levels, migration veto, self clearance, developer approval and send back; migrations-first releases |
| 3 | Oct 9–10 | Classifier port, Jev adapter (live), OpenAI Decisions adapter; Tasks board, review screen, staging header; D1 fixtures |
| 4 | Oct 10–11 | CI live e2e; a freeze run with the three tasks; Policy → Staging forms |
| **Cut line** | end of Oct 11 | Anything not verified live stays off; the video keeps the current client scenes |
| Video and submission | Oct 12–13 | Re-script and re-capture the client scenes; submit on the 13th |

**Owner prerequisites:** a Jev API key in `apps/worker/.dev.vars` and the CI secrets (`JEV_API_KEY`);
an OpenAI key (`OPENAI_API_KEY`) only if the second adapter is to be tested live.

**Scheduling conflict:** `claude/folders-uploads` (spec, plan, LFS spike; not on `main`) competes for
the same days. This spec assumes it moves after the deadline unless the owner says otherwise.

## 12. Demo story (client scenes)

1. "Update the home page heading": lands in staging; the client promotes it (`self`); it is live.
2. "Add a phone field to the contacts": API code and an additive migration. It lands; Promote; the
   classifier is asked (its answers on the developer's review screen). The live classifier has
   declined it in every run (risk medium), so it goes to a developer, who approves; production's
   database is migrated before the code goes live. (Corrected 2026-10-12, ruling P42-4: the owner
   chose to show what the live classifier does; earlier text said the classifier clears it.)
3. "Rename the contact email column": the destructive-migration veto forces `developer` without asking
   the classifier; the client sees the promotion waiting for approval; the developer sends it back to
   staging with a note (add a column instead), and the client's task is rolled back or revised.
   (Corrected 2026-10-12: the web app has no revise-on-staging for developers yet, so the take
   sends it back; it is never approved.)

Seeded with `video/scripts/seed-demo.ts --staging --stage-tasks` (staging Phase 4-2): the take
starts with all three in staging.

The developer scenes (concurrent agents, the contract failing and then fixed) stay, shortened so the
video stays within 10 minutes. `docs/DEMO-SCRIPT.md`, the rehearsal guide and the video's
`selectors.json` are updated in the video phase.

## 13. Out of scope

- Copying or masking production data into staging.
- Picking individual commits within a task; a task is promoted whole.
- Canary or traffic-split releases (unchanged from `docs/LIMITATIONS.md` §2).
- Undoing a production migration automatically.
- A separate custom domain for staging.
