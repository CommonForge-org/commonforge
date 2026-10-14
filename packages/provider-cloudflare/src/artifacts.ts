/**
 * `ArtifactsVersionProvider` (plan §A.7, §B.2–§B.6): Cloudflare Artifacts as a `VersionProvider`.
 *
 * Owns namespace naming, repo create/delete, token mint/revoke with explicit TTL, reads (commit,
 * tree, file, log) and remote URLs. Never runs git and never hands a token to anything but the
 * caller of `issueWorkspaceCredential`: every write (seeding a workspace, retaining a candidate in
 * canonical, reconciling `refs/heads/main`) is a runner job submitted through `RunnerSubmit`; the
 * runner gets its tokens from the credential broker (plan §B.2, §B.8, §A.5 rules 2 and 5).
 *
 * Task workspaces: Artifacts `fork()` only forks inside the source namespace (binding and REST;
 * a target namespace in the REST body is silently ignored — probed live 2026-10-06), but plan
 * §A.7/§F requires task repos in `<prefix>-<org>-tasks` and never in `-canonical`. So a task
 * workspace is a fresh repo in the tasks namespace seeded by a `seed-workspace` runner job, which
 * also pins the workspace branch to exactly the ledger base instead of canonical's projected ref.
 *
 * Environment prefixes must never be dash-prefixes of each other (e.g. `commonforge` and
 * `commonforge-dev`): org ids may contain `-`, so `commonforge-dev-org1-tasks` would also parse as
 * org `dev-org1` under prefix `commonforge`. Configure the `workspace` resolver to bind every
 * handle to its organization and close this gap regardless of prefixes.
 */
import {
  AcceptedHeadSchema,
  ArtifactsCoordsSchema,
  CompareResultSchema,
  DEFAULT_CAPABILITIES,
  FreezeInputSchema,
  FrozenCandidateSchema,
  PreparedReceiptSchema,
  ReconcileResultSchema,
  SeedWorkspaceReceiptSchema,
  WorkspaceGrantSchema,
  artRevisionId,
  candidateId,
  candidateRetentionRef,
  checkPath,
  parseCandidateId,
  parseRevisionId,
  taskWorkspaceId as toTaskWorkspaceId,
  toIsoUtc,
  type AcceptedHead,
  type ArtifactsCoords,
  type CompareResult,
  type CreateIsolatedChangeInput,
  type ExportReceipt,
  type ExportSink,
  type FreezeInput,
  type FrozenCandidate,
  type PreparedReceipt,
  type ProviderCapabilities,
  type ReconcileResult,
  type ResolvedRevision,
  type ResourceId,
  type ResourceRef,
  type RevisionId,
  type RevisionSelector,
  type RunnerSubmit,
  type TaskWorkspaceHandle,
  type TaskWorkspaceState,
  type TreeEntry,
  type VersionProvider,
  type WorkspaceCredential,
  type WorkspaceGrant,
} from '@commonforge-org/core';
import type { z } from 'zod';
import { BindingArtifactsTransport, type ArtifactsBindingResolver } from './artifacts-binding.js';
import { RestArtifactsTransport, type RestArtifactsTransportOptions } from './artifacts-rest.js';
import type { ArtifactsCommit, ArtifactsRepoInfo, ArtifactsTransport } from './artifacts-transport.js';
import { ArtifactsProviderError, isArtifactsProviderError, redactSecrets } from './errors.js';
import {
  assertNamespacePrefix,
  canonicalRepoName,
  isCanonicalNamespace,
  namespaceFor,
  parseNamespace,
  taskWorkspaceRepoName,
} from './naming.js';

/** Artifacts token TTL bounds (plan §0.2). */
export const MIN_TOKEN_TTL_SECONDS = 60;
export const MAX_TOKEN_TTL_SECONDS = 31_536_000;
/** Default task lease bounding agent tokens (plan §F "Token leakage"). */
export const DEFAULT_LEASE_SECONDS = 3600;
/** Default signed-job max lifetime for canonical-write kinds (runner-protocol); runner tokens never outlive it. */
export const DEFAULT_MAX_JOB_SECONDS = 3600;

/** @deprecated core `WorkspaceGrant` now carries `leaseExpiresAt`; kept as an alias. */
export type ArtifactsWorkspaceGrant = WorkspaceGrant;

/**
 * `createIsolatedChange` input plus an optional caller-chosen workspace id. Pass an id that is
 * deterministic per (changeId, resourceId) to make ledger/outbox retries idempotent: an existing
 * repo seeded at the base is adopted instead of a second workspace being created.
 */
export type ArtifactsCreateIsolatedChangeInput = CreateIsolatedChangeInput & { taskWorkspaceId?: string };

/** The ledger's view of a task workspace (the authority; a handle is only a copy). */
export interface WorkspaceRecord {
  organizationId: string;
  state: TaskWorkspaceState;
  /** current lease generation; grants with another generation are refused */
  leaseGeneration?: number;
  /** current lease deadline; credential TTL never exceeds it */
  leaseExpiresAt?: string;
}

/**
 * Computes a compare in the runner (`git diff --name-status -M base candidate`, plan §B.6 P0).
 * `repo` holds both commits (the task repo during freeze, canonical otherwise).
 */
export interface CompareRequest {
  resourceId: ResourceId;
  repo: ArtifactsCoords;
  base: RevisionId;
  candidate: RevisionId;
  baseSha: string;
  candidateSha: string;
}
export type ArtifactsCompareDelegate = (req: CompareRequest) => Promise<CompareResult>;

export type ArtifactsTransportConfig =
  | ArtifactsTransport
  | { kind: 'binding'; bindings: ArtifactsBindingResolver }
  | ({ kind: 'rest' } & RestArtifactsTransportOptions);

export interface ArtifactsVersionProviderOptions {
  /** Workers binding (`env.ARTIFACTS`, one per namespace) or REST (`accountId` + `apiToken`). */
  transport: ArtifactsTransportConfig;
  /** `COMMONFORGE_NAMESPACE_PREFIX` (commonforge-dev | commonforge-ci | …). */
  namespacePrefix: string;
  /**
   * Submits runner jobs the interface has no `RunnerSubmit` parameter for. `createIsolatedChange`
   * needs it for `seed-workspace` (`prepareForAcceptance` / `reconcileAccepted` use their argument).
   */
  runner?: RunnerSubmit;
  /** Required by `compare`/`freezeCandidate` whenever the trees differ. */
  compare?: ArtifactsCompareDelegate;
  /** Ledger head lookup for `resolveRevision({kind:'accepted'})`. */
  acceptedHead?: (resource: ResourceRef) => Promise<AcceptedHead | RevisionId | null>;
  /**
   * Ledger workspace lookup. When configured, `issueWorkspaceCredential` uses the ledger's state,
   * lease generation and lease deadline instead of the handle's; credentials, freeze, collect and
   * prepare all bind the handle to the record's organization. Freeze still checks `handle.state`
   * (the app moves the ledger record out of `writable` before calling it, so new mints are refused
   * while it runs). The app wiring should always configure it.
   */
  workspace?: (taskWorkspaceId: string) => Promise<WorkspaceRecord | null>;
  /** Lease used to cap credential TTL when neither grant nor ledger gives a deadline (default 3600). */
  defaultLeaseSeconds?: number;
  /** Attempts for a create/lookup that fails with 5xx/429 (default 3). */
  createAttempts?: number;
  /** Rounds of list+revoke during freeze before giving up with `freeze_incomplete` (default 4). */
  freezeRevokeRounds?: number;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  newTaskWorkspaceId?: () => string;
}

function resolveTransport(t: ArtifactsTransportConfig): ArtifactsTransport {
  if ('createRepo' in t) return t;
  if (t.kind === 'binding') return new BindingArtifactsTransport(t.bindings);
  return new RestArtifactsTransport(t);
}

const TREE_TYPES: Record<string, TreeEntry['type']> = { tree: 'dir', blob: 'file', exec: 'file', symlink: 'symlink', gitlink: 'submodule' };

interface CheckedTask {
  coords: ArtifactsCoords;
  info: ArtifactsRepoInfo;
  record: WorkspaceRecord | null;
}

export class ArtifactsVersionProvider implements VersionProvider {
  readonly transport: ArtifactsTransport;
  readonly namespacePrefix: string;
  readonly #o: ArtifactsVersionProviderOptions;
  readonly #now: () => Date;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(options: ArtifactsVersionProviderOptions) {
    this.#o = options;
    this.transport = resolveTransport(options.transport);
    this.namespacePrefix = assertNamespacePrefix(options.namespacePrefix);
    this.#now = options.now ?? (() => new Date());
    this.#sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  capabilities(): ProviderCapabilities {
    return { ...DEFAULT_CAPABILITIES.artifacts };
  }

  // ===========================================================================================
  // Naming / coordinates
  // ===========================================================================================

  namespace(organizationId: string, kind: 'canonical' | 'tasks' | 'editions'): string {
    return namespaceFor(this.namespacePrefix, organizationId, kind);
  }

  /** Canonical coords of a Resource, or null when its repo does not exist. */
  async canonicalCoords(organizationId: string, resourceId: string): Promise<ArtifactsCoords | null> {
    const ns = this.namespace(organizationId, 'canonical');
    const info = await this.transport.getRepo(ns, canonicalRepoName(resourceId));
    return info ? toCoords(ns, info) : null;
  }

  /**
   * Create (or find) the canonical repo of a Resource. When this call created it (including a
   * create that answered 5xx/409 and was adopted by lookup), every token is revoked at once:
   * canonical repos receive write tokens only inside runner jobs (§A.5 rule 2). An existing repo
   * is returned untouched (revoking there would kill in-flight runner jobs); stale canonical write
   * tokens are the job of {@link revokeStaleCanonicalWriteTokens}.
   */
  async ensureCanonicalRepo(organizationId: string, resourceId: string, opts: { description?: string; defaultBranch?: string } = {}): Promise<ArtifactsCoords> {
    const ns = this.namespace(organizationId, 'canonical');
    const name = canonicalRepoName(resourceId);
    const existing = await this.#lookup(ns, name);
    if (existing) return toCoords(ns, existing);
    const info = await this.#createWithLookup(ns, name, opts);
    await this.#revokeTokens(ns, name, () => true);
    return toCoords(ns, info);
  }

  /**
   * GC sweep: revoke active canonical **write** tokens older than `maxAgeSeconds` (default: the
   * signed-job max lifetime). Catches a create token left by a crash between create and revoke,
   * and runner tokens whose job ended without revoking. Returns the number revoked.
   */
  async revokeStaleCanonicalWriteTokens(organizationId: string, resourceId: string, maxAgeSeconds = DEFAULT_MAX_JOB_SECONDS): Promise<number> {
    const ns = this.namespace(organizationId, 'canonical');
    const name = canonicalRepoName(resourceId);
    const cutoff = this.#now().getTime() - maxAgeSeconds * 1000;
    const tokens = await this.transport.listTokens(ns, name);
    let n = 0;
    for (const t of tokens) {
      if (t.state !== 'active' || t.scope !== 'write') continue;
      // Without createdAt, a token expiring later than a max-length job could is stale too.
      const created = t.createdAt ? Date.parse(t.createdAt) : Number.NaN;
      const stale = Number.isNaN(created) ? Date.parse(t.expiresAt) > this.#now().getTime() + maxAgeSeconds * 1000 : created < cutoff;
      if (stale && (await this.transport.revokeToken(ns, name, t.id))) n++;
    }
    return n;
  }

  // ===========================================================================================
  // Reads
  // ===========================================================================================

  async resolveRevision(resource: ResourceRef, selector: RevisionSelector): Promise<ResolvedRevision> {
    const canonical = this.#canonicalOf(resource);
    let sha: string;
    switch (selector.kind) {
      case 'accepted': {
        if (!this.#o.acceptedHead) throw new ArtifactsProviderError('accepted_head_unavailable', 'no acceptedHead resolver configured');
        const head = await this.#o.acceptedHead(resource);
        if (head === null) throw new ArtifactsProviderError('not_found', `no accepted head for ${resource.resourceId}`);
        sha = this.#shaIn(typeof head === 'string' ? head : AcceptedHeadSchema.parse(head).revisionId, canonical);
        break;
      }
      case 'revision':
        sha = this.#shaIn(selector.revisionId, canonical);
        break;
      case 'candidate':
        sha = parseCandidateId(selector.candidateId).sha;
        break;
      case 'ref': {
        // REST/binding cannot resolve full ref names (spike A5): only branches and tags, by short name.
        const m = /^refs\/(?:heads|tags)\/(.+)$/.exec(selector.ref);
        if (!m) {
          throw new ArtifactsProviderError('ref_unresolved', `${selector.ref}: only refs/heads/* and refs/tags/* resolve via the control plane; list other refs with git ls-remote in the runner`);
        }
        const [commit] = await this.transport.log(canonical.namespace, canonical.repoName, { ref: m[1]!, limit: 1 });
        if (!commit) throw new ArtifactsProviderError('ref_unresolved', `${selector.ref} did not resolve`);
        sha = commit.hash;
        break;
      }
    }
    const commit = await this.transport.readCommit(canonical.namespace, canonical.repoName, sha);
    if (!commit) throw new ArtifactsProviderError('not_found', `commit ${sha} not in ${canonical.repoName}`);
    return {
      resourceId: resource.resourceId,
      revisionId: artRevisionId(canonical.repoId, commit.hash),
      provider: 'artifacts',
      coords: canonical,
      contentId: commit.hash,
      treeId: commit.treeHash,
      resolvedAt: toIsoUtc(this.#now()),
    };
  }

  async listTree(resource: ResourceRef, revision: RevisionId, path: string): Promise<TreeEntry[]> {
    const canonical = this.#canonicalOf(resource);
    const sha = this.#shaIn(revision, canonical);
    const dir = this.#path(path, true);
    const commit = await this.transport.readCommit(canonical.namespace, canonical.repoName, sha);
    if (!commit) throw new ArtifactsProviderError('not_found', `commit ${sha} not in ${canonical.repoName}`);
    let tree = commit.treeHash;
    for (const seg of dir === '' ? [] : dir.split('/')) {
      const items = await this.transport.readTree(canonical.namespace, canonical.repoName, tree);
      const next = items?.find((i) => i.name === seg);
      if (!next || next.type !== 'tree') return [];
      tree = next.hash;
    }
    const items = (await this.transport.readTree(canonical.namespace, canonical.repoName, tree)) ?? [];
    return items.map((i) => ({
      path: dir === '' ? i.name : `${dir}/${i.name}`,
      type: TREE_TYPES[i.type] ?? 'file',
      mode: i.mode.padStart(6, '0'),
      oid: i.hash,
    }));
  }

  async readFile(resource: ResourceRef, revision: RevisionId, path: string): Promise<Uint8Array | null> {
    const canonical = this.#canonicalOf(resource);
    const sha = this.#shaIn(revision, canonical);
    return this.transport.readFile(canonical.namespace, canonical.repoName, sha, this.#path(path, false));
  }

  // ===========================================================================================
  // Task workspaces
  // ===========================================================================================

  /**
   * Create a task repo `ws-<id>` in `-tasks` and seed it at the base sha with a `seed-workspace`
   * runner job. Slow at size (seconds to tens of seconds): call it from a Queue/Workflow step with
   * the workspace recorded as `provisioning` first. With a caller-supplied `taskWorkspaceId`, a
   * retry adopts the repo of an earlier attempt (seeding it if needed). Every repo this call
   * created is deleted again on any failure.
   */
  async createIsolatedChange(input: ArtifactsCreateIsolatedChangeInput): Promise<TaskWorkspaceHandle> {
    if (input.resource.organizationId !== input.organizationId) {
      throw new ArtifactsProviderError('invalid_input', 'organizationId does not match the resource');
    }
    const canonical = this.#canonicalOf(input.resource);
    const baseSha = this.#shaIn(input.baseRevision, canonical);
    const runner = this.#o.runner;
    if (!runner) throw new ArtifactsProviderError('seed_failed', 'no runner configured to submit seed-workspace jobs');

    const canonInfo = await this.#lookup(canonical.namespace, canonical.repoName);
    if (!canonInfo) throw new ArtifactsProviderError('not_found', `canonical repo ${canonical.repoName} not found`);
    if (canonInfo.id !== canonical.repoId) throw new ArtifactsProviderError('repo_mismatch', 'canonical repoId changed (repo recreated?)');
    // Jobs carry the server's coordinates (remote URL included), never the caller's (review R-2).
    const canonicalServer = toCoords(canonical.namespace, canonInfo);
    const branch = canonInfo.defaultBranch;

    const wsId = toTaskWorkspaceId(input.taskWorkspaceId ?? this.#o.newTaskWorkspaceId?.() ?? crypto.randomUUID());
    const ns = this.namespace(input.organizationId, 'tasks');
    const name = taskWorkspaceRepoName(wsId);

    // Only a caller-chosen id can name an existing repo; a generated UUID never does.
    let existing = input.taskWorkspaceId === undefined ? null : await this.#lookup(ns, name);
    // An adopted repo is left for the retry/GC sweep; only a repo this call (may have) created is deleted.
    let deleteOnFailure = existing === null;
    try {
      let info = existing;
      if (!info) {
        try {
          info = await this.#createWithLookup(ns, name, {
            description: `commonforge task ${input.taskId} change ${input.changeId} resource ${input.resource.resourceId}`.slice(0, 200),
            defaultBranch: branch,
          });
        } catch (e) {
          // 409 without an earlier 5xx: someone else created this repo (a concurrent call with the
          // same caller-chosen id). Never delete it; with a caller id, adopt it like a retry (R-1).
          if (!isArtifactsProviderError(e, 'already_exists')) throw e;
          deleteOnFailure = false;
          if (input.taskWorkspaceId === undefined) throw e;
          info = await this.#lookup(ns, name);
          if (!info) throw e;
          existing = info;
        }
      }
      if (info.defaultBranch !== branch) throw new ArtifactsProviderError('already_exists', `task repo ${name} has branch ${info.defaultBranch}, expected ${branch}`);
      const coords = toCoords(ns, info);
      // No token of a workspace that nobody holds a handle to yet may survive (the 24 h create token
      // included). A caller retrying with the id of a handle in use would cut its agent off: misuse.
      await this.#revokeTokens(ns, name, () => true);

      const head = await this.#head(ns, name, branch);
      if (existing && head !== null && head !== baseSha) {
        deleteOnFailure = false;
        throw new ArtifactsProviderError('already_exists', `task repo ${name} exists at ${head}, not at base ${baseSha}`);
      }
      if (head !== baseSha) {
        const ref = `refs/heads/${branch}`;
        const out = await runner({ kind: 'seed-workspace', taskWorkspaceId: wsId, resourceId: input.resource.resourceId, canonical: canonicalServer, baseSha, taskFork: coords, ref });
        if (!out.ok) throw new ArtifactsProviderError('seed_failed', `seed-workspace ${out.code}: ${out.detail}`, { code: out.code, jobId: out.jobId });
        const receipt = parseReceipt(SeedWorkspaceReceiptSchema, out.receipt, 'seed-workspace');
        if (receipt.sha !== baseSha || receipt.ref !== ref || receipt.taskWorkspaceId !== wsId || receipt.resourceId !== input.resource.resourceId) {
          throw new ArtifactsProviderError('receipt_mismatch', 'seed-workspace receipt does not match the job', { jobId: out.jobId });
        }
        const seeded = await this.#head(ns, name, branch);
        if (seeded !== baseSha) throw new ArtifactsProviderError('seed_failed', `task repo ${name} head ${seeded ?? 'none'} ≠ base ${baseSha}`);
      }
      return {
        taskWorkspaceId: wsId,
        resourceId: input.resource.resourceId,
        baseRevision: input.baseRevision,
        provider: 'artifacts',
        coords,
        state: 'writable',
      };
    } catch (e) {
      // Never leave a half-created workspace behind (fault test: crash between fork and record → GC sweep).
      if (deleteOnFailure) await this.transport.deleteRepo(ns, name).catch(() => false);
      if (isArtifactsProviderError(e)) throw e;
      throw new ArtifactsProviderError('seed_failed', `creating ${name} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Mint a repo-scoped token for a task workspace. Refuses canonical and foreign namespaces, a
   * repoId that does not match the repo under that name, write unless the (ledger) state is
   * `writable`, and a stale lease generation. TTL is clamped to `[60, leaseRemaining]`. The remote
   * URL is the server's, never the handle's.
   */
  async issueWorkspaceCredential(handle: TaskWorkspaceHandle, grant: WorkspaceGrant): Promise<WorkspaceCredential> {
    this.#taskCoords(handle); // synchronous fences before any I/O
    const g = WorkspaceGrantSchema.safeParse(grant);
    if (!g.success) throw new ArtifactsProviderError('invalid_input', `invalid grant: ${g.error.message}`);
    const { coords, record } = await this.#checkedTask(handle);
    const scope = g.data.operations.includes('write') ? 'write' : 'read';
    const state = record?.state ?? handle.state;
    if (scope === 'write' && state !== 'writable') {
      throw new ArtifactsProviderError('workspace_not_writable', `workspace ${handle.taskWorkspaceId} is ${state}`);
    }
    if (state === 'collected' || state === 'abandoned' || state === 'provisioning') {
      throw new ArtifactsProviderError('workspace_not_writable', `workspace ${handle.taskWorkspaceId} is ${state}`);
    }
    if (record?.leaseGeneration !== undefined && record.leaseGeneration !== g.data.leaseGeneration) {
      throw new ArtifactsProviderError('lease_stale', `grant lease generation ${g.data.leaseGeneration} ≠ current ${record.leaseGeneration}`);
    }
    // Earliest deadline by parsed epoch, not string order: ledger timestamps may carry offsets (R-3).
    let deadline: string | undefined;
    for (const d of [g.data.leaseExpiresAt, record?.leaseExpiresAt]) {
      if (d === undefined) continue;
      const at = Date.parse(d);
      if (Number.isNaN(at)) throw new ArtifactsProviderError('invalid_input', 'leaseExpiresAt is not a timestamp');
      if (deadline === undefined || at < Date.parse(deadline)) deadline = d;
    }
    const ttl = this.clampTtl(g.data.ttlSeconds, deadline);
    const t = await this.transport.createToken(coords.namespace, coords.repoName, scope, ttl);
    return { tokenId: t.id, secret: t.plaintext, scope, expiresAt: toIsoUtc(new Date(t.expiresAt)), remoteUrl: coords.remoteUrl };
  }

  /** TTL clamped to `[60, leaseRemaining]`; refuses when the lease has less than 60 s left. */
  clampTtl(requested: number, leaseExpiresAt?: string): number {
    let leaseRemaining = this.#o.defaultLeaseSeconds ?? DEFAULT_LEASE_SECONDS;
    if (leaseExpiresAt !== undefined) {
      const at = Date.parse(leaseExpiresAt);
      if (Number.isNaN(at)) throw new ArtifactsProviderError('invalid_input', 'leaseExpiresAt is not a timestamp');
      leaseRemaining = Math.floor((at - this.#now().getTime()) / 1000);
    }
    leaseRemaining = Math.min(leaseRemaining, MAX_TOKEN_TTL_SECONDS);
    if (leaseRemaining < MIN_TOKEN_TTL_SECONDS) {
      throw new ArtifactsProviderError('lease_too_short', `lease has ${leaseRemaining}s left; Artifacts tokens live at least ${MIN_TOKEN_TTL_SECONDS}s`);
    }
    return Math.max(MIN_TOKEN_TTL_SECONDS, Math.min(Math.floor(requested), leaseRemaining));
  }

  /**
   * Freeze (plan §B.5): read the task branch HEAD; ≠ expectedSha → `candidate_moved`. Then, in
   * bounded rounds: revoke every active write token, re-read HEAD, list again. A write token that
   * appeared meanwhile (concurrent mint) starts another round; a moved HEAD gets one retry and then
   * `candidate_moved_during_freeze`; tokens that keep appearing → `freeze_incomplete`. Revocation
   * is effective on the next request and aborts in-flight pushes (spike A4), so once a round ends
   * with no active write token the sha cannot move.
   *
   * The consuming app must stop new write mints first — record the workspace as no longer writable
   * or bump its lease generation in the ledger (the `workspace` resolver then refuses them).
   */
  async freezeCandidate(handle: TaskWorkspaceHandle, input: FreezeInput): Promise<FrozenCandidate> {
    this.#taskCoords(handle);
    if (handle.state !== 'writable') {
      throw new ArtifactsProviderError('workspace_not_writable', `workspace ${handle.taskWorkspaceId} is ${handle.state}`);
    }
    const parsed = FreezeInputSchema.safeParse(input);
    if (!parsed.success) throw new ArtifactsProviderError('invalid_input', `invalid freeze input: ${parsed.error.message}`);
    const { expectedSha } = parsed.data;
    const { coords, info } = await this.#checkedTask(handle);
    const branch = info.defaultBranch;
    const ns = coords.namespace;
    const repo = coords.repoName;

    const before = await this.#head(ns, repo, branch);
    if (before !== expectedSha) {
      throw new ArtifactsProviderError('candidate_moved', `HEAD is ${before ?? 'unresolved'}, expected ${expectedSha}`, { expectedSha, observedSha: before });
    }
    const rounds = Math.max(2, this.#o.freezeRevokeRounds ?? 4);
    let retried = false;
    let frozen = false;
    for (let round = 0; round < rounds && !frozen; round++) {
      await this.#revokeTokens(ns, repo, (t) => t.scope === 'write');
      const after = await this.#head(ns, repo, branch);
      const left = (await this.transport.listTokens(ns, repo)).filter((t) => t.state === 'active' && t.scope === 'write');
      if (left.length > 0) continue; // minted concurrently: revoke again, then re-read
      if (after === expectedSha) {
        frozen = true;
        break;
      }
      if (retried) {
        throw new ArtifactsProviderError('candidate_moved_during_freeze', `HEAD moved to ${after ?? 'unresolved'} while freezing ${expectedSha}`, {
          expectedSha,
          observedSha: after,
        });
      }
      retried = true;
    }
    if (!frozen) throw new ArtifactsProviderError('freeze_incomplete', `write tokens kept appearing on ${repo} during ${rounds} revoke rounds`);

    const commit = await this.#commit(coords, expectedSha);
    const baseSha = this.#sha(handle.baseRevision);
    const cmp = await this.#compareIn({
      resourceId: handle.resourceId,
      repo: coords,
      base: handle.baseRevision,
      candidate: artRevisionId(coords.repoId, expectedSha),
      baseSha,
      candidateSha: expectedSha,
    });
    const changed = new Set<string>();
    for (const f of cmp.files) {
      changed.add(f.path);
      if (f.oldPath) changed.add(f.oldPath);
    }
    return FrozenCandidateSchema.parse({
      candidateId: candidateId(handle.taskWorkspaceId, expectedSha),
      taskWorkspaceId: handle.taskWorkspaceId,
      fork: coords,
      resourceId: handle.resourceId,
      baseRevision: handle.baseRevision,
      sha: expectedSha,
      treeId: commit.treeHash,
      frozenAt: toIsoUtc(this.#now()),
      submitter: parsed.data.submitter,
      ...(parsed.data.tool === undefined ? {} : { tool: parsed.data.tool }),
      changedPaths: [...changed].sort(),
    });
  }

  /** Delete the task repo (idempotent). Refuses canonical, foreign namespaces and a repoId mismatch. */
  async collectWorkspace(handle: TaskWorkspaceHandle): Promise<void> {
    this.#taskCoords(handle);
    const checked = await this.#checkedTask(handle, { allowMissing: true });
    if (!checked) return;
    await this.transport.deleteRepo(checked.coords.namespace, checked.coords.repoName);
  }

  // ===========================================================================================
  // Compare / acceptance (delegated to the runner)
  // ===========================================================================================

  async compare(resource: ResourceRef, base: RevisionId, candidate: RevisionId): Promise<CompareResult> {
    const canonical = this.#canonicalOf(resource);
    return this.#compareIn({
      resourceId: resource.resourceId,
      repo: canonical,
      base,
      candidate,
      baseSha: this.#shaIn(base, canonical),
      candidateSha: this.#sha(candidate),
    });
  }

  async prepareForAcceptance(candidate: FrozenCandidate, submit: RunnerSubmit): Promise<PreparedReceipt> {
    const c = FrozenCandidateSchema.parse(candidate);
    const fork = this.#taskCoordsOf(c.fork);
    let org = parseNamespace(this.namespacePrefix, fork.namespace)!.organizationId;
    if (this.#o.workspace) {
      const record = await this.#o.workspace(c.taskWorkspaceId);
      if (!record) throw new ArtifactsProviderError('not_found', `workspace ${c.taskWorkspaceId} unknown to the ledger`);
      if (fork.namespace !== this.namespace(record.organizationId, 'tasks')) {
        throw new ArtifactsProviderError('namespace_refused', `${fork.namespace} is not the tasks namespace of ${record.organizationId}`);
      }
      org = record.organizationId;
    }
    const canonical = await this.canonicalCoords(org, c.resourceId);
    if (!canonical) throw new ArtifactsProviderError('not_found', `canonical repo for ${c.resourceId} not found`);
    const retentionRef = candidateRetentionRef(c.candidateId);
    const out = await submit({ kind: 'prepare-candidate', candidate: c, canonical, retentionRef });
    if (!out.ok) throw new ArtifactsProviderError('runner_failed', `prepare-candidate ${out.code}: ${out.detail}`, { code: out.code, jobId: out.jobId });
    const receipt = parseReceipt(PreparedReceiptSchema, out.receipt, 'prepare-candidate');
    const expectedRevision = artRevisionId(canonical.repoId, c.sha);
    if (
      receipt.candidateId !== c.candidateId ||
      receipt.sha !== c.sha ||
      receipt.resourceId !== c.resourceId ||
      receipt.canonicalRef !== retentionRef ||
      receipt.revisionId !== expectedRevision
    ) {
      throw new ArtifactsProviderError('receipt_mismatch', 'prepare-candidate receipt does not match the candidate', { jobId: out.jobId });
    }
    // The objects must now be readable from canonical (plan §A.6 Prepared guard).
    if (!(await this.transport.readCommit(canonical.namespace, canonical.repoName, c.sha))) {
      throw new ArtifactsProviderError('receipt_mismatch', `candidate ${c.sha} not readable in canonical after prepare`, { jobId: out.jobId });
    }
    return receipt;
  }

  /**
   * Project the ledger head onto the canonical branch with a `reconcile-ref` runner job.
   * `opts.branch` is the branch the app recorded for the resource; pass it whenever known, because
   * Artifacts misreports `default_branch` as `main` for imported repos (spike A6). Without it the
   * repo's reported default branch is used.
   *
   * `opts.expectedCurrentSha` fixes the push lease to a sha the caller vouches for (for example the
   * previous head, or the sha it last recorded as synced) instead of whatever the branch holds when
   * this call reads it: a branch moved by anyone else (a newer reconcile included) then makes the
   * runner report `diverged` instead of overwriting it. `null` means "the branch must not exist".
   */
  async reconcileAccepted(
    resource: ResourceRef,
    head: AcceptedHead,
    submit: RunnerSubmit,
    opts: { branch?: string; expectedCurrentSha?: string | null } = {},
  ): Promise<ReconcileResult> {
    const canonical = this.#canonicalOf(resource);
    if (head.resourceId !== resource.resourceId) throw new ArtifactsProviderError('invalid_input', 'head belongs to another resource');
    const targetSha = this.#shaIn(head.revisionId, canonical);
    const info = await this.transport.getRepo(canonical.namespace, canonical.repoName);
    if (!info) throw new ArtifactsProviderError('not_found', `canonical repo ${canonical.repoName} not found`);
    if (info.id !== canonical.repoId) throw new ArtifactsProviderError('repo_mismatch', 'canonical repoId changed (repo recreated?)');
    const canonicalServer = toCoords(canonical.namespace, info);
    const branch = opts.branch ?? info.defaultBranch;
    if (!/^[A-Za-z0-9._/-]{1,200}$/.test(branch) || branch.startsWith('refs/') || branch.includes('..')) {
      throw new ArtifactsProviderError('invalid_input', `invalid branch ${JSON.stringify(branch)}`);
    }
    const ref = `refs/heads/${branch}`;
    const current = await this.#head(canonical.namespace, canonical.repoName, branch);
    if (current === targetSha) {
      return { resourceId: resource.resourceId, ref, targetSha, observedSha: current, status: 'synced', reconciledAt: toIsoUtc(this.#now()) };
    }
    const out = await submit({
      kind: 'reconcile-ref',
      resourceId: resource.resourceId,
      canonical: canonicalServer,
      ref,
      targetSha,
      expectedCurrentSha: opts.expectedCurrentSha !== undefined ? opts.expectedCurrentSha : current,
    });
    if (!out.ok) throw new ArtifactsProviderError('runner_failed', `reconcile-ref ${out.code}: ${out.detail}`, { code: out.code, jobId: out.jobId });
    const receipt = parseReceipt(ReconcileResultSchema, out.receipt, 'reconcile-ref');
    if (receipt.ref !== ref || receipt.targetSha !== targetSha) {
      throw new ArtifactsProviderError('receipt_mismatch', 'reconcile-ref receipt does not match the job', { jobId: out.jobId });
    }
    return receipt;
  }

  async exportRevision(_resource: ResourceRef, _revision: RevisionId, _sink: ExportSink): Promise<ExportReceipt> {
    // An ExportReceipt is bound to a SnapshotId and produced by the runner's `export` job (§B.10),
    // which the consuming app submits for the whole snapshot; this signature carries neither.
    throw new ArtifactsProviderError('not_supported', 'exportRevision: submit a runner `export` job for the snapshot');
  }

  // ===========================================================================================
  // Internals
  // ===========================================================================================

  /** Canonical coords from a ResourceRef, checked against this provider's naming. */
  #canonicalOf(resource: ResourceRef): ArtifactsCoords {
    if (resource.provider !== 'artifacts' || resource.coords.kind !== 'artifacts') {
      throw new ArtifactsProviderError('invalid_input', `resource ${resource.resourceId} is not an Artifacts resource`);
    }
    const coords = ArtifactsCoordsSchema.parse(resource.coords);
    if (coords.namespace !== this.namespace(resource.organizationId, 'canonical')) {
      throw new ArtifactsProviderError('invalid_input', `resource namespace ${coords.namespace} is not the org's canonical namespace`);
    }
    return coords;
  }

  /** Task repo coords from a handle (no I/O); refuses canonical and any non-`-tasks` namespace. */
  #taskCoords(handle: TaskWorkspaceHandle): ArtifactsCoords {
    if (handle.provider !== 'artifacts') throw new ArtifactsProviderError('invalid_input', 'not an Artifacts workspace');
    const coords = this.#taskCoordsOf(handle.coords);
    if (coords.repoName !== taskWorkspaceRepoName(handle.taskWorkspaceId)) {
      throw new ArtifactsProviderError('namespace_refused', `repo ${coords.repoName} is not workspace ${handle.taskWorkspaceId}`);
    }
    return coords;
  }

  #taskCoordsOf(raw: TaskWorkspaceHandle['coords']): ArtifactsCoords {
    if (isCanonicalNamespace(raw.namespace)) {
      throw new ArtifactsProviderError('canonical_namespace_refused', `${raw.namespace} is a canonical namespace`);
    }
    if (raw.kind !== 'artifacts') throw new ArtifactsProviderError('invalid_input', 'not an Artifacts repo');
    const parsed = parseNamespace(this.namespacePrefix, raw.namespace);
    if (!parsed || parsed.kind !== 'tasks') {
      throw new ArtifactsProviderError('namespace_refused', `${raw.namespace} is not a ${this.namespacePrefix} tasks namespace`);
    }
    return ArtifactsCoordsSchema.parse(raw);
  }

  /**
   * Handle checks that need I/O: the ledger record (organization binding) when a `workspace`
   * resolver is configured, and the live repo, whose id must equal the handle's repoId. Returns
   * coords rebuilt from the server's repo info (its remote URL, never the handle's).
   */
  async #checkedTask(handle: TaskWorkspaceHandle, opts: { allowMissing: true }): Promise<CheckedTask | null>;
  async #checkedTask(handle: TaskWorkspaceHandle, opts?: { allowMissing?: false }): Promise<CheckedTask>;
  async #checkedTask(handle: TaskWorkspaceHandle, opts: { allowMissing?: boolean } = {}): Promise<CheckedTask | null> {
    const claimed = this.#taskCoords(handle);
    let record: WorkspaceRecord | null = null;
    if (this.#o.workspace) {
      record = await this.#o.workspace(handle.taskWorkspaceId);
      if (!record) throw new ArtifactsProviderError('not_found', `workspace ${handle.taskWorkspaceId} unknown to the ledger`);
      if (claimed.namespace !== this.namespace(record.organizationId, 'tasks')) {
        throw new ArtifactsProviderError('namespace_refused', `${claimed.namespace} is not the tasks namespace of ${record.organizationId}`);
      }
    }
    const info = await this.transport.getRepo(claimed.namespace, claimed.repoName);
    if (!info) {
      if (opts.allowMissing) return null;
      throw new ArtifactsProviderError('not_found', `task repo ${claimed.repoName} not found`);
    }
    if (info.id !== claimed.repoId) {
      throw new ArtifactsProviderError('repo_mismatch', `task repo ${claimed.repoName} is ${info.id}, handle says ${claimed.repoId}`);
    }
    return { coords: toCoords(claimed.namespace, info), info, record };
  }

  /** Commit sha of an `art:` revision. */
  #sha(revision: RevisionId): string {
    const p = parseRevisionId(revision);
    if (p.kind !== 'art') throw new ArtifactsProviderError('revision_mismatch', `${revision} is not an Artifacts revision`);
    return p.sha;
  }

  /** Commit sha of an `art:` revision that must belong to `coords`. */
  #shaIn(revision: RevisionId, coords: ArtifactsCoords): string {
    const p = parseRevisionId(revision);
    if (p.kind !== 'art' || p.repoId !== coords.repoId) {
      throw new ArtifactsProviderError('revision_mismatch', `${revision} is not a revision of ${coords.repoName} (${coords.repoId})`);
    }
    return p.sha;
  }

  #path(path: string, allowEmpty: boolean): string {
    const r = checkPath(path, { allowEmpty });
    if (!r.ok) throw new ArtifactsProviderError('invalid_input', `invalid path (${r.violation})`);
    return r.path;
  }

  async #head(ns: string, repo: string, branch: string): Promise<string | null> {
    const [c] = await this.transport.log(ns, repo, { ref: branch, limit: 1 });
    return c?.hash ?? null;
  }

  async #commit(coords: ArtifactsCoords, sha: string): Promise<ArtifactsCommit> {
    const c = await this.transport.readCommit(coords.namespace, coords.repoName, sha);
    if (!c) throw new ArtifactsProviderError('not_found', `commit ${sha} not in ${coords.repoName}`);
    return c;
  }

  async #revokeTokens(ns: string, repo: string, which: (t: { scope: 'read' | 'write' }) => boolean): Promise<number> {
    const tokens = await this.transport.listTokens(ns, repo);
    let n = 0;
    for (const t of tokens) {
      if (t.state === 'active' && which(t)) {
        await this.transport.revokeToken(ns, repo, t.id);
        n++;
      }
    }
    return n;
  }

  /** `getRepo`, retried on `provider_unavailable` (5xx/429) instead of guessing "absent". */
  async #lookup(ns: string, name: string): Promise<ArtifactsRepoInfo | null> {
    const attempts = Math.max(1, this.#o.createAttempts ?? 3);
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.transport.getRepo(ns, name);
      } catch (e) {
        if (!isArtifactsProviderError(e, 'provider_unavailable') || attempt >= attempts) throw e;
        await this.#sleep((this.#o.retryDelayMs ?? 1000) * attempt);
      }
    }
  }

  /**
   * Create a repo. Create is not idempotent and can answer 5xx after succeeding (spike A2): after
   * any `provider_unavailable` the repo is looked up (lookup itself retried) before a retry, and a
   * later `already_exists` means our own earlier attempt landed, so the repo is adopted.
   */
  async #createWithLookup(ns: string, name: string, opts: { description?: string; defaultBranch?: string }): Promise<ArtifactsRepoInfo> {
    const attempts = Math.max(1, this.#o.createAttempts ?? 3);
    const delay = this.#o.retryDelayMs ?? 1000;
    let sawUnavailable = false;
    for (let attempt = 1; ; attempt++) {
      try {
        const created = await this.transport.createRepo(ns, name, opts);
        const { token: _secret, ...info } = created;
        return info;
      } catch (e) {
        if (sawUnavailable && isArtifactsProviderError(e, 'already_exists')) {
          const found = await this.#lookup(ns, name);
          if (found) return found;
          throw e;
        }
        if (!isArtifactsProviderError(e, 'provider_unavailable')) throw e;
        sawUnavailable = true;
        // A lookup that keeps failing means "unknown", not "absent": retry the create, and a 409
        // on that retry adopts the repo (above). The caller deletes it if we finally give up.
        let found: ArtifactsRepoInfo | null = null;
        try {
          found = await this.#lookup(ns, name);
        } catch (le) {
          if (!isArtifactsProviderError(le, 'provider_unavailable')) throw le;
        }
        if (found) return found;
        if (attempt >= attempts) throw e;
        await this.#sleep(delay * attempt);
      }
    }
  }

  async #compareIn(req: CompareRequest): Promise<CompareResult> {
    const same: CompareResult = { base: req.base, candidate: req.candidate, sameTree: true, files: [] };
    if (req.baseSha === req.candidateSha) return same;
    const [b, c] = await Promise.all([
      this.transport.readCommit(req.repo.namespace, req.repo.repoName, req.baseSha),
      this.transport.readCommit(req.repo.namespace, req.repo.repoName, req.candidateSha),
    ]);
    if (b && c && b.treeHash === c.treeHash) return same;
    if (!this.#o.compare) {
      throw new ArtifactsProviderError('compare_unavailable', 'trees differ and no compare delegate is configured (plan §B.6: compare runs in the runner)');
    }
    const result = parseReceipt(CompareResultSchema, await this.#o.compare(req), 'compare');
    if (result.base !== req.base || result.candidate !== req.candidate) {
      throw new ArtifactsProviderError('receipt_mismatch', 'compare result is for different revisions');
    }
    return result;
  }
}

/** Parse a runner-produced value; a schema failure becomes a redacted `receipt_mismatch`, never a raw ZodError. */
function parseReceipt<S extends z.ZodType>(schema: S, value: unknown, what: string): z.infer<S> {
  const r = schema.safeParse(value);
  if (!r.success) {
    const issues = r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new ArtifactsProviderError('receipt_mismatch', `${what} result is malformed: ${issues}`);
  }
  return r.data;
}

function toCoords(namespace: string, info: ArtifactsRepoInfo): ArtifactsCoords {
  const parsed = ArtifactsCoordsSchema.safeParse({ kind: 'artifacts', namespace, repoName: info.name, repoId: info.id, remoteUrl: info.remote });
  if (!parsed.success) throw new ArtifactsProviderError('provider_error', `unexpected repo info for ${info.name}: ${redactSecrets(parsed.error.message)}`);
  return parsed.data;
}
