# G1 execution status

Updated: 2026-10-17. Goal: durable project understanding across agent handoffs (M0–M5 only).

**Current result:** the real-local implementation and actual fresh-agent continuity are validated.
Full G1 is **not achieved**: the matching Cloudflare deployment-runtime verifier and authorized
isolated live release/observation/recovery rehearsal remain outstanding. No production change,
private repository access, visibility/license change, package publication or infrastructure purchase
was performed. See the final gate record below; earlier entries are chronological checkpoints.

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
| W07 reference UI | locally verified | real owner browser correction, preview, review and acceptance; explicit enablement |
| W08 release / recovery | partial | bindings/refusals/freshness verified; production runtime/live gate outstanding |
| W09 portability / agency contract | locally verified, bounded | history/evidence payloads without trust; Git restoration not implemented |
| W10 integrated review / rehearsal | local gates verified | actual fresh-agent/self-development evidence; full release gate not achieved |

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

Code revision: implementation commit recorded after staging below. Baseline `d5ab4eb`; isolated
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
| AN-15 | pass | release/core tests distinguish accepted/deployed/healthy/unhealthy/expired-unknown; no live G1 deployment claimed |
| AN-16 | pass (local invariants) | recovery binds historical complete source heads under current knowledge; declared external effects refused; native automatic legacy rollback disabled; successful cloud recovery remains AN-21 |
| AN-17 | pass | bundle conformance + actual API history round-trip, real R2 payload export; imports create local drafts/authority and retain untrusted exact archive; Git is not automatically restored |
| AN-18 | pass | legacy core vectors, ledger/Worker migration and full existing suites; shipped SQLite migrations 1–3 unchanged, native migration 4 appended; D1 0019 appended |
| AN-19 | pass | actual credentialed smart HTTP clone/push/revoke, Node runner, R2, static and isolated API preview; `test:g1:local` and retained real reports |
| AN-20 | pass | actual fork-none Codex implementation, exact context/input hashes, real verification and accepted manifest described above |
| AN-21 | not_run | no matching production runtime verifier/authorized isolated Cloudflare release, observation and recovery run; this blocks full G1 achievement |
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
