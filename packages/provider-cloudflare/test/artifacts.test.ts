import { describe, expect, it, vi } from 'vitest';
import {
  artRevisionId,
  candidateRetentionRef,
  resourceId,
  type AcceptedHead,
  type CompareResult,
  type FrozenCandidate,
  type PreparedReceipt,
  type ResourceRef,
  type RunnerSubmit,
  type TaskWorkspaceHandle,
} from '@commonforge-org/core';
import { IntegrationJobSchema, jobRepoAccess, type IntegrationJob } from '@commonforge-org/runner-protocol';
import { ArtifactsVersionProvider, type ArtifactsVersionProviderOptions, type WorkspaceRecord } from '../src/artifacts.js';
import { ArtifactsProviderError } from '../src/errors.js';
import { FakeArtifacts } from './fake-artifacts.js';

const PREFIX = 'commonforge-test';
const ORG = 'org1';
const RES = resourceId('res1');
const CANON_NS = `${PREFIX}-${ORG}-canonical`;
const TASKS_NS = `${PREFIX}-${ORG}-tasks`;
const NOW = new Date('2026-10-06T12:00:00.000Z');
const submitter = { kind: 'agent' as const, id: 'agent-1' };

/**
 * Every job the provider submits must satisfy runner-protocol's IntegrationJobSchema (M-9). The
 * wrapped handler sees the parsed job.
 */
function validated(handler: (job: IntegrationJob) => unknown, jobs: IntegrationJob[] = []): RunnerSubmit {
  return (async (raw: unknown) => {
    const job = IntegrationJobSchema.parse(raw);
    jobs.push(job);
    return handler(job);
  }) as unknown as RunnerSubmit;
}

type SeedMode = 'ok' | 'fail' | 'noop' | 'bad-receipt';

async function setup(opts: Partial<ArtifactsVersionProviderOptions> & { seed?: SeedMode } = {}) {
  const fake = new FakeArtifacts();
  const canonRepo = fake.addRepo(CANON_NS, 'res1');
  const base = fake.makeCommit({ 'a.txt': 'one', 'src/b.ts': 'b' }, [], 'base');
  fake.push(CANON_NS, 'res1', 'main', base);
  const jobs: IntegrationJob[] = [];
  const seedMode = opts.seed ?? 'ok';
  // The runner: seed-workspace fetches baseSha from canonical and pushes it to the task branch.
  const runner = validated((job) => {
    if (job.kind !== 'seed-workspace') throw new Error(`unexpected ${job.kind}`);
    if (seedMode === 'fail') return { jobId: 'js', ok: false, code: 'provider_unavailable', detail: 'push failed art_v2_x_deadbeef' };
    if (seedMode === 'ok') {
      fake.objectsIn.get(FakeArtifacts.key(job.taskFork.namespace, job.taskFork.repoName))!.add(job.baseSha);
      fake.push(job.taskFork.namespace, job.taskFork.repoName, job.ref.slice('refs/heads/'.length), job.baseSha);
    }
    const receipt = { jobId: 'js', taskWorkspaceId: job.taskWorkspaceId, resourceId: job.resourceId, ref: job.ref, sha: job.baseSha, seededAt: NOW.toISOString() };
    return { jobId: 'js', ok: true, receipt: seedMode === 'bad-receipt' ? { ...receipt, sha: 'nope' } : receipt };
  }, jobs);
  let ids = 0;
  const { seed: _seed, ...rest } = opts;
  const provider = new ArtifactsVersionProvider({
    transport: fake,
    namespacePrefix: PREFIX,
    now: () => NOW,
    sleep: async () => {},
    newTaskWorkspaceId: () => `ws${++ids}`,
    runner,
    ...rest,
  });
  const canonical = { kind: 'artifacts' as const, namespace: CANON_NS, repoName: 'res1', repoId: canonRepo.info.id, remoteUrl: canonRepo.info.remote };
  const resource: ResourceRef = { organizationId: ORG, resourceId: RES, provider: 'artifacts', authority: 'commonforge_ledger', coords: canonical };
  const baseRevision = artRevisionId(canonRepo.info.id, base);
  return { fake, provider, canonical, resource, base, baseRevision, jobs };
}

async function workspace(s: Awaited<ReturnType<typeof setup>>, taskWorkspaceId?: string) {
  return s.provider.createIsolatedChange({
    resource: s.resource,
    baseRevision: s.baseRevision,
    taskId: 'task1',
    organizationId: ORG,
    changeId: 'chg1' as never,
    purpose: 'agent-task',
    ...(taskWorkspaceId ? { taskWorkspaceId } : {}),
  });
}

const grant = (ops: ('read' | 'write')[], ttlSeconds = 3600, leaseGeneration = 1) => ({ principal: submitter, operations: ops, ttlSeconds, leaseGeneration });

async function expectCode(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof ArtifactsProviderError && e.code === code);
}

describe('createIsolatedChange', () => {
  it('creates ws-<id> in the tasks namespace and seeds it with a seed-workspace job; the provider mints no tokens', async () => {
    const s = await setup();
    const h = await workspace(s);
    expect(h).toMatchObject({ taskWorkspaceId: 'ws1', resourceId: RES, baseRevision: s.baseRevision, provider: 'artifacts', state: 'writable' });
    expect(h.coords).toMatchObject({ kind: 'artifacts', namespace: TASKS_NS, repoName: 'ws-ws1' });
    expect(s.fake.repo(TASKS_NS, 'ws-ws1').refs.get('main')).toBe(s.base);
    expect(s.jobs).toEqual([
      { kind: 'seed-workspace', taskWorkspaceId: 'ws1', resourceId: RES, canonical: s.canonical, baseSha: s.base, taskFork: h.coords, ref: 'refs/heads/main' },
    ]);
    // broker policy for the job: canonical read only, task fork write
    expect(jobRepoAccess(s.jobs[0]!).map((a) => [a.role, a.access])).toEqual([
      ['canonical', 'read'],
      ['task-fork', 'write'],
    ]);
    expect(s.fake.calls.filter((c) => c.op === 'createToken')).toEqual([]);
    expect(s.fake.activeTokens(TASKS_NS, 'ws-ws1')).toEqual([]); // the create token was revoked
    expect(s.fake.repo(CANON_NS, 'res1').tokens).toEqual([]);
  });

  it('looks the repo up before retrying a 5xx create that actually succeeded (no second create)', async () => {
    const s = await setup();
    s.fake.failCreate = ['5xx-created'];
    const h = await workspace(s);
    expect(h.state).toBe('writable');
    expect(s.fake.calls.filter((c) => c.op === 'createRepo')).toHaveLength(1);
    expect(s.fake.activeTokens(TASKS_NS, 'ws-ws1')).toEqual([]); // the lost create token was revoked too
  });

  it('retries a 5xx create that did not create the repo, after a lookup', async () => {
    const s = await setup();
    s.fake.failCreate = ['5xx-not-created'];
    await workspace(s);
    const ops = s.fake.calls.map((c) => c.op);
    const firstCreate = ops.indexOf('createRepo');
    const second = ops.indexOf('createRepo', firstCreate + 1);
    expect(second).toBeGreaterThan(firstCreate);
    expect(ops.slice(firstCreate + 1, second)).toContain('getRepo');
  });

  it('5xx create, then failing lookups, then 409: adopts the repo instead of orphaning it (I-4a)', async () => {
    const s = await setup({ createAttempts: 2 });
    s.fake.failCreate = ['5xx-created'];
    s.fake.failGetName = 'ws-ws1';
    s.fake.failGet = 2; // both lookup attempts fail → retry create → 409 → lookup succeeds → adopt
    const h = await workspace(s);
    expect(h.state).toBe('writable');
    expect([...s.fake.repos.keys()].filter((k) => k.startsWith(TASKS_NS))).toEqual([`${TASKS_NS}/ws-ws1`]);
    expect(s.fake.activeTokens(TASKS_NS, 'ws-ws1')).toEqual([]);
  });

  it('deletes the repo when create answered 5xx and lookups keep failing', async () => {
    const s = await setup({ createAttempts: 1 });
    s.fake.failCreate = ['5xx-created'];
    s.fake.failGetName = 'ws-ws1';
    s.fake.failGet = 1;
    await expectCode(workspace(s), 'provider_unavailable');
    expect([...s.fake.repos.keys()].filter((k) => k.startsWith(TASKS_NS))).toEqual([]);
  });

  it('gives up after createAttempts 5xx and surfaces provider_unavailable', async () => {
    const s = await setup({ createAttempts: 2 });
    s.fake.failCreate = ['5xx-not-created', '5xx-not-created'];
    await expectCode(workspace(s), 'provider_unavailable');
  });

  it('deletes the task repo when seeding fails, lands on the wrong sha or returns a bad receipt', async () => {
    const s = await setup({ seed: 'fail' });
    await expect(workspace(s)).rejects.toSatisfy((e: unknown) => e instanceof ArtifactsProviderError && e.code === 'seed_failed' && !e.message.includes('deadbeef'));
    expect(s.fake.repos.has(`${TASKS_NS}/ws-ws1`)).toBe(false);

    const s2 = await setup({ seed: 'noop' });
    await expectCode(workspace(s2), 'seed_failed');
    expect(s2.fake.repos.has(`${TASKS_NS}/ws-ws1`)).toBe(false);

    const s3 = await setup({ seed: 'bad-receipt' });
    await expectCode(workspace(s3), 'receipt_mismatch');
    expect(s3.fake.repos.has(`${TASKS_NS}/ws-ws1`)).toBe(false);
  });

  it('a caller-supplied workspace id makes retries idempotent (adopt seeded, seed unseeded, refuse moved)', async () => {
    const s = await setup();
    const h1 = await workspace(s, 'chg1-res1');
    const creates = s.fake.calls.filter((c) => c.op === 'createRepo').length;
    const h2 = await workspace(s, 'chg1-res1');
    expect(h2).toEqual(h1);
    expect(s.fake.calls.filter((c) => c.op === 'createRepo').length).toBe(creates);
    expect(s.jobs).toHaveLength(1); // no second seed

    s.fake.addRepo(TASKS_NS, 'ws-half'); // an earlier attempt crashed after create, before seeding
    s.fake.mint(TASKS_NS, 'ws-half', 'write', 86_400);
    const h3 = await workspace(s, 'half');
    expect(s.fake.repo(TASKS_NS, 'ws-half').refs.get('main')).toBe(s.base);
    expect(s.fake.activeTokens(TASKS_NS, 'ws-half')).toEqual([]);
    expect(h3.coords.repoName).toBe('ws-half');

    const moved = s.fake.makeCommit({ x: '1' }, [s.base], 'moved');
    s.fake.push(TASKS_NS, 'ws-half', 'main', moved);
    await expectCode(workspace(s, 'half'), 'already_exists');
    expect(s.fake.repos.has(`${TASKS_NS}/ws-half`)).toBe(true); // never deletes a repo it did not create
  });

  it('requires a runner and refuses a base revision of another repo', async () => {
    const s = await setup({ runner: undefined });
    await expectCode(workspace(s), 'seed_failed');
    const s2 = await setup();
    await expectCode(
      s2.provider.createIsolatedChange({ resource: s2.resource, baseRevision: artRevisionId('otherrepo', s2.base), taskId: 't', organizationId: ORG, changeId: 'c' as never, purpose: 'agent-task' }),
      'revision_mismatch',
    );
  });
});

describe('issueWorkspaceCredential', () => {
  it('refuses any handle in a canonical namespace, for read and write', async () => {
    const s = await setup();
    const h: TaskWorkspaceHandle = { taskWorkspaceId: 'res1' as never, resourceId: RES, baseRevision: s.baseRevision, provider: 'artifacts', coords: s.canonical, state: 'writable' };
    await expectCode(s.provider.issueWorkspaceCredential(h, grant(['write'])), 'canonical_namespace_refused');
    await expectCode(s.provider.issueWorkspaceCredential(h, grant(['read'])), 'canonical_namespace_refused');
    // even a canonical namespace of another prefix
    const other = { ...h, coords: { ...s.canonical, namespace: 'commonforge-prod-org1-canonical' } };
    await expectCode(s.provider.issueWorkspaceCredential(other, grant(['read'])), 'canonical_namespace_refused');
    expect(s.fake.calls.some((c) => c.op === 'createToken' && (c.args[0] as string).endsWith('-canonical'))).toBe(false);
  });

  it('refuses namespaces that are not this prefix tasks namespace', async () => {
    const s = await setup();
    const h = await workspace(s);
    await expectCode(s.provider.issueWorkspaceCredential({ ...h, coords: { ...h.coords, namespace: `${PREFIX}-${ORG}-editions` } }, grant(['read'])), 'namespace_refused');
    await expectCode(s.provider.issueWorkspaceCredential({ ...h, coords: { ...h.coords, namespace: `other-${ORG}-tasks` } }, grant(['read'])), 'namespace_refused');
    await expectCode(s.provider.issueWorkspaceCredential({ ...h, coords: { ...h.coords, repoName: 'ws-other' } }, grant(['read'])), 'namespace_refused');
  });

  it('refuses write scope unless the handle is writable; read is allowed on a frozen workspace', async () => {
    const s = await setup();
    const h = await workspace(s);
    for (const state of ['frozen', 'retained', 'provisioning', 'abandoned', 'collected'] as const) {
      await expectCode(s.provider.issueWorkspaceCredential({ ...h, state }, grant(['read', 'write'])), 'workspace_not_writable');
    }
    const c = await s.provider.issueWorkspaceCredential({ ...h, state: 'frozen' }, grant(['read']));
    expect(c.scope).toBe('read');
  });

  it('mints a write token for a writable workspace with the task remote', async () => {
    const s = await setup();
    const h = await workspace(s);
    const c = await s.provider.issueWorkspaceCredential(h, grant(['read', 'write'], 600));
    expect(c).toMatchObject({ scope: 'write', remoteUrl: h.coords.remoteUrl });
    expect(c.secret).toMatch(/^art_v2_/);
    expect(c.expiresAt).toMatch(/Z$/);
    expect(s.fake.activeTokens(TASKS_NS, 'ws-ws1').map((t) => t.ttl)).toEqual([600]);
  });

  it('clamps TTL to [60, leaseRemaining]', async () => {
    const s = await setup();
    const h = await workspace(s);
    const ttlOf = async (g: Parameters<typeof s.provider.issueWorkspaceCredential>[1]) => {
      const c = await s.provider.issueWorkspaceCredential(h, g);
      return s.fake.repo(TASKS_NS, 'ws-ws1').tokens.find((t) => t.id === c.tokenId)!.ttl;
    };
    expect(await ttlOf(grant(['write'], 7200))).toBe(3600); // default lease 3600
    expect(await ttlOf({ ...grant(['write'], 7200), leaseExpiresAt: new Date(NOW.getTime() + 300_000).toISOString() })).toBe(300);
    expect(await ttlOf({ ...grant(['write'], 120), leaseExpiresAt: new Date(NOW.getTime() + 300_000).toISOString() })).toBe(120);
    expect(await ttlOf({ ...grant(['write'], 3600), leaseExpiresAt: new Date(NOW.getTime() + 60_500).toISOString() })).toBe(60);
    expect(s.provider.clampTtl(10)).toBe(60);
    await expectCode(
      s.provider.issueWorkspaceCredential(h, { ...grant(['write']), leaseExpiresAt: new Date(NOW.getTime() + 59_000).toISOString() }),
      'lease_too_short',
    );
    const p2 = new ArtifactsVersionProvider({ transport: s.fake, namespacePrefix: PREFIX, defaultLeaseSeconds: 900, now: () => NOW });
    expect(p2.clampTtl(3600)).toBe(900);
  });
});

describe('freezeCandidate', () => {
  async function withPush(s: Awaited<ReturnType<typeof setup>>) {
    const h = await workspace(s);
    await s.provider.issueWorkspaceCredential(h, grant(['write']));
    await s.provider.issueWorkspaceCredential(h, grant(['read']));
    const cand = s.fake.makeCommit({ 'a.txt': 'two', 'src/b.ts': 'b' }, [s.base], 'cand');
    s.fake.push(TASKS_NS, 'ws-ws1', 'main', cand);
    return { h, cand };
  }

  it('reads HEAD, revokes every write token, re-reads and returns the frozen candidate', async () => {
    const compare = vi.fn(async (req): Promise<CompareResult> => ({
      base: req.base,
      candidate: req.candidate,
      sameTree: false,
      files: [{ path: 'a.txt', status: 'modified', binary: false }, { path: 'c.txt', oldPath: 'old.txt', status: 'renamed', binary: false }],
    }));
    const s = await setup({ compare });
    const { h, cand } = await withPush(s);
    const f = await s.provider.freezeCandidate(h, { expectedSha: cand, submitter, tool: 'claude' });
    expect(f).toMatchObject({ candidateId: `cand:ws1:${cand}`, taskWorkspaceId: 'ws1', resourceId: RES, sha: cand, baseRevision: s.baseRevision, fork: h.coords, frozenAt: NOW.toISOString(), tool: 'claude' });
    expect(f.treeId).toBe(s.fake.commits.get(cand)!.treeHash);
    expect(f.changedPaths).toEqual(['a.txt', 'c.txt', 'old.txt']);
    const tokens = s.fake.repo(TASKS_NS, 'ws-ws1').tokens;
    expect(tokens.filter((t) => t.scope === 'write' && t.state === 'active')).toEqual([]);
    expect(tokens.filter((t) => t.scope === 'read' && t.state === 'active')).toHaveLength(1);
    expect(compare).toHaveBeenCalledWith(expect.objectContaining({ repo: h.coords, baseSha: s.base, candidateSha: cand, base: s.baseRevision, candidate: artRevisionId(h.coords.repoId, cand) }));
    // order: log (HEAD) → revoke → log (re-read)
    const ops = s.fake.calls.map((c) => c.op).slice(s.fake.calls.findIndex((c) => c.op === 'getRepo' && c.args[1] === 'ws-ws1' && true));
    const firstLog = ops.indexOf('log');
    const revoke = ops.indexOf('revokeToken', firstLog);
    expect(revoke).toBeGreaterThan(firstLog);
    expect(ops.indexOf('log', revoke)).toBeGreaterThan(revoke);
  });

  it('candidate_moved when HEAD ≠ expectedSha; nothing is revoked', async () => {
    const s = await setup();
    const { h } = await withPush(s);
    await expect(s.provider.freezeCandidate(h, { expectedSha: s.base, submitter })).rejects.toMatchObject({ code: 'candidate_moved' });
    expect(s.fake.activeTokens(TASKS_NS, 'ws-ws1').filter((t) => t.scope === 'write')).toHaveLength(1);
  });

  it('candidate_moved_during_freeze when a push lands between the read and the revocation (after one retry)', async () => {
    const s = await setup();
    const { h, cand } = await withPush(s);
    const later = s.fake.makeCommit({ 'a.txt': 'three' }, [cand], 'later');
    s.fake.onRevoke = (key) => {
      if (key === `${TASKS_NS}/ws-ws1`) s.fake.push(TASKS_NS, 'ws-ws1', 'main', later);
    };
    await expect(s.provider.freezeCandidate(h, { expectedSha: cand, submitter })).rejects.toMatchObject({ code: 'candidate_moved_during_freeze', details: { observedSha: later } });
    expect(s.fake.activeTokens(TASKS_NS, 'ws-ws1').filter((t) => t.scope === 'write')).toEqual([]);
  });

  it('succeeds when the retry re-read shows the expected sha (transient read)', async () => {
    const s = await setup({ compare: async (req) => ({ base: req.base, candidate: req.candidate, sameTree: false, files: [] }) });
    const { h, cand } = await withPush(s);
    const other = s.fake.makeCommit({ 'x': 'y' }, [], 'other');
    // logs #1/#2 are createIsolatedChange's pre/post-seed checks, #3 the pre-revoke read, #4 the post-revoke read
    s.fake.onLog = (key, n) => (key === `${TASKS_NS}/ws-ws1` && n === 4 ? other : undefined);
    const f = await s.provider.freezeCandidate(h, { expectedSha: cand, submitter });
    expect(f.sha).toBe(cand);
  });

  it('same tree needs no compare delegate; differing trees without one → compare_unavailable', async () => {
    const s = await setup();
    const h = await workspace(s);
    const f = await s.provider.freezeCandidate(h, { expectedSha: s.base, submitter });
    expect(f.changedPaths).toEqual([]);

    const s2 = await setup();
    const { h: h2, cand } = await withPush(s2);
    await expectCode(s2.provider.freezeCandidate(h2, { expectedSha: cand, submitter }), 'compare_unavailable');
  });

  it('refuses non-writable and canonical handles', async () => {
    const s = await setup();
    const h = await workspace(s);
    await expectCode(s.provider.freezeCandidate({ ...h, state: 'frozen' }, { expectedSha: s.base, submitter }), 'workspace_not_writable');
    await expectCode(s.provider.freezeCandidate({ ...h, coords: s.canonical }, { expectedSha: s.base, submitter }), 'canonical_namespace_refused');
  });
});

describe('runner delegation', () => {
  async function frozen(s: Awaited<ReturnType<typeof setup>>): Promise<FrozenCandidate> {
    const h = await workspace(s);
    return s.provider.freezeCandidate(h, { expectedSha: s.base, submitter });
  }

  it('prepareForAcceptance submits a prepare-candidate job with canonical coords and the retention ref', async () => {
    const s = await setup();
    const c = await frozen(s);
    let job: IntegrationJob | undefined;
    const submit = validated((j) => {
      job = j;
      const receipt: PreparedReceipt = {
        receiptId: 'r1', jobId: 'j1', candidateId: c.candidateId, resourceId: RES, canonicalRef: candidateRetentionRef(c.candidateId),
        sha: c.sha, revisionId: artRevisionId(s.canonical.repoId, c.sha), verifiedAssetObjects: [], preparedAt: NOW.toISOString(),
      };
      return { jobId: 'j1', ok: true, receipt };
    });
    const r = await s.provider.prepareForAcceptance(c, submit);
    expect(job).toEqual({ kind: 'prepare-candidate', candidate: c, canonical: s.canonical, retentionRef: `refs/commonforge/candidates/ws1/${c.sha}` });
    expect(r.receiptId).toBe('r1');
    // the provider itself never minted a canonical write token
    expect(s.fake.repo(CANON_NS, 'res1').tokens.some((t) => t.scope === 'write')).toBe(false);
  });

  it('prepareForAcceptance surfaces runner failures and mismatched receipts', async () => {
    const s = await setup();
    const c = await frozen(s);
    const fail = (async () => ({ jobId: 'j', ok: false, code: 'stale_base', detail: 'token art_v2_x_abc123 leaked?' })) as unknown as RunnerSubmit;
    await expect(s.provider.prepareForAcceptance(c, fail)).rejects.toSatisfy(
      (e: unknown) => e instanceof ArtifactsProviderError && e.code === 'runner_failed' && !e.message.includes('abc123'),
    );
    const wrong = (async () => ({
      jobId: 'j', ok: true,
      receipt: { receiptId: 'r', jobId: 'j', candidateId: c.candidateId, resourceId: RES, canonicalRef: 'refs/commonforge/candidates/x/y', sha: c.sha, revisionId: artRevisionId(s.canonical.repoId, c.sha), preparedAt: NOW.toISOString() },
    })) as unknown as RunnerSubmit;
    await expectCode(s.provider.prepareForAcceptance(c, wrong), 'receipt_mismatch');
    // a malformed receipt is a redacted receipt_mismatch, never a raw ZodError (M-4)
    const malformed = (async () => ({ jobId: 'j', ok: true, receipt: { sha: 'art_v2_x_secret123', candidateId: 42 } })) as unknown as RunnerSubmit;
    await expect(s.provider.prepareForAcceptance(c, malformed)).rejects.toSatisfy(
      (e: unknown) => e instanceof ArtifactsProviderError && e.code === 'receipt_mismatch' && !e.message.includes('secret123'),
    );
  });

  it('reconcileAccepted submits reconcile-ref with the observed sha as lease, or short-circuits when synced', async () => {
    const s = await setup();
    const next = s.fake.makeCommit({ 'a.txt': 'n' }, [s.base], 'next');
    s.fake.objectsIn.get(`${CANON_NS}/res1`)!.add(next);
    const head: AcceptedHead = { resourceId: RES, revisionId: artRevisionId(s.canonical.repoId, next), versionSeq: 2, acceptedVersionId: null, acceptedAt: NOW.toISOString(), reconciliation: 'pending' };
    const submit = vi.fn(async (j: { ref: string; targetSha: string }) => ({
      jobId: 'j2', ok: true,
      receipt: { jobId: 'j2', resourceId: RES, ref: j.ref, targetSha: j.targetSha, observedSha: j.targetSha, status: 'synced', reconciledAt: NOW.toISOString() },
    }));
    const r = await s.provider.reconcileAccepted(s.resource, head, validated((j) => submit(j as never)));
    expect(submit).toHaveBeenCalledWith({ kind: 'reconcile-ref', resourceId: RES, canonical: s.canonical, ref: 'refs/heads/main', targetSha: next, expectedCurrentSha: s.base });
    expect(r.status).toBe('synced');

    s.fake.push(CANON_NS, 'res1', 'main', next);
    submit.mockClear();
    const r2 = await s.provider.reconcileAccepted(s.resource, head, validated((j) => submit(j as never)));
    expect(submit).not.toHaveBeenCalled();
    expect(r2).toMatchObject({ status: 'synced', observedSha: next, ref: 'refs/heads/main' });
  });

  it('reconcileAccepted targets the recorded branch over the reported default branch (imported repos)', async () => {
    const s = await setup();
    const next = s.fake.makeCommit({ 'a.txt': 'n' }, [s.base], 'next');
    s.fake.objectsIn.get(`${CANON_NS}/res1`)!.add(next);
    s.fake.push(CANON_NS, 'res1', 'master', s.base);
    const head: AcceptedHead = { resourceId: RES, revisionId: artRevisionId(s.canonical.repoId, next), versionSeq: 2, acceptedVersionId: null, acceptedAt: NOW.toISOString(), reconciliation: 'pending' };
    const submit = vi.fn(async (j: { ref: string; targetSha: string }) => ({
      jobId: 'j3', ok: true,
      receipt: { jobId: 'j3', resourceId: RES, ref: j.ref, targetSha: j.targetSha, observedSha: j.targetSha, status: 'synced', reconciledAt: NOW.toISOString() },
    }));
    await s.provider.reconcileAccepted(s.resource, head, validated((j) => submit(j as never)), { branch: 'master' });
    expect(submit).toHaveBeenCalledWith({ kind: 'reconcile-ref', resourceId: RES, canonical: s.canonical, ref: 'refs/heads/master', targetSha: next, expectedCurrentSha: s.base });
    await expectCode(s.provider.reconcileAccepted(s.resource, head, validated((j) => submit(j as never)), { branch: 'refs/heads/x' }), 'invalid_input');
    submit.mockClear();
    const pinned = 'e'.repeat(40);
    await s.provider.reconcileAccepted(s.resource, head, validated((j) => submit(j as never)), { branch: 'master', expectedCurrentSha: pinned });
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ ref: 'refs/heads/master', expectedCurrentSha: pinned }));
  });

  it('compare: same tree shortcut; otherwise delegates with canonical as the repo', async () => {
    const compare = vi.fn(async (req): Promise<CompareResult> => ({ base: req.base, candidate: req.candidate, sameTree: false, files: [] }));
    const s = await setup({ compare });
    const sameTreeOther = s.fake.makeCommit({}, [], 'x');
    s.fake.commits.get(sameTreeOther)!.treeHash = s.fake.commits.get(s.base)!.treeHash;
    s.fake.objectsIn.get(`${CANON_NS}/res1`)!.add(sameTreeOther);
    const same = await s.provider.compare(s.resource, s.baseRevision, artRevisionId(s.canonical.repoId, sameTreeOther));
    expect(same.sameTree).toBe(true);
    expect(compare).not.toHaveBeenCalled();
    const diff = s.fake.makeCommit({ 'z': '1' }, [], 'z');
    await s.provider.compare(s.resource, s.baseRevision, artRevisionId('forkrepo', diff));
    expect(compare).toHaveBeenCalledWith(expect.objectContaining({ repo: s.canonical, baseSha: s.base, candidateSha: diff }));
  });

  it('exportRevision is not supported without a snapshot-level runner job', async () => {
    const s = await setup();
    await expectCode(s.provider.exportRevision(s.resource, s.baseRevision, { kind: 'r2', r2Prefix: 'x/' }), 'not_supported');
  });
});

describe('collectWorkspace', () => {
  it('deletes the task repo, is idempotent, and never deletes canonical', async () => {
    const s = await setup();
    const h = await workspace(s);
    await s.provider.collectWorkspace(h);
    expect(s.fake.repos.has(`${TASKS_NS}/ws-ws1`)).toBe(false);
    await s.provider.collectWorkspace(h);
    await expectCode(s.provider.collectWorkspace({ ...h, coords: s.canonical }), 'canonical_namespace_refused');
    expect(s.fake.repos.has(`${CANON_NS}/res1`)).toBe(true);
  });
});

describe('reads', () => {
  it('resolveRevision by revision, branch ref (short name), candidate and accepted head', async () => {
    const s = await setup({ acceptedHead: async () => artRevisionId('x', '0'.repeat(40)) });
    const r = await s.provider.resolveRevision(s.resource, { kind: 'ref', ref: 'refs/heads/main' });
    expect(r).toMatchObject({ revisionId: s.baseRevision, contentId: s.base, provider: 'artifacts', coords: s.canonical });
    const log = s.fake.calls.find((c) => c.op === 'log');
    expect((log!.args[2] as { ref: string }).ref).toBe('main'); // never a full ref name
    await expectCode(s.provider.resolveRevision(s.resource, { kind: 'ref', ref: 'refs/commonforge/candidates/a/b' }), 'ref_unresolved');
    await expectCode(s.provider.resolveRevision(s.resource, { kind: 'ref', ref: 'refs/heads/nope' }), 'ref_unresolved');
    expect((await s.provider.resolveRevision(s.resource, { kind: 'revision', revisionId: s.baseRevision })).treeId).toBe(s.fake.commits.get(s.base)!.treeHash);
    await expectCode(s.provider.resolveRevision(s.resource, { kind: 'candidate', candidateId: `cand:ws9:${'1'.repeat(40)}` as never }), 'not_found');
    await expectCode(s.provider.resolveRevision(s.resource, { kind: 'accepted' }), 'revision_mismatch');
    const p = new ArtifactsVersionProvider({ transport: s.fake, namespacePrefix: PREFIX });
    await expectCode(p.resolveRevision(s.resource, { kind: 'accepted' }), 'accepted_head_unavailable');
  });

  it('listTree and readFile by sha', async () => {
    const s = await setup();
    const root = await s.provider.listTree(s.resource, s.baseRevision, '');
    expect(root.map((e) => [e.path, e.type, e.mode])).toEqual([
      ['a.txt', 'file', '100644'],
      ['src', 'dir', '040000'],
    ]);
    const sub = await s.provider.listTree(s.resource, s.baseRevision, 'src');
    expect(sub.map((e) => e.path)).toEqual(['src/b.ts']);
    expect(await s.provider.listTree(s.resource, s.baseRevision, 'missing')).toEqual([]);
    expect(new TextDecoder().decode((await s.provider.readFile(s.resource, s.baseRevision, 'a.txt'))!)).toBe('one');
    expect(await s.provider.readFile(s.resource, s.baseRevision, 'nope.txt')).toBeNull();
    await expectCode(s.provider.readFile(s.resource, s.baseRevision, '../etc/passwd'), 'invalid_input');
  });

  it('refuses a resource whose coords are not the org canonical namespace', async () => {
    const s = await setup();
    await expectCode(s.provider.readFile({ ...s.resource, coords: { ...s.canonical, namespace: TASKS_NS } }, s.baseRevision, 'a.txt'), 'invalid_input');
  });
});

describe('ensureCanonicalRepo', () => {
  it('creates the canonical repo and revokes its initial write token', async () => {
    const s = await setup();
    const c = await s.provider.ensureCanonicalRepo(ORG, 'res2');
    expect(c).toMatchObject({ namespace: CANON_NS, repoName: 'res2' });
    expect(s.fake.activeTokens(CANON_NS, 'res2')).toEqual([]);
    expect(await s.provider.ensureCanonicalRepo(ORG, 'res2')).toEqual(c);
    expect(await s.provider.canonicalCoords(ORG, 'res2')).toEqual(c);
  });
});

describe('review fixes', () => {
  async function pushed(s: Awaited<ReturnType<typeof setup>>) {
    const h = await workspace(s);
    await s.provider.issueWorkspaceCredential(h, grant(['write']));
    const cand = s.fake.makeCommit({ 'a.txt': 'two', 'src/b.ts': 'b' }, [s.base], 'cand');
    s.fake.push(TASKS_NS, 'ws-ws1', 'main', cand);
    return { h, cand };
  }
  const anyCompare = async (req: { base: never; candidate: never }) => ({ base: req.base, candidate: req.candidate, sameTree: false, files: [] });

  it('I-2: a write token minted between list and revoke is revoked before freeze returns', async () => {
    const s = await setup({ compare: anyCompare as never });
    const { h, cand } = await pushed(s);
    let injected = 0;
    s.fake.afterListTokens = (key) => {
      if (key === `${TASKS_NS}/ws-ws1` && injected < 2) {
        injected++;
        s.fake.mint(TASKS_NS, 'ws-ws1', 'write');
      }
    };
    const f = await s.provider.freezeCandidate(h, { expectedSha: cand, submitter });
    expect(f.sha).toBe(cand);
    expect(injected).toBe(2);
    expect(s.fake.activeTokens(TASKS_NS, 'ws-ws1').filter((t) => t.scope === 'write')).toEqual([]);
  });

  it('I-2: tokens that keep appearing → freeze_incomplete', async () => {
    const s = await setup({ compare: anyCompare as never, freezeRevokeRounds: 3 });
    const { h, cand } = await pushed(s);
    s.fake.afterListTokens = (key) => {
      if (key === `${TASKS_NS}/ws-ws1`) s.fake.mint(TASKS_NS, 'ws-ws1', 'write');
    };
    await expectCode(s.provider.freezeCandidate(h, { expectedSha: cand, submitter }), 'freeze_incomplete');
  });

  it('I-3: the returned remote URL is the server one, never the handle one', async () => {
    const s = await setup();
    const h = await workspace(s);
    const evil = { ...h, coords: { ...h.coords, remoteUrl: 'https://evil.example/x.git' } };
    const c = await s.provider.issueWorkspaceCredential(evil, grant(['read']));
    expect(c.remoteUrl).toBe(s.fake.repo(TASKS_NS, 'ws-ws1').info.remote);
  });

  it('I-3: a handle whose repoId differs from the live repo is refused (credential, freeze, collect)', async () => {
    const s = await setup();
    const h = await workspace(s);
    const forged = { ...h, coords: { ...h.coords, repoId: 'someotherrepo' } };
    await expectCode(s.provider.issueWorkspaceCredential(forged, grant(['read'])), 'repo_mismatch');
    await expectCode(s.provider.freezeCandidate(forged, { expectedSha: s.base, submitter }), 'repo_mismatch');
    await expectCode(s.provider.collectWorkspace(forged), 'repo_mismatch');
    expect(s.fake.repos.has(`${TASKS_NS}/ws-ws1`)).toBe(true);
    expect(s.fake.calls.filter((c) => c.op === 'createToken')).toEqual([]);
  });

  it('I-3: with a workspace resolver the ledger state, lease generation and lease deadline win over the handle', async () => {
    let record: WorkspaceRecord = { organizationId: ORG, state: 'frozen', leaseGeneration: 2 };
    const s = await setup({ workspace: async () => record });
    const h = await workspace(s);
    // a stale handle still says writable; the ledger says frozen
    await expectCode(s.provider.issueWorkspaceCredential(h, grant(['write'], 3600, 2)), 'workspace_not_writable');
    record = { ...record, state: 'writable' };
    await expectCode(s.provider.issueWorkspaceCredential(h, grant(['write'], 3600, 1)), 'lease_stale');
    record = { ...record, leaseExpiresAt: new Date(NOW.getTime() + 200_000).toISOString() };
    const c = await s.provider.issueWorkspaceCredential(h, { ...grant(['write'], 3600, 2), leaseExpiresAt: new Date(NOW.getTime() + 900_000).toISOString() });
    expect(s.fake.repo(TASKS_NS, 'ws-ws1').tokens.find((t) => t.id === c.tokenId)!.ttl).toBe(200); // earliest deadline
    await expect(s.provider.issueWorkspaceCredential(h, grant(['write'], 3600, 2))).resolves.toBeTruthy();
  });

  it('M-5: core WorkspaceGrant.leaseExpiresAt caps the TTL through the VersionProvider interface', async () => {
    const s = await setup();
    const h = await workspace(s);
    const c = await s.provider.issueWorkspaceCredential(h, { ...grant(['write'], 3600), leaseExpiresAt: new Date(NOW.getTime() + 120_000).toISOString() });
    expect(s.fake.repo(TASKS_NS, 'ws-ws1').tokens.find((t) => t.id === c.tokenId)!.ttl).toBe(120);
  });

  it('M-6: with a workspace resolver, a dash-prefix collision cannot reach another environment', async () => {
    // provider prefix "commonforge" would parse "commonforge-test-org1-tasks" as org "test-org1"
    const s = await setup();
    const h = await workspace(s);
    const loose = new ArtifactsVersionProvider({ transport: s.fake, namespacePrefix: 'commonforge', now: () => NOW });
    await expect(loose.issueWorkspaceCredential(h, grant(['read']))).resolves.toBeTruthy(); // documented gap without a resolver
    const bound = new ArtifactsVersionProvider({
      transport: s.fake,
      namespacePrefix: 'commonforge',
      now: () => NOW,
      workspace: async () => ({ organizationId: 'org1', state: 'writable' }),
    });
    await expectCode(bound.issueWorkspaceCredential(h, grant(['read'])), 'namespace_refused');
    await expectCode(bound.collectWorkspace(h), 'namespace_refused');
    expect(s.fake.repos.has(`${TASKS_NS}/ws-ws1`)).toBe(true);
  });

  it('M-1: revokeStaleCanonicalWriteTokens revokes only active canonical write tokens older than the max job lifetime', async () => {
    const s = await setup();
    const old = new Date(NOW.getTime() - 2 * 3600_000).toISOString();
    const fresh = new Date(NOW.getTime() - 60_000).toISOString();
    const a = s.fake.mint(CANON_NS, 'res1', 'write', 86_400, old);
    const b = s.fake.mint(CANON_NS, 'res1', 'write', 600, fresh);
    const r = s.fake.mint(CANON_NS, 'res1', 'read', 86_400, old);
    expect(await s.provider.revokeStaleCanonicalWriteTokens(ORG, 'res1')).toBe(1);
    const state = (id: string) => s.fake.repo(CANON_NS, 'res1').tokens.find((t) => t.id === id)!.state;
    expect([state(a.id), state(b.id), state(r.id)]).toEqual(['revoked', 'active', 'active']);
  });
});

describe('re-review fixes', () => {
  it('R-1: a 409 from a concurrent creator with the same caller id never deletes that repo; the call adopts it', async () => {
    const s = await setup();
    let otherId = '';
    s.fake.beforeCreate = (ns, name) => {
      if (name !== 'ws-same' || otherId) return;
      // call B wins the race between A's lookup and A's create, and has already seeded
      const r = s.fake.addRepo(ns, name);
      otherId = r.info.id;
      s.fake.objectsIn.get(`${ns}/${name}`)!.add(s.base);
      s.fake.push(ns, name, 'main', s.base);
    };
    const h = await workspace(s, 'same');
    expect(s.fake.repos.has(`${TASKS_NS}/ws-same`)).toBe(true);
    expect(h.coords.repoId).toBe(otherId);
    expect(s.jobs).toHaveLength(0); // already seeded by B

    // a generated id never adopts, but still never deletes the other repo
    const s2 = await setup({ newTaskWorkspaceId: () => 'dup' });
    s2.fake.beforeCreate = (ns, name) => {
      if (!s2.fake.repos.has(`${ns}/${name}`)) s2.fake.addRepo(ns, name);
    };
    await expectCode(workspace(s2), 'already_exists');
    expect(s2.fake.repos.has(`${TASKS_NS}/ws-dup`)).toBe(true);
  });

  it('R-1: two concurrent calls with the same workspace id end with one repo, seeded, and both handles agree', async () => {
    const s = await setup();
    const results = await Promise.allSettled([workspace(s, 'pair'), workspace(s, 'pair')]);
    expect(s.fake.repos.has(`${TASKS_NS}/ws-pair`)).toBe(true);
    expect(s.fake.repo(TASKS_NS, 'ws-pair').refs.get('main')).toBe(s.base);
    const ok = results.filter((r): r is PromiseFulfilledResult<TaskWorkspaceHandle> => r.status === 'fulfilled');
    expect(ok.length).toBeGreaterThanOrEqual(1);
    for (const r of ok) expect(r.value.coords.repoId).toBe(s.fake.repo(TASKS_NS, 'ws-pair').info.id);
  });

  it('R-2: seed-workspace and reconcile-ref jobs carry the server canonical coords, not a tampered resource URL', async () => {
    const s = await setup();
    const tampered = { ...s.resource, coords: { ...s.canonical, remoteUrl: 'https://evil.example/c.git' } };
    await s.provider.createIsolatedChange({ resource: tampered, baseRevision: s.baseRevision, taskId: 't', organizationId: ORG, changeId: 'c' as never, purpose: 'agent-task' });
    const seed = s.jobs[0]!;
    expect(seed.kind === 'seed-workspace' && seed.canonical.remoteUrl).toBe(s.fake.repo(CANON_NS, 'res1').info.remote);

    const next = s.fake.makeCommit({ 'a.txt': 'n' }, [s.base], 'next');
    s.fake.objectsIn.get(`${CANON_NS}/res1`)!.add(next);
    const head: AcceptedHead = { resourceId: RES, revisionId: artRevisionId(s.canonical.repoId, next), versionSeq: 2, acceptedVersionId: null, acceptedAt: NOW.toISOString(), reconciliation: 'pending' };
    let job: IntegrationJob | undefined;
    await s.provider.reconcileAccepted(tampered, head, validated((j) => {
      job = j;
      return { jobId: 'j', ok: true, receipt: { jobId: 'j', resourceId: RES, ref: 'refs/heads/main', targetSha: next, observedSha: next, status: 'synced', reconciledAt: NOW.toISOString() } };
    }));
    expect(job?.kind === 'reconcile-ref' && job.canonical.remoteUrl).toBe(s.fake.repo(CANON_NS, 'res1').info.remote);
  });

  it('R-3: the earliest lease deadline is chosen by time, not by string order (offset timestamps)', async () => {
    // ledger 12:04Z written as 14:04+02:00 sorts after the grant's 12:10Z as a string
    const s = await setup({ workspace: async () => ({ organizationId: ORG, state: 'writable', leaseExpiresAt: '2026-10-06T14:04:00+02:00' }) });
    const h = await workspace(s);
    const c = await s.provider.issueWorkspaceCredential(h, { ...grant(['write'], 3600), leaseExpiresAt: '2026-10-06T12:10:00.000Z' });
    expect(s.fake.repo(TASKS_NS, 'ws-ws1').tokens.find((t) => t.id === c.tokenId)!.ttl).toBe(240);
  });
});
