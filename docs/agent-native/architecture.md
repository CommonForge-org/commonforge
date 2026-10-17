# Architecture for the first agent-native slice

Status: proposed. Read the [product direction](README.md) first. Names below are proposed
contracts, not assertions that matching exports already exist.

## Existing foundations and constraints

| Existing surface | Reuse or change |
|---|---|
| `packages/core/src/schemas.ts`, `proposal.ts`, `snapshot.ts` | Preserve current hashes; add explicitly versioned project contracts |
| `packages/ledger/src/plan-commit.ts`, `store.ts` | Reuse pure atomic acceptance; extend for project-level acceptance |
| `apps/worker/src/ledger/{schema,sqlite-store,org-ledger}.ts` | Authoritative project knowledge and acceptance state; append migrations |
| `apps/worker/migrations/`, `src/services/` | Directory/search projections and API orchestration; not a second authority |
| `packages/runner-protocol`, `apps/runner/src/` | Signed verification, isolation, job/result binding, real source operations |
| `apps/worker/src/routes/tasks.ts`, `services/auth.ts`, `middleware/authz.ts` | Task-scoped handoff and context access instead of broad user impersonation |
| `apps/cli/src/{checkout,submit,mcp}.ts` | Pinned context, attempt identity, evidence inspection, and correction proposals |
| `apps/web/src/screens/{Overview,ChangeStoryboard,ProposalReview}.tsx` | Outcome-oriented overview and behavioral review |
| `packages/conformance`, worker security/fault tests | New acceptance and provider invariants in existing testing structure |
| `scripts/dev-local.sh`, worker fakes | Current local stack simulates runner/source behavior; add a distinct real-runner rehearsal |

Current `planCommit` checks exact proposal hashes, current policy, approvals, expected heads,
dependencies, prepared receipts, and evidence. The application verifies signatures and approver
authority; the pure ledger does not itself perform asynchronous cryptographic verification.
Preserve that separation explicitly, with verified persisted records crossing the boundary.

Current project versions describe changed resource heads. They are not complete snapshots of
domain knowledge or deployed runtime state. Current handoff opens a broad user session, though
task leases exist. Both gaps matter for the new design.

## Authority and storage

Keep one OrgLedger Durable Object as the initial atomic boundary. Add per-project records inside
it for knowledge heads, project mode, mandates, project proposals, evidence bindings, and accepted
project manifests. In-memory and SQLite implementations must share the same pure decisions.

Large attachments and logs live in R2 under content hashes. Store their references, verified
digests, sizes, media types, and retention roots in the ledger. D1 may project list/search views
through the existing outbox. Reads used to approve or accept must use authoritative ledger state.
An index lag must not make an obsolete rule or revoked mandate acceptable.

All writes use expected revision and idempotency keys. Cross-project references are refused even
inside the same organization unless a future explicit import mechanism permits them. Transactions
perform no network I/O. Prepare and validate blobs first, then commit references; orphan cleanup
handles failed transactions. Retain accepted manifests and referenced evidence; expire abandoned
attempts according to a documented retention policy. Downloads recheck access and redact secrets.

## Minimal records

Every mutable conceptual object has a stable ID and immutable revisions. Records include
organization/project scope, schema version, author principal, timestamps, and content hash.
Current pointers change with compare-and-swap; history is append-only except explicit retention
or deletion procedures. Do not introduce a generic graph database or arbitrary schema engine.

| Record | Required meaning and fields beyond common metadata |
|---|---|
| Outcome | Description, owner, success criteria, state, linked tasks; achievement recorded separately from release |
| KnowledgeRevision | Kind `rule`, `decision`, or `assumption`; text, source references, rationale, predecessor, confirmation record |
| KnowledgeHead | Monotonic project generation and hash of current confirmed revisions/scenario definitions |
| ScenarioRevision | Given/when/then, rule references, importance, manual or executable method, verifier definition digest |
| Attempt | Task, agent identity, mandate, pinned context digest, start/end, status, submitted candidate references |
| Mandate | Task/project scope, permitted operations/resources, issuer, expiry, revocation generation, execution limits |
| ContextPacket | Outcome/task revisions, confirmed rules, labeled assumptions, scenario revisions, source snapshot, mandate reference, omissions |
| ProjectProposal | Versioned acceptance envelope described below, immutable once offered for review |
| ScenarioEvidence | Exact envelope and implementation subject, scenario/verifier revisions, run/actor identity, result, timestamps, attachments |
| ProjectDecision | Envelope digest, human principal, approve/reject/correct/defer, explanation, authority revision |
| ProjectManifest | Parent manifest, complete accepted resource references, knowledge head, envelope/decision/evidence references |
| ReleaseObservation | Release identity, target/environment, check definition, observed result, timestamp and freshness limit |

Suggested results for scenario evidence: `pass`, `fail`, `error`, `not_run`. Freshness and
supersession are computed applicability states; do not mutate a historical pass into a failure.
Human observations additionally record the exact reviewed preview/build and observer.

An agent may draft knowledge and scenarios. Confirmation is a separate authorized operation.
Drafts do not silently join the confirmed knowledge head. Changing a confirmed rule creates a
revision, keeps its provenance, and advances the head. Archived rules remain in history and
leave the current set through an explicit decision.

For the first slice, owners/developers may confirm knowledge; agent principals cannot. Give the
reference product owner domain-friendly labels without changing the meaning of legacy roles.
More granular expert roles are deferred. Membership revocation must still revoke effective access.

## Context and continuity

Generate context on the server with deterministic ordering and canonical serialization. The
packet pins exact revisions, and the workspace carries the packet digest. Generate readable
Markdown plus machine-readable JSON in the existing protected `.commonforge/` location.
User/agent edits to those files do not change authoritative knowledge.

Include all confirmed project rules and scenarios for the small first slice, plus explicitly
linked source context. Apply access filtering before serialization. If a required rule or
scenario is inaccessible, refuse assignment with a non-disclosing explanation rather than
silently supplying incomplete authoritative context. Optional omissions are labeled. Never
expose restricted titles, paths, attachment URLs, or counts through omission diagnostics.

Set explicit byte/count limits and return `context_too_large` rather than silently truncating.
The initial strategy uses bounded structured retrieval, not embeddings. Later retrieval can
select a subset while retaining a manifest of dependencies and disclosure rules.

At submission, compare the pinned knowledge head with the current head. The first implementation
conservatively requires refresh/reverification after any confirmed knowledge/scenario change.
This deliberately invalidates some unrelated work. Fine-grained invalidation comes after the
safe path works and false invalidations are measured.

Untrusted documents and repository instructions are source material, not grants of authority.
A context packet must never contain broad login codes, provider credentials, or signing keys.

## Proposal and evidence binding

Preserve all existing v1 hash encodings and their interpretation. Add a new outer acceptance
envelope with a distinct domain tag, for example `cf.project-proposal/1`. It binds:

- Organization/project, outcome revision, attempt ID, and mandate revision.
- Existing artifact proposal ID and hash, if there are source/asset changes.
- Resolved artifact revisions and preview/build subject to be accepted, including integration
  output rather than only the isolated candidate when integration is required.
- Expected project-manifest parent and expected confirmed knowledge head.
- Proposed knowledge/scenario revisions, if any.
- Context packet digest and explicit required scenario/verifier revisions.
- Policy revision, recovery-plan digest, and declared external effects.

Hash canonical definitions and references, not mutable display summaries. The evidence points
to the envelope digest; the envelope must not include that evidence, avoiding a hash cycle.
Knowledge-only proposals are permitted through the new path. Do not fabricate a source change
to satisfy legacy `planCommit`, which correctly refuses an empty resource change.

Prepare/integrate the inner artifact proposal before freezing the outer envelope; then execute
the behavioral verification and obtain the owner's decision. If integration output changes,
create a new envelope and require new behavioral evidence and approval. This prevents a clean
merge from silently changing the implementation after the owner reviewed its preview.

Bind scenario results additionally to the exact source tree/build evaluated, runtime recipe,
and verifier digest. Existing artifact evidence and new scenario evidence have different
purposes; neither implicitly substitutes for the other. A changed integration result requires
evidence for that result, not a pass from an earlier isolated candidate.

Scenario selection comes from the accepted knowledge/policy plus confirmed additions, not an
agent-supplied subset. Initially run all required project scenarios. Missing, failed, errored,
or inapplicable required evidence blocks acceptance. There is no implicit waiver in this slice.

Manual scenarios require an authorized human attestation against the exact envelope and
preview/build. Automated results require verified runner provenance. An agent's assertion or
uploaded JSON is an explanation, not an attestation.

Verifier definitions are independently pinned and approved. Run approved checks outside the
candidate's writable control, against the candidate application. Candidate-owned tests remain
useful supplementary evidence but cannot replace required project scenarios. Changing code
and weakening the verifier in one proposal must visibly require approval of the verifier change
and fresh execution. Signing a result proves provenance and binding, not completeness or that
the underlying business rule is correct.

## Atomic acceptance and compatibility

Add a pure `planProjectAccept` operation and matching store ports in the existing packages.
It verifies stored envelope integrity, current project mode, expected parent/knowledge head,
current policy, active authority, exact decision binding, required evidence, and idempotency.
For artifact changes it invokes the existing artifact acceptance checks in the same transaction;
for knowledge-only changes it applies its own revision checks. All resulting writes commit
together: source heads where applicable, knowledge head, accepted project manifest, decision
link, audit, idempotency, and outbox. No D1 write followed by a ledger write may masquerade as
atomic acceptance.

New project decisions explicitly bind both the envelope digest and its inner artifact hash.
An internal adapter may supply the existing artifact ApprovalRef only after validating that
dual binding and approver authority. Never accept a legacy artifact-only approval as approval
of the outer envelope. Keep legacy idempotency scopes intact and add a project-accept scope.

An enabled project must reject legacy acceptance paths that lack the envelope. Audit every
path: direct proposal acceptance, promotion, files/assets, restore, and release preparation.
Either integrate the path or return an explicit unsupported-mode error. Staging/promotion is
disabled for newly enabled projects in the first slice; existing legacy projects retain it.
Metadata-only knowledge confirmation goes through the new atomic operation as well.

A knowledge-only acceptance records what the owner now requires; it does not assert that the
currently deployed implementation satisfies the new rule. It can advance knowledge while
marking behavior verification outstanding and opening linked work. Do not require the old
implementation to pass a newly introduced requirement before the owner can record it. Source
acceptance and release under that requirement do require the applicable scenario evidence.

Project mode defaults to legacy for existing projects and agent-native for new projects created
through the new reference onboarding. Migration to agent-native is explicit, requires no in-flight
operations, seeds a genesis manifest from accepted heads, and records that imported history has
no retroactive behavioral evidence. Do not auto-enable existing installations. Do not permit
downgrade as a bypass once enabled; reversible UI flags are different from authority mode.

New manifests point to existing accepted source versions where applicable. Use a separate
project-manifest sequence; do not reinterpret legacy organization-wide accepted-version numbers.
Persist complete head references for the first slice rather than forcing every reader to replay
an event history. Old manifests and proposals remain readable after upgrades.

## API and agent-tool surface

W01 freezes concrete route names to match the repository's routing conventions. The following
operations are required; avoid implementing different business logic separately in UI, CLI,
and MCP. All mutations return stable identifiers/revisions and support idempotency; lists use
bounded cursor pagination. Authorization scopes every read and mutation to the project/task.

| Operation family | Minimum operations |
|---|---|
| Outcomes | Create, read/list, revise, record achieved/deferred status |
| Knowledge/scenarios | Draft, read/list revisions, propose correction, confirm, supersede/archive |
| Task/attempt | Issue/exchange handoff, checkout context, inspect attempt, submit, renew/revoke mandate |
| Project proposal | Prepare, inspect, request verification, inspect evidence, record decision, accept |
| Release/recovery | Prepare from manifest, approve/publish, read observation, propose recovery |
| Portability | Export manifest/bundle, inspect completeness, validate/import into a new project |

Keep existing task/source operations where they fit; add explicit new operations for project
semantics. A server advertises supported project/protocol versions. New-mode clients must refuse
unsupported servers/runners instead of silently falling back to legacy acceptance.

Return structured refusal codes such as `knowledge_stale`, `context_too_large`,
`mandate_revoked`, `scenario_evidence_missing`, `review_subject_changed`, and
`project_mode_unsupported`, with non-sensitive remediation details. Exact names are locked in
W01. Concurrent mutation conflicts should identify the current authorized revision; unauthorized
callers must not learn that a hidden object exists from differing error details.

## Agent mandates

Use the existing task lease/broker mechanisms where possible, adding a single-use task-scoped
handoff exchange. Exchanging it creates only a task/attempt-scoped principal, not a seven-day
user session. Initial capabilities: read permitted context, checkout allowed resources, submit
candidate work, propose knowledge corrections, and inspect one's own attempt results.

Agents cannot confirm rules, approve their own proposals, alter project policy, or deploy.
Use a default one-hour mandate with explicit renewal, bounded attempt/job counts, and runner
timeouts. Do not claim hard monetary control over externally operated agents. Record reported
usage separately from trusted platform-measured usage; unknown remains unknown.

Store mandate revocation generation in the authoritative ledger. Acceptance checks it atomically.
Credential issue and each control-plane operation check active scope. Membership/access
revocation must invalidate associated mandates before the revocation operation reports success;
on partial failure deny new access and retry reconciliation. Document that an already issued
provider token has a bounded residual lifetime; revoke it and prevent revoked work being accepted.
Do not promise instantaneous termination of external agents.

## Release, observation, and recovery

Acceptance does not deploy. Existing release machinery receives an accepted project-manifest
reference and verifies its artifact mapping. Display the knowledge revision associated with
that release even when newer knowledge exists.

First release scope: the existing Cloudflare Worker target and a stateless/synthetic fixture.
Reuse the existing release health check as a bounded observation, adding its exact subject,
timestamp, definition, and freshness. No recurring scheduler is needed for this slice. Expired
observations are unknown; a check against a preview cannot establish production health.

Recovery creates a new accepted project manifest referencing a previously accepted artifact
version, then an explicit release. Reevaluate current required scenarios or require an explicit
future emergency policy; this slice has no emergency bypass. Do not automatically rewind current
business knowledge to match old code. Preview what the recovery affects before acceptance.

Code recovery does not undo database writes, migrations, sent messages, or external actions.
The first slice refuses automated recovery claims for unmodeled external effects. Persistent-data
deployment/migration support is later work requiring an explicit recovery contract.

## Portability and extension boundaries

Export a versioned bundle containing manifests, knowledge/scenarios, decisions, evidence metadata,
available attachments, and source references plus source content when requested/available.
Never export live credentials. A reference-only bundle is not labeled a complete backup.

Import validates hashes and versions, remaps local identities, and retains provenance without
granting imported principals authority. Imported evidence is historical/untrusted for local
acceptance until locally reverified. Include a round-trip test with no private identifiers or
dependencies. Start with explicit API/CLI bundle operations; federation and a catalog are deferred.

Keep core decisions Worker-safe and provider-independent. Use explicit types and narrow ports
for artifact storage, verification execution, deployment, and identity. Do not add unused
framework abstractions or extract every service into a new package before a second consumer
demonstrates the need.
