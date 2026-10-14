/**
 * Live ArtifactsVersionProvider test against the real Cloudflare account (plan §G.3).
 * Runs only under `pnpm test:live` (COMMONFORGE_LIVE=1) with CF_API_TOKEN and CF_ACCOUNT_ID set:
 *
 *   source scripts/load-dev-vars.sh && pnpm --filter @commonforge-org/provider-cloudflare test:live
 *
 * Flow: create canonical → (runner) push two commits to canonical → createIsolatedChange at the
 * NON-tip base (a `seed-workspace` job run by git in this process, standing in for runner + broker)
 * → workspace token → clone/push → freeze (post-freeze push fails) → prepare-candidate stub
 * (runner token pushes refs/commonforge/candidates/<ws>/<sha>) →
 * collect. Uses a disposable org id under COMMONFORGE_NAMESPACE_PREFIX (default commonforge-spike)
 * and always deletes every repo it created. Tokens travel to git via GIT_CONFIG_* env vars (never
 * argv) and all git output is redacted.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  artRevisionId,
  candidateRetentionRef,
  resourceId,
  toIsoUtc,
  type CompareResult,
  type ResourceRef,
  type RunnerSubmit,
} from '@commonforge-org/core';
import { IntegrationJobSchema, jobRepoAccess, type IntegrationJob } from '@commonforge-org/runner-protocol';
import { RestArtifactsTransport } from './artifacts-rest.js';
import { ArtifactsVersionProvider, type CompareRequest } from './artifacts.js';
import { ArtifactsProviderError, redactSecrets } from './errors.js';
import { DEFAULT_NAMESPACE_PREFIX } from './naming.js';

const ACCOUNT_ID = process.env.CF_ACCOUNT_ID ?? '';
const API_TOKEN = process.env.CF_API_TOKEN ?? '';
const LIVE = process.env.COMMONFORGE_LIVE === '1' && Boolean(ACCOUNT_ID && API_TOKEN);
const PREFIX = process.env.COMMONFORGE_NAMESPACE_PREFIX || DEFAULT_NAMESPACE_PREFIX;
const RUN = Date.now().toString(36);
const ORG = `t12live${RUN}`;
const RES = resourceId('res-live');
const submitter = { kind: 'agent' as const, id: 'live-agent' };

const redact = (s: string) => redactSecrets(s, [API_TOKEN, ACCOUNT_ID]);
const timings: Record<string, number> = {};
async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    timings[label] = Math.round(performance.now() - t0);
  }
}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

function git(cwd: string | undefined, args: string[], token?: string): Promise<GitResult> {
  const cfg: Array<[string, string]> = [
    ['credential.helper', ''],
    ['user.name', 'commonforge-live'],
    ['user.email', 'live@commonforge.invalid'],
    ['init.defaultBranch', 'main'],
    ['core.hooksPath', '/dev/null'],
  ];
  if (token) cfg.push(['http.extraHeader', `Authorization: Bearer ${token}`]);
  const env: Record<string, string> = { ...(process.env as Record<string, string>), GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'true', GIT_CONFIG_COUNT: String(cfg.length) };
  cfg.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k;
    env[`GIT_CONFIG_VALUE_${i}`] = v;
  });
  return new Promise((resolve) => {
    execFile('git', args, { cwd, env, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? ((error as { code: number }).code) : 1) : 0;
      resolve({ code, stdout: redact(String(stdout)).trim(), stderr: redact(String(stderr)).trim() });
    });
  });
}

async function gitOk(cwd: string | undefined, args: string[], token?: string): Promise<string> {
  const r = await git(cwd, args, token);
  if (r.code !== 0) throw new Error(`git ${args[0]} failed (${r.code}): ${r.stderr}`);
  return r.stdout;
}

/** Push with retry on `artifacts_git_receive_pack_busy` (one push per repo at a time, spike A1). */
async function pushWithRetry(cwd: string, args: string[], token: string): Promise<GitResult> {
  let r: GitResult = { code: 1, stdout: '', stderr: '' };
  for (let attempt = 0; attempt < 5; attempt++) {
    r = await git(cwd, ['push', ...args], token);
    if (r.code === 0 || !/hung up|receive_pack_busy/.test(r.stderr)) return r;
    await new Promise((res) => setTimeout(res, 150 * 2 ** attempt + Math.random() * 100));
  }
  return r;
}

describe.skipIf(!LIVE)('ArtifactsVersionProvider (live)', () => {
  const transport = LIVE ? new RestArtifactsTransport({ accountId: ACCOUNT_ID, apiToken: API_TOKEN }) : (null as never);
  const created: Array<[string, string]> = [];
  const dirs: string[] = [];
  let tmp = '';

  const newDir = async (name: string) => {
    if (!tmp) {
      tmp = await mkdtemp(join(tmpdir(), 'cf-t12-live-'));
      dirs.push(tmp);
    }
    return join(tmp, name);
  };

  afterAll(async () => {
    const results: string[] = [];
    for (const [ns, name] of created) {
      try {
        await transport.deleteRepo(ns, name);
        results.push(`${name}: ${(await transport.getRepo(ns, name)) === null ? 'deleted' : 'STILL PRESENT'}`);
      } catch (e) {
        results.push(`${name}: delete failed ${redact(String(e))}`);
      }
    }
    for (const d of dirs) await rm(d, { recursive: true, force: true });
    // Never prints tokens: only names, timings and outcomes.
    console.log(`[live] org=${ORG} prefix=${PREFIX} cleanup: ${results.join(', ')}`);
    console.log(`[live] timings ms: ${JSON.stringify(timings)}`);
  });

  it('create → seed → workspace → token → push → freeze → prepare-candidate stub → collect', { timeout: 300_000 }, async () => {
    // Compare delegate = what the runner does (plan §B.6 P0): git diff --name-status -M in a clone holding both commits.
    let compareClone = '';
    const compare = async (req: CompareRequest): Promise<CompareResult> => {
      const out = await gitOk(compareClone, ['diff', '--name-status', '-M', '--no-color', req.baseSha, req.candidateSha]);
      const files = out
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [st, a, b] = line.split('\t');
          if (st!.startsWith('R')) return { path: b!, oldPath: a!, status: 'renamed' as const, binary: false };
          return { path: a!, status: (st === 'A' ? 'added' : st === 'D' ? 'deleted' : 'modified') as 'added' | 'deleted' | 'modified', binary: false };
        });
      return { base: req.base, candidate: req.candidate, sameTree: files.length === 0, files };
    };

    // Runner + broker stand-in for seed-workspace (runner-protocol contract): validate the job,
    // mint a canonical READ and a task-fork WRITE token per jobRepoAccess, fetch baseSha, push
    // exactly <baseSha>:<ref> with a must-not-exist lease, confirm with ls-remote, revoke both.
    const seedRunner = (async (raw: unknown) => {
      const job = IntegrationJobSchema.parse(raw);
      if (job.kind !== 'seed-workspace') throw new Error(`unexpected ${job.kind}`);
      seedJobs.push(job);
      const access = jobRepoAccess(job);
      expect(access.map((a) => [a.role, a.access])).toEqual([
        ['canonical', 'read'],
        ['task-fork', 'write'],
      ]);
      const read = await transport.createToken(job.canonical.namespace, job.canonical.repoName, 'read', 300);
      const write = await transport.createToken(job.taskFork.namespace, job.taskFork.repoName, 'write', 300);
      try {
        const d = await newDir(`seed-${job.taskWorkspaceId}`);
        await gitOk(undefined, ['init', '-q', '--bare', d]);
        await gitOk(d, ['fetch', '-q', job.canonical.remoteUrl, job.baseSha], read.plaintext);
        const r = await pushWithRetry(d, ['-q', `--force-with-lease=${job.ref}:`, job.taskFork.remoteUrl, `${job.baseSha}:${job.ref}`], write.plaintext);
        const ls = await gitOk(undefined, ['ls-remote', job.taskFork.remoteUrl, job.ref], write.plaintext);
        if (!ls.startsWith(job.baseSha)) return { jobId: 'seed-job', ok: false, code: 'provider_unavailable', detail: `seed push failed: ${r.stderr}` };
      } finally {
        await transport.revokeToken(job.canonical.namespace, job.canonical.repoName, read.id);
        await transport.revokeToken(job.taskFork.namespace, job.taskFork.repoName, write.id);
      }
      return {
        jobId: 'seed-job',
        ok: true,
        receipt: { jobId: 'seed-job', taskWorkspaceId: job.taskWorkspaceId, resourceId: job.resourceId, ref: job.ref, sha: job.baseSha, seededAt: toIsoUtc() },
      };
    }) as unknown as RunnerSubmit;
    const seedJobs: IntegrationJob[] = [];

    const provider = new ArtifactsVersionProvider({
      transport,
      namespacePrefix: PREFIX,
      compare,
      runner: seedRunner,
    });

    // 1. Canonical repo (initial create token revoked at once).
    const canonical = await timed('ensureCanonicalRepo', () => provider.ensureCanonicalRepo(ORG, RES));
    created.push([canonical.namespace, canonical.repoName]);
    expect(canonical.namespace).toBe(`${PREFIX}-${ORG}-canonical`);
    expect((await transport.listTokens(canonical.namespace, canonical.repoName)).filter((t) => t.state === 'active')).toEqual([]);

    // 2. Runner seeds canonical main (canonical write tokens exist only inside runner jobs).
    const work = await newDir('canon-work');
    await gitOk(undefined, ['init', '-q', '-b', 'main', work]);
    await writeFile(join(work, 'a.txt'), 'one\n');
    await writeFile(join(work, 'b.txt'), 'bee\n');
    await gitOk(work, ['add', '-A']);
    await gitOk(work, ['commit', '-q', '-m', 'base']);
    const baseSha = await gitOk(work, ['rev-parse', 'HEAD']);
    // A second commit makes the base a NON-tip sha: seeding must fetch a reachable non-tip want (review M-8).
    await writeFile(join(work, 'later.txt'), 'later\n');
    await gitOk(work, ['add', '-A']);
    await gitOk(work, ['commit', '-q', '-m', 'later']);
    const tipSha = await gitOk(work, ['rev-parse', 'HEAD']);
    const runnerTok = await transport.createToken(canonical.namespace, canonical.repoName, 'write', 300);
    try {
      const p = await pushWithRetry(work, ['-q', canonical.remoteUrl, 'main:refs/heads/main'], runnerTok.plaintext);
      expect(p.code, p.stderr).toBe(0);
    } finally {
      await transport.revokeToken(canonical.namespace, canonical.repoName, runnerTok.id);
    }

    const resource: ResourceRef = { organizationId: ORG, resourceId: RES, provider: 'artifacts', authority: 'commonforge_ledger', coords: canonical };
    const resolved = await timed('resolveRevision', () => provider.resolveRevision(resource, { kind: 'ref', ref: 'refs/heads/main' }));
    expect(resolved.contentId).toBe(tipSha);
    const baseRevision = artRevisionId(canonical.repoId, baseSha);
    expect(new TextDecoder().decode((await provider.readFile(resource, baseRevision, 'a.txt'))!)).toBe('one\n');
    expect((await provider.listTree(resource, baseRevision, '')).map((e) => e.path)).toEqual(['a.txt', 'b.txt']);

    // 3. Task workspace in the tasks namespace (create + seed).
    const handle = await timed('createIsolatedChange', () =>
      provider.createIsolatedChange({ resource, baseRevision, taskId: 'task-live', organizationId: ORG, changeId: 'chg-live' as never, purpose: 'agent-task' }),
    );
    created.push([handle.coords.namespace, handle.coords.repoName]);
    expect(handle.coords.namespace).toBe(`${PREFIX}-${ORG}-tasks`);
    expect(handle.state).toBe('writable');
    expect(seedJobs).toHaveLength(1);
    expect(seedJobs[0]).toMatchObject({ kind: 'seed-workspace', baseSha, ref: 'refs/heads/main', canonical });
    expect((await transport.listTokens(handle.coords.namespace, handle.coords.repoName)).filter((t) => t.state === 'active')).toEqual([]);

    // Canonical handles never get credentials.
    await expect(provider.issueWorkspaceCredential({ ...handle, coords: canonical }, { principal: submitter, operations: ['read'], ttlSeconds: 600, leaseGeneration: 1 })).rejects.toMatchObject({
      code: 'canonical_namespace_refused',
    });

    // 4. Agent token → clone → commit → push.
    const cred = await timed('issueWorkspaceCredential', () =>
      provider.issueWorkspaceCredential(handle, { principal: submitter, operations: ['read', 'write'], ttlSeconds: 600, leaseGeneration: 1 }),
    );
    expect(cred.scope).toBe('write');
    expect(cred.remoteUrl).toBe(handle.coords.remoteUrl);
    const agent = await newDir('agent');
    await gitOk(undefined, ['clone', '-q', cred.remoteUrl, agent], cred.secret);
    expect(await gitOk(agent, ['rev-parse', 'HEAD'])).toBe(baseSha);
    await writeFile(join(agent, 'a.txt'), 'two\n');
    await gitOk(agent, ['mv', 'b.txt', 'c.txt']);
    await gitOk(agent, ['commit', '-q', '-am', 'agent change']);
    const candSha = await gitOk(agent, ['rev-parse', 'HEAD']);
    const push1 = await timed('agentPush', () => pushWithRetry(agent, ['-q', 'origin', 'main'], cred.secret));
    expect(push1.code, push1.stderr).toBe(0);
    compareClone = agent;

    // 5. Freeze: wrong expected sha → candidate_moved; right one → frozen and write tokens revoked.
    await expect(provider.freezeCandidate(handle, { expectedSha: baseSha, submitter })).rejects.toMatchObject({ code: 'candidate_moved' });
    const frozen = await timed('freezeCandidate', () => provider.freezeCandidate(handle, { expectedSha: candSha, submitter, tool: 'live-test' }));
    expect(frozen.sha).toBe(candSha);
    expect(frozen.candidateId).toBe(`cand:${handle.taskWorkspaceId}:${candSha}`);
    expect(frozen.changedPaths).toEqual(['a.txt', 'b.txt', 'c.txt']);
    expect((await transport.listTokens(handle.coords.namespace, handle.coords.repoName)).filter((t) => t.state === 'active' && t.scope === 'write')).toEqual([]);

    // Post-freeze push with the agent's token fails and the branch does not move.
    await writeFile(join(agent, 'a.txt'), 'three\n');
    await gitOk(agent, ['commit', '-q', '-am', 'after freeze']);
    const push2 = await git(agent, ['push', '-q', 'origin', 'main'], cred.secret);
    expect(push2.code).not.toBe(0);
    expect(push2.stderr).not.toContain(cred.secret);
    const [headAfter] = await transport.log(handle.coords.namespace, handle.coords.repoName, { ref: 'main', limit: 1 });
    expect(headAfter?.hash).toBe(candSha);
    await expect(provider.issueWorkspaceCredential({ ...handle, state: 'frozen' }, { principal: submitter, operations: ['write'], ttlSeconds: 600, leaseGeneration: 1 })).rejects.toBeInstanceOf(
      ArtifactsProviderError,
    );

    // 6. prepare-candidate stub: the runner fetches the candidate from the task repo (read token)
    //    and pushes it to the retention ref in canonical with a runner-only canonical write token.
    //    No --atomic: Artifacts answered "receiving end does not support --atomic push" on 2026-10-06
    //    (Task 12 probe), although spike S2 saw it work earlier that day.
    let submittedJob: Record<string, unknown> | undefined;
    const submit = (async (raw: unknown) => {
      const job = IntegrationJobSchema.parse(raw);
      if (job.kind !== 'prepare-candidate') throw new Error(`unexpected ${job.kind}`);
      submittedJob = job as unknown as Record<string, unknown>;
      const retentionRef = job.retentionRef as string;
      const fork = await provider.issueWorkspaceCredential({ ...handle, state: 'frozen' }, { principal: { kind: 'runner', id: 'live-runner' }, operations: ['read'], ttlSeconds: 300, leaseGeneration: 1 });
      const canonTok = await transport.createToken(canonical.namespace, canonical.repoName, 'write', 300);
      try {
        const d = await newDir('runner');
        await gitOk(undefined, ['init', '-q', '--bare', d]);
        await gitOk(d, ['fetch', '-q', fork.remoteUrl, candSha], fork.secret);
        const r = await pushWithRetry(d, ['-q', `--force-with-lease=${retentionRef}:`, canonical.remoteUrl, `${candSha}:${retentionRef}`], canonTok.plaintext);
        if (r.code !== 0) return { jobId: 'live-job', ok: false, code: 'provider_unavailable', detail: r.stderr };
        const ls = await gitOk(undefined, ['ls-remote', canonical.remoteUrl, retentionRef], canonTok.plaintext);
        if (!ls.startsWith(candSha)) return { jobId: 'live-job', ok: false, code: 'provider_unavailable', detail: 'ref not visible' };
      } finally {
        await transport.revokeToken(canonical.namespace, canonical.repoName, canonTok.id);
        await transport.revokeToken(handle.coords.namespace, handle.coords.repoName, fork.tokenId);
      }
      return {
        jobId: 'live-job',
        ok: true,
        receipt: {
          receiptId: `rcpt-${RUN}`,
          jobId: 'live-job',
          candidateId: frozen.candidateId,
          resourceId: RES,
          canonicalRef: retentionRef,
          sha: candSha,
          revisionId: artRevisionId(canonical.repoId, candSha),
          verifiedAssetObjects: [],
          preparedAt: toIsoUtc(),
        },
      };
    }) as unknown as RunnerSubmit;
    const receipt = await timed('prepareForAcceptance', () => provider.prepareForAcceptance(frozen, submit));
    expect(submittedJob).toMatchObject({ kind: 'prepare-candidate', canonical, retentionRef: candidateRetentionRef(frozen.candidateId) });
    expect(receipt.canonicalRef).toBe(`refs/commonforge/candidates/${handle.taskWorkspaceId}/${candSha}`);
    // Candidate now readable from canonical by sha; canonical main is untouched.
    expect((await provider.resolveRevision(resource, { kind: 'candidate', candidateId: frozen.candidateId })).contentId).toBe(candSha);
    expect((await provider.resolveRevision(resource, { kind: 'ref', ref: 'refs/heads/main' })).contentId).toBe(tipSha);
    expect((await transport.listTokens(canonical.namespace, canonical.repoName)).filter((t) => t.state === 'active')).toEqual([]);

    // 7. Collect the workspace.
    await timed('collectWorkspace', () => provider.collectWorkspace(handle));
    expect(await transport.getRepo(handle.coords.namespace, handle.coords.repoName)).toBeNull();
    // Canonical is refused for collection.
    await expect(provider.collectWorkspace({ ...handle, coords: canonical })).rejects.toMatchObject({ code: 'canonical_namespace_refused' });
    expect(await transport.getRepo(canonical.namespace, canonical.repoName)).not.toBeNull();
  });
});
