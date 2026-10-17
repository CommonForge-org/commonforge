# G1 execution status

Updated: 2026-10-17. Goal: durable project understanding across agent handoffs (M0–M5 only).

**Current result: bounded G1 achieved (M0–M5).** AN-01–AN-24 are verified within their declared
scope, including actual fresh-agent continuity, real local Git/runner/browser execution, and the
actual isolated Cloudflare release / real expiry / verified recovery gate. See the final completion
record and [live evidence](evidence/live-cloud-report.json); earlier entries are historical checkpoints
superseded by later measured results. Human domain-expert usability remains unobserved.
No production change, private repository access, visibility/license change, package publication,
remote Git push of this implementation branch, or new persistent infrastructure purchase occurred.

## Baseline

- Implementation worktree: `PublicRepo-Implementation`, HEAD `d5ab4eb`, initially clean.
- Planning files were absent here; copied verbatim from sibling `Plan-Public-Project` worktree at the owner's specified handoff. No private repository accessed.
- No applicable AGENTS.md found in repository or ancestor directories.
- Node `v26.8.1`, pnpm `12.5.1`; frozen install passed.
- `pnpm typecheck`: pass (21 tasks). `pnpm build`: pass (13 tasks).
- `pnpm exec turbo run test --concurrency=1`: baseline passed; log in ignored `.g1-artifacts/baseline-test.log`.

## Work packages

| Package | State | Owner / next dependency |
|---|---|---|
| W00 baseline / authority / local spike | complete | baseline, reviewed authority map and actual local provider |
| W01 versioned contracts | locally verified | strict schemas, new domains, old v1 vectors |
| W02 knowledge / outcomes | locally verified | SQLite persistence, CAS and immutable revisions |
| W03 atomic acceptance / compatibility | locally verified | real source acceptance and injected SQLite rollback |
| W04 mandates / context | locally verified, bounded | one-hour scoped handoff, pinned context, CLI/MCP; limitations below |
| W05 trusted scenario evidence | locally verified | fixed synthetic verifier, signed complete set, retry history |
| W06 real local workflow | locally verified | actual Git smart HTTP, Worker, runner, R2 and static/API previews |
| W07 reference UI | locally verified | default native onboarding, fresh folder genesis, real owner correction/preview/review/acceptance |
| W08 release / recovery | verified, bounded | actual isolated release, observation, real expiry and fresh recovery; vars-only workerd scope |
| W09 portability / agency contract | locally verified, bounded | history/evidence payloads without trust; Git restoration not implemented |
| W10 integrated review / rehearsal | verified | actual fresh-agent/self-development, independent audit, local and isolated live gates |

## Decisions and authority map

- Retain legacy v1 hash encoding and append-only migrations. Existing projects stay legacy.
- Keep one OrgLedger atomic boundary; persist explicit versioned project records there.
- Ledger mode enforcement is required, not only route enforcement: legacy head writers are `OrgLedger.accept`, `restore`, and `bindHead`.
- `accept` is called by direct acceptance, file-change queues, and promotion queues. `bindHead` is used by resource adoption, intake, and folder initialization. Resource sharing must not bypass an enabled project's gate.
- Local execution seam: Worker `Services.provider()` currently hardcodes `ArtifactsVersionProvider`; `LocalGitProvider` uses Node/fs. An explicit local adapter is required. Existing fake local stack does not establish real Git/runner/preview behavior.

## Acceptance evidence

Initial checkpoint: AN-01–AN-24 had not run. The final acceptance matrix below supersedes this initial state.
At that initial checkpoint, live Cloudflare and fresh-agent rehearsals had not run. The actual fresh-agent gate passed later; live Cloudflare and human user validation remain unperformed.

## Initial next action (completed)

The baseline, contract freeze, authoritative state, migrations and independent consumer work described by the initial checkpoint were completed. The final next action is recorded below.

## Integration checkpoint (M0–M4, in progress)

- Baseline complete: frozen install, typecheck, build, and unit command all passed. Runner baseline includes two skipped environment-sensitive tests; these are not passes for isolation claims.
- W01 implemented strict core contracts, hash/context helpers, G1 golden vector; existing v1 vectors remain passing.
- W02/W03 implemented pure project reducer with CAS/idempotency, immutable draft/confirmation revisions, authoritative manifests, dual-bound decisions, all-required evidence, explicit supersession, and atomic legacy artifact writes. OrgLedger migration 4 adds versioned project state and permanent source locks. Existing migrations 1–3 unchanged.
- W04 implemented task-only single-use handoff, one-hour mandates, pinned context, CLI/MCP context/proposal tools, submit staleness preflight. Membership/grant narrowing first revokes authoritative native authority. Renewal requires new pinned context; transparent extension of old pinned attempts is not claimed.
- W05 independently pinned synthetic scheduling harness/protocol implemented; signed result set/build/runtime bindings. Verification request budget/reservation and atomic result ingestion integrated. No uploaded JSON can set runner provenance.
- W06 real Git smart-HTTP sidecar and real Node pull runner/preview stack implemented; integrated rehearsal running. Standalone real-local rehearsal passed actual Git, runner, local blobs, preview HTTP and 9 namespace-isolated behavioral scenarios. Worker workflow was initially explicitly not_run in that report.
- W07 implemented Outcomes, Knowledge, Review destinations with draft/confirmed/corrected history, real per-scenario evidence, manual observations, exact decisions and acceptance. Browser owner journey not yet run.
- W08 added D1 migration 0019 release bindings, exact manifest/source/runtime gating on prepare/publish/deploy, bounded observations and refusal of automatic legacy rollback for native projects. No live cloud run performed. Scheduling source-runtime verification cannot establish arbitrary Cloudflare deployment-byte behavior; incompatible runtime binding refuses deployment.
- W09 implemented strict validated metadata/payload bundles, explicit missing source payload report, fresh local authority on import and untrusted historical archive, draft copies needing confirmation, synthetic agency contract tests. Actual payload retention integration underway.
- Independent review found and fixed: queued acceptance bypass requires DO guard; shared-resource bypass requires permanent source locks; native outbox alarm absent; repeated external agent label allowed cross-attempt identity reuse (now unique per handoff plus exact attempt check); invalid legacy ApprovalRef ID found by real-local rehearsal (now valid hashed ID).
- Integrated unit run had 931 Worker passes and one failure in new persistence test due test RPC Promise matcher behavior; reviewer fixed matcher and re-ran targeted persistence/source-lock tests. Full final rerun pending after integration stabilizes.

### Material narrowing

G1 rejects combined source-and-knowledge acceptance until proposed scenario sets can be independently evaluated: confirm metadata first, then refresh/reverify source. Enabled projects currently freeze source membership and refuse shared staging. Import preserves exact history but does not automatically restore Git repositories or trust imported evidence. These limitations must remain in final report; no full G1 achievement is claimed.

### Current next action

Complete real Worker accept/correction cycle, payload retention, browser screenshots, fresh-session rehearsal and isolated self-development proof; then independent review, final integrated/security/fault/browser gates and acceptance matrix. Live cloud remains unverified until an authorized isolated target and runtime verifier are available.

## Final local verification and empirical evidence

Code revision: `654644f` (`Implement native project knowledge, scoped agents and verified local workflow`). Baseline `d5ab4eb`; isolated
self-development snapshot `394958877aca94b522b87dd973b1b9ffb9b5c826` (929 public files at that
rehearsal point), not a claim that it equals the final implementation commit.

| Command | Result / execution |
|---|---|
| `pnpm install --frozen-lockfile` | pass; pinned dependencies, no lockfile changes |
| `pnpm typecheck` | pass, 21 tasks; reviewed final log `.g1-artifacts/reviewed-typecheck.log` |
| `pnpm build` | pass, 13 tasks; reviewed final log `.g1-artifacts/reviewed-build.log`; nonfatal web chunk-size warning |
| `pnpm exec turbo run test --concurrency=1` | pass, 21 tasks; 2,968 tests passed, 5 skipped (not counted as live/isolation passes); `.g1-artifacts/verified-final-test.log` |
| `pnpm test:security` | pass; 369 tests, 1 existing skip; `.g1-artifacts/security.log`; doubles where stated by existing suites |
| `pnpm test:fault` | pass; 18 tests including new actual SQLite acceptance rollback; `.g1-artifacts/fault-final.log` |
| `pnpm --filter @commonforge-org/web exec playwright install chromium` | pass |
| `pnpm --filter @commonforge-org/web run test:e2e:fixture` | pass, 33; all backing API/provider data is fake; `.g1-artifacts/browser-fixture.log` |
| `pnpm --filter @commonforge-org/web run test:e2e:stack` | pass, 15 tests after fixing the transient panel assertion; real Worker/storage with fake provider/runner/deploy; `.g1-artifacts/browser-stack-verified.log` |
| `PORT=8919 PREVIEW_PORT=8920 pnpm test:g1:local` | pass, real API/Git/runner/R2/static+API preview, 2 real owner browser tests; no skipped critical journey; `.g1-artifacts/g1-local-command-final.log` |
| Actual fresh Codex agent session | pass, `collaboration.spawn_agent` with `fork_turns=none`, identity `/root/fresh_g1_continuity`; see retained sanitized evidence |
| G1 isolated Cloudflare live rehearsal | `not_run`; production runtime verifier + authorized isolated deployment prerequisites outstanding |
| Observed domain-expert human usability exercise | `not_run`; owner role in tests was automated, not an observed human participant |

Final actual fresh-agent context: `48a6c317deca522f7073e52b9547b33fa7a32ba7e1d906b0e5a709da230b1c0b`.
Its only input files were `task.md`, `.commonforge/context.json`, `.commonforge/context.md` and the
allowed implementation `fixtures/scheduling/worker.mjs`; no inherited conversation, owner session,
operator coordinates or restated correction. It added `supportContact` health behavior and preserved
the authorized manager override, nonempty retained reason and travel restriction. Node syntax check
alone was not treated as behavioral evidence. Its actual source was subsequently integrated through
real Git and signed Node execution, independently passed all nine trusted scenarios, and was accepted
as manifest `ae47b2fc8b6ec60c4b593c1ab4c7241e34a896e3a3b4d9ff0ec1c1f929bdbe87`.
A supplemental namespace HTTP check ran the exact accepted integration and confirmed the new health
field; accepted and candidate module digests match. Actual model facility was Codex collaboration;
the independent model identifier is not exposed by that API. No cross-vendor claim is made.

Retained reviewable evidence: [rehearsals.json](evidence/rehearsals.json),
[fresh implementation diff](evidence/fresh-agent-implementation.diff), and
[owner screenshots](images/). Raw task-owned run files remain under `/tmp` and ignored
`.g1-artifacts/`; they contain local coordinates or ephemeral credentials and are not public artifacts.
Do not publish operator/session files or magic-link logs.

### AN acceptance matrix

All rows refer to the final implementation code revision and the commands above. A local test of a
release invariant is distinct from a successful live release (AN-21).

| ID | Status | Evidence and execution limits |
|---|---|---|
| AN-01 | pass | `worker/test/api/native-projects.test.ts`: actual DO eviction/reload retains confirmed provenance; real browser reload retains correction |
| AN-02 | pass | same suite: actual Promise.all CAS confirmation has one winner; exact retry replays |
| AN-03 | pass | core project/context + CLI native suites, actual scoped checkout; exact JSON/Markdown digest, denied credentials/oversize/scope |
| AN-04 | pass | Worker native security/submit suites: task-only exchange, cross-task/cross-attempt/confirm/accept/release refusal |
| AN-05 | pass | ledger project stale-head tests, CLI pre-push rejection, actual corrected knowledge/context cycle; old evidence remains history |
| AN-06 | pass | metadata-only outstanding manifests, real owner correction/review screenshot and browser test |
| AN-07 | pass | runner `g1-local-verifier.test.ts`: actual namespace execution, candidate-owned tests cannot replace trusted harness |
| AN-08 | pass | strict signed scenario protocol tests + ledger evidence invariants: exact set/revision/verifier/runtime/source/provenance and supersession |
| AN-09 | pass | ledger manual attestation authorization/subject tests; human provenance is distinct, no automated result accepted from public JSON |
| AN-10 | pass | `worker/test/fault/native-acceptance.fault.test.ts`: SQLite trigger aborts after artifact writes; heads/proposals/versions/audit/outbox/idempotency/project rollback together, retry/replay passes; source/runner fixtures are explicit doubles |
| AN-11 | pass | actual DO source locks reject legacy accept/restore/adoption; existing legacy unit/security/browser compatibility checks (final browser result below) |
| AN-12 | pass | native security expiry/revoke/single-use tests, source acceptance mandate checks, replacement handoff revocation; old provider token residual TTL is bounded |
| AN-13 | pass | exact envelope resulting-head checks and preview source-map regression; changed integration output cannot reuse the prior subject |
| AN-14 | pass | packaged real-local Playwright owner correction + exact-source preview + nine results + approve/accept; no JSON/Git entered in owner UI; synthetic automated owner, not user validation |
| AN-15 | pass | release/core tests plus actual isolated accepted/deployed/healthy and real expired-unknown projection; no continuous monitoring claim |
| AN-16 | pass (real local workflow) | browser prepares historical source under current knowledge, fresh signed9 passes, atomic restore+manifest, actual canonical Git ref synced and repeated isolated9; declared/data effects and unsupported artifact checks refused; actual bounded stateless cloud recovery verified in AN-21 |
| AN-17 | pass | bundle conformance + actual API history round-trip, real R2 payload export; imports create local drafts/authority and retain untrusted exact archive; Git is not automatically restored |
| AN-18 | pass | legacy core vectors, ledger/Worker migration and full existing suites; shipped SQLite migrations 1–3 unchanged, native migration 4 appended; D1 0019 appended |
| AN-19 | pass | actual credentialed smart HTTP clone/push/revoke, Node runner, R2, static and isolated API preview; `test:g1:local` and retained real reports |
| AN-20 | pass | actual fork-none Codex implementation, exact context/input hashes, real verification and accepted manifest described above |
| AN-21 | pass | actual isolated CI releases, nine HTTPS scenarios per deployment, exact observation bindings, real expiry to unknown, fresh recovery preserving current knowledge; evidence/live-cloud-report.json |
| AN-22 | pass | public build + synthetic agency consumer contract tests; no private package/config/repository dependency |
| AN-23 | pass | actual candidate mount/PID/network namespace tests deny controlling secret/network; own-development source snapshot and candidate run separately; external same-OS-account agent is not a multi-tenant sandbox |
| AN-24 | pass (conservative policy) | real R2 + authoritative payload registry race/fault tests, all-history retention, permanent tombstone before delete, missing/corrupt bytes detected; automatic orphan expiry not implemented |

### Review fixes and remaining work

Independent implementation/review subagents found and corrected cross-attempt scope, immutable
revocation, source lock bypasses, outbox scheduling, CLI path/downgrade, exact preview source mapping,
R2 tombstone races and atomic persistence. Real-local execution additionally caught invalid legacy
approval IDs and a millisecond request-lifetime race; both were fixed. Replayed native acceptance
now returns the inner accepted version so interrupted post-accept projections can be repaired.

A first legacy browser run was interrupted by hot reload while code was changing (fake in-memory
source reset); the settled rerun reached first publish but exposed an assertion against a panel
that intentionally disappears when the permanent timeline becomes Live. The test now waits for the
durable timeline state, preserving the actual behavior check. Neither failed run is counted as a pass.
The packaged rehearsal initially reached a readiness race; its wrapper now waits for actual Worker
health before calling the API and then passed the full two-test journey including real previews.

Remaining G1 prerequisites/limits are explicit in [local-workflow.md](local-workflow.md),
[release-rehearsal.md](release-rehearsal.md) and [LIMITATIONS](../LIMITATIONS.md): explicit enablement
instead of default native onboarding; source membership frozen; source/knowledge acceptance two-step;
replacement handoff instead of transparent renewal; authority restoration needs reconciliation;
Git source restoration absent; conservative attachment retention without automatic orphan expiry;
Linux/Node fixture runtime only; production runtime/live verification not delivered. Do not claim these
are environmental checks that have passed or proceed to M6–M8 as if G1 were complete.

**Next action:** finish the matching Cloudflare runtime verifier and dedicated isolated G1
release/observation/recovery rehearsal when authorized infrastructure is available. Keep external
GitHub/CI/bootstrap as the recovery bridge. A later session can resume from this record without the
original conversation. No work beyond G1 was started.

### Final review addendum

After the integrated unit run, the final full Worker suite passed **944 tests in 91 files**
(`.g1-artifacts/reviewed-worker-all.log`), including three additional concurrency/revocation/scope
regressions. The final overall typecheck/build remained 21/13 successful tasks. The strengthened
verifier binding passed five targeted actual runner tests, then the complete packaged real-local
API/preview/browser command passed both critical browser tests again. Its verifier definition now
binds examples, host and supervisor comparison/isolation logic; the runtime recipe pins Node version
and architecture. Earlier fresh-agent evidence retains its original historical verifier digest.

Final review also confirmed a revoked pending verification reservation cannot dispatch through an
idempotent retry. Raw source envelopes from a task token now require the dedicated task-bound source
preparation endpoint; knowledge-only proposals remain available through generic commands. No unresolved
critical local authority bypass was identified by the independent reviewer after regression tests.

The task-owned original/resumed dev stack was stopped gracefully. No data was deleted. Its accepted
self-development/fresh-agent project is retained in `/tmp/commonforge-g1-real-worker-CSARaE`; resume
with `G1_STATE_DIR=/tmp/commonforge-g1-real-worker-CSARaE scripts/dev-real-worker.sh`. Some earlier failed
provisional projects predate the final unshipped migration-4 table set; do not use them as a portability
baseline. The final packaged rehearsal always starts fresh with the complete schema. Raw keys/session
files remain task-private; sanitized summaries and screenshots are committed.

Implementation and sanitized evidence were committed locally as `654644f`; the follow-up status commit records that revision. No push or publication was performed. The working tree was clean after the status commit. The G1 goal remains open because AN-21 and the stated implementation limitations remain.


## Continuation: remaining local G1 work (2026-10-17)

The preceding goal turn made progress (committed implementation/evidence), not a verified wait.
The continuation inspected current sources and addressed additional independent implementation gaps:

- New web onboarding defaults to native genesis, with explicit legacy agency/staging selection.
  No-mode API clients retain v1 legacy behavior. Owner/developer creation works. New dedicated Git
  folders reserve permanent exclusive ownership, execute actual zero-parent Git initialization and
  atomically bind artifact head + unverified manifest. Legacy existing-source attach/detach/import
  remains refused. All mount insertion paths now serialize with native enablement via ledger
  reservations. Historical/failed reservations are conservatively retained, so conversion can require
  fresh sources/project. Actual SQLite trigger fault proves genesis all-or-nothing and exact retry.
- Added explicit owner authority reconciliation with current directory/full source access checks,
  client CAS, durable idempotency and incremented authority revision. Prior decisions/mandates are
  not restored. Durable directory-transition barriers fence enrollment and restoration during
  membership/grant narrowing, including projects created concurrently. Partial-failure barriers remain
  closed; ordinary retries cannot clear an earlier failed barrier. Operator recovery must quiesce
  mutations and verify directory/lease completion before trusted barrier completion. This is an
  explicit remaining recovery limitation, not an automatic repair claim.
- Added real pinned workerd verification of actual namespace-built scheduling source output.
  Recipe/environment uses the same runtime hash domain as native release binding. Signed bridge
  tests use real Git immutable revisions, actual isolated build, actual workerd HTTP nine scenarios,
  signed complete evidence, replay and wrong-runtime/cross-project refusal. The executable
  `g1-cloudflare-server.ts` reads only operator-registered Artifacts repos/revisions and serves the
  bridge behind operator-managed TLS. HTTPS transport is fixed configuration, rejects redirects and
  incompatible protocol. Local Node fixture mode remains separate. Remote Artifacts source access
  in the new server is tested with a transport double, not claimed as live.
- Workerd support is intentionally bounded to one bundled vars-only Worker; external bindings,
  migrations, assets and extra modules fail closed. Tested build bytes are exact, but a later
  production release rebuild still has its separately approved outputDigest. No production-byte
  equivalence or successful cloud deployment is inferred from the local adapter tests.
- Independent review identified that the existing pure historical-head recovery checks do not yet
  prove a usable end-to-end recovery proposal path. A dedicated implementation audit is underway;
  AN-16 remains a local invariant test, not a successful recovery workflow claim.

Continuation validation:

| Command | Result |
|---|---|
| `pnpm typecheck` / `pnpm build` | pass, 21/13 tasks; `.g1-artifacts/continuation-{typecheck,build}.log` |
| `pnpm exec turbo run test --concurrency=1` | pass, 21 tasks, 2,992 tests +5 existing skips; Worker956, web660, runner170; `.g1-artifacts/continuation-all-test.log` |
| `pnpm test:security` | pass, 382 tests +1 existing skip; `.g1-artifacts/continuation-security.log` |
| `pnpm test:fault` | pass, 19 tests including actual native genesis rollback; `.g1-artifacts/continuation-fault.log` |
| New workerd verifier/source/signed bridge tests | 8 actual local tests passed, included in full runner run |
| Registered Artifacts source server + signed bridge tests | 3 passed; REST source reads use a double, bridge execution real; `.g1-artifacts/cloudflare-server-tests.log` |
| HTTPS transport security tests | 2 passed; redirect/protocol replies mocked; `.g1-artifacts/native-verifier-transport.log` |
| `PORT=8939 PREVIEW_PORT=8940 pnpm test:g1:local` | pass, real source/runner/preview plus all3 browser journeys including native creation/folder setup; `.g1-artifacts/native-onboarding-real-local.log` |
| Four affected legacy fixture browser stories | pass; fake backing explicitly; `.g1-artifacts/native-onboarding-fixture-browser.log` |

The first continuation transport test assertions incorrectly matched error message against code;
they were corrected to inspect structured code, then passed. The first packaged rehearsal exposed
workerd's unsupported `redirect:'error'` Fetch option; transport now uses `manual` and rejects non-2xx,
then all three actual journeys passed. Failed attempts are not counted as passes. The new
[onboarding screenshot](images/native-onboarding.png) was inspected by implementer and lead.

Cloud credentials and a dedicated allowed target were not present in the shell. A user question
requests the existing isolated test configuration/allowed scope or confirmation to keep cloud pending.
No secrets were printed, no private repository accessed, no deployment/provisioning/purchase performed.
The isolated target must not be the running control instance. See updated
[release-rehearsal.md](release-rehearsal.md) for executable runtime prerequisites.

**Next action:** complete the concrete native recovery audit/workflow; finish any independent local
G1 requirements. Run AN-21 only after an authorized isolated target/runner is available. The G1 goal
remains active, with no work beyond M5. This continuation does not mark G1 complete.


## Final continuation result: local recovery and verification

Additional independent implementation/review closed the concrete recovery gap. The new
`POST …/native/recoveries {manifestHash,expectedGeneration,idempotencyKey}` prepares an exact complete
historical source set under current knowledge/policy. The owner UI exposes **Review recovery to
project version …** in accepted history, then uses the existing fresh scenario, explanation,
approval and separate acceptance controls. No raw JSON or Git is needed for that owner journey.
Recovery never restores knowledge or silently deploys. The same SQLite transaction writes the
artifact restore version, heads, ref-reconciliation outbox, project manifest and idempotency.

Acceptance rechecks full current write access, current allowed approval role, immutable authority
revision, exact parent/policy, complete fresh evidence, and accepted historical source membership.
Generic recovery-preparation bypasses are refused. Imported archives cannot become local targets.
Declared/intervening effects, configured/recorded data migrations and unsupported current mandatory
artifact checks/contracts refuse recovery rather than treating them as reverted or verified. These
are bounded code-only recovery semantics; arbitrary persistence/framework recovery is not claimed.
Native release binding permits a separately verified accepted recovery, while metadata-only state
still cannot release source. Policy changes after preparation are covered by independent regressions.

Actual final packaged command `PORT=8939 PREVIEW_PORT=8940 pnpm test:g1:local` passed **all four** real
browser journeys (22.8s). The recovery ran nine fresh signed scenarios, accepted historical manifest
`f097186b97138563df60848459ab26b99b6a636d0c58199c413ca59c7e44d43c` as new manifest
`b86361f7d661472db86ce7495c4611a058b0c26cd4846c81f5cc1b451185ad99`, and retained current knowledge
`6e0306a76a72b1fe60ee6a2c54d409c2a6a43ec6ac7fd1b52cc55932d449be88`.
The wrapper now waits for exact restored heads to become `synced`, then performs an actual smart-HTTP
Git read verifying SHA `547a4e7a795521d93cc06c3f7b61c63e37fe2142`. It independently executes all nine
scenarios again against that exact canonical module in namespaces, confirming ruleVersion2 and
removal of the later source-only reviewReady field. The accepted artifact is `av-000000000005`.

The first recovery browser run accepted correctly but stopped the local stack before ref delivery;
the follow-up read caught pending reconciliation. That run is not counted as a complete provider
recovery gate. Local emulator queue delivery is process-local; ledger records are durable. The test
and wrapper now keep the stack alive through actual reconciliation and the independent canonical
source check. No source ref was manually forced to create a passing result.

Public evidence: [recovery report](evidence/recovery-report.json),
[browser acceptance](evidence/recovery-acceptance.json), and [review screenshot](images/recovery-accepted.png).
The screenshot was inspected. CI uploads only bounded sanitized reports/acceptance/PNGs, never operator
files, raw logs or session data. The final task-owned stack was stopped gracefully; retained state is
`/tmp/commonforge-g1-real-worker-uYQgeq`. No unrelated process or data was touched.

Final verification after recovery integration:

| Command | Result |
|---|---|
| `pnpm typecheck` | pass, 21 tasks; `.g1-artifacts/recovery-final-typecheck.log` |
| `pnpm build` | pass, 13 tasks; `.g1-artifacts/recovery-final-build.log` |
| `pnpm exec turbo run test --concurrency=1` | pass, 21 tasks, **3,013 passed /5 existing skips**; Worker965, ledger204, web661, runner171; `.g1-artifacts/recovery-final-all-test.log` |
| `pnpm test:security` | pass, **387 passed /1 existing skip**; `.g1-artifacts/recovery-final-security.log` |
| `pnpm test:fault` | pass, **20 tests**, including actual acceptance/genesis/recovery SQLite faults; `.g1-artifacts/recovery-final-fault.log` |
| Packaged real-local | pass, actual API/Git/runner/R2/preview, four browser journeys and exact canonical recovery/namespace check; `.g1-artifacts/native-recovery-real-local-final.log` |

Continuation implementation before recovery was committed as `98c4f57`. Recovery code and its
updated evidence were committed as `678970c` (`Add verified historical source recovery under current project requirements`). Full G1 remains **not achieved**:
AN-21 requires authorized isolated remote Cloudflare release, observation, freshness expiry and recovery.
The HTTPS/workerd supervisor is locally executable and verified for its bounded shape; deployment
infrastructure/credentials/target authorization remain unspecified. The user clarification is pending.
No cloud operation, private repository access, purchase, push or publication occurred.

Remaining bounded limitations are documented in local-workflow.md and release-rehearsal.md: existing
source attach/detach/import and shared staging unsupported; source/knowledge acceptance two-step;
mandate renewal via replacement handoff/context, not transparent token extension; failed directory
barriers require quiescent operator repair; Git bundle materialization absent; conservative payload
and mount-reservation retention; one bundled vars-only workerd target. These must remain visible.

**Next action:** obtain the existing isolated test target/configuration and allowed scope, then run
remote supervisor/provider integration and AN-21's release/observe/expire/recover sequence. Reassess
any unfulfilled local contract before claiming G1 complete. Do not proceed to M6–M8. The goal remains
active; all work in this continuation stayed within G1.

Final continuation commits: `98c4f57` (native onboarding/workerd/authority), `678970c` (usable historical recovery), followed by this documentation-only revision record. No push/publication. Working tree clean after the revision-record commit. Goal remains active pending the remaining G1 live gate and any subsequent completion-audit findings.

## Completion-audit continuation (in progress)

The preceding turn made progress (`98c4f57`, `678970c`, `95bf15c`), not a verified wait.
A fresh requirement-by-requirement audit of current committed sources found additional explicit
local work; earlier green gates do not prove these missing behaviors:

- W04 generic `renewMandate` changed revision/expiry but left the task attempt/context and D1 lease
  pinned to the old grant, returning success for unusable renewal. Implementation is replacing this
  with explicit human-authorized renewal, a new one-use handoff/fresh workspace/context, CAS and
  durable idempotency. In-place renewal now refuses with a replacement-handoff explanation.
- W02/W07 had no scenario archive operation. Added immutable `archiveScenario`, current-knowledge
  invalidation and retained evidence/history; owner controls show Archived and allow correction.
  Two targeted pure ledger tests pass. Actual browser archival/reload is added to the packaged
  first journey, awaiting integrated run. A test initially reused the old decision ID and hit the
  expected uniqueness guard; the corrected stale-revision test uses a fresh decision ID and passes.
- W05 startup/build/isolation/transport failures could leave a verification reservation pending
  without durable execution error history. Implementation now distinguishes candidate execution
  after an established sandbox from unavailable execution, retaining both honestly; integration
  and security review are underway.
- W09 exported original imported history only as an API sidecar, so a second export/import lost
  that origin history. A bounded explicitly versioned lineage bundle is being implemented with
  v1 compatibility, exact ancestor digests and inert authority/evidence across generations.

Subagents have disjoint implementation ownership for renewal, verification failures and lineage;
lead owns scenario archival and integration. Shared migrations remain serialized. No new cloud,
private-repository, publishing or infrastructure action is authorized/performed. The isolated-target
question remains pending. Do not claim full G1 or these audit fixes complete until integrated evidence
is recorded below. Next: finish these four local requirements, review failures, run targeted then
relevant integrated/security/fault/browser checks, and refresh the acceptance record.

### Live prerequisite discovery during completion audit

The shell lacked CF_* variables, but `wrangler whoami` proved an existing OAuth session with
Artifacts scope. Read-only D1 inventory and Worker settings found the historically owner-approved
CI target documented in `scripts/deploy-ci.sh` / `scripts/ci-config-core.mjs`: commonforge-ci-worker,
commonforge-ci D1, commonforge-ci namespace, -ci queues, log-mode auth, cfci release prefix. Every
scope value matched; CI D1 differs from production D1 (production settings were read only to prove
that separation). The user's original authorization permits existing isolated test infrastructure
within its established scope, so missing shell variables alone are no longer a live blocker.
No remote mutation has occurred at this checkpoint. Task-private generated CI config and metadata
are ignored under .g1-artifacts; OAuth token was never printed or committed. A dedicated phased live
rehearsal is being prepared/reviewed, and the candidate CI deployment will wait for local validation.
No production changes, private repo access or paid infrastructure are authorized.

## Completion audit: integrated local verification

All five audit gaps are implemented and integrated: explicit renewed handoff with fresh task
attempt/context/workspace and durable idempotency; immutable scenario archival; durable failed,
unavailable and superseded verification history; exact inert multi-generation bundle lineage;
and outcome editing with immutable history. Independent review additionally caught and fixed
credential filtering for cfl/cfh tokens and preserved original v1 aggregate payload compatibility.
See renewal.md, agency-consumer.md and live-ci-rehearsal.md for bounded operational contracts.

Latest integrated gates (2026-10-17):

| Gate | Actual result |
|---|---|
| typecheck / build | pass, 21 /13 tasks; audit-final-reviewed logs |
| full unit suite | 3,046 passed /5 existing skips, 21 tasks; audit-final-unit.log |
| security | 392 passed /1 existing skip; audit-final-security.log |
| faults | 20 passed; audit-final-fault.log |
| actual packaged local | five browser journeys plus real API/Git/runner/R2/preview/recovery canonical inspection; audit-real-local-verified.log |
| bounded live fixture preparation | three tests, actual workerd for both variants; audit-cloud-plan-tests.log; no cloud claim |

Browser failures during development exposed a real changing accessible-label bug (fixed using
stable labels) and two stale test locators/text expectations (fixed). Only the final five-pass run
counts as the browser gate. Inspected screenshots scenario-archived.png and
outcome-revision-history.png and refreshed sanitized recovery evidence are retained in evidence/.
Renewal tests use real file Git and an explicit fake control plane; actual remote renewal is not
claimed. Unavailable isolation tests establish refusal, never simulated successful execution.

The previously unspecified live prerequisite is now resolved by verified existing CI scope.
Next: deploy this reviewed revision only to commonforge-ci-worker with its existing isolated
D1/queues/R2/namespace; obtain a synthetic log-mode owner session and new task-owned organization;
execute the dedicated live release/real-five-minute-expiry/recovery phases. Existing CI secrets
are preserved. No production mutation, private repo, package publication, purchase or push.
AN-21 remains not_run until empirical remote evidence is recorded. Goal active, M0–M5 only.

### Isolated live execution started

Audited local implementation committed as `93aad88`. Existing CI-only migration and Worker
deployment completed; /health reports deployment=ci, emailMode=log. No infrastructure setup or
secret replacement was run. A new synthetic owner and new task-owned organization/project were
created; actual Sandbox folder initialization completed with a real Git head. The registered
source supervisor reports matching verifier/runtime digests and nine scenarios through HTTPS.
CI-only verifier transport configuration was deployed; no production mutation occurred.
Private operator state/logs live under ignored .g1-artifacts/live-* (must not publish checkpoint).
Independent review found and is tightening name-only project adoption and interrupted-push
resumption in the rehearsal; product/release target checks and credential/report filtering passed
review. Actual source/release/expiry/recovery gate still pending; do not count this setup as AN-21.

### First actual isolated cloud release verified

CI source cycle accepted manifest `05fc083c29ea5caef2d11abe94fce97467e878336653ae33ee400465e1838df3`
with nine signed checks of exact registered Artifacts source. Actual release
`rel-e4618516f2fa987ff64714cf` built output
`27940a79f4355cacbe140cb96aa5d1180fc84103e16a911d83337004c156ee45`, was separately
publish-approved and deployed. Actual HTTPS `/version` matched, all nine deployed behavioral
scenarios passed and a healthy release observation was persisted with exact manifest/output binding.
Its real freshness deadline is `2026-10-17T22:08:08.138Z`. An early expiry read honestly returned
not_run with that deadline. No clock override. AN-21 remains partial until expiry and recovery.
Rehearsal interruption/name-adoption safeguards committed as `ddc72d1`; seven actual local
Git/workerd tests plus runner build/typecheck passed. Signed source verification and actual
Cloudflare output remain separately identified, not inferred byte equivalence.

### Real freshness expiry verified

At `2026-10-17T22:08:21.714Z`, after the actual `22:08:08.138Z` deadline, the initial live
release API reported `healthState:unknown`. No clock override or fabricated result. Recovery
phase is now running against the same isolated project/target, first creating a distinct later
source/release before restoring the first accepted source under unchanged current knowledge.
AN-21 remains incomplete until the recovery release and its actual HTTPS behavior/observation pass.

Independent re-review of `ddc72d1` confirmed both rehearsal findings closed: no name-only project
adoption, durable pre-push intent, exact remote verification and refusal of foreign movement.
An interruption after successful freeze but before saving the candidate identifier may still
require operator inspection, as documented for interrupted external operations. No new blocker.

## Final G1 completion record

All required technical gates now pass. Actual isolated cloud report is retained at
`docs/agent-native/evidence/live-cloud-report.json`, not the private operator checkpoint.

| Live phase | Empirical result |
|---|---|
| Initial | exact accepted manifest, separately approved built output, actual release identity and nine deployed HTTPS scenario passes, bound healthy observation |
| Expiry | actual `2026-10-17T22:08:21.714Z` read after five-minute deadline reports unknown; no clock override |
| Later | distinct source/accepted manifest and output; actual separately approved deployment and nine HTTPS passes |
| Recovery | fresh nine signed checks and exact owner-role decision, atomic accepted source recovery, unchanged current knowledge, separately approved third deployment, actual historical variant and nine HTTPS passes, new bound healthy observation |

Recovery manifest: `c7077a80ca3ea2f0880f2f621b8133eeafadb5b4b4088f3cd36b50a86280b512`.
Recovery release: `rel-fcaf0253609f3ab5adf11532`; output
`d801d3e2948eb4c9343c6361ccc8c741b393b870c25ed2c9c8b4b0d2caff49fc`.
All three deployments use the same exact task-owned cfci target. The source supervisor ran real
isolated workerd against exact remote Artifacts source; actual Sandbox builds and actual deployed
HTTPS cases are separately recorded. There is no inferred compiled-byte equivalence or mocked
cloud pass. Scripted owner decisions are synthetic automation, not observed human validation.

Cleanup: CI-only temporary verifier URL removed by successful deployment; /health still reports
ci/log. Task-owned supervisor/tunnel stopped and loopback port verified closed. Existing CI secrets,
production resources and unrelated processes were unchanged. Synthetic project/Git history/evidence
and the stateless cfci recovery deployment remain for inspection; health is a time-bounded observation
and will become unknown. A new run requires an operator-configured trusted HTTPS supervisor.
No permanent supervisor infrastructure or new database/bucket/queue was provisioned.

Verification totals remain: 3,046 full-suite unit passes /5 existing skips; 392 security passes
/1 existing skip; 20 fault passes; five actual real-local browser journeys plus canonical recovery;
21-task typecheck and 13-task build. Subsequent rehearsal-only safeguards passed seven targeted
real Git/workerd tests and runner build/typecheck. Skips do not substantiate any real gate.
Public report passed independent structural assertions and credential scan. Independent requirement
review found no further local M0–M5 blocker; independent safety review confirmed its findings fixed.

Known bounded limits: dedicated source membership/no shared staging; metadata and source changes
accepted in two steps; explicit renewal creates a fresh attempt/context/workspace; directory-barrier
repair may need quiescent operator work; interrupted external operations may require inspection;
Git content is not automatically restored from metadata bundles; conservative permanent evidence
retention/tombstones; one bundled vars-only Worker runtime with no persistent/external effects;
same-family fresh agent only; no observed domain-expert human usability or continuous monitoring.
Legacy workflows, original v1 hashes and prior migrations remain compatible. Agency extraction stays
incremental, with only the synthetic consumer contract in this public repository.

**Next recommended goal:** validate the public reference workflow with domain experts, then start a
separately authorized private agency consumer integration using the existing public contracts.
G1 stops here. M6–M8 are not started. No branch push, PR or package publication is performed.

Final independent AN-21 evidence audit passed: three distinct releases and 27 actual deployed
HTTPS cases, exact observation subjects and 300-second bounds, real expiry to unknown, restored
initial source, unchanged current knowledge, and credential/local-path scan clean. Observation
`environment:production` denotes the release channel within the isolated CI project; control
Worker and deployment targets remain commonforge-ci-worker/cfci, not production infrastructure.

## Landing review and CI portability fixes

PR #1: https://github.com/CommonForge-org/commonforge/pull/1.
The landing review rechecked acceptance, scoped agent authority, evidence binding, legacy source
guards, and release binding. Local typecheck/build passed. A fresh uncached full unit run reported
3,053 passes and five skips before correcting duplicate discovery described below.

The first PR CI run exceeded the default five-second timeout in the test performing two real
isolated workerd builds/verifications. That integration test now has an explicit 30-second timeout;
all seven tests in its file passed locally with unchanged behavioral assertions.

The next CI run exposed source-adjacent ledger tests being emitted into `dist` and then discovered
again by Vitest. Ledger builds now exclude `src/**/*.test.ts`, and test discovery excludes `dist`
even when stale output exists. The multi-megabyte bundle compatibility/limit tests have explicit
30-second timeouts without reducing payload sizes or assertions. Ledger build/typecheck and all
176 source tests passed after the fix; build-file inspection confirms source tests are excluded.
Earlier aggregate unit totals include 44 duplicate ledger tests and must not be interpreted as
unique test counts. PR checks are the authoritative landing result for the final head.
