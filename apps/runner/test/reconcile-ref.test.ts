import { chmod, writeFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { candidateRetentionRef } from '@commonforge-org/core';
import { World, type CanonicalRepo } from './helpers.js';

let w: World;
let site: CanonicalRepo;
let target: string;

beforeAll(async () => {
  w = await World.create();
  site = await w.canonical('res-site', { 'index.html': 'v1\n' });
  const { candidate } = await w.candidate(site, { 'index.html': 'v2\n' }, 'rec');
  const r = await w.runner().execute(await w.delivery({ kind: 'prepare-candidate', candidate, canonical: site.coords, retentionRef: candidateRetentionRef(candidate.candidateId) }));
  expect(r.ok).toBe(true);
  target = candidate.sha;
});
afterAll(() => w?.close());

const job = (expectedCurrentSha: string | null, targetSha = target) => ({
  kind: 'reconcile-ref' as const,
  resourceId: 'res-site',
  canonical: site.coords,
  ref: 'refs/heads/main',
  targetSha,
  expectedCurrentSha,
});

describe('reconcile-ref', () => {
  it('a failed push with the ref unmoved is provider_unavailable, not diverged', async () => {
    const path = decodeURIComponent(new URL(site.coords.remoteUrl).pathname);
    const hook = `${path}/hooks/pre-receive`;
    const { readFile } = await import('node:fs/promises');
    const original = await readFile(hook, 'utf8').catch(() => null);
    // the provider installs its guard via core.hooksPath; add a refusing pre-receive there
    const hooksPath = (await w.git.run(['config', '--file', `${path}/config`, '--get', 'core.hooksPath'], path)).stdout.trim() || `${path}/hooks`;
    const guard = `${hooksPath.startsWith('/') ? hooksPath : `${path}/${hooksPath}`}/pre-receive`;
    const guardOriginal = await readFile(guard, 'utf8').catch(() => null);
    await writeFile(guard, '#!/bin/sh\necho "artifacts_git_receive_pack_busy" >&2\nexit 1\n');
    await chmod(guard, 0o755);
    try {
      const r = await w.runner({ push: { attempts: 2, baseDelayMs: 1 } }).execute(await w.delivery(job(site.sha)));
      expect(r).toMatchObject({ ok: false, code: 'provider_unavailable' });
      expect(await w.remoteSha(site.coords, 'refs/heads/main')).toBe(site.sha);
    } finally {
      if (guardOriginal !== null) await writeFile(guard, guardOriginal);
      if (original !== null) await writeFile(hook, original);
    }
  });

  it('pushes with --force-with-lease on the expected sha → synced; repeat is synced without a push', async () => {
    const r = await w.runner().execute(await w.delivery(job(site.sha)));
    expect(r).toMatchObject({ ok: true, receipt: { status: 'synced', observedSha: target, ref: 'refs/heads/main' } });
    expect(await w.remoteSha(site.coords, 'refs/heads/main')).toBe(target);
    expect(await w.runner().execute(await w.delivery(job(site.sha)))).toMatchObject({ ok: true, receipt: { status: 'synced' } });
  });

  it('diverged when a concurrent writer moved the ref away from the lease; nothing is overwritten', async () => {
    const other = await w.advanceCanonical(site, { 'hotfix.txt': 'x\n' }, 'concurrent writer');
    const r = await w.runner().execute(await w.delivery(job(target, site.sha)));
    expect(r).toMatchObject({ ok: true, receipt: { status: 'diverged', observedSha: other } });
    expect(await w.remoteSha(site.coords, 'refs/heads/main')).toBe(other);
  });
});
