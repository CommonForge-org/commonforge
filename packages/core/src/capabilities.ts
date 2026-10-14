/**
 * Provider contracts (plan §B.1, §B.2, §B.11, §B.12) and capability checks.
 */
import { CoreError } from './errors.js';
import type { ManifestId, ResourceId, RevisionId, TaskWorkspaceId } from './ids.js';
import type {
  AcceptedHead,
  AssetManifest,
  CompareResult,
  CreateIsolatedChangeInput,
  ExportReceipt,
  ExportSink,
  FreezeErrorCode,
  FreezeInput,
  FrozenCandidate,
  PreparedReceipt,
  ProviderCapabilities,
  ProviderErrorCode,
  ProviderKind,
  ReadGrant,
  ReconcileResult,
  ResolvedRevision,
  ResourceRef,
  RevisionSelector,
  RunnerFailureCode,
  RunnerJobKind,
  RunnerReceiptByKind,
  TaskWorkspaceHandle,
  TreeEntry,
  ValidationEvidence,
  WorkspaceCredential,
  WorkspaceGrant,
} from './schemas.js';

/** Boolean capability flags (the keys a provider can lack). */
export type CapabilityFlag = {
  [K in keyof ProviderCapabilities]: ProviderCapabilities[K] extends boolean ? K : never;
}[keyof ProviderCapabilities];

export class CapabilityError extends CoreError<'provider_capability_unsupported'> {
  readonly provider: ProviderKind;
  readonly capability: keyof ProviderCapabilities;

  constructor(provider: ProviderKind, capability: keyof ProviderCapabilities) {
    super('provider_capability_unsupported', `${provider}:${capability}`, { provider, capability });
    // Exact message per plan §B.1.
    this.message = `provider_capability_unsupported:${provider}:${capability}`;
    this.name = 'CapabilityError';
    this.provider = provider;
    this.capability = capability;
  }
}

/** Throw {@link CapabilityError} unless `caps[flag]` is true. */
export function requireCapability(caps: ProviderCapabilities, flag: CapabilityFlag): void {
  if (!caps[flag]) throw new CapabilityError(caps.kind, flag);
}

/** Throw {@link CapabilityError} (`maxBlobBytes`) if `bytes` exceeds the provider's blob limit. */
export function requireBlobSize(caps: ProviderCapabilities, bytes: number): void {
  if (caps.maxBlobBytes !== null && bytes > caps.maxBlobBytes) throw new CapabilityError(caps.kind, 'maxBlobBytes');
}

const MiB = 1024 * 1024;

/** Reference capability sets for the known provider kinds (plan §B.1 comments, §0.2 limits). */
export const DEFAULT_CAPABILITIES: { readonly [K in ProviderKind]: Readonly<ProviderCapabilities> } = {
  artifacts: {
    kind: 'artifacts',
    immutableRevisions: true,
    retainedHistory: true,
    gitTransport: true,
    writableCandidates: true,
    conditionalAccept: true, // ledger-enforced
    externalReview: false,
    binaryAssets: false,
    maxBlobBytes: 32 * MiB,
    maxRepoBytes: 1024 * MiB,
  },
  'local-git': {
    kind: 'local-git',
    immutableRevisions: true,
    retainedHistory: true,
    gitTransport: true,
    writableCandidates: true,
    conditionalAccept: true,
    externalReview: false,
    binaryAssets: false,
    maxBlobBytes: null,
    maxRepoBytes: null,
  },
  'github-connected': {
    kind: 'github-connected',
    immutableRevisions: true,
    retainedHistory: true,
    gitTransport: true,
    writableCandidates: true,
    conditionalAccept: true, // via beforeOid
    externalReview: true,
    binaryAssets: false,
    maxBlobBytes: 100 * MiB,
    maxRepoBytes: null,
  },
  'r2-assets': {
    kind: 'r2-assets',
    immutableRevisions: true,
    retainedHistory: true,
    gitTransport: false,
    writableCandidates: false,
    conditionalAccept: true, // ledger-enforced on manifest ids
    externalReview: false,
    binaryAssets: true,
    maxBlobBytes: null,
    maxRepoBytes: null,
  },
  'legacy-vc-storage': {
    kind: 'legacy-vc-storage',
    immutableRevisions: false,
    retainedHistory: false,
    gitTransport: false,
    writableCandidates: false,
    conditionalAccept: false,
    externalReview: false,
    binaryAssets: true,
    maxBlobBytes: null,
    maxRepoBytes: null,
  },
};

// =============================================================================================
// Runner submission (the provider never runs git; the consuming app injects this)
// =============================================================================================

/**
 * A job handed to the runner. The concrete discriminated union (`IntegrationJob`) and its signing
 * live in `@commonforge-org/runner-protocol`; any of its members is assignable to this shape.
 */
export type RunnerJobRequest<K extends RunnerJobKind = RunnerJobKind> = { kind: K } & { readonly [field: string]: unknown };

export type RunnerOutcome<R> =
  | { jobId: string; ok: true; receipt: R }
  | { jobId: string; ok: false; code: RunnerFailureCode; detail: string; evidence?: ValidationEvidence };

/** Enqueue a signed integration job and await its result (plan §B.2). */
export type RunnerSubmit = <K extends RunnerJobKind>(
  job: RunnerJobRequest<K>,
) => Promise<RunnerOutcome<RunnerReceiptByKind[K]>>;

// =============================================================================================
// B.2 VersionProvider
// =============================================================================================

/**
 * A versioned store of git resources (plan §B.2): canonical repositories plus isolated task
 * repositories, one per task workspace.
 *
 * Conventions every implementation follows (checked by `@commonforge-org/conformance`):
 * - **Errors.** Methods reject with a `CoreError` carrying a stable `.code`. Freeze and credential
 *   refusals use {@link FreezeErrorCode}; other shared meanings use {@link ProviderErrorCode}
 *   (`canonical_namespace_refused`, `not_found` for an unknown workspace, …). Provider-specific
 *   codes extend these, never redefine them. A **collected** workspace refuses credentials and
 *   freeze with `workspace_not_writable` (local-git keeps its record) or `not_found` (Artifacts:
 *   the task repo is gone); consumers treat both as "no such writable workspace".
 * - **State.** Providers MUST decide about a workspace (credentials, freeze, collect) from the real
 *   workspace state, not the caller-supplied `handle.state`. Local-git keeps its own record.
 *   Artifacts gets it from the consuming app's ledger through its `workspace` resolver and falls
 *   back to `handle.state` without one, so a production Artifacts deployment must configure the
 *   resolver.
 * - **No fork lineage.** A task repository may be a fresh repository seeded with the base commit
 *   rather than a fork of canonical; callers must not assume shared history beyond the base sha.
 */
export interface VersionProvider {
  capabilities(): ProviderCapabilities;
  resolveRevision(resource: ResourceRef, selector: RevisionSelector): Promise<ResolvedRevision>;
  /**
   * Direct children of `path` in `revision`; `path = ''` is the resource root. Entries carry their
   * full resource-relative path and directories are `type: 'dir'` (see {@link TreeEntry}).
   */
  listTree(resource: ResourceRef, revision: RevisionId, path: string): Promise<TreeEntry[]>;
  /** File bytes, or `null` when `path` does not exist (or is not a file) in `revision`. */
  readFile(resource: ResourceRef, revision: RevisionId, path: string): Promise<Uint8Array | null>;
  /**
   * Create the task workspace for one resource of a change. It may be a fresh `-tasks` repository
   * seeded with the base sha (Artifacts cannot fork across namespaces): callers must not assume
   * fork lineage.
   */
  createIsolatedChange(input: CreateIsolatedChangeInput): Promise<TaskWorkspaceHandle>;
  /**
   * Decides from the real workspace state (see the State convention above), not the caller's
   * `handle.state`. Write scope only while the workspace is writable, else `workspace_not_writable`
   * (frozen, read-only, …; a collected workspace gives `workspace_not_writable` or `not_found`).
   * Never for canonical coords (`canonical_namespace_refused`). A write credential is scoped to the
   * task repository and can never write canonical. The returned `remoteUrl` is the provider's URL
   * for the workspace's task repository, never copied from the handle: it equals the
   * `coords.remoteUrl` that `createIsolatedChange` returned for this workspace.
   */
  issueWorkspaceCredential(handle: TaskWorkspaceHandle, grant: WorkspaceGrant): Promise<WorkspaceCredential>;
  /**
   * Freeze the candidate at `input.expectedSha` (revoking write access first). `changedPaths` is
   * computed by compare; `input.declaredChangedPaths` is advisory only.
   */
  freezeCandidate(handle: TaskWorkspaceHandle, input: FreezeInput): Promise<FrozenCandidate>;
  /**
   * Compare two revisions. Accepts canonical revisions and revisions of the resource's task
   * repositories (`art:|local:<taskRepoId>:<sha>`), so a candidate can be compared before prepare.
   */
  compare(resource: ResourceRef, base: RevisionId, candidate: RevisionId): Promise<CompareResult>;
  prepareForAcceptance(candidate: FrozenCandidate, job: RunnerSubmit): Promise<PreparedReceipt>;
  reconcileAccepted(resource: ResourceRef, head: AcceptedHead, job: RunnerSubmit): Promise<ReconcileResult>;
  exportRevision(resource: ResourceRef, revision: RevisionId, sink: ExportSink): Promise<ExportReceipt>;
  /**
   * Delete the task repository. Prepared candidates remain readable from their canonical retention
   * refs (`candidateRetentionRef`). Refuses canonical coords (`canonical_namespace_refused`).
   */
  collectWorkspace(handle: TaskWorkspaceHandle): Promise<void>;
}

// =============================================================================================
// B.11 AssetProvider
// =============================================================================================

export interface AssetProvider {
  capabilities(): ProviderCapabilities;
  stageUpload(input: {
    organizationId: string;
    taskWorkspaceId: TaskWorkspaceId;
    path: string;
    size: number;
    mime: string;
  }): Promise<{ stagingKey: string; uploadUrl?: string }>;
  /** HEAD-verify, copy to immutable key, delete staging. */
  promoteStaged(input: {
    stagingKey: string;
    expectedSha256: string;
    resourceId: ResourceId;
  }): Promise<{ objectKey: string; sha256: string; size: number }>;
  /**
   * Copy an already-verified upload held elsewhere in the org's bucket (an LFS-staged object) into
   * the resource's content-addressed key. Pins the source etag and re-hashes while copying; the
   * source is not deleted. Idempotent: an existing content key with matching sha256 is returned.
   */
  adoptVerified(input: {
    sourceKey: string;
    etag: string;
    sha256: string;
    size: number;
    mime: string;
    resourceId: ResourceId;
  }): Promise<{ objectKey: string; sha256: string; size: number }>;
  writeManifest(m: Omit<AssetManifest, 'manifestId' | 'createdAt'>): Promise<AssetManifest>;
  readManifest(manifestId: ManifestId | string): Promise<AssetManifest | null>;
  objectUrl(objectKey: string, grant: ReadGrant, ttlSeconds: number): Promise<string>;
  /** `reachable` is computed by the consuming app from the ledger; the provider never decides it. */
  collectUnreachable(input: { reachable: Set<string>; graceSeconds: number; now: string }): Promise<{ deleted: string[] }>;
}

// =============================================================================================
// B.12 ConnectedProviderWriteback
// =============================================================================================

export interface ConnectedProviderWriteback {
  /** Prepare a provider-native proposal (branch + PR) for one resource; acceptance remains the provider's. */
  prepareProposal(input: {
    resource: ResourceRef;
    base: RevisionId;
    candidate: FrozenCandidate;
    title: string;
    body: string;
  }): Promise<{ providerRef: string; providerProposalUrl?: string }>;
  observeAcceptance(resource: ResourceRef): Promise<{ accepted: boolean; headSha?: string }>;
  conditionalPromote(input: {
    resource: ResourceRef;
    targetRef: string;
    expectedSha: string;
    newSha: string;
  }): Promise<{ ok: boolean; code?: 'expected_head_stale' | 'provider_unavailable' }>;
}
