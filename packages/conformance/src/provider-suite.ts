/**
 * `describeProviderConformance` — the `VersionProvider` lifecycle every git-backed provider must
 * pass (plan §B.2–§B.6, §B.8–§B.10, §G.2), against real git:
 *
 *   resolve/read seed → create isolated changes (3 agents, concurrently) → credentials (decided
 *   by the provider's own state) → agents push to their task repos; agent credentials cannot
 *   write canonical → freeze (moved refusal; computed changedPaths; post-freeze push and
 *   credential refused) → compare → prepareForAcceptance (tamper refused; retention ref in
 *   canonical) → integrate onto the ledger head while refs/heads/main lags → reconcileAccepted
 *   (force-with-lease) → stale-base refusal → textual conflict → collect (task repos gone) and
 *   integrate from canonical alone → reconcile with a concurrent writer (diverged, then
 *   re-synced) → exportRevision / reimport object equality.
 *
 * The ledger head (simulated by the suite and offered to the runner as `currentHead`) is the
 * authority; canonical `refs/heads/main` is a projection and never decides staleness.
 *
 * The steps share one fixture and run sequentially; a failing step makes later ones fail with
 * "earlier step failed". Integration jobs that are not provider methods (`integrate`) are
 * submitted by the suite itself to the same `RunnerSubmit` the provider receives.
 */
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  acceptedVersionId,
  candidateId,
  candidateRetentionRef,
  changeId as toChangeId,
  computeSnapshotIdSync,
  CompareResultSchema,
  ExportReceiptSchema,
  FrozenCandidateSchema,
  parseRevisionId,
  PreparedReceiptSchema,
  ReconcileResultSchema,
  requireCapability,
  resourceId as toResourceId,
  sha256Hex,
  sha256HexSync,
  TaskWorkspaceHandleSchema,
  toIsoUtc,
  WorkspaceCredentialSchema,
  type AcceptedHead,
  type FreezeErrorCode,
  FreezeErrorCodeSchema,
  ProviderErrorCodeSchema,
  type FreezeInput,
  type FrozenCandidate,
  type IntegrationReceipt,
  type PreparedReceipt,
  type RepoCoords,
  type ResourceId,
  type ResourceRef,
  type RevisionId,
  type RunnerOutcome,
  type RunnerSubmit,
  type TaskWorkspaceHandle,
  type TreeEntry,
  type VersionProvider,
  type WorkspaceCredential,
  type WorkspaceGrant,
} from '@commonforge-org/core';
import { IntegrationJobSchema, jobIntegrationRef, mayBeSameRepo, type IntegrationJob } from '@commonforge-org/runner-protocol';
import { writeFile } from 'node:fs/promises';
import {
  AgentCheckout,
  cloneRepo,
  createSeedRepo,
  createTempDir,
  gitOk,
  initBareRepo,
  lsRemote,
  nodeGitRunner,
  gitBlobOid,
  removeDir,
  revisionForCoords,
  revParse,
  type FileChanges,
  type GitRunner,
  type SeedRepo,
} from './git-helpers.js';
import { createReferenceRunner } from './reference-runner.js';

// =============================================================================================
// Public contract
// =============================================================================================

/** What the suite hands to `makeProvider`. */
export interface ProviderFactoryContext {
  /** scratch directory owned by the suite (removed afterwards); the provider may create repos under it */
  workDir: string;
  /** the suite's git runner (plain Node git unless overridden) */
  git: GitRunner;
  /** a local working repository whose `main` holds {@link SEED_FILES}; canonical `refs/heads/main` must equal `seed.sha` */
  seed: SeedRepo;
  organizationId: string;
  resourceId: ResourceId;
}

/** What `makeProvider` returns. */
export interface ProviderUnderTest {
  provider: VersionProvider;
  /** the canonical Resource (`resourceId` and `organizationId` from the context) */
  resource: ResourceRef;
  /** the canonical repository (target of runner jobs); must not be a task-workspace repository */
  canonical: RepoCoords;
  /** git able to read/write canonical and read task forks (runner + verification); default: the suite git */
  serviceGit?: GitRunner;
  /** git authenticated as the holder of `credential` (an agent); default: the suite git */
  gitForCredential?(credential: WorkspaceCredential): GitRunner;
  /** bytes the provider wrote for an export item key (`ExportReceipt` `r2Key`), or null */
  readExport(r2Key: string): Promise<Uint8Array | null>;
  dispose?(): Promise<void>;
}

export interface RunnerFactoryContext {
  git: GitRunner;
  workDir: string;
  /**
   * The (simulated) ledger's accepted head per resource. A runner's `stale_base` check must use
   * this or the job's own snapshot, never canonical `refs/heads/main` (a lagging projection).
   */
  currentHead(resourceId: string): RevisionId | null;
}

export interface ProviderConformanceOptions {
  /** describe() title (default `VersionProvider conformance`) */
  name?: string;
  makeProvider(ctx: ProviderFactoryContext): Promise<ProviderUnderTest>;
  /** suite git runner (default: Node git isolated from global/system config) */
  git?: GitRunner;
  /** the RunnerSubmit handed to the provider and used for `integrate` (default: {@link createReferenceRunner}) */
  makeRunner?(ctx: RunnerFactoryContext): RunnerSubmit;
  /** per-step timeout (default 60 s) */
  timeoutMs?: number;
}

export const CONFORMANCE_ORG = 'org-conformance';
export const CONFORMANCE_RESOURCE = 'res-conformance';

const BINARY = new Uint8Array([0, 1, 2, 255, 0, 10, 13, 0]);

/** Files of the seed commit (canonical `main` before the suite starts). */
export const SEED_FILES: Readonly<Record<string, string>> = {
  'README.md': '# Conformance fixture\nline: base\n',
  'other.txt': 'other: base\n',
  'remove-me.txt': 'delete me\n',
  'src/app.txt': 'app\n',
};

/** Agent A: modify, add text, add binary, delete. */
export const CHANGE_A: FileChanges = {
  'README.md': '# Conformance fixture\nline: agent-a\n',
  'docs/added.md': 'added by agent a\n',
  'bin/blob.bin': BINARY,
  'remove-me.txt': null,
};
/** Agent B: the same README line as A (textual conflict with A). */
export const CHANGE_B: FileChanges = { 'README.md': '# Conformance fixture\nline: agent-b\n' };
/** Agent C: a different file (merges cleanly with A). */
export const CHANGE_C: FileChanges = { 'other.txt': 'other: agent-c\n' };

const EXPECTED_COMPARE_A = [
  { path: 'README.md', status: 'modified', binary: false },
  { path: 'bin/blob.bin', status: 'added', binary: true },
  { path: 'docs/added.md', status: 'added', binary: false },
  { path: 'remove-me.txt', status: 'deleted', binary: false },
];

// =============================================================================================
// Suite
// =============================================================================================

const text = (b: Uint8Array | null): string | null => (b === null ? null : new TextDecoder().decode(b));
const sortBy = <T>(xs: T[], key: (x: T) => string): T[] => [...xs].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));

interface AgentState {
  name: 'a' | 'b' | 'c';
  handle: TaskWorkspaceHandle;
  credential?: WorkspaceCredential;
  checkout?: AgentCheckout;
  sha?: string;
  frozen?: FrozenCandidate;
  receipt?: PreparedReceipt;
}

export function describeProviderConformance(options: ProviderConformanceOptions): void {
  const timeout = options.timeoutMs ?? 60_000;
  const git = options.git ?? nodeGitRunner();

  describe.sequential(options.name ?? 'VersionProvider conformance', () => {
    let workDir = '';
    let seed: SeedRepo;
    let put: ProviderUnderTest;
    let provider: VersionProvider;
    let resource: ResourceRef;
    let canonical: RepoCoords;
    let serviceGit: GitRunner;
    let baseRevision: RevisionId;
    /** the simulated ledger's accepted head (authority); refs/heads/main is only its projection */
    let ledgerHead: RevisionId | null = null;
    let innerSubmit: RunnerSubmit;
    let beforeReconcile: (() => Promise<void>) | null = null;
    const jobs: IntegrationJob[] = [];
    const agents: Partial<Record<'a' | 'b' | 'c', AgentState>> = {};
    const state: { headA?: AcceptedHead; integration?: IntegrationReceipt['results'][number] } = {};
    let dirSeq = 0;
    const scratch = (label: string) => join(workDir, `suite-${++dirSeq}-${label}`);

    /** Validates and records every job, then delegates to the runner. */
    const submit = (async (request: unknown): Promise<RunnerOutcome<unknown>> => {
      const job = IntegrationJobSchema.parse(request);
      jobs.push(job);
      if (job.kind === 'reconcile-ref' && beforeReconcile) {
        const hook = beforeReconcile;
        beforeReconcile = null;
        await hook();
      }
      return (innerSubmit as (j: unknown) => Promise<RunnerOutcome<unknown>>)(request);
    }) as RunnerSubmit;

    const need = <T>(v: T | undefined, what: string): T => {
      if (v === undefined) throw new Error(`earlier step failed: no ${what}`);
      return v;
    };
    const agent = (n: 'a' | 'b' | 'c') => need(agents[n], `agent ${n}`);
    const gitFor = (cred: WorkspaceCredential): GitRunner => put.gitForCredential?.(cred) ?? git;
    const freezeCode = (code: FreezeErrorCode): FreezeErrorCode => FreezeErrorCodeSchema.parse(code);
    /** Push the agent's commit to canonical refs with its own credential: every push must be refused. */
    const expectAgentCannotWriteCanonical = async (a: AgentState, refs: string[]) => {
      const checkout = need(a.checkout, `checkout ${a.name}`);
      const sha = need(a.sha, `sha ${a.name}`);
      for (const ref of refs) {
        const before = await canonicalSha(ref);
        const r = await checkout.git(['push', '--porcelain', '--force', canonical.remoteUrl, `${sha}:${ref}`], checkout.dir);
        expect(r.code, `agent ${a.name} credential pushed ${ref} to canonical`).not.toBe(0);
        expect(await canonicalSha(ref)).toBe(before);
      }
    };
    const grant = (ops: WorkspaceGrant['operations'], id: string): WorkspaceGrant => ({
      principal: { kind: 'agent', id, onBehalfOf: { kind: 'user', id: 'user-conformance' } },
      operations: ops,
      ttlSeconds: 3600,
      leaseGeneration: 1,
    });
    const freezeInput = (sha: string, who: string): FreezeInput => ({
      expectedSha: sha,
      submitter: { kind: 'agent', id: who, onBehalfOf: { kind: 'user', id: 'user-conformance' } },
      tool: 'conformance',
    });
    const head = (revisionId: RevisionId, versionSeq: number): AcceptedHead => ({
      resourceId: resource.resourceId,
      revisionId,
      versionSeq,
      acceptedVersionId: acceptedVersionId(`av-${String(versionSeq).padStart(12, '0')}`),
      acceptedAt: toIsoUtc(),
      reconciliation: 'pending',
    });
    const canonicalSha = (ref: string) => lsRemote(serviceGit, workDir, canonical.remoteUrl, ref);
    const integrateJob = (proposal: string, jobId: string, candidates: FrozenCandidate[], expectedHead: RevisionId) => {
      const entries = [{ resourceId: resource.resourceId, revisionId: expectedHead, mode: 'must-match-accepted' as const, mountName: 'app', operations: ['read' as const, 'write' as const] }];
      const snap = { projectId: 'proj-conformance', organizationId: resource.organizationId, membershipRevision: 1, policyRevision: 1, entries };
      return {
        kind: 'integrate' as const,
        proposalId: proposal,
        proposalHash: sha256HexSync(`conformance:${proposal}`),
        baseSnapshot: { snapshotId: computeSnapshotIdSync(snap), ...snap, createdAt: toIsoUtc() },
        candidateSnapshotId: sha256HexSync(`conformance:candidate-snapshot:${proposal}`),
        candidates,
        targets: [{ resourceId: resource.resourceId, canonical, expectedHead }],
        integrationRef: jobIntegrationRef(proposal, jobId),
        checks: [],
        contracts: [],
      };
    };

    beforeAll(async () => {
      workDir = await createTempDir();
      seed = await createSeedRepo(git, join(workDir, 'seed'), SEED_FILES);
      put = await options.makeProvider({ workDir, git, seed, organizationId: CONFORMANCE_ORG, resourceId: toResourceId(CONFORMANCE_RESOURCE) });
      ({ provider, resource, canonical } = put);
      serviceGit = put.serviceGit ?? git;
      baseRevision = revisionForCoords(canonical, seed.sha);
      ledgerHead = baseRevision;
      const runnerCtx: RunnerFactoryContext = {
        git: serviceGit,
        workDir: join(workDir, 'runner'),
        currentHead: (rid) => (rid === resource.resourceId ? ledgerHead : null),
      };
      innerSubmit = options.makeRunner?.(runnerCtx) ?? createReferenceRunner(runnerCtx).submit;
    }, timeout);

    afterAll(async () => {
      await put?.dispose?.();
      if (workDir) await removeDir(workDir);
    });

    it('declares a git-backed provider with writable candidates', () => {
      const caps = provider.capabilities();
      expect(caps.kind).toBe(resource.provider);
      requireCapability(caps, 'gitTransport');
      requireCapability(caps, 'writableCandidates');
      requireCapability(caps, 'immutableRevisions');
      expect(resource.resourceId).toBe(CONFORMANCE_RESOURCE);
    });

    it('canonical main holds the seed and reads resolve by sha', async () => {
      expect(await canonicalSha('refs/heads/main')).toBe(seed.sha);
      const resolved = await provider.resolveRevision(resource, { kind: 'revision', revisionId: baseRevision });
      expect(resolved).toMatchObject({ resourceId: resource.resourceId, revisionId: baseRevision, contentId: seed.sha });
      if (resolved.treeId !== undefined) expect(resolved.treeId).toBe(seed.treeId);
      expect(text(await provider.readFile(resource, baseRevision, 'README.md'))).toBe(SEED_FILES['README.md']);
      expect(text(await provider.readFile(resource, baseRevision, 'src/app.txt'))).toBe(SEED_FILES['src/app.txt']);
      expect(await provider.readFile(resource, baseRevision, 'missing.txt')).toBeNull();
      const root = await provider.listTree(resource, baseRevision, '');
      expect(root).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'README.md', type: 'file' }), expect.objectContaining({ path: 'src', type: 'dir' })]));
      const src = await provider.listTree(resource, baseRevision, 'src');
      expect(src.map((e) => e.path)).toContain('src/app.txt');
    }, timeout);

    it('creates isolated changes for concurrent agents', async () => {
      const names = ['a', 'b', 'c'] as const;
      const handles = await Promise.all(
        names.map((n) =>
          provider.createIsolatedChange({
            resource,
            baseRevision,
            taskId: `task-${n}`,
            organizationId: resource.organizationId,
            changeId: toChangeId(`change-${n}`),
            purpose: 'agent-task',
          }),
        ),
      );
      handles.forEach((h, i) => {
        TaskWorkspaceHandleSchema.parse(h);
        expect(h).toMatchObject({ resourceId: resource.resourceId, baseRevision, state: 'writable', provider: resource.provider });
        expect(mayBeSameRepo(h.coords, canonical)).toBe(false);
        agents[names[i]!] = { name: names[i]!, handle: h };
      });
      expect(new Set(handles.map((h) => h.taskWorkspaceId)).size).toBe(3);
      expect(new Set(handles.map((h) => h.coords.remoteUrl)).size).toBe(3);
    }, timeout);

    it('issues write credentials only for workspaces that are really writable', async () => {
      for (const n of ['a', 'b', 'c'] as const) {
        const a = agent(n);
        const cred = await provider.issueWorkspaceCredential(a.handle, grant(['read', 'write'], `agent-${n}`));
        WorkspaceCredentialSchema.parse(cred);
        expect(cred.scope).toBe('write');
        expect(cred.remoteUrl).toBe(a.handle.coords.remoteUrl);
        expect(Date.parse(cred.expiresAt)).toBeGreaterThan(Date.now());
        a.credential = cred;
      }
      const a = agent('a');
      await expect(provider.issueWorkspaceCredential({ ...a.handle, coords: canonical }, grant(['read', 'write'], 'agent-a'))).rejects.toMatchObject({
        code: ProviderErrorCodeSchema.parse('canonical_namespace_refused'),
      });
      await expect(provider.issueWorkspaceCredential({ ...a.handle, state: 'frozen' }, grant(['read', 'write'], 'agent-a'))).rejects.toMatchObject({
        code: 'workspace_not_writable',
      });
    }, timeout);

    it('agents push to their own task workspaces; agent credentials cannot write canonical', async () => {
      const changes = { a: CHANGE_A, b: CHANGE_B, c: CHANGE_C };
      for (const n of ['a', 'b', 'c'] as const) {
        const a = agent(n);
        const cred = need(a.credential, `credential ${n}`);
        a.checkout = await AgentCheckout.clone(gitFor(cred), cred.remoteUrl, scratch(`agent-${n}`));
        expect(await revParse(a.checkout.git, a.checkout.dir, 'HEAD')).toBe(seed.sha);
        a.sha = await a.checkout.commit(changes[n], `agent ${n} change`);
        const pushed = await a.checkout.push();
        expect(pushed.code, pushed.stderr).toBe(0);
      }
      expect(await canonicalSha('refs/heads/main')).toBe(seed.sha);

      // A task-workspace write credential is scoped to its fork: canonical main, candidate
      // retention refs and integration refs all refuse it.
      const a = agent('a');
      const sha = need(a.sha, 'sha a');
      await expectAgentCannotWriteCanonical(a, [
        'refs/heads/main',
        candidateRetentionRef(candidateId(a.handle.taskWorkspaceId, sha)),
        jobIntegrationRef('prop-agent', 'job-agent'),
      ]);

      // A read-only credential cannot push to its own fork either.
      const readCred = await provider.issueWorkspaceCredential(a.handle, grant(['read'], 'agent-a-reader'));
      expect(readCred.scope).toBe('read');
      const reader = await AgentCheckout.clone(gitFor(readCred), readCred.remoteUrl, scratch('reader-a'));
      expect(await revParse(reader.git, reader.dir, 'HEAD')).toBe(a.sha);
      await reader.commit({ 'sneaky.txt': 'nope\n' }, 'read-only push attempt');
      expect((await reader.push()).code).not.toBe(0);
      expect(await lsRemote(reader.git, reader.dir, readCred.remoteUrl, 'refs/heads/main')).toBe(a.sha);
    }, timeout);

    it('freeze refuses a candidate that moved (candidate_moved)', async () => {
      const a = agent('a');
      await expect(provider.freezeCandidate(a.handle, freezeInput(seed.sha, 'agent-a'))).rejects.toMatchObject({ code: freezeCode('candidate_moved') });
    }, timeout);

    it('freezes the candidate (ignoring declared paths) and refuses every later write', async () => {
      const a = agent('a');
      const sha = need(a.sha, 'sha a');
      const checkout = need(a.checkout, 'checkout a');
      // declaredChangedPaths is advisory; changedPaths is computed by compare (§B.5)
      const frozen = await provider.freezeCandidate(a.handle, { ...freezeInput(sha, 'agent-a'), declaredChangedPaths: ['not/really.txt'] });
      FrozenCandidateSchema.parse(frozen);
      expect(frozen).toMatchObject({
        candidateId: candidateId(a.handle.taskWorkspaceId, sha),
        taskWorkspaceId: a.handle.taskWorkspaceId,
        resourceId: resource.resourceId,
        baseRevision,
        sha,
        treeId: await revParse(checkout.git, checkout.dir, `${sha}^{tree}`),
      });
      expect(frozen.fork).toEqual(a.handle.coords);
      expect([...frozen.changedPaths].sort()).toEqual(EXPECTED_COMPARE_A.map((f) => f.path).sort());
      a.frozen = frozen;

      // The agent's (previously valid) write credential can no longer move the candidate.
      await checkout.commit({ 'late.txt': 'after freeze\n' }, 'post-freeze push attempt');
      const late = await checkout.push();
      expect(late.code).not.toBe(0);
      // The provider checks its own state: the caller's handle object still says 'writable'.
      expect(a.handle.state).toBe('writable');
      await expect(provider.issueWorkspaceCredential(a.handle, grant(['read', 'write'], 'agent-a'))).rejects.toMatchObject({
        code: freezeCode('workspace_not_writable'),
      });
      const frozenHandle: TaskWorkspaceHandle = { ...a.handle, state: 'frozen' };
      const readCred = await provider.issueWorkspaceCredential(frozenHandle, grant(['read'], 'agent-a-reader'));
      expect(await lsRemote(gitFor(readCred), workDir, readCred.remoteUrl, 'refs/heads/main')).toBe(sha);
    }, timeout);

    it('compare reports added/modified/deleted/binary files', async () => {
      const a = agent('a');
      const candidateRevision = revisionForCoords(a.handle.coords, need(a.sha, 'sha a'));
      const cmp = await provider.compare(resource, baseRevision, candidateRevision);
      CompareResultSchema.parse(cmp);
      expect(cmp).toMatchObject({ base: baseRevision, candidate: candidateRevision, sameTree: false });
      expect(sortBy(cmp.files.map((f) => ({ path: f.path, status: f.status, binary: f.binary })), (f) => f.path)).toEqual(EXPECTED_COMPARE_A);
      const same = await provider.compare(resource, baseRevision, baseRevision);
      expect(same.sameTree).toBe(true);
      expect(same.files).toEqual([]);
    }, timeout);

    it('prepareForAcceptance retains the candidate in canonical (idempotently)', async () => {
      const a = agent('a');
      const frozen = need(a.frozen, 'frozen a');
      const ref = candidateRetentionRef(frozen.candidateId);
      // A tampered candidate (tree differs from the frozen one) is refused and nothing is retained.
      const tampered = await submit({ kind: 'prepare-candidate', candidate: { ...frozen, treeId: seed.treeId }, canonical, retentionRef: ref });
      expect(tampered).toMatchObject({ ok: false, code: 'scope_violation' });
      expect(await canonicalSha(ref)).toBeNull();

      const receipt = await provider.prepareForAcceptance(frozen, submit);
      PreparedReceiptSchema.parse(receipt);
      expect(receipt).toMatchObject({ candidateId: frozen.candidateId, resourceId: resource.resourceId, canonicalRef: ref, sha: frozen.sha });
      expect(parseRevisionId(receipt.revisionId)).toMatchObject({ repoId: canonical.repoId, sha: frozen.sha });
      const job = jobs.at(-1);
      expect(job).toMatchObject({ kind: 'prepare-candidate', retentionRef: ref, canonical, candidate: { candidateId: frozen.candidateId } });
      expect(await canonicalSha(ref)).toBe(frozen.sha);
      expect(await canonicalSha('refs/heads/main')).toBe(seed.sha);
      expect(text(await provider.readFile(resource, receipt.revisionId, 'README.md'))).toBe(CHANGE_A['README.md']);
      const again = await provider.prepareForAcceptance(frozen, submit);
      expect(again).toMatchObject({ canonicalRef: ref, sha: frozen.sha, revisionId: receipt.revisionId });
      a.receipt = receipt;

      // Another agent's still-valid write credential cannot overwrite the retention ref.
      await expectAgentCannotWriteCanonical(agent('b'), [ref]);
      expect(await canonicalSha(ref)).toBe(frozen.sha);

      // The ledger accepts A (simulated): the ledger head moves, refs/heads/main does not yet.
      ledgerHead = receipt.revisionId;
      state.headA = head(receipt.revisionId, 2);
    }, timeout);

    it('freezes and prepares the other candidates', async () => {
      for (const n of ['b', 'c'] as const) {
        const a = agent(n);
        a.frozen = await provider.freezeCandidate(a.handle, freezeInput(need(a.sha, `sha ${n}`), `agent-${n}`));
        a.receipt = await provider.prepareForAcceptance(a.frozen, submit);
        expect(await canonicalSha(candidateRetentionRef(a.frozen.candidateId))).toBe(a.frozen.sha);
      }
    }, timeout);

    it('integrates onto the ledger head while refs/heads/main lags (reconcile pending)', async () => {
      const c = need(agent('c').frozen, 'frozen c');
      const headA = need(state.headA, 'head A');
      expect(await canonicalSha('refs/heads/main')).toBe(seed.sha);
      const job = integrateJob('prop-pending', 'job-pending', [c], headA.revisionId);
      const out = await submit(job);
      if (!out.ok) throw new Error(`integrate failed: ${out.code}: ${out.detail}`);
      const result = need((out.receipt as IntegrationReceipt).results[0], 'integration result');
      expect(await canonicalSha(job.integrationRef)).toBe(result.sha);
      expect(await canonicalSha('refs/heads/main')).toBe(seed.sha);
    }, timeout);

    it('reconcileAccepted fast-forwards refs/heads/main with a lease on the observed sha', async () => {
      const headA = need(state.headA, 'head A');
      const sha = need(agent('a').receipt, 'receipt a').sha;
      const result = await provider.reconcileAccepted(resource, headA, submit);
      ReconcileResultSchema.parse(result);
      expect(result).toMatchObject({ ref: 'refs/heads/main', targetSha: sha, observedSha: sha, status: 'synced' });
      expect(jobs.at(-1)).toMatchObject({ kind: 'reconcile-ref', ref: 'refs/heads/main', targetSha: sha, expectedCurrentSha: seed.sha, canonical });
      expect(await canonicalSha('refs/heads/main')).toBe(sha);
    }, timeout);

    it('refuses to integrate onto a base that is no longer the ledger head (stale_base)', async () => {
      const b = need(agent('b').frozen, 'frozen b');
      const job = integrateJob('prop-stale', 'job-stale', [b], baseRevision);
      const out = await submit(job);
      expect(out).toMatchObject({ ok: false, code: 'stale_base' });
      expect(await canonicalSha(job.integrationRef)).toBeNull();
    }, timeout);

    it('detects a textual conflict (textual_conflict) and pushes nothing', async () => {
      const b = need(agent('b').frozen, 'frozen b');
      const headA = need(state.headA, 'head A');
      const job = integrateJob('prop-conflict', 'job-conflict', [b], headA.revisionId);
      const out = await submit(job);
      expect(out).toMatchObject({ ok: false, code: 'textual_conflict' });
      expect(out.ok ? '' : out.detail).toContain('README.md');
      expect(await canonicalSha(job.integrationRef)).toBeNull();
      expect(await canonicalSha('refs/heads/main')).toBe(need(agent('a').receipt, 'receipt a').sha);
    }, timeout);

    it('collects task workspaces (forks gone, no new credentials); candidates still integrate from canonical alone', async () => {
      for (const n of ['a', 'b', 'c'] as const) await provider.collectWorkspace(agent(n).handle);
      for (const n of ['a', 'b', 'c'] as const) {
        const a = agent(n);
        expect((await serviceGit(['ls-remote', a.handle.coords.remoteUrl], workDir)).code, `fork ${n} still reachable`).not.toBe(0);
        const forkRead = provider.readFile(resource, revisionForCoords(a.handle.coords, need(a.sha, `sha ${n}`)), 'README.md').catch(() => null);
        expect(await forkRead, `fork ${n} still readable`).toBeNull();
        await expect(provider.issueWorkspaceCredential(a.handle, grant(['read', 'write'], `agent-${n}`)), `credential for collected ${n}`).rejects.toMatchObject({
          code: freezeCode('workspace_not_writable'),
        });
      }
      const c = need(agent('c').frozen, 'frozen c');
      const headA = need(state.headA, 'head A');
      const job = integrateJob('prop-clean', 'job-clean', [c], headA.revisionId);
      const out = await submit(job);
      if (!out.ok) throw new Error(`integrate failed: ${out.code}: ${out.detail}`);
      const receipt = out.receipt as IntegrationReceipt;
      const result = need(receipt.results[0], 'integration result');
      expect(receipt.evidence.mergeOutcome).toEqual([{ resourceId: resource.resourceId, result: 'clean' }]);
      expect(await canonicalSha(job.integrationRef)).toBe(result.sha);
      expect(parseRevisionId(result.revisionId)).toMatchObject({ repoId: canonical.repoId, sha: result.sha });
      expect(text(await provider.readFile(resource, result.revisionId, 'README.md'))).toBe(CHANGE_A['README.md']);
      expect(text(await provider.readFile(resource, result.revisionId, 'other.txt'))).toBe(CHANGE_C['other.txt']);
      // a prepared candidate stays readable by sha after its workspace is collected
      const receiptA = need(agent('a').receipt, 'receipt a');
      expect(text(await provider.readFile(resource, receiptA.revisionId, 'docs/added.md'))).toBe(CHANGE_A['docs/added.md']);
      state.integration = result;
      ledgerHead = result.revisionId;
    }, timeout);

    it('reconcileAccepted never overwrites a concurrent writer (diverged), then re-syncs to the ledger head', async () => {
      const integration = need(state.integration, 'integration');
      const shaA = need(agent('a').receipt, 'receipt a').sha;
      let intruder = '';
      beforeReconcile = async () => {
        const dir = scratch('intruder');
        await cloneRepo(serviceGit, canonical.remoteUrl, dir);
        intruder = await new AgentCheckout(serviceGit, dir).commit({ 'intruder.txt': 'out of band\n' }, 'out-of-band push');
        await gitOk(serviceGit, ['push', `--force-with-lease=refs/heads/main:${shaA}`, 'origin', `${intruder}:refs/heads/main`], dir);
      };
      const head3 = head(integration.revisionId, 3);
      const diverged = await provider.reconcileAccepted(resource, head3, submit);
      expect(diverged).toMatchObject({ status: 'diverged', targetSha: integration.sha, observedSha: intruder });
      expect(intruder).not.toBe('');
      expect(await canonicalSha('refs/heads/main')).toBe(intruder);

      // Policy: the ledger head is the authority, so a retry leases on the observed sha and
      // restores the projection (the out-of-band commit is no longer referenced by main).
      const synced = await provider.reconcileAccepted(resource, head3, submit);
      expect(synced).toMatchObject({ status: 'synced', targetSha: integration.sha, observedSha: integration.sha });
      expect(jobs.at(-1)).toMatchObject({ kind: 'reconcile-ref', expectedCurrentSha: intruder });
      expect(await canonicalSha('refs/heads/main')).toBe(integration.sha);
    }, timeout);

    it('exportRevision produces a bundle that reimports to the identical revision', async () => {
      const integration = need(state.integration, 'integration');
      const receipt = await provider.exportRevision(resource, integration.revisionId, { kind: 'r2', r2Prefix: 'conformance/exports/' });
      ExportReceiptSchema.parse(receipt);
      const item = receipt.items.find((i) => i.kind === 'git-bundle' && i.resourceId === resource.resourceId);
      if (!item || item.kind !== 'git-bundle') throw new Error('export has no git-bundle item for the resource');
      expect(item.headSha).toBe(integration.sha);
      expect(item.r2Key.startsWith('conformance/exports/')).toBe(true);
      const bytes = await put.readExport(item.r2Key);
      if (!bytes) throw new Error(`export ${item.r2Key} not readable`);
      expect(await sha256Hex(bytes)).toBe(item.sha256);

      // Reimport with plain git: no provider involved.
      const bundle = join(workDir, 'export.bundle');
      await writeFile(bundle, bytes);
      const bare = scratch('reimport.git');
      await initBareRepo(git, bare);
      await gitOk(git, ['bundle', 'verify', '-q', bundle], bare);
      await gitOk(git, ['fetch', '-q', bundle, '+refs/*:refs/imported/*'], bare);
      expect((await git(['cat-file', '-e', `${item.headSha}^{commit}`], bare)).code).toBe(0);
      const resolved = await provider.resolveRevision(resource, { kind: 'revision', revisionId: integration.revisionId });
      const tree = await revParse(git, bare, `${item.headSha}^{tree}`);
      if (resolved.treeId !== undefined) expect(tree).toBe(resolved.treeId);
      if (item.historyMode === 'full') {
        // seed + A + C + integration merge
        expect((await gitOk(git, ['rev-list', '--count', item.headSha], bare)).trim()).toBe('4');
      }

      // Object-level equality: every blob of the reimported tree equals what the provider reads.
      const blobs = (await gitOk(git, ['ls-tree', '-r', '-z', item.headSha], bare))
        .split('\0')
        .filter(Boolean)
        .map((line) => {
          const [meta, path] = line.split('\t') as [string, string];
          return { path, oid: meta.split(' ')[2]! };
        });
      expect(blobs.map((b) => b.path).sort()).toEqual(['README.md', 'bin/blob.bin', 'docs/added.md', 'other.txt', 'src/app.txt']);
      for (const b of blobs) {
        const fromProvider = await provider.readFile(resource, integration.revisionId, b.path);
        if (!fromProvider) throw new Error(`provider cannot read ${b.path}`);
        expect(await gitBlobOid(fromProvider, b.oid.length === 64 ? 'sha256' : 'sha1'), b.path).toBe(b.oid);
      }
      const listed = await listRecursive(provider, resource, integration.revisionId);
      const files = listed.filter((e) => e.type === 'file');
      expect(files.map((e) => e.path).sort()).toEqual(blobs.map((b) => b.path).sort());
      for (const f of files) if (f.oid !== undefined) expect(f.oid, f.path).toBe(blobs.find((b) => b.path === f.path)?.oid);
    }, timeout);
  });
}

/** Walk `listTree` from the root. */
async function listRecursive(provider: VersionProvider, resource: ResourceRef, revision: RevisionId, path = ''): Promise<TreeEntry[]> {
  const out: TreeEntry[] = [];
  for (const e of await provider.listTree(resource, revision, path)) {
    out.push(e);
    if (e.type === 'dir') out.push(...(await listRecursive(provider, resource, revision, e.path)));
  }
  return out;
}
