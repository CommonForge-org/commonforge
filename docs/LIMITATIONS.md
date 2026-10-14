# CommonForge: known limitations

An honest list of what the competition build (P0) does not do, does differently from the plan, or
only proves under stated conditions. Sources: the internal implementation plan (its P0 shortcuts
and out-of-scope list; "plan §…" references below point to it and it is not published), the spike
results in the [README](../README.md#spike-results), [apps/worker/API.md](../apps/worker/API.md)
"Known deviations", and the test suites. The PRD's own caveat applies: passing the acceptance tests covers the
synthetic fixture and the declared threat model only. It does not prove compatibility with every
framework, or secrecy against every possible attack.

## 1. Previews share one origin

- **What happens.** Previews are path-based on one dedicated Worker, at
  `commonforge-preview.<account>.workers.dev/p/<org>/<preview>/<token>/`. Each preview is
  token-gated and expires, but every preview shares one browser origin. This was an owner
  decision on 2026-10-06. Per-candidate hostnames need a zone with wildcard DNS, which the account
  does not have (spike A7: PARTIAL).
- **Consequences:**
  - Previews in the same browser share `localStorage`/IndexedDB.
  - Service Workers are blocked (`worker-src 'none'`), and cookies are stripped.
  - The app's session cookie is `__Host-` and is never sent to the preview origin.
  - The app, the previews and the demo release targets still share the registrable domain
    `workers.dev`. A separate app domain is a later decision for the owner.
- **Preview runtime.** The preview api runs in a Node "dev mode" host inside a container, not in
  workerd. A bundle that needs Workers-only runtime APIs does not run in preview.

## 2. P0 shortcuts (plan §C.2)

- One organization is one `OrgLedger` Durable Object. There is no sharding. The GC cron walks
  every org in sequence.
- The runner is one Sandbox container image with `git` and Node (spike A3: VERIFIED). A
  developer-controlled Node runner speaks the same signed-job protocol.
- Compare runs in the runner.
- Previews are built in the Sandbox. The production target is one Worker per release target,
  deployed from the runner with an account token that only the control plane holds.
- Roles are owner, developer, client and viewer. Sign-in is by email magic link only, with no SSO.
- **The agent hand-off prompt carries a sign-in code.** *Copy prompt for your agent* puts a
  one-time `cforge login` code in the prompt (`POST /api/auth/cli/code`: single use, 15 minutes,
  never shown on the page). The code ends up in the coding agent's chat history. Once used it is
  worthless, but the CLI session it opened acts as the person, in every project they can reach,
  for 7 days (a normal login lasts 30). The person sees it under *Your account* (the avatar) as an
  agent hand-off session and can end it there, or with `cforge logout`. A session limited to one
  task is not built. Until it is used, the code also sits on the clipboard, where another program
  could read it. The steps under "Run the steps yourself" use the emailed code instead.
- **Folder access has two levels of settings.** Per project, the owner makes each folder *Can be
  changed* or *Read-only* (Settings → Folders). Per person, the owner chooses in Settings → Access:
  for a client, Can change, Read only or No access per folder. A new client reads only until the
  owner chooses. Making a folder read-only stops new tasks from changing it, and ends client agents'
  leases; a developer's task already checked out keeps its write until it is submitted.
- `cforge` runs on macOS and Linux. On Windows it needs WSL: its git credential helper needs an
  absolute POSIX path.
- **AI apps connect through `cforge mcp`**, a local MCP server: the Claude Desktop extension
  (`commonforge.mcpb`, built by `pnpm --filter @commonforge-org/cli mcpb`), the Claude Code plugin
  (`plugins/commonforge`, with its marketplace in `.claude-plugin/`) and a Codex `config.toml`
  entry. The Account page shows all three and makes the one-time sign-in code, with the same
  limits as the hand-off code above. Limits:
  - The tools act as the signed-in person; the server checks every call, so they can do nothing
    the person cannot. As with the hand-off, the session is not limited to one task.
  - Checking out and submitting need an app that can edit local files and run git (Claude Code,
    Codex, Claude Desktop's Code tab). In a plain Claude Desktop chat, sign-in, listing, creating
    tasks and status work; editing a checked-out task does not. On Windows, checkout needs WSL as
    above.
  - The Claude Code plugin and the Codex entry start the server from npm (`npx -y
    @commonforge-org/cli mcp`), so they work once the CLI is published; until then the Account
    page shows `cforge mcp` from a source build. The Desktop extension carries its own copy.
  - The Account page links the extension to the repository's latest GitHub release; the link works
    once a release with `commonforge.mcpb` attached exists. A self-hosted copy can attach its own.
  - Tested: the MCP protocol and every tool against the CLI's fake API, the packed npm bin and the
    unpacked extension over stdio, the extension manifest with `@anthropic-ai/mcpb validate`, the
    plugin with `claude plugin validate --strict`, and sign-in plus task creation against the
    local stack. **Not tested:** installing the extension in Claude Desktop, the plugin in Claude
    Code, or the Codex entry in Codex; and checkout and submit against a real git server. Under
    Claude Desktop's own Node runtime, git is told to run the credential helper with
    `ELECTRON_RUN_AS_NODE=1` (macOS and Linux); this is untested in the app.
- The stale-base policy is **refuse**: there is no automatic rebase. A proposal whose base moved
  must be rebuilt.
- Fork cleanup is an alarm/cron-driven sweep (every 10 min, 1 h grace). There is no quota
  accounting.
- The release health check reads each target's `/version` once. There is no canary or traffic
  split.

## 3. Credentials until the owner supplies dedicated tokens

- **`CF_API_TOKEN`.** The dev deployments run with a broad account token. Production needs a
  **dedicated** token with *Account › Artifacts: Edit* only.
- **`COMMONFORGE_DEPLOY_API_TOKEN`.** This token needs *Workers Scripts: Edit* and *Workers KV
  Storage: Edit*, ideally on a **separate deploy account**. Until then, release targets share the
  control plane's account:
  - Targets are confined by name (`cfapp-<orgId>-<name>`; `commonforge*` is refused) and by
    platform-created bindings.
  - They are not confined by account isolation.
- **Roll the broad dev token** after the dedicated ones are installed (API.md "Deploy
  prerequisites").
- **Artifacts tokens** are repository-scoped `read`/`write`, with no branch or path scoping.
  Isolation is therefore one repository per task workspace: a fresh `-tasks` repo per workspace,
  and a fresh `-editions` repo per client edition. It is never a branch.

## 4. Out of scope for P0 (plan §C.3 and cuts in §C.1)

- **ArtifactFS.** Export uses standard git bundles and asset manifests: only `git` and `curl` are
  needed, with no proprietary filesystem.
- Private Git import. Intake takes public HTTPS remotes and ZIP uploads only.
- Populating ZIP intake resources. Confirming a ZIP creates the planned resources and folders,
  but copying the staged archive into them needs a runner `intake-apply` job that does not exist
  yet (`pendingPopulation: true`). An owner's "include anyway" choice for an inspected
  secret-named file is recorded on the plan for when that job lands.
- Cloud-drive connectors, an MCP adapter, a local sync helper, semantic search and an annotation
  widget.
- A Decision Inbox beyond the "Needs your decision" badge.
- Adoption of the engine packages (`@commonforge-org/*`) by other products. They are reusable,
  but no other product uses them yet.
- AI suggestions in intake, preview transcoding, a Review Brief beyond a thin table, and export of
  review metadata.

## 5. Platform constraints we design around (spikes, plan §0.3)

- **No write API.** The Artifacts binding and REST API cannot write, commit, merge or update refs.
  Every write is a `git push` from the runner, outside the Worker request.
- **Pushes:**
  - The server accepts `--force` (A1 PARTIAL), so every runner push uses `--force-with-lease`
    against the ledger's sha.
  - `--atomic` is refused, so multi-ref jobs are sequential pushes that handle partial failure.
  - Only one push per repo can run at a time; the runner retries with backoff.
- **Forks:**
  - Forks cannot cross namespaces, so task workspaces are fresh repos seeded at the base sha, with
    no fork lineage.
  - Fork, create and import take seconds to tens of seconds, so they run in queue steps.
  - Import is public HTTPS only, with a hard limit of about 70 s (use `depth`).
- **Events.** `repo.forked` and `repo.imported` events are never delivered. `pushed` events are
  only wakeups; the ledger is the authority. Repo-level `pushed` subscriptions are not created
  automatically.
- **REST cannot resolve full ref names** (A5). The ledger stores shas, and ref listing happens in
  the runner.

## 6. Isolation is a credential boundary, not a process boundary

- A task fork isolates **what an agent can write**: its token is scoped to its own `-tasks` repo.
- It does not isolate **processes**. Agents that run on the same machine share that machine.
- Process isolation needs separate sandboxes or machines (plan §F, last row).
- Check network in the Sandbox:
  - Jobs that can write a repository (and every `integrate` job) run their checks with **no
    network**, but only when the runtime grants a network namespace (`unshare --net`, verified live
    in Task 22). If it is not available, the checks silently share the runner's network, which
    reaches only the job's gateway (npm read, its own repositories, the runner endpoints).
  - Read-only build jobs (`preview-build`, `release-build`) always keep that gateway-limited
    network for their install and build steps.
  - Dependencies install only from a committed `pnpm-lock.yaml`, without install scripts.

## 7. Recorded deviations and gaps (API.md "Known deviations")

- **Grants and memberships live in D1.** Approvals are filtered by current membership just before
  `accept`. A membership change inside that window is not atomic with the accept.
- **Sessions.** A session lasts 30 days (7 for an agent hand-off login). *Your account* lists your
  sessions and ends any of them; there is no way for an owner to end someone else's sessions other
  than removing them from the organization. Sessions opened before migration 0018 show as "Signed
  in before this list existed". The global magic-link cap (200/h) can be exhausted by a
  distributed sender.
- **Self-approval is allowed.** One person may hold every role; the records stay separate. Agents
  never approve.
- **Editions:**
  - A return against a moved head is refused; there is no automatic reintegration.
  - A rebuild replaces the edition's single commit, so older downloads go away.
  - Edition repos and staged return ZIPs are not swept by GC.
- **Not swept by GC:** staged intake ZIPs and old export bundles. The ledger does not emit
  `candidate-superseded` yet.
- **Repairing a failed proposal.** Freezing a workspace is final: there is no reopen. A repair
  inside the same Change works by freezing another written mount of the same task. The demo's
  contract fix does this with `requirements`, and the review then shows "Fixed. This new version
  passes…". A repair that must touch an already-frozen mount needs a new task, which is a new
  Change: the old proposal stays blocked and the new one is reviewed on its own. Found while
  writing `apps/web/e2e/local-stack.spec.ts`, which exercises the supported path.
- **Edition draft default (UI).** The "New edition" draft is named "Website pages" and its include
  and write lists suit a web front end. Its source is the git folder named `website` when the project
  has one, otherwise the first git folder. Check the source before you save.

## 8. What the test suites fake, and what only a live run proves

| Suite | Command | Real | Faked |
|---|---|---|---|
| Fixture UI e2e (CI) | `pnpm --filter @commonforge-org/web test:e2e:fixture` | The production UI bundle, in Chromium | **Everything behind the UI**: `src/api/fake.ts` answers every call, always under the "Fixture mode" banner. It proves the screens of the eight-minute path, never a backend behavior. |
| Local stack e2e (no credentials, CI-capable) | `pnpm --filter @commonforge-org/web test:e2e:stack` | The Worker under `wrangler dev`: every route, D1, both Durable Objects, R2, the step/outbox/runner queues, log-mode magic links, cookies, CSRF, the real web bundle | **Cloudflare Artifacts**: an in-memory repo store. "git push" is a test route that demands the agent's real broker-minted write token. **The integration runner**: `FakeRunner`, which speaks the real signed-job protocol but performs merges and checks on the in-memory store; a contract failure is injected. **The Cloudflare API for releases** and the `/version` health check. Previews are not exercised. |
| Worker tests, fault and security suites | `pnpm test`, `pnpm test:fault`, `pnpm test:security` | The Worker app on miniflare (D1, Durable Objects, R2, queue handlers) | The same Artifacts/runner/Cloudflare API doubles as the local stack, plus a captured email transport. |
| Conformance and runner suites | `pnpm test` (packages) | Real `git`, local bare repos, the real runner jobs | The provider is `LocalGitProvider` or a fake provider. Real Artifacts runs only in the gated live job. |
| Live (gated) | `pnpm test:live`, the Task 23 live rehearsal | The dedicated Cloudflare account: Artifacts, R2, Sandbox, Email | — |

Plan §G.4 coverage of the two e2e suites:

- They cover AT-01 (mixed resources in one tree; intake itself is API-tested), AT-02 (fixture: the
  video stays in R2), AT-05 (fixture lanes), AT-06, AT-08, AT-19, AT-20, AT-21, AT-24, AT-25/26 (edition copy only), AT-27 (ZIP return), AT-30 and AT-34
  (fake deploy).
- They drive no CLI: AT-22 and `cforge` are covered by `apps/cli/test` (including the local
  `e2e.at22.test.ts`).
- AT-09 (stale approval) is covered by the API and ledger tests.
- AT-35 (a failed release keeps the previous live pointer) and AT-33 are covered by
  `apps/worker/test/api/releases.test.ts`, not by the e2e.

Only a live run proves the following:

- An Artifacts token cannot clone or push another repository, including a canonical repo whose URL
  is known (AT-25, server behavior).
- Revocation takes effect mid-push (A4).
- Preview origin and cookie behavior in a real browser across `workers.dev` (AT-37).
- A real `wrangler deploy` and its `/version` (AT-34).
- Email delivery.

### Fault injection (plan §G.5)

`apps/worker/src/chaos.ts` defines the chaos flags (`COMMONFORGE_CHAOS`, comma-separated):

- `after_fork_before_record`
- `after_prepare_before_commit`
- `provider_5xx_during_prepare`
- `after_commit_before_reconcile`
- `lost_accept_response`
- `runner_job_expiry`

Rules for the flags:

- They are never set in `wrangler.jsonc`.
- A Worker ignores them unless it is local (`COMMONFORGE_PUBLIC_URL` on `localhost`, `127.0.0.1`,
  `::1`, `*.localhost` or `*.test`; one helper, `apps/worker/src/lib/local-host.ts`, also used by the
  e2e stack guard and the broker URL check), or `COMMONFORGE_CHAOS_ALLOW_DEPLOYED=inject-faults` is set on a
  rehearsal Worker. Production must never set it.
- `/health` lists the flags that are active.

`packages/conformance` exports `describeProviderFaultConformance`, which runs the provider-generic
rows against any git-backed provider.

### Security acceptance tests

`pnpm test:security` runs these suites:

| AT | Suites |
|---|---|
| AT-16 unauthorized access | `apps/worker/test/security/at16-at17-access-and-agent-authority.test.ts` (cross-tenant), `test/api/authz-matrix.test.ts` (every principal × route), `test/api/projects.test.ts` |
| AT-17 agent authority | `test/security/at16-at17-…` (credentials only for its own `-tasks` copies, reference read-only, runner endpoints need a signed job, asset staging confined, accepted manifest moves only on accept), `test/api/tasks.test.ts`, `test/api/review.test.ts`, `test/api/runner.test.ts`, conformance `provider-suite` (real git: agent credentials cannot push canonical) |
| AT-18 source injection | `test/security/at18-at38-repository-instructions.test.ts`: `PROJECT-CONTEXT.md` is server-generated, and hostile policy, workspace, approval, CI and wrangler files change nothing. Also `test/api/flow.test.ts`. |
| AT-25 no production repo access | `test/api/editions.test.ts`, `test/api/tasks.test.ts`, `test/api/authz-matrix.test.ts` |
| AT-26 history and source disclosure | `test/api/editions.test.ts` (canary + hidden module absent everywhere client-visible), `apps/runner/test/build-edition.test.ts` (real git) |
| AT-28 scope and manifest tampering | `test/api/editions.test.ts`, `apps/runner/test/edition-return.test.ts`, `apps/runner/test/zip.test.ts`, `packages/core/src/path-policy.test.ts`, `packages/runner-protocol/test/verify-materialization.test.ts` |
| AT-37 preview-origin boundary | `apps/worker/test/preview-worker.test.ts`, `test/api/previews.test.ts`, `apps/runner/test/preview-host.test.ts` |
| AT-38 protected-policy mutation | `test/security/at18-at38-…` (hostile files do not change a release's targets or recipe; policy is owner-only; a policy change refuses the reviewed proposal), `test/api/releases.test.ts` (AT-33 identity) |

## 9. Staging (spec 2026-10-07, Phase 1)

- **One staging per project.** A project has one staging environment (`<workerName>-staging` per
  release target, one D1/KV set). Tasks land in it together; there are no per-task environments.
- **Its URL is public.** Staging runs on a workers.dev hostname with no access gate, so it must hold
  demo data only. The capture sink URL (`/api/sink/<token>`) is likewise public by design: the
  token in the path is the only credential, and it receives only what staging's own Workers send.
- **Staging Workers with capture vars fetch over the public internet.** The sink is a workers.dev
  Worker on the same Cloudflare account, which refuses such subrequests (error 1042) unless the
  caller has `global_fetch_strictly_public`. The platform adds that flag to every staging Worker with
  `captureVars`, so all of its outbound `fetch` calls (not only the sink's) take the public route.
- **Removing or editing an applied migration resets staging data.** Migrations are append-only. If
  an applied file disappears or changes, the next build recreates D1/KV from scratch and replays
  every migration and seed. A migration that fails part-way is not reverted: use "reset staging".
- **The D1 `/query` API runs each migration file as one request.** Statements in a file are not
  split by the platform, so keep files small and one concern each.
- **No resubmit.** A failed or rolled-back landing is not retried; the client starts a new task from
  the current staging. A task that is live on staging can be revised (Phase 2).
- **Staging Workers do not count toward the per-org release Worker quota**, so an org can run up to
  twice as many Workers as `MAX_ORG_RELEASE_WORKERS` once staging is on.
- **Proven live on CI (staging Phase 4-1, 2026-10-11).** `scripts/ci-live/staging.ts` runs staging with a
  platform-created D1 (migrated, seeded), the deploy of `-staging` Workers with `d1_databases` through the
  egress gateway, production migrations applied at promotion before the code, the sink, a classifier
  decline approved by a developer, a destructive-migration veto sent back and rolled back, and cleanup
  (`cleanupRun`, `sweep.ts` cover `-staging` Workers and every D1/KV of the org). The CI demo
  (`demoPolicy`) still defaults to staging off; e2e.ts and rehearsal.ts do not turn it on.
- **Every task starts from staging.** In a staging-mode project every task (client, developer or owner)
  starts from the live staging commit, so a proposal based on staging work can be promoted. Developers cannot
  use the manual propose/integrate path in such a project (`409 staging_proposal`); they promote.
- **No way around promotion (staging Phase 4-2, P42-2).** In a staging-mode project the Worker refuses
  `POST …/proposals` (`409 staging_proposal`), creating an edition, starting an edition update or sending one
  back (`409 staging_mode`), and requesting a preview (`409 staging_mode`); the web app does not offer them.
  What existed before staging was turned on is not migrated: existing previews and editions stay readable, and
  an open proposal can still be integrated and approved, but the policy save that turned staging on made it
  `policy_revision_stale`, so it cannot be accepted, and it cannot be proposed again. Its task goes through staging
  instead (the developer starts a new task). Turning staging off lifts the guards.
- **Tasks seed from a staging commit fetched by sha.** A client's task fork is seeded at the live
  staging commit, which no branch of the canonical repo names (only `refs/commonforge/staging`).
  Artifacts serves such an unreferenced sha to the fork (proven live in the staging Phase 4-1 run:
  each task was checked out from the live staging commit).
- **No checks on staging.** A landing is merged, built, migrated and deployed; the project's checks and
  contracts run when the task is promoted (on the promotion's result), not on staging. Landing dependencies
  are resolved at promotion (the set of earlier landings sharing a path).
- **Only release targets are staged.** R2 asset mounts and mounts that no release target builds are
  not part of staging: a landing that touches only those still "lands" (nothing on staging changes).
- **Deploying migration 0008 (release channel).** 0008 re-keys `release_live` by channel. Between
  `d1 migrations apply` and the new Worker going out, the old Worker's `release_live` upsert fails,
  so a release reaching live (or a health check finishing) in that window errors. Apply 0008 and
  deploy when no release deploy or health check is in flight.

## 10. Promotion to production (spec 2026-10-07, Phase 2)

- **Accept and release take turns per project.** Promotions with disjoint landing sets build, gate and
  wait for approval in parallel; from the accept until its release ends one promotion holds production and
  the others wait in `cleared` (first come first served). A slow release (up to the 2 hour release deadline)
  delays every other accept of the project, and a lost chain holds production until GC's nudge lets the
  deadline fire.
- **Waiters rebuild after each accept.** A promotion's proposal is built on the `main` it is accepted on,
  so after each accept the first waiter in line rebuilds (a full integrate, checks and gate). It does so
  while the accepted promotion releases, so production is idle only when the rebuild outlasts the
  release; waiters further back rebuild once they reach the front (one waiter rebuilds ahead at a time).
  If `main` moves again by a direct accept during the release, GC's next sweep wakes the waiter to rebuild
  again (counted toward the cap, like any rebuild for a direct accept). Rebuilds caused only by this project's own accepts are not capped. The 6 hour
  deadline restarts when a waiting `cleared` promotion rebuilds, so it does not bound the wait by itself;
  waiting is bounded by the first-in-first-out order (about one rebuild per promotion ahead in line). A
  promotion whose machine states do run past 6 hours fails with "Production kept changing; promote again."
- **Alone-first trusts the `gatesAlone` checks.** A task goes to production without earlier overlapping
  landings when every folder it changes has a required check marked `gatesAlone: true` and the build and
  checks pass. Behaviour no such check covers (a page relying on another task's wording, data
  assumptions) is not detected, so the feature the client previewed on staging can reach production
  without the earlier task it depended on. Owners must mark only checks that build or test the code (a
  lint-only check should not be marked), and developers declare other couplings with travel-with. The
  landing left behind may later stop merging on the new `main` (`conflicts_with_production`).
- **A promotion widens at most once** (to the closure at that moment); a second failure fails it. The
  alone eligibility is re-checked at every build and a policy change widens the promotion.
- **Travel-with is manual.** A link applies to the next request (a promotion that lacks the linked landing is
  superseded when the link is added, and a link is refused with `travel_with_in_flight` once the
  promotion holds production). A link to a landing that failed or was rolled back blocks the promotion
  until a developer removes it.
- **Staging needs the owner's first production publish (baseline).** Landings wait until `main` is
  published once; a project whose owner never publishes never gets staging. The baseline is permanent:
  turning staging off and on keeps it, and changes accepted while staging was off need one owner publish
  before a clearance release, as before.
- **A withdrawn promotion's integrate job still runs to completion** (wasted runner time; nothing reads its
  receipt).
- **Fake vs real merges.** The Worker tests' fake runner merges by lines (equal line counts); the real
  runner uses `git merge-tree --merge-base`.
- **Landings are promoted at accept; production may lag (R10).** A landing becomes `promoted` when the
  accept lands in `main`, not when the release is live. If the release fails (`release_failed`), `main`
  already has the change and production runs the previous version until `retry-release` succeeds.
- **The classifier only clears; it is not a security boundary (staging phase 3).** It turns a `classify`
  level into a `classifier` clearance and never blocks more than before. Every failure (no provider or key,
  5 s timeout, HTTP error, refusal, malformed answer) means a developer decides.
  - *Prompt injection is mitigated, not prevented.* Task text, file names, diffs and check output are
    agent- or client-written. They go in as quoted `state` (never as instructions), a guard question must
    also answer safely, and the veto runs first (a destructive migration is never sent). The 96 KiB size limit and the
    complete-view check (P3-11) also run before anything is sent. A cleverly worded diff could still push the answers toward "safe"; `developer` paths and the veto are what hold.
  - *Calibration is the provider's claim.* The 0.9 threshold applies to the provider's own probabilities;
    CommonForge has not measured how well they match reality. Treat the threshold as a knob, not a guarantee.
  - *Only a complete view of the change can clear (P3-11).* A truncated or oversized diff, files past the
    cap, a file that could not be read, or a binary file that is not an allow-listed asset type
    (`input_incomplete`) goes to a developer without asking the provider; so does a state over the size limit
    (`input_too_large`). The size check runs after reading the file because the provider has no stat call.
  - *Evidence is for developers and owners only* (`gate_json.classifier`: provider, model, answers, safe
    probabilities, digest, latency, error code). Clients see only the platform reason text.
  - *Usage is billed to the owner's keys.* TypeSafe (`JEV_API_KEY`) and OpenAI (`OPENAI_API_KEY`) calls cost
    fractions of a cent each, one per promotion gate run.
  - *The Promote dry run may differ from the request.* If staging changes between the dry run and the
    request, the request is evaluated on what is then in staging.
  - *A carried classifier clearance survives `main` moves.* A cleared promotion that waits and rebuilds keeps
    its clearance (and its evidence) as long as its change is the same; it is not asked again.
  - *Clients and viewers poll staging even in non-staging projects* (one extra GET); the response is
    harmless and the UI shows nothing.
- **Production migrations are never reverted automatically.** A failed or interrupted release leaves the
  migrations that ran in place. An outcome that is unknown (the query was sent, no definite answer) blocks
  every deploy needing that database (`migration_state_unknown`) until an owner checks the database and
  resolves it (`POST …/production-migrations/resolve`).
- **A 4xx on a multi-statement migration file counts as nothing ran.** D1's partial-failure semantics for
  a file with several statements are not verified; keep migration files to one concern.
- **Generated data files are refused.** Migration files must be committed; a build that produces data
  files outside the declared `release.migrations` folders is refused (`release_data_not_allowed`).
- **One project per org D1.** A D1 database is bound by one project of the org (`binding_in_use`), and an
  org has at most 3.
- **An owner adding a `migrations` folder later runs files already on `main` that were never vetoed.**
  The veto reads what a promotion changes; files that were already there when the folder was declared run
  at the next release.
- **Staging seed SQL is not linted** (it never runs on production); only migrations go through the veto.
- **A policy target that points at a missing mount sends every promotion to a developer** (the gate fails
  closed on a mount it cannot map).
- **Old git modes count as destructive.** A migration file with a non-regular mode (for example `100664`)
  is treated as destructive and needs a developer.
- **`ALTER TABLE` with a single-quoted table name counts as destructive.** Use unquoted, double-quoted,
  backtick or bracket names.
- **Asset changes are never promoted.** Landing proposals carry no asset changes (R2 asset mounts are not
  staged); change assets through the normal propose/approve/accept path.
- **Rolling production back and then promoting re-ships the rolled-back change.** `main` is linear; a
  rollback moves the live release, not `main`, so the next promotion's release contains it again.
- **A revision is applied at its landing's position.** It may conflict if it builds on a later landing;
  the staging build then drops only the revision (`staging.revision_dropped`) and the landing stays live
  without it.
- **Revision numbering may drift.** The "(revision N)" in a title counts parts and revisions still in
  progress; dropped or canceled revisions can leave gaps or repeats.
- **A promotion superseded mid-build may leave an unused prepared proposal** (closed, never accepted).
- **A production migration that runs longer than 10 minutes** may be swept as a lost deploy
  (`recovery_required`); an owner then checks the database and uses `recover`.
- **Staging stops requesting builds after 5 consecutive failures** (`staging.stuck`, developers only)
  until a new landing or a reset.
- **A folder mounted after the owner baseline needs one owner publish** before a clearance can
  carry it (`release_needs_publish_approval`).
- **The promotions list is capped.** `GET …/projects/:pid/promotions` returns the newest 100 (filterable
  by `?state=`), without resources or checks; read one by id (`GET …/promotions/:id`) for those.
- **The "probably needs task X" hint** on check failures is not implemented.
- **Uploads and edits in a staging-mode project wait for a promotion.** A git folder's file change lands
  on staging and stays `staged` ("On staging") until its task is promoted; the Files tab shows the
  folder's `main` (production), not staging, so a staged file is not listed there yet. The Files tab
  has no promote button: promote the change's task (`taskId` on the change) from the staging view.
  Turning staging off leaves changes already staged waiting, like agent tasks' landings (their landings
  are not dropped and cannot be promoted while staging is off); their uploads stay pinned (never
  expire) until the change is promoted after staging is turned on again, or its landing is rolled back.
- **File collections are not staged.** In a staging-mode project a file collection's change still lands
  on its own (staging builds git candidates only).
- **A staged change whose landing staging drops after its promotion's accept committed** is failed
  (`staging_failed`) and then added by the accept anyway; GC keeps its uploads while a promotion claims
  the landing. If an object is missing at that point all the same, the change is added with event
  `files.change_objects_missing` (and a Worker error log) for a developer to re-upload the file.
