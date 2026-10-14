import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deriveEvidenceKey, evidenceKeyToWire, jobIntegrationRef } from '@commonforge-org/runner-protocol';
import { brokerCredentials, egressCredentials, JobContext, staticCredentials } from '../src/index.js';
import { main } from '../src/main.js';
import { KEY, World, type CanonicalRepo } from './helpers.js';

let w: World;
let site: CanonicalRepo;

beforeAll(async () => {
  w = await World.create();
  site = await w.canonical('res-site', { 'index.html': '<h1>v1</h1>\n' });
});
afterAll(() => w?.close());

const seedJob = async (name: string) => ({
  kind: 'seed-workspace' as const,
  taskWorkspaceId: name,
  resourceId: 'res-site',
  canonical: site.coords,
  baseSha: site.sha,
  taskFork: await w.bareRepo('tasks', `ws-${name}`),
  ref: 'refs/heads/main',
});

async function allFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) if (e.isFile()) out.push(join(e.parentPath, e.name));
  return out;
}

describe('job verification', () => {
  it('refuses an expired job with job_expired before asking for any token', async () => {
    const before = w.worker.issued.length;
    const d = await w.delivery(await seedJob('tw-exp'), { issuedAt: new Date(Date.now() - 3_600_000), lifetimeSeconds: 600 });
    const r = await w.runner().execute(d);
    expect(r).toMatchObject({ ok: false, code: 'job_expired', jobId: d.signedJob.jobId });
    expect(w.worker.issued.length).toBe(before);
  });

  it('refuses a tampered job (keyring: bad signature; no keyring: the broker refuses every token)', async () => {
    const d = await w.delivery(await seedJob('tw-tamper'));
    const tampered = { ...d, signedJob: { ...d.signedJob, job: { ...d.signedJob.job, ref: 'refs/heads/evil' } } };
    expect(await w.runner().execute(tampered)).toMatchObject({ ok: false, code: 'scope_violation' });
    const before = w.worker.issued.length;
    const r = await w.runner({ jobKeyring: undefined }).execute(tampered);
    expect(r).toMatchObject({ ok: false, code: 'scope_violation' });
    expect(w.worker.issued.length).toBe(before);
    expect(w.worker.refusals.at(-1)?.detail).toMatch(/signature/);
  });

  it('refuses an evidence key that belongs to another job', async () => {
    const d = await w.delivery(await seedJob('tw-key'));
    const other = evidenceKeyToWire(await deriveEvidenceKey(KEY, 'job-other'));
    expect(await w.runner().execute({ ...d, evidenceKey: other })).toMatchObject({ ok: false, code: 'scope_violation' });
  });

  it('fails with job_expired when the job expires before a push', async () => {
    const d = await w.delivery(await seedJob('tw-midexp'));
    const issuedBefore = w.worker.issued.length;
    const runner = w.runner({ now: () => new Date(Date.now() + (w.worker.issued.length > issuedBefore ? 3_600_000 : 0)) });
    const r = await runner.execute(d);
    expect(r).toMatchObject({ ok: false, code: 'job_expired' });
    expect(await w.remoteRefs(d.signedJob.job.kind === 'seed-workspace' ? d.signedJob.job.taskFork : site.coords)).toEqual({});
  });
});

describe('dedupe by jobId', () => {
  it('runs a job once for concurrent and repeated deliveries, also across runner restarts (journal)', async () => {
    const journalDir = w.dir('journal');
    const d = await w.delivery(await seedJob('tw-dedupe'));
    const before = w.worker.issued.length;
    const runner = w.runner({ journalDir });
    const [a, b] = await Promise.all([runner.execute(d), runner.execute(d)]);
    expect(a).toEqual(b);
    const issued = w.worker.issued.length - before;
    expect(await runner.execute(d)).toEqual(a);
    expect(await w.runner({ journalDir }).execute(d)).toEqual(a);
    expect(w.worker.issued.length - before).toBe(issued);
  });
});

describe('credential hygiene', () => {
  it('never puts a token in git argv, on disk or in the result; revokes every token', async () => {
    const log = w.dir('argv-log');
    await mkdir(log, { recursive: true });
    const wrapper = join(log, 'git-wrapper.sh');
    await writeFile(wrapper, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${join(log, 'argv.txt')}'\nexec git "$@"\n`);
    await chmod(wrapper, 0o755);
    const workDir = w.dir('kept-work');
    const d = await w.delivery(await seedJob('tw-hygiene'));
    const r = await w.runner({ git: { binary: wrapper, allowFile: true }, workDir, keepWorkDirs: true }).execute(d);
    expect(r.ok).toBe(true);
    const tokens = w.worker.issued.filter((t) => t.jobId === d.signedJob.jobId);
    expect(tokens.length).toBe(2);
    const argv = await readFile(join(log, 'argv.txt'), 'utf8');
    expect(argv).toContain('push');
    const onDisk = (await Promise.all((await allFiles(workDir)).map((f) => readFile(f, 'latin1')))).join('\n');
    for (const t of tokens) {
      expect(argv).not.toContain(t.token);
      expect(onDisk).not.toContain(t.token);
    }
    w.assertTokensHygiene(JSON.stringify(r));
  });

  it('artifacts tokens travel as a URL-scoped extraHeader env, local-git tokens as COMMONFORGE_TOKEN', async () => {
    const d = await w.delivery(await seedJob('tw-env'));
    const session = brokerCredentials({ brokerForLocalGit: true }).open(d.signedJob);
    const env = await session.gitEnv(site.coords, 'read');
    expect(Object.keys(env)).toEqual(['COMMONFORGE_TOKEN']);
    await session.close();
    const egress = await egressCredentials({ caInfo: '/etc/ca.crt' }).open(d.signedJob).gitEnv(site.coords, 'write');
    expect(egress).toEqual({ GIT_SSL_CAINFO: '/etc/ca.crt' });
    // review I-3: the per-job runner key reaches only the git process environment (and redaction)
    const keyed = egressCredentials({ caInfo: '/etc/ca.crt', runnerKey: 'a'.repeat(64) }).open(d.signedJob);
    expect(await keyed.gitEnv(site.coords, 'read')).toEqual({ GIT_SSL_CAINFO: '/etc/ca.crt', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `x-commonforge-runner-key: ${'a'.repeat(64)}` });
    expect(keyed.secrets()).toEqual(['a'.repeat(64)]);
  });

  it('refuses to push a ref the job does not allow', async () => {
    const d = await w.delivery(await seedJob('tw-guard'));
    const ctx = new JobContext(d.signedJob, w.dir('ctx'), staticCredentials(() => ({})).open(d.signedJob), {
      git: (await import('../src/git.js')).createGit(),
      pushMutex: new (await import('../src/git.js')).KeyedMutex(),
      runnerId: 'r',
      runnerKind: 'node-runner',
      commands: {},
      checksRoot: w.dir('checks'),
      procs: (await import('../src/procs.js')).linuxProcessOps,
      push: {},
      canaries: [],
      now: () => new Date(),
      log: () => undefined,
    }, null, []);
    await expect(ctx.push({ coords: site.coords, ref: 'refs/heads/main', sha: site.sha, dir: w.root })).rejects.toMatchObject({ code: 'scope_violation' });
    await expect(ctx.push({ coords: site.coords, ref: jobIntegrationRef('p', 'j'), sha: site.sha, dir: w.root })).rejects.toMatchObject({ code: 'scope_violation' });
  });
});

describe('CLI', () => {
  it('runs a delivery from a file, prints and posts the redacted result', async () => {
    const d = await w.delivery(await seedJob('tw-cli'));
    const file = join(w.dir('cli'), 'delivery.json');
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, JSON.stringify(d));
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(['run', file, '--worker-url', w.worker.url, '--allow-file-remotes', '--work-dir', w.dir('cli-work'), '--blobs', w.dir('cli-blobs')], {
      stdin: async () => '',
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
      env: {},
    });
    expect(code).toBe(0);
    expect(JSON.parse(out.join(''))).toMatchObject({ ok: true, jobId: d.signedJob.jobId });
    expect(w.worker.results.at(-1)).toMatchObject({ signedJob: { jobId: d.signedJob.jobId }, result: { ok: true } });
    w.assertTokensHygiene(out.join('') + err.join('') + JSON.stringify(w.worker.results));
  });

  it('exits 1 for a failed job and 2 for bad input', async () => {
    const d = await w.delivery(await seedJob('tw-cli2'), { issuedAt: new Date(Date.now() - 7_200_000), lifetimeSeconds: 600 });
    const io = { stdin: async () => JSON.stringify(d), stdout: () => undefined, stderr: () => undefined, env: {} };
    expect(await main(['run', '-', '--no-post', '--allow-file-remotes', '--credentials', 'egress', '--blobs', w.dir('b2'), '--work-dir', w.dir('cli-work2')], io)).toBe(1);
    expect(await main(['run', '-'], { ...io, stdin: async () => 'not json' })).toBe(2);
  });
});
