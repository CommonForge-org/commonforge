/**
 * `LocalGitProvider` (plan §B.2–§B.6, §B.10, §G.2): a `VersionProvider` over bare git repositories
 * under one root directory. It backs tests and local development, and it is the exit route of
 * plan §I Q15: the root can be served by any git server (e.g. `git http-backend` behind an
 * authenticating front), so canonical repositories never depend on Cloudflare Artifacts.
 *
 * Layout under `root`:
 *
 *   <prefix>-<orgId>-canonical/<resourceId>.git     canonical repo, one per Resource
 *   <prefix>-<orgId>-tasks/ws-<taskWorkspaceId>.git  task workspace repo
 *   .commonforge/repos/<repoId>.json                 registry: role, owner, workspace state
 *   .commonforge/service-token                       the runner/service credential (0600)
 *   .commonforge/no-hooks/                           empty hooks dir for the provider's own git
 *   exports/<r2Key>                                  default export store
 *
 * Rules (same as the Artifacts provider, plan §0.3 update 2026-10-06):
 * - Task workspaces are fresh repos seeded with the base sha from canonical. There is no fork
 *   lineage, and canonical never sees a task repo's objects until `prepare-candidate` runs.
 * - Every canonical write goes through the injected `RunnerSubmit`. The provider never pushes;
 *   its only writes are seeding a new task repo, the freeze lock, and deleting a collected repo.
 * - Credentials are real: each repo has a push guard (see `hooks.ts`). Canonical accepts only the
 *   service credential. A task repo accepts only an unexpired write token issued for it, and
 *   nothing once frozen. Freeze revokes the write tokens, and collect deletes the repository.
 *   The workspace state the provider persists decides; the caller's `handle.state` can only
 *   narrow it.
 * - Pushes are one ref at a time, like Artifacts: `receive.advertiseAtomic` is off.
 *
 * Security boundary: over `file://` the enforcement is ADVISORY. It catches mistakes and runs
 * the conformance contract, but it does not stop a hostile agent. A `file://` pusher starts
 * `receive-pack` itself, so it controls that process's command line and environment. For example,
 * `git push --receive-pack='git -c core.hooksPath=/dev/null receive-pack'` skips the guard, and a
 * fake `date` or `git` early on `PATH` defeats the expiry or digest check. Reads are not enforced
 * at all: whoever can open the directory can read it.
 * Real enforcement needs both of the following:
 * - Serve `root` over smart HTTP. The front authenticates `Authorization: Bearer <secret>` with
 *   {@link LocalGitProvider.authorizeGitRequest}, then runs `git http-backend` with
 *   `COMMONFORGE_TOKEN=<secret>`, so the server-side guard sees the same credential.
 * - Agents can reach only the HTTP endpoint, never the `root` directory or a shell on that host.
 * Configure `remoteUrl` so coords carry the HTTP URLs.
 *
 * Maintenance: the guard also fires for local ref transactions. Run operator maintenance through
 * {@link LocalGitProvider.maintain}, or use git with `-c core.hooksPath=<empty dir>`, as the
 * provider's own git does. Plain `git pack-refs` or `git update-ref` without a credential is
 * refused, and `git gc` skips packing refs.
 *
 * Clock: credential expiry is stored as epoch seconds. The provider checks it against the
 * injected `now`, but over git the guard checks it against the host clock (`date +%s`), so
 * production must not inject a skewed clock.
 *
 * Export: implemented here in full (`git bundle` of the revision's complete history, with
 * `historyMode: 'full'`), because a local provider has direct repository access and no Worker
 * constraint. The Artifacts provider delegates export to a runner job instead.
 */
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  AcceptedHeadSchema,
  candidateId,
  candidateRetentionRef,
  checkPath,
  computeSnapshotIdSync,
  DEFAULT_CAPABILITIES,
  FreezeInputSchema,
  FrozenCandidateSchema,
  IdSegmentSchema,
  isValidGitRef,
  localRevisionId,
  parseCandidateId,
  parseRevisionId,
  PreparedReceiptSchema,
  ReconcileResultSchema,
  sha256Hex,
  taskWorkspaceId as toTaskWorkspaceId,
  toIsoUtc,
  WorkspaceGrantSchema,
  type AcceptedHead,
  type CompareResult,
  type CreateIsolatedChangeInput,
  type ExportReceipt,
  type ExportSink,
  type FreezeInput,
  type FrozenCandidate,
  type LocalGitCoords,
  type PreparedReceipt,
  type ProviderCapabilities,
  type ReconcileResult,
  type RepoCoords,
  type ResolvedRevision,
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
import { LocalGitProviderError } from './errors.js';
import { FileExportStore, type ExportStore } from './export-store.js';
import { createGitExec, utf8, type GitExec, type GitExecOptions, type NodeGitExecOptions } from './git.js';
import { FROZEN_MARKER, GUARDED_HOOKS, guardScript, HOOKS_DIR, SERVICE_DIR, STATE_DIR, TOKEN_PREFIX, TOKENS_DIR, type GuardRole } from './hooks.js';

export const DEFAULT_NAMESPACE_PREFIX = 'commonforge-local';
export const DEFAULT_BRANCH = 'main';
/** How long freeze waits for a ref lock held by an in-flight push (ms). */
const FREEZE_LOCK_TIMEOUT_MS = 10_000;

const PREFIX_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export interface LocalGitProviderOptions {
  /** directory that holds every repository (created if missing) */
  root: string;
  /** namespace prefix: `<prefix>-<orgId>-canonical|tasks` (default `commonforge-local`) */
  namespacePrefix?: string;
  /**
   * The service (runner) credential canonical repositories accept. Default: read from
   * `<root>/.commonforge/service-token`, generated on first use.
   */
  serviceToken?: string;
  /** remote URL for a repository (default `file://<path>`); set it when serving `root` over HTTP */
  remoteUrl?: (repo: { namespace: string; repoName: string; path: string }) => string;
  /** where export bundles are written (default {@link FileExportStore} under `<root>/exports`) */
  exportStore?: ExportStore;
  /** ledger head lookup for `resolveRevision({ kind: 'accepted' })` */
  acceptedHead?: (resource: ResourceRef) => Promise<AcceptedHead | RevisionId | null>;
  /** git process options (binary, extra env, timeout); global/system config is always ignored */
  git?: NodeGitExecOptions;
  now?: () => Date;
  newTaskWorkspaceId?: () => string;
  /** how long freeze waits for a branch lock held by an in-flight push (default 10 s) */
  freezeLockTimeoutMs?: number;
}

export interface CreateCanonicalInput {
  organizationId: string;
  resourceId: string;
  /** repository (path or URL) to import `sourceRef` from; omit for an empty repository */
  source?: string;
  /** `HEAD`, a full sha, or a full ref name (`refs/...`) in `source` (default `HEAD`) */
  sourceRef?: string;
  /** canonical branch (default `main`) */
  branch?: string;
}

/** Registry record of one repository (`.commonforge/repos/<repoId>.json`). */
interface RepoRecord {
  v: 1;
  role: GuardRole;
  repoId: string;
  namespace: string;
  repoName: string;
  organizationId: string;
  resourceId: string;
  branch: string;
  createdAt: string;
  updatedAt: string;
  /** task repos only */
  taskWorkspaceId?: string;
  baseRevision?: string;
  state?: TaskWorkspaceState;
  frozenSha?: string;
}

type TaskRecord = RepoRecord & { role: 'task'; taskWorkspaceId: string; baseRevision: string; state: TaskWorkspaceState };

const TREE_TYPES: Record<string, TreeEntry['type']> = { tree: 'dir', blob: 'file', commit: 'submodule' };

export class LocalGitProvider implements VersionProvider {
  readonly root: string;
  readonly namespacePrefix: string;
  readonly exportStore: ExportStore;
  readonly #o: LocalGitProviderOptions;
  readonly #exec: GitExec;
  readonly #now: () => Date;
  readonly #locks = new Map<string, Promise<unknown>>();
  #serviceToken: string | undefined;
  #ready: Promise<void> | undefined;

  constructor(options: LocalGitProviderOptions) {
    this.#o = options;
    this.root = options.root;
    this.namespacePrefix = options.namespacePrefix ?? DEFAULT_NAMESPACE_PREFIX;
    if (!PREFIX_RE.test(this.namespacePrefix)) throw new LocalGitProviderError('invalid_input', `namespace prefix must match ${PREFIX_RE}`);
    this.exportStore = options.exportStore ?? new FileExportStore(join(options.root, 'exports'));
    this.#exec = createGitExec(options.git);
    this.#now = options.now ?? (() => new Date());
    this.#serviceToken = options.serviceToken;
  }

  /** Construct and initialize (root directories, service credential). */
  static async open(options: LocalGitProviderOptions): Promise<LocalGitProvider> {
    const p = new LocalGitProvider(options);
    await p.#init();
    return p;
  }

  capabilities(): ProviderCapabilities {
    return { ...DEFAULT_CAPABILITIES['local-git'] };
  }

  // ===========================================================================================
  // Credentials for git clients
  // ===========================================================================================

  /** The service (runner) credential. It can write canonical repositories, so keep it secret. */
  async serviceToken(): Promise<string> {
    await this.#init();
    return this.#serviceToken!;
  }

  /** Environment for a `file://` git client that pushes as the service (runner). */
  async serviceGitEnv(): Promise<Record<string, string>> {
    return { COMMONFORGE_TOKEN: await this.serviceToken() };
  }

  /** Environment for a `file://` git client that pushes with a workspace credential. */
  static credentialGitEnv(credential: Pick<WorkspaceCredential, 'secret'>): Record<string, string> {
    return { COMMONFORGE_TOKEN: credential.secret };
  }

  /**
   * Authorization check for an HTTP front serving `root` (`git http-backend`). `namespace` and
   * `repoName` come from the request path, `secret` from the bearer token, and `operation` is
   * `write` for `git-receive-pack` and `read` otherwise. The push guard re-checks every push.
   */
  async authorizeGitRequest(request: { namespace: string; repoName: string; secret: string | null; operation: 'read' | 'write' }): Promise<boolean> {
    await this.#init();
    if (!request.secret) return false;
    const record = await this.#findRecordByName(request.namespace, request.repoName);
    if (!record) return false;
    const service = secretsEqual(request.secret, this.#serviceToken!);
    if (record.role === 'canonical') return service;
    const task = record as TaskRecord;
    if (task.state === 'collected' || task.state === 'abandoned' || task.state === 'provisioning') return false;
    if (service) return request.operation === 'read';
    const tok = await this.#readToken(task, request.secret);
    if (!tok || tok.expires * 1000 <= this.#now().getTime()) return false;
    if (request.operation === 'read') return true;
    return tok.scope === 'write' && task.state === 'writable' && !(await exists(join(this.#repoPath(task), FROZEN_MARKER)));
  }

  // ===========================================================================================
  // Canonical repositories
  // ===========================================================================================

  namespace(organizationId: string, kind: 'canonical' | 'tasks'): string {
    assertIdSegment(organizationId, 'organizationId');
    const ns = `${this.namespacePrefix}-${organizationId}-${kind}`;
    if (ns.length > 128) throw new LocalGitProviderError('invalid_input', 'namespace longer than 128 characters');
    return ns;
  }

  /**
   * Create the canonical repository of a Resource, optionally importing `sourceRef` from
   * `source` as its branch. The repository's id is the resourceId, so it must be unique under root.
   */
  async createCanonicalResource(input: CreateCanonicalInput): Promise<ResourceRef> {
    await this.#init();
    assertIdSegment(input.resourceId, 'resourceId');
    const branch = input.branch ?? DEFAULT_BRANCH;
    if (branch.startsWith('-') || !isValidGitRef(`refs/heads/${branch}`)) throw new LocalGitProviderError('invalid_input', `invalid branch ${JSON.stringify(branch)}`);
    // Import arguments may come from user input: never let them be parsed as git options.
    if (input.source !== undefined && (input.source === '' || input.source.startsWith('-') || /[\0\n]/.test(input.source))) {
      throw new LocalGitProviderError('invalid_input', 'source must be a repository path or URL');
    }
    const src = input.sourceRef ?? 'HEAD';
    if (!(src === 'HEAD' || SHA_RE.test(src) || (src.startsWith('refs/') && isValidGitRef(src)))) {
      throw new LocalGitProviderError('invalid_input', 'sourceRef must be HEAD, a full sha or a full ref name');
    }
    const now = toIsoUtc(this.#now());
    const record: RepoRecord = {
      v: 1,
      role: 'canonical',
      repoId: input.resourceId,
      namespace: this.namespace(input.organizationId, 'canonical'),
      repoName: input.resourceId,
      organizationId: input.organizationId,
      resourceId: input.resourceId,
      branch,
      createdAt: now,
      updatedAt: now,
    };
    await this.#claimRecord(record);
    const path = this.#repoPath(record);
    try {
      await this.#initRepo(path, branch, 'canonical');
      if (input.source !== undefined) {
        await this.#gitOk(
          [...IMPORT_PROTOCOLS, 'fetch', '-q', '--no-tags', '--no-write-fetch-head', '--end-of-options', input.source, `${src}:refs/heads/${branch}`],
          path,
        );
      }
    } catch (e) {
      await rm(path, { recursive: true, force: true });
      await rm(this.#recordPath(record.repoId), { force: true });
      throw e;
    }
    return this.#resourceRef(record);
  }

  /** The ResourceRef of an existing canonical repository, or null. */
  async openCanonicalResource(organizationId: string, resourceId: string): Promise<ResourceRef | null> {
    await this.#init();
    const record = await this.#readRecord(resourceId);
    if (!record || record.role !== 'canonical' || record.organizationId !== organizationId) return null;
    await this.#installGuard(this.#repoPath(record), 'canonical');
    return this.#resourceRef(record);
  }

  // ===========================================================================================
  // Reads
  // ===========================================================================================

  async resolveRevision(resource: ResourceRef, selector: RevisionSelector): Promise<ResolvedRevision> {
    const canonical = await this.#canonicalOf(resource);
    let target: { record: RepoRecord; sha: string };
    switch (selector.kind) {
      case 'accepted': {
        if (!this.#o.acceptedHead) throw new LocalGitProviderError('accepted_head_unavailable', 'no acceptedHead resolver configured');
        const head = await this.#o.acceptedHead(resource);
        if (head === null) throw new LocalGitProviderError('not_found', `no accepted head for ${resource.resourceId}`);
        const revision = typeof head === 'string' ? head : AcceptedHeadSchema.parse(head).revisionId;
        target = await this.#revisionTarget(resource, revision);
        if (target.record.role !== 'canonical') throw new LocalGitProviderError('revision_mismatch', 'an accepted head must be a canonical revision');
        break;
      }
      case 'revision':
        target = await this.#revisionTarget(resource, selector.revisionId);
        break;
      case 'ref': {
        if (!isValidGitRef(selector.ref)) throw new LocalGitProviderError('invalid_input', `invalid ref ${JSON.stringify(selector.ref)}`);
        const r = await this.#git(['rev-parse', '--verify', '--quiet', '--end-of-options', `${selector.ref}^{commit}`], this.#repoPath(canonical));
        if (r.code !== 0) throw new LocalGitProviderError('ref_unresolved', `${selector.ref} does not resolve in canonical`);
        target = { record: canonical, sha: utf8(r.stdout).trim() };
        break;
      }
      case 'candidate': {
        const { taskWorkspaceId, sha } = parseCandidateId(selector.candidateId);
        if (await this.#hasCommit(this.#repoPath(canonical), sha)) {
          target = { record: canonical, sha };
        } else {
          const task = await this.#readRecord(taskRepoId(taskWorkspaceId));
          if (!task || task.role !== 'task' || task.resourceId !== resource.resourceId || task.state === 'collected') {
            throw new LocalGitProviderError('not_found', `candidate ${selector.candidateId} not found`);
          }
          target = { record: task, sha };
        }
        break;
      }
    }
    const path = this.#repoPath(target.record);
    if (!(await this.#hasCommit(path, target.sha))) throw new LocalGitProviderError('not_found', `commit ${target.sha} not in ${target.record.repoName}`);
    const treeId = utf8((await this.#gitOk(['rev-parse', `${target.sha}^{tree}`], path)).stdout).trim();
    return {
      resourceId: resource.resourceId,
      revisionId: localRevisionId(target.record.repoId, target.sha),
      provider: 'local-git',
      coords: this.#coords(target.record),
      contentId: target.sha,
      treeId,
      resolvedAt: toIsoUtc(this.#now()),
    };
  }

  async listTree(resource: ResourceRef, revision: RevisionId, path: string): Promise<TreeEntry[]> {
    const { record, sha } = await this.#revisionTarget(resource, revision);
    const repo = this.#repoPath(record);
    await this.#requireCommit(repo, sha, record);
    const dir = normalize(path, true);
    const r = await this.#git(['ls-tree', '-l', '-z', '--end-of-options', dir === '' ? `${sha}^{tree}` : `${sha}:${dir}`], repo);
    if (r.code !== 0) return []; // missing path or not a directory
    const out: TreeEntry[] = [];
    for (const line of utf8(r.stdout).split('\0')) {
      if (!line) continue;
      const tab = line.indexOf('\t');
      const [mode, type, oid, size] = line.slice(0, tab).split(/\s+/) as [string, string, string, string];
      const name = line.slice(tab + 1);
      const kind = mode === '120000' ? 'symlink' : (TREE_TYPES[type] ?? 'file');
      out.push({ path: dir === '' ? name : `${dir}/${name}`, type: kind, mode, oid, ...(kind === 'file' ? { size: Number(size) } : {}) });
    }
    return out;
  }

  async readFile(resource: ResourceRef, revision: RevisionId, path: string): Promise<Uint8Array | null> {
    const { record, sha } = await this.#revisionTarget(resource, revision);
    const repo = this.#repoPath(record);
    await this.#requireCommit(repo, sha, record);
    const file = normalize(path, false);
    const oid = await this.#git(['rev-parse', '--verify', '--quiet', '--end-of-options', `${sha}:${file}`], repo);
    if (oid.code !== 0) return null;
    const id = utf8(oid.stdout).trim();
    const type = await this.#gitOk(['cat-file', '-t', id], repo);
    if (utf8(type.stdout).trim() !== 'blob') return null;
    return (await this.#gitOk(['cat-file', 'blob', id], repo)).stdout;
  }

  // ===========================================================================================
  // Task workspaces
  // ===========================================================================================

  async createIsolatedChange(input: CreateIsolatedChangeInput): Promise<TaskWorkspaceHandle> {
    if (input.resource.organizationId !== input.organizationId) throw new LocalGitProviderError('invalid_input', 'organizationId does not match the resource');
    const canonical = await this.#canonicalOf(input.resource);
    const base = await this.#revisionTarget(input.resource, input.baseRevision);
    if (base.record.role !== 'canonical') throw new LocalGitProviderError('revision_mismatch', 'the base revision must be a canonical revision');
    const canonicalPath = this.#repoPath(canonical);
    await this.#requireCommit(canonicalPath, base.sha, canonical);

    const wsId = toTaskWorkspaceId(this.#o.newTaskWorkspaceId?.() ?? crypto.randomUUID());
    const now = toIsoUtc(this.#now());
    const record: TaskRecord = {
      v: 1,
      role: 'task',
      repoId: taskRepoId(wsId),
      namespace: this.namespace(input.organizationId, 'tasks'),
      repoName: taskRepoId(wsId),
      organizationId: input.organizationId,
      resourceId: input.resource.resourceId,
      branch: canonical.branch,
      createdAt: now,
      updatedAt: now,
      taskWorkspaceId: wsId,
      baseRevision: input.baseRevision,
      state: 'provisioning',
    };
    await this.#claimRecord(record);
    const path = this.#repoPath(record);
    try {
      await this.#initRepo(path, record.branch, 'task');
      // Seed: a fresh repo holding exactly the ledger base (no fork lineage, plan §0.3).
      await this.#gitOk(['fetch', '-q', '--no-tags', '--no-write-fetch-head', canonicalPath, `${base.sha}:refs/heads/${record.branch}`], path);
      if ((await this.#branchHead(record)) !== base.sha) throw new LocalGitProviderError('git_failed', `seeding ${record.repoName} did not produce ${base.sha}`);
      await this.#writeRecord({ ...record, state: 'writable', updatedAt: toIsoUtc(this.#now()) });
    } catch (e) {
      await rm(path, { recursive: true, force: true });
      await rm(this.#recordPath(record.repoId), { force: true });
      throw e;
    }
    return {
      taskWorkspaceId: wsId,
      resourceId: input.resource.resourceId,
      baseRevision: input.baseRevision,
      provider: 'local-git',
      coords: this.#coords(record),
      state: 'writable',
    };
  }

  async issueWorkspaceCredential(handle: TaskWorkspaceHandle, grant: WorkspaceGrant): Promise<WorkspaceCredential> {
    const g = WorkspaceGrantSchema.safeParse(grant);
    if (!g.success) throw new LocalGitProviderError('invalid_input', `invalid grant: ${g.error.message}`);
    const scope = g.data.operations.includes('write') ? 'write' : 'read';
    return this.#withLock(handle.taskWorkspaceId, async () => {
      const record = await this.#taskOf(handle);
      if (record.state === 'collected' || record.state === 'abandoned' || record.state === 'provisioning') {
        throw new LocalGitProviderError('workspace_not_writable', `workspace ${record.taskWorkspaceId} is ${record.state}`);
      }
      if (scope === 'write' && (record.state !== 'writable' || handle.state !== 'writable')) {
        throw new LocalGitProviderError('workspace_not_writable', `workspace ${record.taskWorkspaceId} is ${record.state === 'writable' ? handle.state : record.state}`);
      }
      const path = this.#repoPath(record);
      await this.#pruneExpiredTokens(path);
      const secret = `${TOKEN_PREFIX}${hex(crypto.getRandomValues(new Uint8Array(32)))}`;
      const tokenId = `tok-${hex(crypto.getRandomValues(new Uint8Array(8)))}`;
      const expiresMs = this.#now().getTime() + g.data.ttlSeconds * 1000;
      const digest = await this.#digest(path, secret);
      await writeFileAtomic(join(path, TOKENS_DIR, digest), `${scope} ${Math.floor(expiresMs / 1000)} ${tokenId}\n`, 0o600);
      return { tokenId, secret, scope, expiresAt: toIsoUtc(new Date(expiresMs)), remoteUrl: this.#coords(record).remoteUrl };
    });
  }

  /**
   * Freeze (plan §B.5): head ≠ expectedSha → `candidate_moved`. Then write the frozen marker (the
   * push guard refuses every later push and every in-flight push that has not committed its ref
   * update yet) and revoke every write token. Then take the branch's ref lock with a
   * compare-and-swap of expectedSha onto itself. A push that committed in between makes the CAS
   * fail, and freeze then rolls the marker back and refuses with `candidate_moved_during_freeze`.
   * Revoked tokens stay revoked, so the agent needs a new credential. Changed paths are computed.
   */
  async freezeCandidate(handle: TaskWorkspaceHandle, input: FreezeInput): Promise<FrozenCandidate> {
    const parsed = FreezeInputSchema.safeParse(input);
    if (!parsed.success) throw new LocalGitProviderError('invalid_input', `invalid freeze input: ${parsed.error.message}`);
    const { expectedSha } = parsed.data;
    const record = await this.#withLock(handle.taskWorkspaceId, async () => {
      const rec = await this.#taskOf(handle);
      if (rec.state !== 'writable' || handle.state !== 'writable') {
        throw new LocalGitProviderError('workspace_not_writable', `workspace ${rec.taskWorkspaceId} is ${rec.state === 'writable' ? handle.state : rec.state}`);
      }
      const path = this.#repoPath(rec);
      const before = await this.#branchHead(rec);
      if (before !== expectedSha) {
        throw new LocalGitProviderError('candidate_moved', `head is ${before ?? 'unresolved'}, expected ${expectedSha}`, { expectedSha, observedSha: before });
      }
      await writeFileAtomic(join(path, FROZEN_MARKER), `${expectedSha}\n`, 0o644);
      await this.#revokeWriteTokens(path);
      const cas = await this.#git(
        ['-c', `core.filesRefLockTimeout=${this.#o.freezeLockTimeoutMs ?? FREEZE_LOCK_TIMEOUT_MS}`, 'update-ref', `refs/heads/${rec.branch}`, expectedSha, expectedSha],
        path,
      );
      if (cas.code !== 0) {
        const after = await this.#branchHead(rec);
        await rm(join(path, FROZEN_MARKER), { force: true });
        const why = after === expectedSha ? `a push held the branch lock (${cas.stderr.trim()})` : `head moved to ${after ?? 'unresolved'}`;
        throw new LocalGitProviderError('candidate_moved_during_freeze', `${why} while freezing ${expectedSha}; write tokens were revoked`, {
          expectedSha,
          observedSha: after,
        });
      }
      const frozen: TaskRecord = { ...rec, state: 'frozen', frozenSha: expectedSha, updatedAt: toIsoUtc(this.#now()) };
      await this.#writeRecord(frozen);
      return frozen;
    });

    const repo = this.#repoPath(record);
    const treeId = utf8((await this.#gitOk(['rev-parse', `${expectedSha}^{tree}`], repo)).stdout).trim();
    const baseSha = parseRevisionId(record.baseRevision);
    const cmp = await this.#diff(repo, null, (baseSha as { sha: string }).sha, expectedSha);
    const changed = new Set<string>();
    for (const f of cmp.files) {
      changed.add(f.path);
      if (f.oldPath) changed.add(f.oldPath);
    }
    return FrozenCandidateSchema.parse({
      candidateId: candidateId(record.taskWorkspaceId, expectedSha),
      taskWorkspaceId: record.taskWorkspaceId,
      fork: this.#coords(record),
      resourceId: record.resourceId,
      baseRevision: record.baseRevision,
      sha: expectedSha,
      treeId,
      frozenAt: toIsoUtc(this.#now()),
      submitter: parsed.data.submitter,
      ...(parsed.data.tool === undefined ? {} : { tool: parsed.data.tool }),
      changedPaths: [...changed].sort(),
    });
  }

  /** Delete the task repository (idempotent). The record stays as a `collected` tombstone. */
  async collectWorkspace(handle: TaskWorkspaceHandle): Promise<void> {
    await this.#withLock(handle.taskWorkspaceId, async () => {
      const record = await this.#taskOf(handle);
      const path = this.#repoPath(record);
      if (record.state !== 'collected') {
        await this.#writeRecord({ ...record, state: 'collected', updatedAt: toIsoUtc(this.#now()) });
      }
      // Refuse pushes first, then delete (a push racing the delete fails either way).
      await writeFileAtomic(join(path, FROZEN_MARKER), 'collected\n', 0o644).catch(() => undefined);
      await rm(path, { recursive: true, force: true });
    });
  }

  // ===========================================================================================
  // Compare / acceptance
  // ===========================================================================================

  /** `git diff --name-status -M` plus `--numstat` (binary detection); either side may be a task repo. */
  async compare(resource: ResourceRef, base: RevisionId, candidate: RevisionId): Promise<CompareResult> {
    const b = await this.#revisionTarget(resource, base);
    const c = await this.#revisionTarget(resource, candidate);
    const cPath = this.#repoPath(c.record);
    const bPath = this.#repoPath(b.record);
    await this.#requireCommit(bPath, b.sha, b.record);
    await this.#requireCommit(cPath, c.sha, c.record);
    const result = await this.#diff(cPath, bPath === cPath ? null : bPath, b.sha, c.sha);
    return { base, candidate, ...result };
  }

  async prepareForAcceptance(candidate: FrozenCandidate, submit: RunnerSubmit): Promise<PreparedReceipt> {
    const c = FrozenCandidateSchema.parse(candidate);
    const task = await this.#readRecord(c.fork.repoId);
    if (!task || task.role !== 'task' || task.taskWorkspaceId !== c.taskWorkspaceId || !sameCoords(this.#coords(task), c.fork)) {
      throw new LocalGitProviderError('namespace_refused', `candidate fork ${c.fork.repoName} is not a task workspace of this provider`);
    }
    if (task.resourceId !== c.resourceId) throw new LocalGitProviderError('revision_mismatch', 'candidate belongs to another resource');
    if (task.state === 'collected' || task.state === 'abandoned') {
      throw new LocalGitProviderError('workspace_collected', `workspace ${c.taskWorkspaceId} was ${task.state}; prepare before collecting`);
    }
    if (task.frozenSha !== c.sha || !(task.state === 'frozen' || task.state === 'retained')) {
      throw new LocalGitProviderError('workspace_not_writable', `candidate ${c.sha} is not the frozen candidate of ${c.taskWorkspaceId}`);
    }
    const canonical = await this.#readRecord(c.resourceId);
    if (!canonical || canonical.role !== 'canonical') throw new LocalGitProviderError('not_found', `canonical repo for ${c.resourceId} not found`);
    const coords = this.#coords(canonical);
    const retentionRef = candidateRetentionRef(c.candidateId);
    const out = await submit({ kind: 'prepare-candidate', candidate: c, canonical: coords, retentionRef });
    if (!out.ok) throw new LocalGitProviderError('runner_failed', `prepare-candidate ${out.code}: ${out.detail}`, { code: out.code, jobId: out.jobId });
    const receipt = PreparedReceiptSchema.parse(out.receipt);
    if (
      receipt.candidateId !== c.candidateId ||
      receipt.sha !== c.sha ||
      receipt.resourceId !== c.resourceId ||
      receipt.canonicalRef !== retentionRef ||
      receipt.revisionId !== localRevisionId(canonical.repoId, c.sha)
    ) {
      throw new LocalGitProviderError('receipt_mismatch', 'prepare-candidate receipt does not match the candidate', { jobId: out.jobId });
    }
    const canonicalPath = this.#repoPath(canonical);
    const retained = await this.#git(['rev-parse', '--verify', '--quiet', '--end-of-options', retentionRef], canonicalPath);
    if (retained.code !== 0 || utf8(retained.stdout).trim() !== c.sha) {
      throw new LocalGitProviderError('receipt_mismatch', `${retentionRef} does not hold ${c.sha} after prepare`, { jobId: out.jobId });
    }
    await this.#withLock(c.taskWorkspaceId, async () => {
      const rec = (await this.#readRecord(task.repoId)) as TaskRecord | null;
      if (rec && rec.state === 'frozen') await this.#writeRecord({ ...rec, state: 'retained', updatedAt: toIsoUtc(this.#now()) });
    });
    return receipt;
  }

  async reconcileAccepted(resource: ResourceRef, head: AcceptedHead, submit: RunnerSubmit): Promise<ReconcileResult> {
    const canonical = await this.#canonicalOf(resource);
    const h = AcceptedHeadSchema.parse(head);
    if (h.resourceId !== resource.resourceId) throw new LocalGitProviderError('invalid_input', 'head belongs to another resource');
    const target = await this.#revisionTarget(resource, h.revisionId);
    if (target.record.role !== 'canonical') throw new LocalGitProviderError('revision_mismatch', 'an accepted head must be a canonical revision');
    await this.#requireCommit(this.#repoPath(canonical), target.sha, canonical);
    const ref = `refs/heads/${canonical.branch}`;
    const current = await this.#branchHead(canonical);
    if (current === target.sha) {
      return { resourceId: resource.resourceId, ref, targetSha: target.sha, observedSha: current, status: 'synced', reconciledAt: toIsoUtc(this.#now()) };
    }
    const out = await submit({
      kind: 'reconcile-ref',
      resourceId: resource.resourceId,
      canonical: this.#coords(canonical),
      ref,
      targetSha: target.sha,
      expectedCurrentSha: current,
    });
    if (!out.ok) throw new LocalGitProviderError('runner_failed', `reconcile-ref ${out.code}: ${out.detail}`, { code: out.code, jobId: out.jobId });
    const receipt = ReconcileResultSchema.parse(out.receipt);
    if (receipt.ref !== ref || receipt.targetSha !== target.sha) {
      throw new LocalGitProviderError('receipt_mismatch', 'reconcile-ref receipt does not match the job', { jobId: out.jobId });
    }
    return receipt;
  }

  /**
   * A `git bundle` of the revision's full history, written to `<r2Prefix><resourceId>/<sha>.bundle`
   * in the export store. The bundle has one ref, `refs/heads/<branch>`, at the revision.
   * `snapshotId` identifies a one-entry snapshot pinning this revision (projectId = resourceId,
   * mountName = resourceId, revisions 0), because the call carries no project snapshot.
   */
  async exportRevision(resource: ResourceRef, revision: RevisionId, sink: ExportSink): Promise<ExportReceipt> {
    if (sink.kind !== 'r2' || !sink.r2Prefix.endsWith('/')) throw new LocalGitProviderError('invalid_input', 'unsupported export sink');
    const { record, sha } = await this.#revisionTarget(resource, revision);
    const source = this.#repoPath(record);
    await this.#requireCommit(source, sha, record);
    const exportId = `exp-${crypto.randomUUID()}`;
    const tmp = join(this.root, '.commonforge', 'tmp', exportId);
    try {
      await mkdir(tmp, { recursive: true });
      await this.#gitOk(['init', '-q', '--bare', '-b', record.branch], tmp);
      // Borrow the source's objects instead of copying them; bundle create packs through alternates.
      await writeFile(join(tmp, 'objects', 'info', 'alternates'), `${join(source, 'objects')}\n`);
      await this.#gitOk(['update-ref', `refs/heads/${record.branch}`, sha], tmp);
      const file = join(tmp, 'export.bundle');
      await this.#gitOk(['bundle', 'create', '-q', file, `refs/heads/${record.branch}`], tmp);
      const bytes = new Uint8Array(await readFile(file));
      const r2Key = `${sink.r2Prefix}${resource.resourceId}/${sha}.bundle`;
      await this.exportStore.put(r2Key, bytes);
      const snapshotId = computeSnapshotIdSync({
        projectId: resource.resourceId,
        organizationId: resource.organizationId,
        membershipRevision: 0,
        policyRevision: 0,
        entries: [{ resourceId: resource.resourceId, revisionId: revision, mode: 'pinned-reference', mountName: resource.resourceId, operations: ['read'] }],
      });
      return {
        exportId,
        snapshotId,
        items: [{ resourceId: resource.resourceId, kind: 'git-bundle', r2Key, sha256: await sha256Hex(bytes), headSha: sha, historyMode: 'full' }],
        createdAt: toIsoUtc(this.#now()),
      };
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  /**
   * Operator maintenance (`git gc --quiet`, which also packs refs) on every live repository, with
   * the push guard bypassed the same way as the provider's own git. Returns the repos it maintained.
   */
  async maintain(): Promise<string[]> {
    await this.#init();
    const done: string[] = [];
    for (const name of await readdir(join(this.root, '.commonforge', 'repos'))) {
      if (!name.endsWith('.json')) continue;
      const record = await this.#readRecord(name.slice(0, -'.json'.length));
      if (!record || (record.role === 'task' && (record.state === 'collected' || record.state === 'abandoned'))) continue;
      const path = this.#repoPath(record);
      if (!(await exists(path))) continue;
      await this.#withLock(record.taskWorkspaceId ?? record.repoId, () => this.#gitOk(['gc', '--quiet'], path));
      done.push(`${record.namespace}/${record.repoName}`);
    }
    return done;
  }

  /** Bytes written for an export key, or null. */
  readExport(r2Key: string): Promise<Uint8Array | null> {
    return this.exportStore.get(r2Key);
  }

  // ===========================================================================================
  // Internals: setup
  // ===========================================================================================

  #init(): Promise<void> {
    this.#ready ??= (async () => {
      const meta = join(this.root, '.commonforge');
      await mkdir(join(meta, 'repos'), { recursive: true });
      await mkdir(join(meta, 'no-hooks'), { recursive: true });
      if (this.#serviceToken === undefined) {
        const file = join(meta, 'service-token');
        try {
          this.#serviceToken = (await readFile(file, 'utf8')).trim();
        } catch (e) {
          if ((e as { code?: string }).code !== 'ENOENT') throw e;
          const token = `${TOKEN_PREFIX}svc_${hex(crypto.getRandomValues(new Uint8Array(32)))}`;
          await writeFileAtomic(file, `${token}\n`, 0o600, true).catch(async (err: unknown) => {
            if ((err as { code?: string }).code !== 'EEXIST') throw err;
          });
          this.#serviceToken = (await readFile(file, 'utf8')).trim();
        }
      }
      if (!/^cflg_[A-Za-z0-9_]+$/.test(this.#serviceToken)) throw new LocalGitProviderError('invalid_input', `service token must match ${TOKEN_PREFIX}[A-Za-z0-9_]+`);
    })();
    return this.#ready;
  }

  async #initRepo(path: string, branch: string, role: GuardRole): Promise<void> {
    await mkdir(path, { recursive: true });
    await this.#gitOk(['init', '-q', '--bare', '-b', branch], path);
    const config: Array<[string, string]> = [
      // Relative: resolved against the bare repo, so the guard survives moving `root`.
      ['core.hooksPath', HOOKS_DIR],
      // Artifacts parity: one ref per push (Artifacts refuses --atomic, plan §0.3).
      ['receive.advertiseAtomic', 'false'],
      ['receive.fsckObjects', 'true'],
      ['core.logAllRefUpdates', 'true'],
    ];
    for (const [k, v] of config) await this.#gitOk(['config', k, v], path);
    await this.#installGuard(path, role);
  }

  /** (Re)write the push guard and, for canonical, the service credential digest. */
  async #installGuard(path: string, role: GuardRole): Promise<void> {
    await mkdir(join(path, HOOKS_DIR), { recursive: true });
    await mkdir(join(path, TOKENS_DIR), { recursive: true, mode: 0o700 });
    await mkdir(join(path, SERVICE_DIR), { recursive: true, mode: 0o700 });
    for (const hook of GUARDED_HOOKS) {
      await writeFileAtomic(join(path, HOOKS_DIR, hook), guardScript(role), 0o755);
      await chmod(join(path, HOOKS_DIR, hook), 0o755);
    }
    if (role === 'canonical') await this.#writeServiceDigest(path);
  }

  async #writeServiceDigest(path: string): Promise<void> {
    const digest = await this.#digest(path, this.#serviceToken!);
    const file = join(path, SERVICE_DIR, digest);
    if (!(await exists(file))) await writeFileAtomic(file, 'service\n', 0o600);
  }

  // ===========================================================================================
  // Internals: registry
  // ===========================================================================================

  #recordPath(repoId: string): string {
    assertIdSegment(repoId, 'repoId');
    return join(this.root, '.commonforge', 'repos', `${repoId}.json`);
  }

  #repoPath(record: Pick<RepoRecord, 'namespace' | 'repoName'>): string {
    return join(this.root, record.namespace, `${record.repoName}.git`);
  }

  #coords(record: RepoRecord): LocalGitCoords {
    const path = this.#repoPath(record);
    return {
      kind: 'local-git',
      namespace: record.namespace,
      repoName: record.repoName,
      repoId: record.repoId,
      remoteUrl: this.#o.remoteUrl?.({ namespace: record.namespace, repoName: record.repoName, path }) ?? pathToFileURL(path).href,
    };
  }

  #resourceRef(record: RepoRecord): ResourceRef {
    return {
      organizationId: record.organizationId,
      resourceId: record.resourceId as ResourceRef['resourceId'],
      provider: 'local-git',
      authority: 'commonforge_ledger',
      coords: this.#coords(record),
    };
  }

  async #readRecord(repoId: string): Promise<RepoRecord | null> {
    if (!IdSegmentSchema.safeParse(repoId).success) return null;
    await this.#init();
    try {
      const raw = await readFile(this.#recordPath(repoId), 'utf8');
      let record: RepoRecord;
      try {
        record = JSON.parse(raw) as RepoRecord;
      } catch {
        throw new LocalGitProviderError('state_corrupt', `registry record ${repoId} is not valid JSON`);
      }
      if (record?.v !== 1 || record.repoId !== repoId || (record.role !== 'canonical' && record.role !== 'task')) {
        throw new LocalGitProviderError('state_corrupt', `registry record ${repoId} is malformed`);
      }
      return record;
    } catch (e) {
      if ((e as { code?: string }).code === 'ENOENT') return null;
      throw e;
    }
  }

  async #findRecordByName(namespace: string, repoName: string): Promise<RepoRecord | null> {
    const record = await this.#readRecord(repoName);
    return record && record.namespace === namespace ? record : null;
  }

  /** Create a registry record; refuses an existing repoId or repository directory. */
  async #claimRecord(record: RepoRecord): Promise<void> {
    if (await exists(this.#repoPath(record))) throw new LocalGitProviderError('already_exists', `${record.namespace}/${record.repoName} already exists`);
    try {
      await writeFileAtomic(this.#recordPath(record.repoId), `${JSON.stringify(record, null, 2)}\n`, 0o644, true);
    } catch (e) {
      if ((e as { code?: string }).code === 'EEXIST') throw new LocalGitProviderError('already_exists', `repository id ${record.repoId} already exists`);
      throw e;
    }
  }

  async #writeRecord(record: RepoRecord): Promise<void> {
    await writeFileAtomic(this.#recordPath(record.repoId), `${JSON.stringify(record, null, 2)}\n`, 0o644);
  }

  /** Canonical record for a ResourceRef, checked against the registry. */
  async #canonicalOf(resource: ResourceRef): Promise<RepoRecord> {
    if (resource.provider !== 'local-git' || resource.coords.kind !== 'local-git') {
      throw new LocalGitProviderError('invalid_input', `resource ${resource.resourceId} is not a local-git resource`);
    }
    const record = await this.#readRecord(resource.coords.repoId);
    if (
      !record ||
      record.role !== 'canonical' ||
      record.resourceId !== resource.resourceId ||
      record.organizationId !== resource.organizationId ||
      !sameCoords(this.#coords(record), resource.coords)
    ) {
      throw new LocalGitProviderError('not_found', `no canonical repository for resource ${resource.resourceId} at the given coords`);
    }
    return record;
  }

  /** The task record behind a handle, which must match the recorded coords exactly. */
  async #taskOf(handle: TaskWorkspaceHandle): Promise<TaskRecord> {
    if (handle.coords.namespace.endsWith('-canonical')) {
      throw new LocalGitProviderError('canonical_namespace_refused', `${handle.coords.namespace} is a canonical namespace`);
    }
    const byCoords = await this.#readRecord(handle.coords.repoId);
    if (byCoords?.role === 'canonical') throw new LocalGitProviderError('canonical_namespace_refused', `${handle.coords.repoId} is a canonical repository`);
    const record = await this.#readRecord(taskRepoId(handle.taskWorkspaceId));
    if (!record || record.role !== 'task') throw new LocalGitProviderError('not_found', `task workspace ${handle.taskWorkspaceId} not found`);
    if (!sameCoords(this.#coords(record), handle.coords) || record.resourceId !== handle.resourceId) {
      throw new LocalGitProviderError('namespace_refused', `handle coords do not match workspace ${handle.taskWorkspaceId}`);
    }
    return record as TaskRecord;
  }

  /** Repository and sha of a revision; the repository must be canonical or a live task repo of the resource. */
  async #revisionTarget(resource: ResourceRef, revision: string): Promise<{ record: RepoRecord; sha: string }> {
    await this.#canonicalOf(resource);
    const p = parseRevisionId(revision);
    if (p.kind !== 'local') throw new LocalGitProviderError('revision_mismatch', `${revision} is not a local-git revision`);
    const record = await this.#readRecord(p.repoId);
    if (!record) throw new LocalGitProviderError('not_found', `unknown repository ${p.repoId}`);
    if (record.resourceId !== resource.resourceId) throw new LocalGitProviderError('revision_mismatch', `${revision} belongs to another resource`);
    if (record.role === 'task' && (record.state === 'collected' || record.state === 'abandoned')) {
      throw new LocalGitProviderError('not_found', `task workspace ${record.taskWorkspaceId} was ${record.state}`);
    }
    return { record, sha: p.sha };
  }

  // ===========================================================================================
  // Internals: tokens
  // ===========================================================================================

  /** git object id of the secret (what the push guard compares); never stored in clear. */
  async #digest(repo: string, secret: string): Promise<string> {
    const out = utf8((await this.#gitOk(['hash-object', '--stdin'], repo, { input: secret })).stdout).trim();
    if (!SHA_RE.test(out)) throw new LocalGitProviderError('git_failed', 'unexpected hash-object output');
    return out;
  }

  async #readToken(record: RepoRecord, secret: string): Promise<{ scope: string; expires: number } | null> {
    const path = this.#repoPath(record);
    try {
      const [scope, expires] = (await readFile(join(path, TOKENS_DIR, await this.#digest(path, secret)), 'utf8')).trim().split(/\s+/);
      return scope && expires ? { scope, expires: Number(expires) } : null;
    } catch {
      return null;
    }
  }

  async #tokenFiles(repo: string): Promise<Array<{ file: string; scope: string; expires: number }>> {
    const dir = join(repo, TOKENS_DIR);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (e) {
      if ((e as { code?: string }).code === 'ENOENT') return [];
      throw e;
    }
    const out: Array<{ file: string; scope: string; expires: number }> = [];
    for (const name of names) {
      if (!SHA_RE.test(name)) continue;
      const file = join(dir, name);
      const [scope = '', expires = '0'] = (await readFile(file, 'utf8').catch(() => '')).trim().split(/\s+/);
      out.push({ file, scope, expires: Number(expires) });
    }
    return out;
  }

  async #revokeWriteTokens(repo: string): Promise<void> {
    for (const t of await this.#tokenFiles(repo)) if (t.scope !== 'read') await rm(t.file, { force: true });
  }

  async #pruneExpiredTokens(repo: string): Promise<void> {
    const nowS = Math.floor(this.#now().getTime() / 1000);
    for (const t of await this.#tokenFiles(repo)) if (!(t.expires > nowS)) await rm(t.file, { force: true });
  }

  // ===========================================================================================
  // Internals: git
  // ===========================================================================================

  /** The provider's own git: hooks disabled (command-line config beats the repo's hooksPath). */
  #git(args: readonly string[], cwd: string, options?: GitExecOptions) {
    return this.#exec(['-c', `core.hooksPath=${join(this.root, '.commonforge', 'no-hooks')}`, ...args], cwd, options);
  }

  async #gitOk(args: readonly string[], cwd: string, options?: GitExecOptions) {
    const r = await this.#git(args, cwd, options);
    if (r.code !== 0) throw new LocalGitProviderError('git_failed', `git ${args.find((a, i) => !a.startsWith('-') && args[i - 1] !== '-c') ?? ''} exited ${r.code}: ${r.stderr.trim()}`, { args: [...args] });
    return r;
  }

  async #hasCommit(repo: string, sha: string, env?: Record<string, string>): Promise<boolean> {
    if (!SHA_RE.test(sha)) return false;
    return (await this.#git(['cat-file', '-e', `${sha}^{commit}`], repo, env ? { env } : undefined)).code === 0;
  }

  async #requireCommit(repo: string, sha: string, record: RepoRecord): Promise<void> {
    if (!(await exists(repo))) throw new LocalGitProviderError('not_found', `repository ${record.repoName} is gone`);
    if (!(await this.#hasCommit(repo, sha))) throw new LocalGitProviderError('not_found', `commit ${sha} not in ${record.repoName}`);
  }

  async #branchHead(record: RepoRecord): Promise<string | null> {
    const r = await this.#git(['rev-parse', '--verify', '--quiet', `refs/heads/${record.branch}`], this.#repoPath(record));
    return r.code === 0 ? utf8(r.stdout).trim() : null;
  }

  /**
   * Diff two commits in `repo`, borrowing `otherRepo`'s objects (read-only alternates) when the
   * base lives in another repository.
   */
  async #diff(repo: string, otherRepo: string | null, baseSha: string, candidateSha: string): Promise<Omit<CompareResult, 'base' | 'candidate'>> {
    const opts: GitExecOptions | undefined = otherRepo ? { env: { GIT_ALTERNATE_OBJECT_DIRECTORIES: join(otherRepo, 'objects') } } : undefined;
    const diffArgs = ['diff', '--no-ext-diff', '--no-textconv', '-M', '-z'];
    const [ns, num, trees] = await Promise.all([
      this.#gitOk([...diffArgs, '--name-status', baseSha, candidateSha, '--'], repo, opts),
      this.#gitOk([...diffArgs, '--numstat', baseSha, candidateSha, '--'], repo, opts),
      this.#gitOk(['rev-parse', `${baseSha}^{tree}`, `${candidateSha}^{tree}`], repo, opts),
    ]);
    const stats = parseNumstat(utf8(num.stdout));
    const files = parseNameStatus(utf8(ns.stdout)).map((f) => ({ ...f, ...(stats.get(f.path) ?? { binary: false }) }));
    const [tb, tc] = utf8(trees.stdout).trim().split('\n');
    return { sameTree: tb === tc, files };
  }

  async #withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#locks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.#locks.set(key, tail);
    try {
      return await run;
    } finally {
      if (this.#locks.get(key) === tail) this.#locks.delete(key);
    }
  }
}

// =============================================================================================
// Helpers
// =============================================================================================

const taskRepoId = (taskWorkspaceId: string): string => `ws-${taskWorkspaceId}`;

/** Transports an import may use (no `ext::`, no `fd::`); a bare path counts as `file`. */
const IMPORT_PROTOCOLS = ['-c', 'protocol.allow=never', '-c', 'protocol.file.allow=always', '-c', 'protocol.https.allow=always', '-c', 'protocol.ssh.allow=always'];

function secretsEqual(a: string, b: string): boolean {
  const x = createHash('sha256').update(a).digest();
  const y = createHash('sha256').update(b).digest();
  return timingSafeEqual(x, y);
}

function assertIdSegment(value: string, label: string): void {
  if (!IdSegmentSchema.safeParse(value).success) throw new LocalGitProviderError('invalid_input', `${label} is not a valid id segment`);
}

function normalize(path: string, allowEmpty: boolean): string {
  const r = checkPath(path, { allowEmpty });
  if (!r.ok) throw new LocalGitProviderError('invalid_input', `invalid path (${r.violation})`, { violation: r.violation });
  return r.path;
}

function sameCoords(a: RepoCoords, b: RepoCoords): boolean {
  return a.kind === b.kind && a.namespace === b.namespace && a.repoName === b.repoName && a.repoId === b.repoId && a.remoteUrl === b.remoteUrl;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Write via a temp file and rename; `exclusive` refuses an existing target (EEXIST). */
async function writeFileAtomic(path: string, data: string, mode: number, exclusive = false): Promise<void> {
  if (exclusive) {
    await writeFile(path, data, { flag: 'wx', mode });
    return;
  }
  const tmp = `${path}.tmp-${crypto.randomUUID()}`;
  await writeFile(tmp, data, { mode });
  await rename(tmp, path);
}

type CompareFile = CompareResult['files'][number];

/** `--name-status -z -M`: `X\0path\0` or `Rnnn\0old\0new\0`. */
export function parseNameStatus(out: string): Array<Pick<CompareFile, 'path' | 'status' | 'oldPath'>> {
  const parts = out.split('\0');
  const files: Array<Pick<CompareFile, 'path' | 'status' | 'oldPath'>> = [];
  let i = 0;
  while (i < parts.length && parts[i] !== '') {
    const letter = parts[i]!.charAt(0);
    if (letter === 'R' || letter === 'C') {
      const oldPath = parts[i + 1]!;
      const path = parts[i + 2]!;
      files.push(letter === 'R' ? { path, status: 'renamed', oldPath } : { path, status: 'added' });
      i += 3;
    } else {
      const path = parts[i + 1]!;
      files.push({ path, status: letter === 'A' ? 'added' : letter === 'D' ? 'deleted' : 'modified' });
      i += 2;
    }
  }
  return files;
}

/** `--numstat -z -M`: `a\td\tpath\0` or `a\td\t\0old\0new\0`; `-\t-` marks binary. Keyed by (new) path. */
export function parseNumstat(out: string): Map<string, Pick<CompareFile, 'binary' | 'additions' | 'deletions'>> {
  const parts = out.split('\0');
  const stats = new Map<string, Pick<CompareFile, 'binary' | 'additions' | 'deletions'>>();
  let i = 0;
  while (i < parts.length && parts[i] !== '') {
    const rec = parts[i]!;
    const t1 = rec.indexOf('\t');
    const t2 = rec.indexOf('\t', t1 + 1);
    const add = rec.slice(0, t1);
    const del = rec.slice(t1 + 1, t2);
    const path = rec.slice(t2 + 1);
    let key = path;
    if (path === '') {
      key = parts[i + 2]!;
      i += 3;
    } else {
      i += 1;
    }
    stats.set(key, add === '-' ? { binary: true } : { binary: false, additions: Number(add), deletions: Number(del) });
  }
  return stats;
}


