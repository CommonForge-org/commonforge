/**
 * Zod schemas for every CommonForge wire type (plan §B.1–§B.13) plus the shared record and
 * receipt types the plan references but leaves undefined. Each schema `FooSchema` has an inferred
 * output type `Foo`. Choices for plan-undefined types are documented in packages/core/README.md.
 *
 * Conventions:
 * - timestamps are UTC ISO-8601 with `Z` and millisecond precision (IsoUtcTimestampSchema);
 * - resource-relative paths are normalized (see path-policy) — schemas reject non-normalized paths;
 * - unknown object keys are stripped on parse (forward-compatible readers).
 */
import { z } from 'zod';
import {
  AcceptedVersionIdSchema,
  CandidateIdSchema,
  ChangeIdSchema,
  GitShaSchema,
  IdSegmentSchema,
  isValidGitRef,
  ManifestIdSchema,
  ProposalHashSchema,
  ProposalIdSchema,
  ReleaseIdSchema,
  ResourceIdSchema,
  RevisionIdSchema,
  Sha256HexSchema,
  SnapshotIdSchema,
  TaskWorkspaceIdSchema,
} from './ids.js';
import { checkPath, isNormalizedPath } from './path-policy.js';
import {
  CandidateStateSchema,
  ChangeStateSchema,
  ProposalStateSchema,
  ReconciliationStateSchema,
  ResourceAuthoritySchema,
  TaskWorkspaceStateSchema,
} from './state.js';

// =============================================================================================
// Primitives
// =============================================================================================

/**
 * Canonical timestamp: UTC ISO-8601 with `Z` and exactly millisecond precision — the format of
 * `new Date().toISOString()`. One fixed spelling means timestamps hash deterministically and
 * compare correctly as strings (e.g. `approvedAt < updatedAt` in the ledger).
 */
export const IsoUtcTimestampSchema = z.iso.datetime({ precision: 3 });
export type IsoUtcTimestamp = z.infer<typeof IsoUtcTimestampSchema>;

/** Alias: every timestamp in CommonForge wire types and ledger records is an {@link IsoUtcTimestampSchema}. */
export const TimestampSchema = IsoUtcTimestampSchema;
export type Timestamp = IsoUtcTimestamp;

/** Format a Date (default: now) as an {@link IsoUtcTimestamp}. */
export function toIsoUtc(date: Date = new Date()): IsoUtcTimestamp {
  return date.toISOString();
}

/** Non-empty, NFC, relative, no `..`, already normalized. */
export const RelativePathSchema = z
  .string()
  .refine((p) => isNormalizedPath(p), 'expected a normalized relative path (NFC, no .., no leading /, no \\)');

/** Like RelativePathSchema but the empty string (root) is allowed. Used for prefixes. */
export const PathPrefixSchema = z
  .string()
  .refine((p) => isNormalizedPath(p, { allowEmpty: true }), 'expected a normalized relative path prefix');

/** A single path segment usable as a mount directory: NFC, no `/`, not dot-prefixed, ≤128 chars. */
export const MountNameSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((s) => {
    const r = checkPath(s);
    return r.ok && r.path === s && !s.includes('/') && !s.startsWith('.');
  }, 'expected a mount name: one NFC path segment, not starting with "."');

export const NonNegativeIntSchema = z.number().int().nonnegative();
export const PositiveIntSchema = z.number().int().positive();

/**
 * Git transport URL without embedded credentials. https/http for hosted remotes, file for local.
 * Credentials always travel via a credential helper, never inside the URL.
 *
 * The URL must already be in the spelling the WHATWG parser would not "repair": a lowercase
 * `https://`, `http://` or `file://` scheme, no whitespace, control characters or backslashes
 * anywhere (the parser silently strips leading/trailing whitespace and tab/newline characters,
 * lowercases the scheme and turns `\` into `/`, so a value that only parses after repair could be
 * read differently by another URL parser, git included). Equality checks on remote URLs (e.g.
 * `WorkspaceCredential.remoteUrl === handle.coords.remoteUrl`) are plain string equality.
 */
export const RemoteUrlSchema = z.string().refine((s) => {
  // eslint-disable-next-line no-control-regex
  if (!/^(?:https?|file):\/\//.test(s) || /[\s\u0000-\u001f\u007f\\]/.test(s)) return false;
  try {
    const u = new URL(s);
    return (u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'file:') && !u.username && !u.password;
  } catch {
    return false;
  }
}, 'expected a lowercase http(s):// or file:// URL without credentials, whitespace, control characters or backslashes');

/**
 * A folder's Git LFS endpoint (`lfs.url`, e.g. `https://…/api/lfs/<org>/<resourceId>/info/lfs`):
 * spelled like {@link RemoteUrlSchema}, https (or http on localhost / 127.0.0.1 / [::1] for local
 * development), no query or fragment. The CLI's credential helper sends the task lease there.
 */
export const LfsUrlSchema = RemoteUrlSchema.refine((s) => {
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return false;
  }
  const loopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
  return (u.protocol === 'https:' || (u.protocol === 'http:' && loopback)) && !u.search && !u.hash && !s.includes('?') && !s.includes('#');
}, 'expected an https:// (or loopback http://) LFS URL without query or fragment');

/** Git ref name, validated like `git check-ref-format` (see `isValidGitRef`). */
export const GitRefSchema = z.string().refine(isValidGitRef, 'expected a valid git ref name');

export const OperationSchema = z.enum(['read', 'write']);
export type Operation = z.infer<typeof OperationSchema>;

// =============================================================================================
// B.1 Provider capabilities
// =============================================================================================

export const ProviderKindSchema = z.enum(['artifacts', 'r2-assets', 'github-connected', 'legacy-vc-storage', 'local-git']);
export type ProviderKind = z.infer<typeof ProviderKindSchema>;

export const ProviderCapabilitiesSchema = z.object({
  kind: ProviderKindSchema,
  /** every revision is content-identified and retained */
  immutableRevisions: z.boolean(),
  /** older revisions remain readable (legacy-vc-storage: false) */
  retainedHistory: z.boolean(),
  /** standard clone/fetch/push works */
  gitTransport: z.boolean(),
  /** createIsolatedChange supported */
  writableCandidates: z.boolean(),
  /** provider can enforce expected-head (github: via beforeOid; artifacts: ledger-enforced) */
  conditionalAccept: z.boolean(),
  /** provider has its own review/merge (github: true) */
  externalReview: z.boolean(),
  /** large/binary objects supported natively */
  binaryAssets: z.boolean(),
  maxBlobBytes: PositiveIntSchema.nullable(),
  maxRepoBytes: PositiveIntSchema.nullable(),
});
export type ProviderCapabilities = z.infer<typeof ProviderCapabilitiesSchema>;

// =============================================================================================
// Shared references (plan-undefined; see README)
// =============================================================================================

export const PrincipalKindSchema = z.enum(['user', 'agent', 'service', 'runner', 'client']);
export type PrincipalKind = z.infer<typeof PrincipalKindSchema>;

/** Who did something. Agents and clients act on behalf of a user principal recorded in `onBehalfOf`. */
export const PrincipalRefSchema = z.object({
  kind: PrincipalKindSchema,
  id: IdSegmentSchema,
  displayName: z.string().max(256).optional(),
  onBehalfOf: z.object({ kind: z.enum(['user', 'service']), id: IdSegmentSchema }).optional(),
});
export type PrincipalRef = z.infer<typeof PrincipalRefSchema>;

/** Artifacts repository (namespaces `commonforge-<orgId>-canonical|tasks|editions`). */
export const ArtifactsCoordsSchema = z.object({
  kind: z.literal('artifacts'),
  namespace: z.string().min(1).max(128),
  repoName: z.string().min(1).max(256),
  repoId: IdSegmentSchema,
  remoteUrl: RemoteUrlSchema,
});
export type ArtifactsCoords = z.infer<typeof ArtifactsCoordsSchema>;

/** LocalGitProvider bare repository; `namespace` is a directory grouping, `remoteUrl` usually file://. */
export const LocalGitCoordsSchema = z.object({
  kind: z.literal('local-git'),
  namespace: z.string().min(1).max(128),
  repoName: z.string().min(1).max(256),
  repoId: IdSegmentSchema,
  remoteUrl: RemoteUrlSchema,
});
export type LocalGitCoords = z.infer<typeof LocalGitCoordsSchema>;

/** Connected GitHub repository; `targetRef` is the authoritative branch (e.g. `refs/heads/main`). */
export const GitHubCoordsSchema = z.object({
  kind: z.literal('github-connected'),
  owner: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/),
  repo: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/),
  targetRef: GitRefSchema,
  installationId: PositiveIntSchema.optional(),
});
export type GitHubCoords = z.infer<typeof GitHubCoordsSchema>;

/** R2 asset collection: immutable objects under `<prefix>obj/<sha256>`, manifests under `<prefix>manifest/`. */
export const AssetManifestCoordsSchema = z.object({
  kind: z.literal('r2-assets'),
  bucket: z.string().min(1).max(63),
  /** `org/<orgId>/res/<resourceId>/` */
  prefix: z.string().min(1).endsWith('/'),
  manifestId: ManifestIdSchema.nullable(),
});
export type AssetManifestCoords = z.infer<typeof AssetManifestCoordsSchema>;

/** Untouched VibeControl storage (R2 + project_files). */
export const LegacyStorageCoordsSchema = z.object({
  kind: z.literal('legacy-vc-storage'),
  projectId: IdSegmentSchema,
  version: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
});
export type LegacyStorageCoords = z.infer<typeof LegacyStorageCoordsSchema>;

export const ProviderCoordsSchema = z.discriminatedUnion('kind', [
  ArtifactsCoordsSchema,
  LocalGitCoordsSchema,
  GitHubCoordsSchema,
  AssetManifestCoordsSchema,
  LegacyStorageCoordsSchema,
]);
export type ProviderCoords = z.infer<typeof ProviderCoordsSchema>;

/** A git repository the integration runner can fetch from / push to. */
export const RepoCoordsSchema = z.discriminatedUnion('kind', [ArtifactsCoordsSchema, LocalGitCoordsSchema]);
export type RepoCoords = z.infer<typeof RepoCoordsSchema>;

/** Identifies a managed Resource and how to reach it. `coords.kind` must equal `provider`. */
export const ResourceRefSchema = z
  .object({
    organizationId: IdSegmentSchema,
    resourceId: ResourceIdSchema,
    provider: ProviderKindSchema,
    authority: ResourceAuthoritySchema,
    coords: ProviderCoordsSchema,
  })
  .refine((r) => r.coords.kind === r.provider, { message: 'coords.kind must equal provider', path: ['coords', 'kind'] });
export type ResourceRef = z.infer<typeof ResourceRefSchema>;

// =============================================================================================
// B.2 Revision resolution and reads
// =============================================================================================

export const RevisionSelectorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('accepted') }),
  z.object({ kind: z.literal('revision'), revisionId: RevisionIdSchema }),
  z.object({ kind: z.literal('ref'), ref: GitRefSchema }),
  z.object({ kind: z.literal('candidate'), candidateId: CandidateIdSchema }),
]);
export type RevisionSelector = z.infer<typeof RevisionSelectorSchema>;

export const ResolvedRevisionSchema = z.object({
  resourceId: ResourceIdSchema,
  revisionId: RevisionIdSchema,
  provider: ProviderKindSchema,
  coords: ProviderCoordsSchema,
  /** commit sha or manifest sha256 */
  contentId: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64}|[A-Za-z0-9][A-Za-z0-9._-]{0,63})$/),
  /** git tree oid when applicable */
  treeId: GitShaSchema.optional(),
  resolvedAt: TimestampSchema,
  reconciliation: ReconciliationStateSchema.optional(),
});
export type ResolvedRevision = z.infer<typeof ResolvedRevisionSchema>;

/**
 * One `listTree` entry. `listTree(resource, revision, path)` returns the **direct children** of
 * `path` (`''` is the resource root), each with its **full resource-relative** path (never relative
 * to `path`); directories are `type: 'dir'`.
 */
export const TreeEntrySchema = z.object({
  /** full resource-relative path */
  path: RelativePathSchema,
  type: z.enum(['file', 'dir', 'symlink', 'submodule']),
  /** git mode string, e.g. 100644, 100755, 040000, 120000, 160000 */
  mode: z.string().regex(/^[0-7]{6}$/).optional(),
  /** git blob/tree oid or asset sha256 */
  oid: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/).optional(),
  /** bytes; files only */
  size: NonNegativeIntSchema.optional(),
});
export type TreeEntry = z.infer<typeof TreeEntrySchema>;

// =============================================================================================
// B.3 Snapshot and materialization
// =============================================================================================

export const DependencyModeSchema = z.enum(['pinned-reference', 'must-match-accepted']);
export type DependencyMode = z.infer<typeof DependencyModeSchema>;

export const SnapshotEntrySchema = z.object({
  resourceId: ResourceIdSchema,
  revisionId: RevisionIdSchema,
  mode: DependencyModeSchema,
  mountName: MountNameSchema,
  operations: z.array(OperationSchema).min(1),
});
export type SnapshotEntry = z.infer<typeof SnapshotEntrySchema>;

export const ProjectSnapshotSchema = z
  .object({
    snapshotId: SnapshotIdSchema,
    projectId: IdSegmentSchema,
    organizationId: IdSegmentSchema,
    membershipRevision: NonNegativeIntSchema,
    policyRevision: NonNegativeIntSchema,
    entries: z.array(SnapshotEntrySchema),
    createdAt: TimestampSchema,
  })
  .refine((s) => new Set(s.entries.map((e) => e.mountName)).size === s.entries.length, {
    message: 'mount names must be unique',
    path: ['entries'],
  });
export type ProjectSnapshot = z.infer<typeof ProjectSnapshotSchema>;

// =============================================================================================
// B.11 Asset manifests (defined early: referenced by B.3 and B.8)
// =============================================================================================

export const AssetManifestEntrySchema = z.object({
  path: RelativePathSchema,
  sha256: Sha256HexSchema,
  size: NonNegativeIntSchema,
  mime: z.string().min(1).max(255),
  /** immutable object key `org/<orgId>/res/<resourceId>/obj/<sha256>` */
  objectKey: z.string().min(1).max(1024),
  source: z.object({ kind: z.enum(['upload', 'intake', 'task']), ref: z.string().min(1).max(512) }).optional(),
});
export type AssetManifestEntry = z.infer<typeof AssetManifestEntrySchema>;

export const AssetManifestSchema = z
  .object({
    /** sha256 of canonical JSON of {resourceId, parentManifestId, entries(sorted by path)} */
    manifestId: ManifestIdSchema,
    resourceId: ResourceIdSchema,
    parentManifestId: ManifestIdSchema.nullable(),
    entries: z.array(AssetManifestEntrySchema),
    createdAt: TimestampSchema,
  })
  .refine((m) => new Set(m.entries.map((e) => e.path)).size === m.entries.length, {
    message: 'manifest entry paths must be unique',
    path: ['entries'],
  });
export type AssetManifest = z.infer<typeof AssetManifestSchema>;

/** A read authorization handed to `AssetProvider.objectUrl`; the provider never decides it. */
export const ReadGrantSchema = z.object({
  principal: PrincipalRefSchema,
  organizationId: IdSegmentSchema,
  resourceId: ResourceIdSchema,
  purpose: z.enum(['materialize', 'preview', 'export', 'browse', 'edition']),
  expiresAt: TimestampSchema,
});
export type ReadGrant = z.infer<typeof ReadGrantSchema>;

export const MaterializationMountSchema = z.object({
  mountName: MountNameSchema,
  resourceId: ResourceIdSchema,
  revisionId: RevisionIdSchema,
  source: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('git'),
      remoteUrl: RemoteUrlSchema,
      sha: GitShaSchema,
      credential: z.enum(['helper', 'none']).optional(),
      /** the folder's Git LFS endpoint; `cforge checkout` sets `lfs.url` to it (folders phase 4) */
      lfsUrl: LfsUrlSchema.optional(),
    }),
    z.object({ kind: z.literal('assets'), manifest: AssetManifestSchema, objectUrlResolver: z.literal('broker') }),
  ]),
  writable: z.boolean(),
  taskWorkspaceId: TaskWorkspaceIdSchema.optional(),
});
export type MaterializationMount = z.infer<typeof MaterializationMountSchema>;

/**
 * An absolute local directory: POSIX (`/…`) or Windows drive (`C:\…`, `C:/…`), at most 4096
 * chars. No NUL or other control characters, and no `.`/`..` segments, so it names one directory
 * without resolution. The single validator for workspace roots (core plan, runner-protocol
 * authorization and verification, the Worker's materialization route).
 */
export function isAbsoluteDir(p: string): boolean {
  if (p.length === 0 || p.length > 4096) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(p)) return false;
  if (!p.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(p)) return false;
  return !p.split(/[\\/]/).some((seg) => seg === '.' || seg === '..');
}

/** Zod form of {@link isAbsoluteDir}. */
export const AbsoluteDirSchema = z
  .string()
  .refine(isAbsoluteDir, 'expected an absolute directory path (POSIX or drive letter; no control characters, no . or .. segments)');

export const MaterializationPlanSchema = z.object({
  /** absolute directory the mounts are materialized under (each mount at `<workspaceRoot>/<mountName>`) */
  workspaceRoot: AbsoluteDirSchema,
  mounts: z.array(MaterializationMountSchema),
  /** paths are relative to workspaceRoot (normally under `.commonforge/`) */
  contextFiles: z.array(z.object({ path: RelativePathSchema, content: z.string() })),
});
export type MaterializationPlan = z.infer<typeof MaterializationPlanSchema>;

// =============================================================================================
// B.4 Isolated change creation and workspace credentials
// =============================================================================================

export const ChangePurposeSchema = z.enum(['agent-task', 'client-edition', 'integration']);
export type ChangePurpose = z.infer<typeof ChangePurposeSchema>;

export const CreateIsolatedChangeInputSchema = z.object({
  resource: ResourceRefSchema,
  baseRevision: RevisionIdSchema,
  taskId: IdSegmentSchema,
  organizationId: IdSegmentSchema,
  changeId: ChangeIdSchema,
  purpose: ChangePurposeSchema,
});
export type CreateIsolatedChangeInput = z.infer<typeof CreateIsolatedChangeInputSchema>;

export const TaskWorkspaceHandleSchema = z.object({
  taskWorkspaceId: TaskWorkspaceIdSchema,
  resourceId: ResourceIdSchema,
  baseRevision: RevisionIdSchema,
  provider: ProviderKindSchema,
  coords: RepoCoordsSchema,
  state: TaskWorkspaceStateSchema,
});
export type TaskWorkspaceHandle = z.infer<typeof TaskWorkspaceHandleSchema>;

export const WorkspaceGrantSchema = z.object({
  principal: PrincipalRefSchema,
  operations: z.array(OperationSchema).min(1),
  /** Artifacts range 60..31_536_000; callers clamp to the task lease (default 3600). */
  ttlSeconds: z.number().int().min(60).max(31_536_000),
  leaseGeneration: NonNegativeIntSchema,
  /** when the task lease ends; providers cap the credential TTL so it never outlives the lease */
  leaseExpiresAt: TimestampSchema.optional(),
});
export type WorkspaceGrant = z.infer<typeof WorkspaceGrantSchema>;

/**
 * Contains a secret: never log, persist to workspace.json, or embed in a remote URL. A write
 * credential is scoped to the task repository and can never write a canonical repository.
 */
export const WorkspaceCredentialSchema = z.object({
  tokenId: z.string().min(1),
  secret: z.string().min(1),
  scope: OperationSchema,
  expiresAt: TimestampSchema,
  /** the provider's URL for the task repository, equal (string equality) to the `coords.remoteUrl` `createIsolatedChange` returned; never copied from the caller's handle */
  remoteUrl: RemoteUrlSchema,
});
export type WorkspaceCredential = z.infer<typeof WorkspaceCredentialSchema>;

// =============================================================================================
// B.5 Candidate save / freeze
// =============================================================================================

export const FreezeInputSchema = z.object({
  expectedSha: GitShaSchema,
  /** advisory only: providers compute `FrozenCandidate.changedPaths` themselves and never trust this */
  declaredChangedPaths: z.array(RelativePathSchema).optional(),
  submitter: PrincipalRefSchema,
  tool: z.string().max(256).optional(),
});
export type FreezeInput = z.infer<typeof FreezeInputSchema>;

export const FrozenCandidateSchema = z.object({
  candidateId: CandidateIdSchema,
  taskWorkspaceId: TaskWorkspaceIdSchema,
  /** the task workspace's fork repository (where `prepare-candidate` fetches `sha` from); never a credential */
  fork: RepoCoordsSchema,
  resourceId: ResourceIdSchema,
  baseRevision: RevisionIdSchema,
  sha: GitShaSchema,
  treeId: GitShaSchema,
  frozenAt: TimestampSchema,
  submitter: PrincipalRefSchema,
  tool: z.string().max(256).optional(),
  /** computed by compare, not trusted from input (`FreezeInput.declaredChangedPaths` is advisory only) */
  changedPaths: z.array(RelativePathSchema),
});
export type FrozenCandidate = z.infer<typeof FrozenCandidateSchema>;

/** `CoreError.code` of a freeze or credential refusal (see `VersionProvider`). */
export const FreezeErrorCodeSchema = z.enum(['candidate_moved', 'candidate_moved_during_freeze', 'workspace_not_writable']);
export type FreezeErrorCode = z.infer<typeof FreezeErrorCodeSchema>;

/**
 * Error codes every `VersionProvider` uses with the same meaning (`CoreError.code` on a rejected
 * promise). Providers may add their own codes (e.g. Artifacts `lease_stale`, `provider_unavailable`),
 * but where a meaning below applies they use this code, so consumers can handle all providers alike.
 *
 * | code | meaning |
 * |---|---|
 * | `candidate_moved`, `candidate_moved_during_freeze`, `workspace_not_writable` | {@link FreezeErrorCodeSchema} |
 * | `canonical_namespace_refused` | a credential, freeze or collect named a canonical repository |
 * | `namespace_refused` | the handle's coords are not a task repository this provider owns |
 * | `invalid_input` | the input failed its schema |
 * | `revision_mismatch` | a RevisionId that does not belong to this resource's repositories |
 * | `not_found` | unknown resource, revision, candidate or task workspace (Artifacts: also a collected one; local-git answers `workspace_not_writable` for those) |
 * | `ref_unresolved` | a ref selector did not resolve |
 * | `already_exists` | a create collided with an existing repository |
 * | `accepted_head_unavailable` | `resolveRevision({ kind: 'accepted' })` without a ledger head resolver |
 * | `runner_failed` | the injected `RunnerSubmit` returned `ok: false` |
 * | `receipt_mismatch` | the runner's receipt does not match the job |
 */
export const ProviderErrorCodeSchema = z.enum([
  ...FreezeErrorCodeSchema.options,
  'canonical_namespace_refused',
  'namespace_refused',
  'invalid_input',
  'revision_mismatch',
  'not_found',
  'ref_unresolved',
  'already_exists',
  'accepted_head_unavailable',
  'runner_failed',
  'receipt_mismatch',
]);
export type ProviderErrorCode = z.infer<typeof ProviderErrorCodeSchema>;

// =============================================================================================
// B.6 Compare
// =============================================================================================

export const CompareFileSchema = z.object({
  path: RelativePathSchema,
  status: z.enum(['added', 'modified', 'deleted', 'renamed']),
  oldPath: RelativePathSchema.optional(),
  binary: z.boolean(),
  additions: NonNegativeIntSchema.optional(),
  deletions: NonNegativeIntSchema.optional(),
});
export type CompareFile = z.infer<typeof CompareFileSchema>;

export const CompareResultSchema = z.object({
  base: RevisionIdSchema,
  candidate: RevisionIdSchema,
  sameTree: z.boolean(),
  files: z.array(CompareFileSchema),
  /** where a full patch can be fetched (R2 key); omitted for binary-only */
  patchRef: z.string().min(1).optional(),
});
export type CompareResult = z.infer<typeof CompareResultSchema>;

// =============================================================================================
// B.7 Validation evidence
// =============================================================================================

export const RunnerKindSchema = z.enum(['sandbox', 'node-runner', 'vc-hosted', 'vc-runtime']);
export type RunnerKind = z.infer<typeof RunnerKindSchema>;

export const CheckResultSchema = z.object({
  checkId: IdSegmentSchema,
  command: z.string().optional(),
  result: z.enum(['pass', 'fail', 'skipped']),
  /**
   * Copied from `CheckSpec.required`. Absent means `true` (evidence produced before the flag
   * existed). A required check must `pass` for acceptance (`fail` and `skipped` both block); a
   * check with `required: false` is recorded but never blocks. Verifiers must check a present flag
   * against the signed job's `CheckSpec.required` (runner-protocol's `parseRunnerResultForJob`
   * does), so a runner can never relax policy. Optional rather than defaulted, so parsing never
   * adds a key to signed evidence.
   */
  required: z.boolean().optional(),
  startedAt: TimestampSchema,
  endedAt: TimestampSchema,
  logRef: z.string().min(1).optional(),
});
export type CheckResult = z.infer<typeof CheckResultSchema>;

export const ContractCheckResultSchema = z.object({
  contractId: IdSegmentSchema,
  producerResource: ResourceIdSchema,
  consumerResource: ResourceIdSchema,
  result: z.enum(['pass', 'fail']),
  detail: z.string().optional(),
});
export type ContractCheckResult = z.infer<typeof ContractCheckResultSchema>;

export const MergeOutcomeSchema = z.object({
  resourceId: ResourceIdSchema,
  result: z.enum(['clean', 'textual-conflict', 'stale-base', 'asset-conflict']),
  conflictPaths: z.array(RelativePathSchema).optional(),
});
export type MergeOutcome = z.infer<typeof MergeOutcomeSchema>;

export const ValidationEvidenceSchema = z.object({
  evidenceId: IdSegmentSchema,
  proposalHash: ProposalHashSchema,
  snapshotId: SnapshotIdSchema,
  runnerId: IdSegmentSchema,
  runnerKind: RunnerKindSchema,
  checks: z.array(CheckResultSchema),
  contractChecks: z.array(ContractCheckResultSchema),
  mergeOutcome: z.array(MergeOutcomeSchema),
  producedAt: TimestampSchema,
  /** HMAC by the runner's job key; agent text never satisfies this */
  signature: z.string().min(1),
});
export type ValidationEvidence = z.infer<typeof ValidationEvidenceSchema>;

// =============================================================================================
// B.8 support types (IntegrationJob/SignedJob/RunnerResult live in runner-protocol)
// =============================================================================================

/** A validation command run by the integration runner (must be on the runner's allowlist). */
export const CheckSpecSchema = z.object({
  checkId: IdSegmentSchema,
  /** mount whose working tree is the command's cwd */
  mountName: MountNameSchema,
  command: z.string().min(1).max(4096),
  timeoutSeconds: z.number().int().min(1).max(3600).default(600),
  /** a failing optional check is recorded but does not fail the job */
  required: z.boolean().default(true),
  /**
   * Staging phase 2b (B8): this check builds or tests the code of its mount, so a promotion may go to
   * production without earlier overlapping tasks when every resource it changes has a required check
   * with `gatesAlone`. Absent means false. The runner ignores it.
   */
  gatesAlone: z.boolean().optional(),
});
export type CheckSpec = z.infer<typeof CheckSpecSchema>;

/** Cross-resource contract: producer output must validate against a JSON Schema owned by the consumer side. */
export const ContractSpecSchema = z.object({
  contractId: IdSegmentSchema,
  version: z.string().min(1).max(64),
  producerResource: ResourceIdSchema,
  consumerResource: ResourceIdSchema,
  /** JSON Schema location inside a resource of the snapshot */
  schema: z.object({ resourceId: ResourceIdSchema, path: RelativePathSchema }),
  /** command (in the producer mount) whose stdout is the JSON sample to validate */
  producerOutput: z.object({ mountName: MountNameSchema, command: z.string().min(1).max(4096) }),
});
export type ContractSpec = z.infer<typeof ContractSpecSchema>;

/** Server-owned recipe for assembling a preview or release build. */
export const BuildRecipeSchema = z.object({
  recipeId: IdSegmentSchema,
  revision: PositiveIntSchema,
  steps: z.array(
    z.object({
      stepId: IdSegmentSchema,
      mountName: MountNameSchema,
      command: z.string().min(1).max(4096),
      /**
       * Non-secret, server-owned environment for this step (e.g. `VITE_QUOTE_API_URL`). Runners
       * refuse values that look like secrets; part of the recipe revision and the env digest.
       */
      env: z.record(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/), z.string().max(1024)).optional(),
    }),
  ).min(1),
  /** mount-relative directory holding the static output, if any */
  output: z.object({ mountName: MountNameSchema, path: PathPrefixSchema }).optional(),
  /** digest of the non-secret environment configuration bound into releases */
  envConfigDigest: Sha256HexSchema.optional(),
});
export type BuildRecipe = z.infer<typeof BuildRecipeSchema>;

export const RunnerJobKindSchema = z.enum([
  'prepare-candidate',
  'integrate',
  'reconcile-ref',
  'preview-build',
  'export',
  'edition-return',
  /** seed a fresh task repository with the base commit (addition: Artifacts cannot fork across namespaces) */
  'seed-workspace',
]);
export type RunnerJobKind = z.infer<typeof RunnerJobKindSchema>;

export const RunnerFailureCodeSchema = z.enum([
  'stale_base',
  'textual_conflict',
  'scope_violation',
  'contract_failed',
  'check_failed',
  'provider_unavailable',
  'job_expired',
  /** apply-files (spec 2026-10-07 §6): an edited file's blob is not the one the editor opened */
  'file_changed',
  /** apply-files: a staged small text file's bytes do not match the recorded sha256/size */
  'hash_mismatch',
  /** apply-files: a move names a path that does not exist */
  'path_not_found',
  /** apply-files: a path cannot be placed (a file where a folder is, or a folder where a file is) */
  'path_conflict',
  /** apply-files: a limit of the change (e.g. an LFS file edited in place) */
  'limit_exceeded',
  /** init-folder (folders phase 4): canonical main already holds a commit other than the folder's first one */
  'branch_not_empty',
]);
export type RunnerFailureCode = z.infer<typeof RunnerFailureCodeSchema>;

/** Result of `prepare-candidate`: candidate objects are retained in canonical under a service ref. */
export const PreparedReceiptSchema = z.object({
  receiptId: IdSegmentSchema,
  jobId: IdSegmentSchema,
  candidateId: CandidateIdSchema,
  resourceId: ResourceIdSchema,
  /** `refs/commonforge/candidates/<taskWorkspaceId>/<sha>` in the canonical repo */
  canonicalRef: GitRefSchema,
  sha: GitShaSchema,
  /** the candidate commit as a revision of the canonical repo (usable as a new head) */
  revisionId: RevisionIdSchema,
  /** asset object keys HEAD-verified during preparation */
  verifiedAssetObjects: z.array(z.string().min(1)).default([]),
  preparedAt: TimestampSchema,
});
export type PreparedReceipt = z.infer<typeof PreparedReceiptSchema>;

/** Result of `integrate`: one integration commit per target resource plus signed evidence. */
export const IntegrationReceiptSchema = z.object({
  jobId: IdSegmentSchema,
  proposalId: ProposalIdSchema,
  results: z.array(
    z.object({
      resourceId: ResourceIdSchema,
      /** `refs/commonforge/integrations/<proposalId>` */
      integrationRef: GitRefSchema,
      sha: GitShaSchema,
      revisionId: RevisionIdSchema,
      expectedHead: RevisionIdSchema,
    }),
  ),
  evidence: ValidationEvidenceSchema,
  integratedAt: TimestampSchema,
});
export type IntegrationReceipt = z.infer<typeof IntegrationReceiptSchema>;

/** Result of `reconcile-ref`: projection health of the provider ref vs the ledger head. */
export const ReconcileResultSchema = z.object({
  jobId: IdSegmentSchema.optional(),
  resourceId: ResourceIdSchema.optional(),
  ref: GitRefSchema,
  targetSha: GitShaSchema,
  /** sha observed on the ref after the attempt; null if the ref does not exist */
  observedSha: GitShaSchema.nullable(),
  status: z.enum(['synced', 'diverged']),
  reconciledAt: TimestampSchema,
});
export type ReconcileResult = z.infer<typeof ReconcileResultSchema>;

export const PreviewReceiptSchema = z.object({
  jobId: IdSegmentSchema,
  previewId: IdSegmentSchema,
  /** token-gated preview URL; the token itself is never part of the receipt */
  url: z.url(),
  integrationSha: z.record(ResourceIdSchema, GitShaSchema),
  recipe: z.object({ recipeId: IdSegmentSchema, revision: PositiveIntSchema }),
  readyAt: TimestampSchema,
  expiresAt: TimestampSchema,
});
export type PreviewReceipt = z.infer<typeof PreviewReceiptSchema>;

/** Where an export is written. */
export const ExportSinkSchema = z.object({
  kind: z.literal('r2'),
  /** key prefix ending in `/`, e.g. `org/<orgId>/exports/<exportId>/` */
  r2Prefix: z.string().min(1).endsWith('/'),
});
export type ExportSink = z.infer<typeof ExportSinkSchema>;

// =============================================================================================
// B.10 Export
// =============================================================================================

export const ExportItemSchema = z.union([
  z.object({
    resourceId: ResourceIdSchema,
    kind: z.literal('git-bundle'),
    r2Key: z.string().min(1),
    sha256: Sha256HexSchema,
    headSha: GitShaSchema,
    historyMode: z.enum(['full', 'snapshot-only']),
  }),
  z.object({
    resourceId: ResourceIdSchema,
    kind: z.literal('asset-manifest'),
    r2Key: z.string().min(1),
    manifestId: ManifestIdSchema,
    objects: NonNegativeIntSchema,
    bytes: NonNegativeIntSchema,
  }),
  /** mounts, snapshot, provenance, allowed review metadata */
  z.object({ kind: z.literal('project-structure'), r2Key: z.string().min(1) }),
]);
export type ExportItem = z.infer<typeof ExportItemSchema>;

export const ExportReceiptSchema = z.object({
  exportId: IdSegmentSchema,
  snapshotId: SnapshotIdSchema,
  items: z.array(ExportItemSchema),
  createdAt: TimestampSchema,
});
export type ExportReceipt = z.infer<typeof ExportReceiptSchema>;

// =============================================================================================
// B.13 Edition manifests and deltas
// =============================================================================================

export const EditionInventoryEntrySchema = z.object({
  editionPath: RelativePathSchema,
  sha256: Sha256HexSchema,
  size: NonNegativeIntSchema,
});
export type EditionInventoryEntry = z.infer<typeof EditionInventoryEntrySchema>;

export const EditionMappingSchema = z.object({
  /** edition-relative prefix; '' maps the whole edition */
  editionPathPrefix: PathPrefixSchema,
  resourceId: ResourceIdSchema,
  /** canonical resource-relative prefix; '' is the resource root */
  canonicalPathPrefix: PathPrefixSchema,
  writable: z.boolean(),
});
export type EditionMapping = z.infer<typeof EditionMappingSchema>;

export const EditionManifestServerSideSchema = z.object({
  editionId: IdSegmentSchema,
  policyRevision: NonNegativeIntSchema,
  /**
   * The live release the edition was published from (PRD §4.5, AT-30). `null` while the project has
   * no recorded release (the edition is then based on the accepted heads in `canonicalBases`).
   */
  sourceReleaseId: ReleaseIdSchema.nullable(),
  exportedSnapshotId: SnapshotIdSchema,
  inventory: z.array(EditionInventoryEntrySchema),
  mappings: z.array(EditionMappingSchema),
  canonicalBases: z.array(z.object({ resourceId: ResourceIdSchema, revisionId: RevisionIdSchema })),
  editionRepo: RepoCoordsSchema.optional(),
  allowedAssetNamespaces: z.array(z.string().min(1)),
  contractVersions: z.record(z.string(), z.string()),
  /**
   * Canonical-path glob patterns that a client return may never change (policy, pipeline,
   * credentials, dependencies, auth, infra, schema). Addition to plan §B.13; default [].
   * `.git`, `.commonforge` and `.vibecontrol` segments are always protected.
   */
  protectedPaths: z.array(z.string().min(1)).default([]),
});
export type EditionManifestServerSide = z.infer<typeof EditionManifestServerSideSchema>;

export const EditionChangeSchema = z.object({
  /** edition-relative path as returned (normalized when valid; raw otherwise, blocked later as path_escape) */
  path: z.string().min(1),
  kind: z.enum(['added', 'modified', 'deleted', 'renamed']),
  /** for renamed: the inventory path it came from */
  oldPath: z.string().min(1).optional(),
  /** new content hash (added/modified/renamed) */
  sha256: Sha256HexSchema.optional(),
  /** inventory content hash (modified/deleted/renamed) */
  previousSha256: Sha256HexSchema.optional(),
});
export type EditionChange = z.infer<typeof EditionChangeSchema>;

/** Output of `diffAgainstInventory`. */
export const EditionDeltaSchema = z.object({
  mode: z.enum(['full', 'partial']),
  changes: z.array(EditionChangeSchema),
  /** inventory paths returned with identical content */
  unchanged: z.array(z.string()),
  /** partial mode: inventory paths neither returned nor explicitly deleted (kept as-is) */
  omitted: z.array(z.string()),
  /** explicit deletions of paths absent from the inventory (ignored, reported for transparency) */
  unknownDeletions: z.array(z.string()),
});
export type EditionDelta = z.infer<typeof EditionDeltaSchema>;

/**
 * `case_collision`: an added/renamed-to path differs only by case from another published path.
 * `path_conflict`: an added/renamed-to path is a file where a published folder is (or another new
 * path lies below it), or lies below a published (or another new) file.
 */
export const EditionBlockReasonSchema = z.enum(['not_mapped', 'read_only', 'protected', 'path_escape', 'case_collision', 'path_conflict']);
export type EditionBlockReason = z.infer<typeof EditionBlockReasonSchema>;

/** An allowed edition change translated to a canonical resource path. */
export const MappedChangeSchema = z.object({
  resourceId: ResourceIdSchema,
  /** canonical base the change applies to (from manifest.canonicalBases) */
  baseRevision: RevisionIdSchema,
  kind: z.enum(['added', 'modified', 'deleted', 'renamed']),
  editionPath: RelativePathSchema,
  canonicalPath: RelativePathSchema,
  oldEditionPath: RelativePathSchema.optional(),
  oldCanonicalPath: RelativePathSchema.optional(),
  sha256: Sha256HexSchema.optional(),
  previousSha256: Sha256HexSchema.optional(),
});
export type MappedChange = z.infer<typeof MappedChangeSchema>;

export const BlockedChangeSchema = z.object({ path: z.string(), reason: EditionBlockReasonSchema });
export type BlockedChange = z.infer<typeof BlockedChangeSchema>;

export const EditionReturnReceiptSchema = z.object({
  jobId: IdSegmentSchema,
  editionId: IdSegmentSchema,
  resourceId: ResourceIdSchema,
  /** candidate created in a new task fork; absent when nothing was allowed */
  candidate: z
    .object({ candidateId: CandidateIdSchema, taskWorkspaceId: TaskWorkspaceIdSchema, sha: GitShaSchema })
    .optional(),
  expectedHead: RevisionIdSchema,
  allowed: z.array(MappedChangeSchema),
  blocked: z.array(BlockedChangeSchema),
  returnedAt: TimestampSchema,
});
export type EditionReturnReceipt = z.infer<typeof EditionReturnReceiptSchema>;

/**
 * Result of `seed-workspace`: the fresh task repository's `ref` now points at the base commit.
 * Addition to plan §B.8 (Artifacts `fork()` cannot cross namespaces, so task repos in the `-tasks`
 * namespace are created empty and seeded by the runner).
 */
export const SeedWorkspaceReceiptSchema = z.object({
  jobId: IdSegmentSchema,
  taskWorkspaceId: TaskWorkspaceIdSchema,
  resourceId: ResourceIdSchema,
  /** `refs/heads/<branch>` of the task repository */
  ref: GitRefSchema,
  /** the base commit the ref points at */
  sha: GitShaSchema,
  seededAt: TimestampSchema,
});
export type SeedWorkspaceReceipt = z.infer<typeof SeedWorkspaceReceiptSchema>;

export const RunnerReceiptSchema = z.union([
  PreparedReceiptSchema,
  IntegrationReceiptSchema,
  ReconcileResultSchema,
  PreviewReceiptSchema,
  ExportReceiptSchema,
  EditionReturnReceiptSchema,
  SeedWorkspaceReceiptSchema,
]);
export type RunnerReceipt = z.infer<typeof RunnerReceiptSchema>;

/** Which receipt each runner job kind produces. */
export interface RunnerReceiptByKind {
  'prepare-candidate': PreparedReceipt;
  integrate: IntegrationReceipt;
  'reconcile-ref': ReconcileResult;
  'preview-build': PreviewReceipt;
  export: ExportReceipt;
  'edition-return': EditionReturnReceipt;
  'seed-workspace': SeedWorkspaceReceipt;
}

// =============================================================================================
// B.9 Conditional acceptance (shared inputs; planCommit/CommitDecision live in ledger)
// =============================================================================================

export const ApprovalRefSchema = z.object({
  approvalId: IdSegmentSchema,
  proposalId: ProposalIdSchema,
  /** must equal the AcceptInput.proposalHash */
  proposalHash: ProposalHashSchema,
  approver: PrincipalRefSchema,
  /** role under which the approval was given (semantics owned by the consuming app) */
  role: z.string().min(1).max(64),
  approvedAt: TimestampSchema,
});
export type ApprovalRef = z.infer<typeof ApprovalRefSchema>;

export const HeadRefSchema = z.object({ resourceId: ResourceIdSchema, revisionId: RevisionIdSchema });
export type HeadRef = z.infer<typeof HeadRefSchema>;

export const ReadDependencySchema = z.object({
  resourceId: ResourceIdSchema,
  revisionId: RevisionIdSchema,
  mode: DependencyModeSchema,
});
export type ReadDependency = z.infer<typeof ReadDependencySchema>;

export const AcceptInputSchema = z.object({
  proposalId: ProposalIdSchema,
  proposalHash: ProposalHashSchema,
  idempotencyKey: z.string().min(1).max(256),
  expectedHeads: z.array(HeadRefSchema),
  newHeads: z.array(HeadRefSchema.extend({ preparedReceiptId: IdSegmentSchema })),
  readDependencies: z.array(ReadDependencySchema),
  approvals: z.array(ApprovalRefSchema),
  policyRevision: NonNegativeIntSchema,
  evidence: z.array(ValidationEvidenceSchema),
  actor: PrincipalRefSchema,
});
export type AcceptInput = z.infer<typeof AcceptInputSchema>;

export const RestoreInputSchema = z.object({
  resourceId: ResourceIdSchema,
  expectedHead: RevisionIdSchema,
  targetRevision: RevisionIdSchema,
  idempotencyKey: z.string().min(1).max(256),
  actor: PrincipalRefSchema,
});
export type RestoreInput = z.infer<typeof RestoreInputSchema>;

export const CommitRefusalCodeSchema = z.enum([
  'proposal_hash_mismatch',
  'expected_head_stale',
  'dependency_stale',
  'approval_invalid',
  'policy_revision_stale',
  'receipt_missing',
  'evidence_missing',
  'proposal_not_prepared',
]);
export type CommitRefusalCode = z.infer<typeof CommitRefusalCodeSchema>;

// =============================================================================================
// Ledger records (shared by ledger, OrgLedger DO, outbox consumer)
// =============================================================================================

/** The single accepted head for one Resource (authority rule 1). */
export const AcceptedHeadSchema = z.object({
  resourceId: ResourceIdSchema,
  revisionId: RevisionIdSchema,
  /** per-resource head sequence: 1 for the first accepted head, +1 per accept/restore */
  versionSeq: PositiveIntSchema,
  /** the accepted project version that set this head; null for a seeded/imported head */
  acceptedVersionId: AcceptedVersionIdSchema.nullable(),
  acceptedAt: TimestampSchema,
  /** projection health of the provider ref (never authority) */
  reconciliation: ReconciliationStateSchema,
});
export type AcceptedHead = z.infer<typeof AcceptedHeadSchema>;

/** Inputs to `computeProposalHash` (plan §A.5), as stored. */
export const ResourceChangeSchema = z.object({
  resourceId: ResourceIdSchema,
  baseRevision: RevisionIdSchema,
  candidateId: CandidateIdSchema,
  /** the candidate commit as a revision of the resource */
  candidateRevision: RevisionIdSchema,
});
export type ResourceChange = z.infer<typeof ResourceChangeSchema>;

export const AssetManifestChangeSchema = z.object({
  resourceId: ResourceIdSchema,
  baseManifestId: ManifestIdSchema.nullable(),
  newManifestId: ManifestIdSchema,
});
export type AssetManifestChange = z.infer<typeof AssetManifestChangeSchema>;

export const ProposalRecordSchema = z.object({
  proposalId: ProposalIdSchema,
  proposalHash: ProposalHashSchema,
  organizationId: IdSegmentSchema,
  projectId: IdSegmentSchema,
  changeId: ChangeIdSchema,
  baseSnapshotId: SnapshotIdSchema,
  candidateSnapshotId: SnapshotIdSchema,
  resourceChanges: z.array(ResourceChangeSchema),
  readDependencies: z.array(ReadDependencySchema),
  assetManifestChanges: z.array(AssetManifestChangeSchema),
  policyRevision: NonNegativeIntSchema,
  state: ProposalStateSchema,
  /** PreparedReceipt ids recorded against this proposal, by resource */
  preparedReceipts: z.array(z.object({ resourceId: ResourceIdSchema, receiptId: IdSegmentSchema })).default([]),
  createdAt: TimestampSchema,
  /** last mutation of hashed content; approvals older than this are invalid */
  updatedAt: TimestampSchema,
});
export type ProposalRecord = z.infer<typeof ProposalRecordSchema>;

/** `bind` (addition): genesis via the ledger's `planBindHead` (older stores recorded it as `accept`). */
export const IdempotencyScopeSchema = z.enum(['accept', 'restore', 'release', 'bind']);
export type IdempotencyScope = z.infer<typeof IdempotencyScopeSchema>;

export const IdempotencyRecordSchema = z.object({
  key: z.string().min(1).max(256),
  scope: IdempotencyScopeSchema,
  /** sha256 of the canonical request; same key with a different request is a conflict */
  requestHash: Sha256HexSchema,
  acceptedVersionId: AcceptedVersionIdSchema,
  createdAt: TimestampSchema,
});
export type IdempotencyRecord = z.infer<typeof IdempotencyRecordSchema>;

/**
 * One accepted project version, monotonically sequenced per org: an `accept` (of a proposal), a
 * `restore`, or a `bind` (addition: genesis, a resource's first head; `proposalId` and
 * `proposalHash` are null). Versions written before `bind` existed recorded genesis as
 * `kind: 'accept'` with `proposalId: null`; readers should treat that pair as a bind.
 */
export const AcceptedProjectVersionSchema = z.object({
  acceptedVersionId: AcceptedVersionIdSchema,
  organizationId: IdSegmentSchema,
  /** per-organization monotonically increasing sequence */
  sequence: PositiveIntSchema,
  kind: z.enum(['accept', 'restore', 'bind']),
  proposalId: ProposalIdSchema.nullable(),
  proposalHash: ProposalHashSchema.nullable(),
  heads: z.array(
    z.object({
      resourceId: ResourceIdSchema,
      revisionId: RevisionIdSchema,
      previousRevisionId: RevisionIdSchema.nullable(),
      versionSeq: PositiveIntSchema,
    }),
  ),
  actor: PrincipalRefSchema,
  acceptedAt: TimestampSchema,
});
export type AcceptedProjectVersion = z.infer<typeof AcceptedProjectVersionSchema>;

const OutboxBase = {
  eventId: IdSegmentSchema,
  organizationId: IdSegmentSchema,
  /** dedupe key for at-least-once delivery */
  dedupeKey: z.string().min(1).max(512),
  createdAt: TimestampSchema,
  attempts: NonNegativeIntSchema.default(0),
  deliveredAt: TimestampSchema.nullable().default(null),
};

export const OutboxEventSchema = z.discriminatedUnion('kind', [
  z.object({
    ...OutboxBase,
    kind: z.literal('reconcile-ref'),
    payload: z.object({
      resourceId: ResourceIdSchema,
      targetRevision: RevisionIdSchema,
      expectedCurrent: RevisionIdSchema.nullable(),
      acceptedVersionId: AcceptedVersionIdSchema,
    }),
  }),
  z.object({
    ...OutboxBase,
    kind: z.literal('candidate-superseded'),
    payload: z.object({ resourceId: ResourceIdSchema, candidateId: CandidateIdSchema }),
  }),
  z.object({
    ...OutboxBase,
    kind: z.literal('projection-refresh'),
    payload: z.object({ resourceIds: z.array(ResourceIdSchema), acceptedVersionId: AcceptedVersionIdSchema.optional() }),
  }),
]);
export type OutboxEvent = z.infer<typeof OutboxEventSchema>;
export type OutboxEventKind = OutboxEvent['kind'];

/** Append-only audit trail entry. `action` is a dotted verb, e.g. `proposal.accepted`. */
export const AuditEventSchema = z.object({
  auditId: IdSegmentSchema,
  organizationId: IdSegmentSchema,
  at: TimestampSchema,
  actor: PrincipalRefSchema,
  action: z.string().regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/),
  subject: z.object({
    kind: z.enum(['resource', 'proposal', 'candidate', 'workspace', 'change', 'release', 'edition', 'project']),
    id: z.string().min(1),
  }),
  proposalHash: ProposalHashSchema.optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

/** Change record kept by the consuming app (state machine in state.ts). */
export const ChangeRecordSchema = z.object({
  changeId: ChangeIdSchema,
  organizationId: IdSegmentSchema,
  projectId: IdSegmentSchema,
  state: ChangeStateSchema,
  updatedAt: TimestampSchema,
});
export type ChangeRecord = z.infer<typeof ChangeRecordSchema>;

/** Candidate lifecycle record. */
export const CandidateRecordSchema = z.object({
  candidate: FrozenCandidateSchema,
  state: CandidateStateSchema,
  preparedReceiptId: IdSegmentSchema.nullable(),
  updatedAt: TimestampSchema,
});
export type CandidateRecord = z.infer<typeof CandidateRecordSchema>;
