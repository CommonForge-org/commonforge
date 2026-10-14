import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { candidateRetentionRef, localRevisionId } from '@commonforge-org/core';
import { World, type CanonicalRepo } from './helpers.js';

let w: World;
let site: CanonicalRepo;
const prepared = async (c: CanonicalRepo, files: Record<string, string>, label: string, base?: string) => {
  const { candidate } = await w.candidate(c, files, label, base ? localRevisionId(c.coords.repoId, base) : undefined);
  const r = await w.runner().execute(await w.delivery({ kind: 'prepare-candidate', candidate, canonical: c.coords, retentionRef: candidateRetentionRef(candidate.candidateId) }));
  expect(r.ok).toBe(true);
  return candidate;
};
let buildSeq = 0;
let lastBuildId = '';
const job = (landings: Array<{ landingId: string; candidates: Array<{ candidateId: string; sha: string; baseSha: string }> }>, buildId = `b-${++buildSeq}`) => ({
  kind: 'staging-build' as const,
  buildId: (lastBuildId = buildId),
  targets: [{ resourceId: site.resource.resourceId, canonical: site.coords, mainSha: site.sha, landings }],
});
const land = (id: string, c: { candidateId: string; sha: string }, baseSha: string) => ({ landingId: id, candidates: [{ candidateId: c.candidateId, sha: c.sha, baseSha }] });
const shaOf = (r: unknown) => (r as { receipt: { results: Array<{ sha: string }> } }).receipt.results[0]!.sha;

beforeAll(async () => {
  w = await World.create();
  site = await w.canonical('res-site-stg', { 'index.html': '<h1>Hi</h1>\n', 'footer.html': 'old footer\n', 'about.html': 'about\n' });
});
afterAll(() => w?.close());

describe('staging-build', () => {
  // several git repos and pushes: slow under turbo's parallel load (vitest's 5 s default is too tight)
  it('applies each landing as the diff from its own base, in order, and pushes refs/commonforge/staging', { timeout: 30_000 }, async () => {
    const a = await prepared(site, { 'index.html': '<h1>Welcome</h1>\n' }, 'stg-a');
    const b = await prepared(site, { 'footer.html': 'new footer\n' }, 'stg-b');
    const r = await w.runner().execute(await w.delivery(job([land('l-a', a, site.sha), land('l-b', b, site.sha)])));
    expect(r.ok).toBe(true);
    const buildId = lastBuildId;
    const sha = shaOf(r);
    expect(await w.remoteSha(site.coords, 'refs/commonforge/staging')).toBe(sha);
    expect(await w.remoteSha(site.coords, `refs/commonforge/staging-builds/${buildId}`)).toBe(sha);
    expect(await w.showFile(site.coords, sha, 'index.html')).toBe('<h1>Welcome</h1>\n');
    expect(await w.showFile(site.coords, sha, 'footer.html')).toBe('new footer\n');
    expect(await w.remoteSha(site.coords, 'refs/heads/main')).toBe(site.sha);
  });
  it('a task based on an earlier staging commit contributes only its own edits', { timeout: 30_000 }, async () => {
    const a = await prepared(site, { 'index.html': '<h1>Welcome</h1>\n' }, 'stg-c');
    const first = await w.runner().execute(await w.delivery(job([land('l-c', a, site.sha)])));
    const staging1 = shaOf(first);
    const b = await prepared(site, { 'about.html': 'about us\n' }, 'stg-d', staging1);
    // without l-c: b must not bring a's index.html with it
    const r = await w.runner().execute(await w.delivery(job([land('l-d', b, staging1)])));
    const sha = shaOf(r);
    expect(await w.showFile(site.coords, sha, 'index.html')).toBe('<h1>Hi</h1>\n');
    expect(await w.showFile(site.coords, sha, 'about.html')).toBe('about us\n');
  });
  it('a conflict names the landing and leaves the staging ref alone', { timeout: 30_000 }, async () => {
    const before = await w.remoteSha(site.coords, 'refs/commonforge/staging');
    const a = await prepared(site, { 'index.html': '<h1>A</h1>\n' }, 'stg-e');
    const b = await prepared(site, { 'index.html': '<h1>B</h1>\n' }, 'stg-f');
    const r = await w.runner().execute(await w.delivery(job([land('l-e', a, site.sha), land('l-f', b, site.sha)])));
    expect(r).toMatchObject({ ok: false, code: 'textual_conflict' });
    expect((r as { detail: string }).detail).toMatch(/^landing l-f conflicts in res-site-stg: index\.html/);
    expect(await w.remoteSha(site.coords, 'refs/commonforge/staging')).toBe(before);
  });
  it('retrying the same job (same build, same sha) succeeds; every build keeps its own ref', { timeout: 30_000 }, async () => {
    const a = await prepared(site, { 'index.html': '<h1>Retry</h1>\n' }, 'stg-g');
    const j = job([land('l-g', a, site.sha)], 'b-retry');
    const opts = { jobId: 'job-retry-1', issuedAt: new Date() };
    const r1 = await w.runner().execute(await w.delivery(j, opts));
    expect(r1.ok, JSON.stringify(r1)).toBe(true);
    const r2 = await w.runner().execute(await w.delivery(j, opts));
    expect(r2.ok, JSON.stringify(r2)).toBe(true);
    expect(shaOf(r2)).toBe(shaOf(r1));
    expect(await w.remoteSha(site.coords, 'refs/commonforge/staging-builds/b-retry')).toBe(shaOf(r1));
    // another build's ref is untouched
    const other = await w.runner().execute(await w.delivery(job([land('l-g', a, site.sha)], 'b-retry-2')));
    expect(other.ok).toBe(true);
    expect(await w.remoteSha(site.coords, 'refs/commonforge/staging-builds/b-retry')).toBe(shaOf(r1));
  });
  it('a refused build ref on the second target fails the job before any target\'s refs/commonforge/staging moves', { timeout: 30_000 }, async () => {
    const other = await w.canonical('res-api-stg', { 'src/app.ts': 'export const v = 1;\n' });
    const a = await prepared(site, { 'index.html': '<h1>X</h1>\n' }, 'stg-h');
    const o = (await w.candidate(other, { 'src/app.ts': 'export const v = 2;\n' }, 'stg-o')).candidate;
    expect((await w.runner().execute(await w.delivery({ kind: 'prepare-candidate', candidate: o, canonical: other.coords, retentionRef: candidateRetentionRef(o.candidateId) }))).ok).toBe(true);
    const beforeSite = await w.remoteSha(site.coords, 'refs/commonforge/staging');
    const taken = await w.mergeOnto(other, other.sha, o.sha, 'refs/commonforge/staging-builds/b-taken');
    const r = await w.runner().execute(
      await w.delivery({
        kind: 'staging-build' as const,
        buildId: 'b-taken',
        targets: [
          { resourceId: site.resource.resourceId, canonical: site.coords, mainSha: site.sha, landings: [land('l-h', a, site.sha)] },
          { resourceId: other.resource.resourceId, canonical: other.coords, mainSha: other.sha, landings: [land('l-o', o, other.sha)] },
        ],
      }),
    );
    expect(r.ok).toBe(false);
    expect(await w.remoteSha(site.coords, 'refs/commonforge/staging')).toBe(beforeSite);
    expect(await w.remoteSha(other.coords, 'refs/commonforge/staging')).toBeNull();
    expect(await w.remoteSha(other.coords, 'refs/commonforge/staging-builds/b-taken')).toBe(taken);
  });
  it('a conflicting build leaves neither the staging ref nor a build ref behind', { timeout: 30_000 }, async () => {
    const before = await w.remoteSha(site.coords, 'refs/commonforge/staging');
    const a = await prepared(site, { 'index.html': '<h1>X2</h1>\n' }, 'stg-j');
    const b = await prepared(site, { 'index.html': '<h1>Y2</h1>\n' }, 'stg-k');
    const r = await w.runner().execute(await w.delivery(job([land('l-j', a, site.sha), land('l-k', b, site.sha)], 'b-fail')));
    expect(r.ok).toBe(false);
    expect(await w.remoteSha(site.coords, 'refs/commonforge/staging')).toBe(before);
    expect(await w.remoteSha(site.coords, 'refs/commonforge/staging-builds/b-fail')).toBeNull();
  });
});
