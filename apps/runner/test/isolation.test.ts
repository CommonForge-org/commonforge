/** Review fixes I-1 (check isolation) and I-2 (job-chosen destinations). */
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { candidateRetentionRef, computeSnapshotIdSync, sha256HexSync, type FrozenCandidate } from '@commonforge-org/core';
import { jobIntegrationRef } from '@commonforge-org/runner-protocol';
import { spawn } from 'node:child_process';
import { brokerCredentials, createGit, createRunner, findCheckProcesses, JobContext, KeyedMutex, linuxProcessOps, reapCheckProcesses, staticCredentials } from '../src/index.js';
import { main } from '../src/main.js';
import { World, type CanonicalRepo } from './helpers.js';

let w: World;
let site: CanonicalRepo;
let cand: FrozenCandidate;
let seq = 0;

beforeAll(async () => {
  w = await World.create();
  site = await w.canonical('res-site', {
    'index.html': 'v1\n',
    'scripts/cwd.mjs': 'console.error(`CWD=${process.cwd()}`);\nprocess.exit(1);\n',
    'scripts/daemon.mjs':
      "import { spawn } from 'node:child_process';\nimport { writeFileSync } from 'node:fs';\nconst c = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' });\nc.unref();\nwriteFileSync(process.argv[2], String(c.pid));\n",
  });
  cand = (await w.candidate(site, { 'index.html': 'v2\n' }, 'iso')).candidate;
  const r = await w.runner().execute(await w.delivery({ kind: 'prepare-candidate', candidate: cand, canonical: site.coords, retentionRef: candidateRetentionRef(cand.candidateId) }));
  expect(r.ok).toBe(true);
});
afterAll(() => w?.close());

function integrateJob(command: string) {
  const jobId = `job-iso-${++seq}`;
  const proposalId = `prop-iso-${seq}`;
  const entries = [{ resourceId: site.resource.resourceId, revisionId: site.revision, mode: 'must-match-accepted' as const, mountName: 'website', operations: ['read' as const, 'write' as const] }];
  const snap = { projectId: 'p', organizationId: 'org1', membershipRevision: 1, policyRevision: 1, entries };
  return {
    jobId,
    job: {
      kind: 'integrate' as const,
      proposalId,
      proposalHash: sha256HexSync(proposalId),
      baseSnapshot: { ...snap, snapshotId: computeSnapshotIdSync(snap), createdAt: new Date().toISOString() },
      candidateSnapshotId: sha256HexSync(`candidate:${proposalId}`),
      candidates: [cand],
      targets: [{ resourceId: site.resource.resourceId, canonical: site.coords, expectedHead: site.revision }],
      integrationRef: jobIntegrationRef(proposalId, jobId),
      checks: [{ checkId: 'c', mountName: 'website', command, timeoutSeconds: 30, required: true }],
      contracts: [],
    },
  };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('I-1 check isolation', () => {
  it('refuses to run checks or recipes without a check uid unless explicitly opted in', async () => {
    const { job, jobId } = integrateJob('node scripts/cwd.mjs');
    const r = await w.runner({ commands: {} }).execute(await w.delivery(job, { jobId }));
    expect(r).toMatchObject({ ok: false, code: 'provider_unavailable' });
    if (!r.ok) expect(r.detail).toMatch(/check uid/);
    expect(Object.keys(await w.remoteRefs(site.coords)).some((k) => k.includes(jobId))).toBe(false);
    const preview = {
      kind: 'preview-build' as const,
      previewId: 'pv-iso',
      integrationSha: { 'res-site': site.sha },
      sources: [{ resourceId: 'res-site', mountName: 'website', canonical: site.coords }],
      recipe: { recipeId: 'r', revision: 1, steps: [{ stepId: 's', mountName: 'website', command: 'node scripts/cwd.mjs' }] },
    };
    expect(await w.runner({ commands: {}, previewBaseUrl: 'https://p.example' }).execute(await w.delivery(preview))).toMatchObject({ ok: false, code: 'provider_unavailable' });
  });

  it('runs checks in a checkout outside the job directory that holds the push repositories', async () => {
    const workDir = w.dir('iso-work');
    const checksDir = w.dir('iso-checks');
    const { job, jobId } = integrateJob('node scripts/cwd.mjs');
    const r = await w.runner({ workDir, checksDir }).execute(await w.delivery(job, { jobId }));
    expect(r).toMatchObject({ ok: false, code: 'check_failed' });
    if (r.ok) return;
    const cwd = /CWD=(\S+)/.exec(r.detail)![1]!;
    expect(cwd.startsWith(`${checksDir}/`)).toBe(true);
    expect(cwd.startsWith(workDir)).toBe(false);
  });

  it('kills check descendants that escaped into their own session before anything is pushed', async () => {
    const pidDir = w.dir('pids');
    await mkdir(pidDir, { recursive: true });
    const pidFile = join(pidDir, 'daemon.pid');
    const { job, jobId } = integrateJob(`node scripts/daemon.mjs ${pidFile}`);
    const r = await w.runner().execute(await w.delivery(job, { jobId }));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const pid = Number(await readFile(pidFile, 'utf8'));
    expect(pid).toBeGreaterThan(1);
    expect(alive(pid)).toBe(false);
  });

  it('refuses to push while a check-uid process survives', async () => {
    const d = await w.delivery({ kind: 'seed-workspace', taskWorkspaceId: 'tw-iso', resourceId: 'res-site', canonical: site.coords, baseSha: site.sha, taskFork: await w.bareRepo('tasks', 'ws-tw-iso'), ref: 'refs/heads/main' });
    const killed: number[] = [];
    const ctx = new JobContext(
      d.signedJob,
      w.dir('ctx-iso'),
      staticCredentials(() => ({})).open(d.signedJob),
      {
        git: createGit({ allowFile: true }),
        pushMutex: new KeyedMutex(),
        runnerId: 'r',
        runnerKind: 'node-runner',
        commands: { uid: 4242, gid: 4242 },
        checksRoot: w.dir('ctx-checks'),
        // an unkillable process owned by the check uid
        procs: { list: async () => [{ pid: 999_999, uids: [4242, 4242, 4242, 4242] }], environ: async () => null, kill: (pid) => void killed.push(pid) },
        push: {},
        canaries: [],
        now: () => new Date(),
        log: () => undefined,
      },
      null,
      [],
    );
    const job = d.signedJob.job as { taskFork: CanonicalRepo['coords'] };
    await expect(ctx.push({ coords: job.taskFork, ref: 'refs/heads/main', sha: site.sha, dir: w.root })).rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(killed.length).toBeGreaterThan(0);
    expect(await w.remoteRefs(job.taskFork)).toEqual({});
  });
});

describe('I-2 destinations come from configuration only', () => {
  it('refuses a job whose credential broker is not the trusted Worker, before any network call', async () => {
    const before = w.worker.issued.length + w.worker.refusals.length;
    const d = await w.delivery({ kind: 'seed-workspace', taskWorkspaceId: 'tw-iso2', resourceId: 'res-site', canonical: site.coords, baseSha: site.sha, taskFork: await w.bareRepo('tasks', 'ws-tw-iso2'), ref: 'refs/heads/main' });
    const r = await w.runner({ trustedWorkerOrigin: 'https://worker.example.com' }).execute(d);
    expect(r).toMatchObject({ ok: false, code: 'scope_violation' });
    expect(w.worker.issued.length + w.worker.refusals.length).toBe(before);
  });

  it('refuses file:// remotes unless the runner enables them', async () => {
    const d = await w.delivery({ kind: 'seed-workspace', taskWorkspaceId: 'tw-iso3', resourceId: 'res-site', canonical: site.coords, baseSha: site.sha, taskFork: await w.bareRepo('tasks', 'ws-tw-iso3'), ref: 'refs/heads/main' });
    const r = await w.runner({ git: {} }).execute(d);
    expect(r).toMatchObject({ ok: false, code: 'scope_violation' });
    if (!r.ok) expect(r.detail).toMatch(/file remotes/);
  });

  it('the CLI needs --worker-url in broker mode and for posting', async () => {
    const io = { stdin: async () => '{}', stdout: () => undefined, stderr: () => undefined, env: {} };
    expect(await main(['run', '-'], io)).toBe(2);
    expect(await main(['run', '-', '--credentials', 'egress'], io)).toBe(2);
    expect(await main(['run', '-', '--credentials', 'egress', '--no-post'], io)).toBe(2); // worker blob store still needs it
  });
});

describe('R-1 / R-2 construction guards', () => {
  const own = process.getuid!();

  it('refuses a check uid of 0 or the runner\'s own uid (runner, process finder and CLI)', async () => {
    for (const uid of [0, own]) {
      expect(() => w.runner({ commands: { uid } })).toThrow(/check uid/);
      await expect(findCheckProcesses(linuxProcessOps, { uid })).rejects.toThrow(/check uid/);
      await expect(reapCheckProcesses(linuxProcessOps, { uid })).rejects.toThrow(/check uid/);
    }
    const io = { stdin: async () => '{}', stdout: () => undefined, stderr: () => undefined, env: {} };
    expect(await main(['run', '-', '--worker-url', w.worker.url, '--check-uid', String(own)], io)).toBe(2);
    expect(await main(['run', '-', '--worker-url', w.worker.url, '--check-uid', '0'], io)).toBe(2);
  });

  it('a JobContext configured with the runner\'s own uid refuses to run checks', async () => {
    const d = await w.delivery({ kind: 'seed-workspace', taskWorkspaceId: 'tw-r1', resourceId: 'res-site', canonical: site.coords, baseSha: site.sha, taskFork: await w.bareRepo('tasks', 'ws-tw-r1'), ref: 'refs/heads/main' });
    const ctx = new JobContext(d.signedJob, w.dir('ctx-r1'), staticCredentials(() => ({})).open(d.signedJob), {
      git: createGit({ allowFile: true }),
      pushMutex: new KeyedMutex(),
      runnerId: 'r',
      runnerKind: 'node-runner',
      commands: { uid: own },
      checksRoot: w.dir('ctx-r1-checks'),
      procs: linuxProcessOps,
      push: {},
      canaries: [],
      now: () => new Date(),
      log: () => undefined,
    }, null, []);
    expect(() => ctx.assertCheckIsolation()).toThrow(/own uid/);
  });

  it('refuses to construct a broker-mode runner without a trusted Worker origin', () => {
    expect(() => createRunner({ workDir: w.dir('r2'), credentials: brokerCredentials() })).toThrow(/trustedWorkerOrigin/);
    expect(() => createRunner({ workDir: w.dir('r2b'), credentials: brokerCredentials(), trustedWorkerOrigin: 'https://w.example' })).not.toThrow();
  });

  // R-3: the real uid sweep needs root (to spawn as another uid); skipped otherwise.
  it.skipIf(own !== 0)('as root: reaps every process of the check uid, including escaped sessions', async () => {
    const child = spawn('sleep', ['300'], { uid: 65534, gid: 65534, detached: true, stdio: 'ignore' });
    child.unref();
    await new Promise((r) => setTimeout(r, 100));
    expect(await findCheckProcesses(linuxProcessOps, { uid: 65534 })).toContain(child.pid);
    expect(await reapCheckProcesses(linuxProcessOps, { uid: 65534 })).toEqual([]);
    expect(alive(child.pid!)).toBe(false);
  });
});
