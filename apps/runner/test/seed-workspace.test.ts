import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { World, type CanonicalRepo } from './helpers.js';

let w: World;
let site: CanonicalRepo;

beforeAll(async () => {
  w = await World.create();
  site = await w.canonical('res-site', { 'index.html': '<h1>v1</h1>\n' });
  // a canonical service ref of another workspace that must never reach a task repo
  await w.advanceCanonical(site, { 'later.txt': 'later\n' });
});
afterAll(() => w?.close());

describe('seed-workspace', () => {
  it('pushes exactly <baseSha>:<ref>, idempotently, and revokes both tokens', async () => {
    const fork = await w.bareRepo('tasks', 'ws-tw-seed1');
    const job = {
      kind: 'seed-workspace' as const,
      taskWorkspaceId: 'tw-seed1',
      resourceId: 'res-site',
      canonical: site.coords,
      baseSha: site.sha,
      taskFork: fork,
      ref: 'refs/heads/main',
    };
    const runner = w.runner();
    const d = await w.delivery(job);
    const r = await runner.execute(d);
    expect(r).toMatchObject({ ok: true, receipt: { sha: site.sha, ref: 'refs/heads/main', taskWorkspaceId: 'tw-seed1' } });
    expect(await w.remoteRefs(fork)).toEqual({ 'refs/heads/main': site.sha });

    // a retry as a new job (same base) succeeds without pushing anything else
    const r2 = await w.runner().execute(await w.delivery(job));
    expect(r2.ok).toBe(true);
    expect(await w.remoteRefs(fork)).toEqual({ 'refs/heads/main': site.sha });

    const forJob = w.worker.issued.filter((t) => t.jobId === d.signedJob.jobId);
    expect(forJob.map((t) => `${t.repo}:${t.access}`).sort()).toEqual(['res-site:read', 'ws-tw-seed1:write']);
    w.assertTokensHygiene(JSON.stringify([r, r2]));
  });

  it('refuses when the task ref already holds a different sha (scope_violation)', async () => {
    const fork = await w.bareRepo('tasks', 'ws-tw-seed2');
    const job = { kind: 'seed-workspace' as const, taskWorkspaceId: 'tw-seed2', resourceId: 'res-site', canonical: site.coords, baseSha: site.sha, taskFork: fork, ref: 'refs/heads/main' };
    expect((await w.runner().execute(await w.delivery(job))).ok).toBe(true);
    const later = await w.remoteSha(site.coords, 'refs/heads/main');
    const r = await w.runner().execute(await w.delivery({ ...job, baseSha: later! }));
    expect(r).toMatchObject({ ok: false, code: 'scope_violation' });
    expect(await w.remoteRefs(fork)).toEqual({ 'refs/heads/main': site.sha });
  });
});
