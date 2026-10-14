/**
 * A minimal in-test `VersionProvider` over local bare repositories, used only to prove the
 * provider suite runs. Not exported; the real local provider is Task 11's `LocalGitProvider`.
 *
 * - canonical: `git clone --bare` of the seed. Its `pre-receive` hook accepts only the service
 *   (runner) token, so agent credentials can never write canonical.
 * - task workspaces: a fresh bare repo seeded with the base sha from canonical (no fork lineage,
 *   like an Artifacts `-tasks` repo seeded from canonical).
 * - credentials: a token file per secret inside the fork; a `pre-receive` hook refuses pushes
 *   unless `COMMONFORGE_TOKEN` names a live write token and the fork is not frozen. Freeze deletes
 *   every token (revocation) and writes a frozen marker.
 * - writes to canonical go only through the injected `RunnerSubmit`.
 */
import { execFile } from 'node:child_process';
import { chmod, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  candidateId,
  candidateRetentionRef,
  CoreError,
  DEFAULT_CAPABILITIES,
  parseCandidateId,
  parseRevisionId,
  revisionCommitSha,
  sha256Hex,
  sha256HexSync,
  snapshotId,
  toIsoUtc,
  type CompareResult,
  type FrozenCandidate,
  type PreparedReceipt,
  type ReconcileResult,
  type RepoCoords,
  type ResourceRef,
  type RevisionId,
  type RunnerJobRequest,
  type RunnerSubmit,
  type TaskWorkspaceHandle,
  type TaskWorkspaceState,
  type TreeEntry,
  type VersionProvider,
  type WorkspaceCredential,
} from '@commonforge-org/core';
import {
  fileUrl,
  gitOk,
  initBareRepo,
  nodeGitRunner,
  revisionForCoords,
  type ProviderFactoryContext,
  type ProviderUnderTest,
} from '../src/provider.js';

const execFileP = promisify(execFile);

const PRE_RECEIVE = `#!/bin/sh
t="$COMMONFORGE_TOKEN"
f="$GIT_DIR/commonforge-tokens/$t"
if [ -f "$GIT_DIR/commonforge-frozen" ]; then echo "commonforge: workspace is frozen" >&2; exit 1; fi
if [ -z "$t" ] || [ ! -f "$f" ] || [ "$(cat "$f")" != write ]; then echo "commonforge: no valid write token" >&2; exit 1; fi
exit 0
`;

const CANONICAL_PRE_RECEIVE = `#!/bin/sh
if [ -z "$COMMONFORGE_TOKEN" ] || [ "$COMMONFORGE_TOKEN" != "$(cat "$GIT_DIR/commonforge-service-token")" ]; then
  echo "commonforge: canonical accepts only the service credential" >&2; exit 1
fi
exit 0
`;

async function installHook(git: ProviderFactoryContext['git'], repo: string, script: string): Promise<void> {
  await writeFile(join(repo, 'hooks', 'pre-receive'), script);
  await chmod(join(repo, 'hooks', 'pre-receive'), 0o755);
  await gitOk(git, ['config', 'core.hooksPath', join(repo, 'hooks')], repo);
}

interface Workspace {
  handle: TaskWorkspaceHandle;
  path: string;
  state: TaskWorkspaceState;
}

export async function makeFakeProvider(ctx: ProviderFactoryContext): Promise<ProviderUnderTest> {
  const git = ctx.git;
  const root = join(ctx.workDir, 'fake-provider');
  const canonicalPath = join(root, 'canonical', `${ctx.resourceId}.git`);
  await mkdir(join(root, 'canonical'), { recursive: true });
  await gitOk(git, ['clone', '-q', '--bare', ctx.seed.path, canonicalPath], root);
  const serviceToken = sha256HexSync(crypto.getRandomValues(new Uint8Array(32)));
  await writeFile(join(canonicalPath, 'commonforge-service-token'), serviceToken);
  await installHook(git, canonicalPath, CANONICAL_PRE_RECEIVE);

  const canonical: RepoCoords = {
    kind: 'local-git',
    namespace: 'conformance-canonical',
    repoName: ctx.resourceId,
    repoId: `canon-${ctx.resourceId}`,
    remoteUrl: fileUrl(canonicalPath),
  };
  const resource: ResourceRef = { organizationId: ctx.organizationId, resourceId: ctx.resourceId, provider: 'local-git', authority: 'commonforge_ledger', coords: canonical };
  const repos = new Map<string, string>([[canonical.repoId, canonicalPath]]);
  const workspaces = new Map<string, Workspace>();
  const exports = new Map<string, Uint8Array>();
  let exportSeq = 0;

  const repoOf = (revision: RevisionId): { path: string; sha: string } => {
    const p = parseRevisionId(revision);
    if (p.kind !== 'local') throw new CoreError('invalid_revision_id', `not a local revision: ${revision}`);
    const path = repos.get(p.repoId);
    if (!path) throw new CoreError('invalid_revision_id', `unknown repository ${p.repoId}`);
    return { path, sha: p.sha };
  };
  const hasObject = async (path: string, spec: string) => (await git(['cat-file', '-e', spec], path)).code === 0;
  const workspaceOf = (handle: TaskWorkspaceHandle): Workspace => {
    const ws = workspaces.get(handle.taskWorkspaceId);
    if (!ws) throw new CoreError('workspace_not_found', handle.taskWorkspaceId);
    return ws;
  };
  const submitTyped = <R>(submit: RunnerSubmit, job: RunnerJobRequest): Promise<R> =>
    (submit as (j: RunnerJobRequest) => ReturnType<RunnerSubmit>)(job).then((out) => {
      if (!out.ok) throw new CoreError(out.code, out.detail);
      return out.receipt as R;
    });

  const provider: VersionProvider = {
    capabilities: () => ({ ...DEFAULT_CAPABILITIES['local-git'] }),

    async resolveRevision(_resource, selector) {
      let revisionId: RevisionId;
      if (selector.kind === 'revision') revisionId = selector.revisionId;
      else if (selector.kind === 'ref') revisionId = revisionForCoords(canonical, (await gitOk(git, ['rev-parse', '--verify', selector.ref], canonicalPath)).trim());
      else if (selector.kind === 'candidate') {
        const { sha } = parseCandidateId(selector.candidateId);
        revisionId = revisionForCoords(canonical, sha);
        if (!(await hasObject(canonicalPath, `${candidateRetentionRef(selector.candidateId)}`))) {
          const ws = workspaces.get(parseCandidateId(selector.candidateId).taskWorkspaceId);
          if (!ws) throw new CoreError('invalid_revision_id', 'candidate not found');
          revisionId = revisionForCoords(ws.handle.coords, sha);
        }
      } else throw new CoreError('provider_capability_unsupported', 'accepted heads are resolved by the ledger');
      const { path, sha } = repoOf(revisionId);
      if (!(await hasObject(path, `${sha}^{commit}`))) throw new CoreError('invalid_revision_id', `no commit ${sha}`);
      const treeId = (await gitOk(git, ['rev-parse', `${sha}^{tree}`], path)).trim();
      return { resourceId: ctx.resourceId, revisionId, provider: 'local-git', coords: canonical, contentId: sha, treeId, resolvedAt: toIsoUtc() };
    },

    async listTree(_resource, revision, path) {
      const { path: repo, sha } = repoOf(revision);
      const out = await gitOk(git, ['ls-tree', '-l', '-z', sha, ...(path ? ['--', `${path}/`] : [])], repo);
      return out
        .split('\0')
        .filter(Boolean)
        .map((line): TreeEntry => {
          const [meta, p] = line.split('\t') as [string, string];
          const [mode, type, oid, size] = meta.split(/\s+/) as [string, string, string, string];
          const kind = type === 'tree' ? 'dir' : type === 'commit' ? 'submodule' : mode === '120000' ? 'symlink' : 'file';
          return { path: p, type: kind, mode, oid, ...(kind === 'file' ? { size: Number(size) } : {}) };
        });
    },

    async readFile(_resource, revision, path) {
      const { path: repo, sha } = repoOf(revision);
      const t = await git(['cat-file', '-t', `${sha}:${path}`], repo);
      if (t.code !== 0 || t.stdout.trim() !== 'blob') return null;
      const { stdout } = await execFileP('git', ['cat-file', 'blob', `${sha}:${path}`], { cwd: repo, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
      return new Uint8Array(stdout);
    },

    async createIsolatedChange(input) {
      const { sha } = repoOf(input.baseRevision);
      const id = `ws-${input.changeId}`;
      const path = join(root, 'tasks', `${id}.git`);
      await mkdir(join(root, 'tasks'), { recursive: true });
      await initBareRepo(git, path);
      await gitOk(git, ['fetch', '-q', '--no-tags', canonicalPath, `${sha}:refs/heads/main`], path);
      await mkdir(join(path, 'commonforge-tokens'));
      await installHook(git, path, PRE_RECEIVE);
      const coords: RepoCoords = { kind: 'local-git', namespace: 'conformance-tasks', repoName: id, repoId: `fork-${input.changeId}`, remoteUrl: fileUrl(path) };
      repos.set(coords.repoId, path);
      const handle: TaskWorkspaceHandle = {
        taskWorkspaceId: id as TaskWorkspaceHandle['taskWorkspaceId'],
        resourceId: input.resource.resourceId,
        baseRevision: input.baseRevision,
        provider: 'local-git',
        coords,
        state: 'writable',
      };
      workspaces.set(id, { handle, path, state: 'writable' });
      return handle;
    },

    async issueWorkspaceCredential(handle, grant): Promise<WorkspaceCredential> {
      if (handle.coords.namespace.endsWith('-canonical') || handle.coords.repoId === canonical.repoId) {
        throw new CoreError('canonical_namespace_refused', 'never issue credentials for a canonical repository');
      }
      const ws = workspaceOf(handle);
      const scope = grant.operations.includes('write') ? 'write' : 'read';
      // the provider's own state decides; the caller's handle.state is only a hint
      if (scope === 'write' && (handle.state !== 'writable' || ws.state !== 'writable')) throw new CoreError('workspace_not_writable', ws.state);
      if (ws.state === 'collected') throw new CoreError('workspace_not_found', 'collected');
      const secret = sha256HexSync(crypto.getRandomValues(new Uint8Array(32)));
      await mkdir(join(ws.path, 'commonforge-tokens'), { recursive: true });
      await writeFile(join(ws.path, 'commonforge-tokens', secret), scope);
      return { tokenId: `tok-${secret.slice(0, 12)}`, secret, scope, expiresAt: new Date(Date.now() + grant.ttlSeconds * 1000).toISOString(), remoteUrl: ws.handle.coords.remoteUrl };
    },

    async freezeCandidate(handle, input): Promise<FrozenCandidate> {
      const ws = workspaceOf(handle);
      if (ws.state !== 'writable') throw new CoreError('workspace_not_writable', ws.state);
      const headSha = async () => (await gitOk(git, ['rev-parse', 'refs/heads/main'], ws.path)).trim();
      if ((await headSha()) !== input.expectedSha) throw new CoreError('candidate_moved', 'fork head differs from expectedSha');
      await writeFile(join(ws.path, 'commonforge-frozen'), input.expectedSha);
      await rm(join(ws.path, 'commonforge-tokens'), { recursive: true, force: true });
      if ((await headSha()) !== input.expectedSha) throw new CoreError('candidate_moved_during_freeze', 'fork head moved during freeze');
      ws.state = 'frozen';
      const sha = input.expectedSha;
      const cmp = await provider.compare(resource, handle.baseRevision, revisionForCoords(handle.coords, sha));
      return {
        candidateId: candidateId(handle.taskWorkspaceId, sha),
        taskWorkspaceId: handle.taskWorkspaceId,
        fork: ws.handle.coords,
        resourceId: handle.resourceId,
        baseRevision: handle.baseRevision,
        sha,
        treeId: (await gitOk(git, ['rev-parse', `${sha}^{tree}`], ws.path)).trim(),
        frozenAt: toIsoUtc(),
        submitter: input.submitter,
        ...(input.tool ? { tool: input.tool } : {}),
        changedPaths: cmp.files.map((f) => f.path).sort(),
      };
    },

    async compare(_resource, base, candidate): Promise<CompareResult> {
      const b = repoOf(base);
      const c = repoOf(candidate);
      const repo = (await hasObject(c.path, `${b.sha}^{commit}`)) ? c.path : b.path;
      const [ns, num, trees] = await Promise.all([
        gitOk(git, ['diff', '--no-renames', '--name-status', '-z', b.sha, c.sha], repo),
        gitOk(git, ['diff', '--no-renames', '--numstat', '-z', b.sha, c.sha], repo),
        gitOk(git, ['rev-parse', `${b.sha}^{tree}`, `${c.sha}^{tree}`], repo),
      ]);
      const stats = new Map<string, { binary: boolean; additions?: number; deletions?: number }>();
      for (const rec of num.split('\0').filter(Boolean)) {
        const [add, del, path] = rec.split('\t') as [string, string, string];
        stats.set(path, add === '-' ? { binary: true } : { binary: false, additions: Number(add), deletions: Number(del) });
      }
      const parts = ns.split('\0').filter(Boolean);
      const files: CompareResult['files'] = [];
      for (let i = 0; i < parts.length; i += 2) {
        const letter = parts[i]!;
        const path = parts[i + 1]!;
        const status = letter === 'A' ? 'added' : letter === 'D' ? 'deleted' : 'modified';
        files.push({ path, status, ...(stats.get(path) ?? { binary: false }) });
      }
      const [tb, tc] = trees.trim().split('\n');
      return { base, candidate, sameTree: tb === tc, files };
    },

    prepareForAcceptance(candidate, submit) {
      return submitTyped<PreparedReceipt>(submit, {
        kind: 'prepare-candidate',
        candidate,
        canonical,
        retentionRef: candidateRetentionRef(candidate.candidateId),
      });
    },

    async reconcileAccepted(_resource, head, submit) {
      const ref = 'refs/heads/main';
      const current = await git(['rev-parse', '--verify', ref], canonicalPath);
      return submitTyped<ReconcileResult>(submit, {
        kind: 'reconcile-ref',
        resourceId: head.resourceId,
        canonical,
        ref,
        targetSha: revisionCommitSha(head.revisionId)!,
        expectedCurrentSha: current.code === 0 ? current.stdout.trim() : null,
      });
    },

    async exportRevision(_resource, revision, sink) {
      const { path, sha } = repoOf(revision);
      const tmp = join(root, 'exports', `exp-${++exportSeq}`);
      await initBareRepo(git, tmp);
      await gitOk(git, ['fetch', '-q', path, `${sha}:refs/heads/main`], tmp);
      const file = join(tmp, 'out.bundle');
      await gitOk(git, ['bundle', 'create', '-q', file, 'refs/heads/main'], tmp);
      const bytes = new Uint8Array(await readFile(file));
      const r2Key = `${sink.r2Prefix}${ctx.resourceId}/${sha}.bundle`;
      exports.set(r2Key, bytes);
      return {
        exportId: `exp-${exportSeq}`,
        snapshotId: snapshotId(sha256HexSync(`fake-export:${sha}`)),
        items: [{ resourceId: ctx.resourceId, kind: 'git-bundle', r2Key, sha256: await sha256Hex(bytes), headSha: sha, historyMode: 'full' }],
        createdAt: toIsoUtc(),
      };
    },

    async collectWorkspace(handle) {
      const ws = workspaceOf(handle);
      await rm(ws.path, { recursive: true, force: true });
      repos.delete(ws.handle.coords.repoId);
      ws.state = 'collected';
    },
  };

  return {
    provider,
    resource,
    canonical,
    serviceGit: nodeGitRunner({ COMMONFORGE_TOKEN: serviceToken }),
    gitForCredential: (cred) => nodeGitRunner({ COMMONFORGE_TOKEN: cred.secret }),
    readExport: async (key) => exports.get(key) ?? null,
  };
}
