import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { candidateRetentionRef } from '@commonforge-org/core';
import { World, type CanonicalRepo } from './helpers.js';

let w: World;
let site: CanonicalRepo;

beforeAll(async () => {
  w = await World.create();
  site = await w.canonical('res-site', { 'index.html': '<h1>v1</h1>\n', 'about.html': 'about\n' });
});
afterAll(() => w?.close());

const prepJob = (candidate: Awaited<ReturnType<World['candidate']>>['candidate']) => ({
  kind: 'prepare-candidate' as const,
  candidate,
  canonical: site.coords,
  retentionRef: candidateRetentionRef(candidate.candidateId),
});

describe('prepare-candidate', () => {
  it('fetches the fork sha and retains it in canonical; receipt {candidateId, canonicalRef, sha}; idempotent', async () => {
    const { candidate } = await w.candidate(site, { 'index.html': '<h1>v2</h1>\n' }, 'prep1');
    const d = await w.delivery(prepJob(candidate));
    const r = await w.runner().execute(d);
    expect(r).toMatchObject({
      ok: true,
      receipt: { candidateId: candidate.candidateId, canonicalRef: `refs/commonforge/candidates/${candidate.taskWorkspaceId}/${candidate.sha}`, sha: candidate.sha },
    });
    expect(await w.remoteSha(site.coords, candidateRetentionRef(candidate.candidateId))).toBe(candidate.sha);
    expect(await w.remoteSha(site.coords, 'refs/heads/main')).toBe(site.sha);
    // retry (new job) is idempotent
    expect((await w.runner().execute(await w.delivery(prepJob(candidate)))).ok).toBe(true);
    // the fork was read, canonical written: exactly those grants
    expect(w.worker.issued.filter((t) => t.jobId === d.signedJob.jobId).map((t) => t.access).sort()).toEqual(['read', 'write']);
    w.assertTokensHygiene(JSON.stringify(r));
  });

  it('refuses a tampered tree, lying changedPaths, and an occupied retention ref (scope_violation)', async () => {
    const { candidate } = await w.candidate(site, { 'about.html': 'about v2\n' }, 'prep2');
    const refs = await w.remoteRefs(site.coords);
    for (const bad of [
      { ...candidate, treeId: site.sha },
      { ...candidate, changedPaths: ['index.html'] },
      { ...candidate, changedPaths: [] },
    ]) {
      const r = await w.runner().execute(await w.delivery(prepJob(bad)));
      expect(r, JSON.stringify(bad.changedPaths)).toMatchObject({ ok: false, code: 'scope_violation' });
    }
    expect(await w.remoteRefs(site.coords)).toEqual(refs);
  });

  it('fails with provider_unavailable when the candidate sha is not in the fork', async () => {
    const { candidate } = await w.candidate(site, { 'x.txt': 'x\n' }, 'prep3');
    const missing = 'f'.repeat(40);
    const ghost = { ...candidate, sha: missing, candidateId: `cand:${candidate.taskWorkspaceId}:${missing}` as never };
    const r = await w.runner().execute(await w.delivery(prepJob(ghost)));
    expect(r).toMatchObject({ ok: false, code: 'provider_unavailable' });
  });
});
