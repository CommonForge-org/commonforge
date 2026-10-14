# @commonforge-org/core

Shared engine contracts for CommonForge: identities, Zod wire schemas, content hashing, path
policy, edition mapping, state machines and provider interfaces. Worker-safe (no `node:` imports,
no `Buffer`; the build compiles with `lib: ["ES2023", "WebWorker"]` and `types: []`, so a Node global
fails the build). Hash functions are **async** (WebCrypto `crypto.subtle`), and each has a
**synchronous** twin backed by a dependency-free pure-TypeScript SHA-256 (`sha256HexSync`,
`hashCanonicalSync`, `computeSnapshotIdSync`, `computeProposalHashSync`, `computeAssetManifestIdSync`)
for synchronous contexts such as the ledger's `planCommit` inside `transactionSync`. Outputs are identical.

| Module | Contents |
|---|---|
| `ids.ts` | Branded ids + schemas, constructors and parsers (`RevisionId`, `CandidateId`, `SnapshotId`, `ProposalHash`, `ManifestId`, …), service ref helpers |
| `schemas.ts` | Zod schema `FooSchema` + inferred type `Foo` for every §B.1–B.13 wire type and shared records/receipts |
| `canonical-json.ts` | `canonicalJson`, `sha256Hex`, `hashCanonical`, `sha256HexSync`, `hashCanonicalSync` |
| `sha256-sync.ts` | `sha256Sync` (pure-TS FIPS 180-4) |
| `snapshot.ts` | `computeSnapshotId`, `verifySnapshotId`, `canonicalSnapshotPayload` |
| `proposal.ts` | `computeProposalHash`, `verifyProposalHash`, `canonicalProposalPayload` |
| `manifest.ts` | `computeAssetManifestId` |
| `path-policy.ts` | `normalizePath`, `checkPath`, `findCaseFoldCollisions`, `checkEntry`, `matchesPathPattern`, `isWithinPrefix` |
| `edition.ts` | `diffAgainstInventory`, `mapEditionDelta`, `mapEditionPath` |
| `state.ts` | State enums and transition tables for Change, TaskWorkspace, Candidate, Proposal, Preview, Release, canonical-ref reconciliation |
| `capabilities.ts` | `CapabilityError`, `requireCapability`, `DEFAULT_CAPABILITIES`, `VersionProvider`, `AssetProvider`, `ConnectedProviderWriteback`, `RunnerSubmit` |
| `errors.ts` | `CoreError` (stable `code`), `PathPolicyError` |

## Identity formats

- Opaque ids (`ResourceId`, `ChangeId`, `TaskWorkspaceId`, `ProposalId`, `AcceptedVersionId`, `ReleaseId`, org/project ids): `[A-Za-z0-9][A-Za-z0-9._-]{0,127}` with no `..`, no trailing `.` and no `.lock` suffix. UUIDs qualify; `:` and `/` never appear, so ids embed safely in other ids, keys and git ref components.
- Git refs (`GitRefSchema` / `isValidGitRef`) follow `git check-ref-format` (≥2 components; no `..`, `@{`, control chars, space, `~^:?*[\`; no component starting with `.` or ending `.lock`; not ending `.`), verified against real git in `git-ref.test.ts`. Ref helpers (`candidateRetentionRef`, `integrationJobRef`, `checkpointRef`) validate their output. `integrationRef(proposalId)` is deprecated: integration results go to the per-job ref `refs/commonforge/integrations/<proposalId>/<jobId>` (`integrationJobRef`; runner-protocol's `jobIntegrationRef` is the same value).
- Timestamps everywhere (`IsoUtcTimestampSchema`, alias `TimestampSchema`) are UTC with `Z` and exactly millisecond precision — `new Date().toISOString()` / `toIsoUtc()`. A single spelling makes timestamps hash deterministically and compare correctly as strings (`approvedAt` vs `ProposalRecord.updatedAt`).
- `RevisionId`: `art:<repoId>:<sha>`, `gh:<owner>/<repo>:<sha>`, `r2m:<sha256>`, `legacy:<projectId>:<version>`, plus **`local:<repoId>:<sha>`** for `LocalGitProvider` (so a local repo is never mistaken for an Artifacts one). Git shas must be **full** lowercase (40 or 64 hex); abbreviated shas are never identities.
- `CandidateId`: `cand:<taskWorkspaceId>:<sha>`.
- `SnapshotId`, `ProposalHash`, `ManifestId`: lowercase sha256 hex.
- Brands are output-only: `Schema.parse` / constructors produce branded values; `z.input<>` stays plain `string`. Test fixtures should use the constructors (e.g. `artRevisionId`) or `Schema.parse`.

## Hashing

All hashes are sha256 over `canonicalJson` (sorted keys, no whitespace, undefined properties dropped, strings not normalized; `undefined`/holes in arrays, NaN/±Infinity, bigint and non-plain objects throw). Every hashed payload carries a domain/version tag `$t` (`cf.snapshot/1`, `cf.proposal/1`, `cf.asset-manifest/1`) so payload changes can be versioned and types can never collide. Arrays that are semantically sets are sorted before hashing; `canonical*Payload` functions expose the exact hashed object.

- **SnapshotId** hashes `{projectId, organizationId, membershipRevision, policyRevision, entries}` with entries `{resourceId, revisionId, mode, mountName (NFC), operations (sorted, deduped)}` sorted by `resourceId` then `mountName`. `organizationId`, `mountName` and `operations` go beyond the §A.5 minimum because §B.3 hashes the whole snapshot except id/timestamp. Duplicate mount names are refused.
- **ProposalHash** hashes `{baseSnapshotId, candidateSnapshotId, resourceChanges, readDependencies, assetManifestChanges, policyRevision}`. `resourceChanges` = `{resourceId, baseRevision, candidateId, candidateRevision}`; `readDependencies` = `{resourceId, revisionId, mode}`; `assetManifestChanges` = `{resourceId, baseManifestId|null, newManifestId}`. Set arrays are order-independent; exact duplicates are refused.
- **ManifestId** hashes `{resourceId, parentManifestId, entries}` with entries parsed through `AssetManifestEntrySchema` (unknown keys stripped) and sorted by path.
- Hash functions validate structure, not id formats; wire boundaries validate formats with the schemas.

## Choices for types the plan leaves undefined

- **Coords** are tagged by `kind` equal to the `ProviderKind`: `ArtifactsCoords {namespace, repoName, repoId, remoteUrl}`, `LocalGitCoords` (same shape), `GitHubCoords {owner, repo, targetRef, installationId?}`, `AssetManifestCoords {bucket, prefix, manifestId|null}`, `LegacyStorageCoords {projectId, version}`. `RepoCoords` = Artifacts | LocalGit (repos the runner pushes to); GitHub writes go through `ConnectedProviderWriteback`. Remote URLs (`RemoteUrlSchema`) must start with a lowercase `https://`, `http://` or `file://`, may not embed credentials and may not contain whitespace, control characters or backslashes (values the WHATWG parser would silently repair are refused, so every consumer reads the same URL); remote URLs are compared by string equality. `MaterializationPlan.workspaceRoot` is an absolute directory (POSIX or Windows drive) without `.`/`..` segments.
- **FrozenCandidate** adds `fork: RepoCoords` (beyond §B.5): the task workspace's fork repository, so a `prepare-candidate` job knows where to fetch the candidate sha from. Coordinates only, never a credential.
- **ResourceRef** `{organizationId, resourceId, provider, authority, coords}`; `coords.kind` must equal `provider`.
- **PrincipalRef** `{kind: user|agent|service|runner|client, id, displayName?, onBehalfOf?}`.
- **TreeEntry** `{path, type: file|dir|symlink|submodule, mode?, oid?, size?}`.
- **ApprovalRef** `{approvalId, proposalId, proposalHash, approver, role, approvedAt}` — the ledger compares `proposalHash` and `approvedAt` vs `ProposalRecord.updatedAt`.
- **Receipts**: `PreparedReceipt {receiptId, jobId, candidateId, resourceId, canonicalRef, sha, revisionId, verifiedAssetObjects, preparedAt}`; `IntegrationReceipt {jobId, proposalId, results[{resourceId, integrationRef, sha, revisionId, expectedHead}], evidence, integratedAt}`; `ReconcileResult {ref, targetSha, observedSha|null, status: synced|diverged, …}`; `PreviewReceipt` (URL never contains the token); `EditionReturnReceipt {allowed, blocked, candidate?, expectedHead, …}`. `RunnerReceiptByKind` maps job kind → receipt.
- **CheckSpec** `{checkId, mountName, command, timeoutSeconds=600, required=true}`; **ContractSpec** `{contractId, version, producerResource, consumerResource, schema: {resourceId, path}, producerOutput: {mountName, command}}`; **BuildRecipe** `{recipeId, revision, steps[{stepId, mountName, command}], output?, envConfigDigest?}`.
- **AcceptedHead** `{resourceId, revisionId, versionSeq (per-resource, starts at 1), acceptedVersionId|null, acceptedAt, reconciliation}`.
- **ProposalRecord** = hashed fields + `{proposalId, proposalHash, organizationId, projectId, changeId, state: open|prepared|accepted|rejected|superseded|withdrawn, preparedReceipts[], createdAt, updatedAt}`.
- **IdempotencyRecord** `{key, scope: accept|restore|release|bind, requestHash, acceptedVersionId, createdAt}` — same key with a different `requestHash` is a conflict.
- **AcceptedProjectVersion** `{acceptedVersionId, organizationId, sequence (per org), kind: accept|restore|bind, proposalId|null, proposalHash|null, heads[{resourceId, revisionId, previousRevisionId, versionSeq}], actor, acceptedAt}`. `bind` (addition) is genesis (`planBindHead`); stores written before it existed hold genesis as `kind: accept` with `proposalId: null`.
- **CheckResult.required** (addition, optional; absent = `true`): copied from `CheckSpec.required`. The ledger refuses acceptance on a failed check only when it is required. It is optional rather than defaulted so that parsing never adds a key to signed evidence.
- **Provider errors**: `ProviderErrorCodeSchema` lists the codes every `VersionProvider` uses with the same meaning (freeze codes, `canonical_namespace_refused`, `namespace_refused`, `not_found`, …); providers extend it with their own codes. The `VersionProvider` JSDoc states the shared conventions (credential scope, `remoteUrl` is the provider's task-repo URL as returned by `createIsolatedChange`, `compare` on task-repo revisions, `listTree` root semantics, `collectWorkspace`, no fork lineage). A collected workspace refuses credentials with `workspace_not_writable` (local-git) or `not_found` (Artifacts). Providers must decide from the real workspace state; Artifacts needs its `workspace` resolver configured for that (it falls back to `handle.state` without one).
- **OutboxEvent**: discriminated by `kind` (`reconcile-ref`, `candidate-superseded`, `projection-refresh`) with `dedupeKey`, `attempts`, `deliveredAt`.
- **AuditEvent** `{auditId, organizationId, at, actor, action (dotted verb), subject {kind, id}, proposalHash?, detail?}`.
- **ReadGrant** `{principal, organizationId, resourceId, purpose, expiresAt}`; **ExportSink** `{kind: 'r2', r2Prefix}`.
- **`seed-workspace`** (addition to §B.8): `RunnerJobKind` includes it and `SeedWorkspaceReceipt {jobId, taskWorkspaceId, resourceId, ref, sha, seededAt}` is its receipt. Artifacts `fork()` cannot cross namespaces, so a task repo in `-tasks` is created empty and the runner pushes the base commit into it.
- **WorkspaceGrant.leaseExpiresAt** (optional, addition to §B.4): providers cap the credential TTL so it never outlives the task lease.
- **RunnerSubmit** is generic over `RunnerJobKind` and returns `RunnerOutcome<RunnerReceiptByKind[K]>`; the concrete `IntegrationJob` / `SignedJob` / `RunnerResult` live in `@commonforge-org/runner-protocol`, which builds on these types. `planCommit`, `CommitDecision`, `LedgerStore` live in `@commonforge-org/ledger`; `AcceptInput`, `RestoreInput` and `CommitRefusalCode` are here.

## Edition semantics (AT-29)

- `diffAgainstInventory(inv, returned, mode, deletions)`: `full` deletes inventory paths not returned; `partial` reports them as `omitted` and only deletes explicit `deletions`. Equal content → `unchanged`; deletions of unknown paths → `unknownDeletions`; an unambiguous 1:1 delete/add with the same sha256 → `renamed`. Duplicate returned paths, or a path both returned and deleted, throw `invalid_edition_return`.
- `mapEditionDelta(delta, manifest)`: longest `editionPathPrefix` wins (ties → `not_mapped`). Reasons are checked in order `path_escape` → `not_mapped` (incl. no canonical base) → `read_only` → `protected`. Every change is either allowed or blocked — nothing disappears. A rename stays a rename only when both sides are allowed in the same resource; otherwise it is split into `deleted(oldPath)` + `added(path)` and each side is mapped independently, so the outcome never depends on whether the diff's rename heuristic paired the files.
- `EditionManifestServerSide.protectedPaths` (addition to §B.13, default `[]`) holds canonical-path globs (`**`, `*`, `?`; a plain path also covers everything beneath it). `.git`, `.commonforge` and `.vibecontrol` segments are always protected.

## Deviations from the plan text

- Hash functions are async (WebCrypto), with synchronous twins.
- Hash payloads carry a `$t` domain tag (not in §A.5/§B.11 text).
- Candidate retention ref is `refs/commonforge/candidates/<taskWorkspaceId>/<sha>`, not `…/<candidateId>`: git ref names cannot contain `:`.
- State values are snake_case (`ready_for_review`), and `TaskWorkspaceState` includes `abandoned` and `read_only` (a workspace whose write access was removed for good without a freeze, e.g. a reference copy; only the consuming app's ledger records it). The proposal machine (`PROPOSAL_TRANSITIONS`) adds `prepared → open`. Transitions added for totality are marked `// addition` in `state.ts`: validating→needs_resolution, ready_for_review→integrating, stale→integrating|canceled, recovery_required→sync_pending|failed, provisioning→abandoned, provisioning|writable→read_only, read_only→abandoned|collected, frozen→collected, candidate frozen→superseded|rejected, preview failed|expired→queued, release recovery paths.
