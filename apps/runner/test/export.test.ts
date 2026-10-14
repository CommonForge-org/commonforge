import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeAssetManifestIdSync, sha256HexSync } from '@commonforge-org/core';
import { World, type CanonicalRepo } from './helpers.js';

let w: World;
let site: CanonicalRepo;
let v2: string;

beforeAll(async () => {
  w = await World.create();
  site = await w.canonical('res-site', { 'index.html': 'v1\n' });
  v2 = await w.advanceCanonical(site, { 'index.html': 'v2\n' });
});
afterAll(() => w?.close());

describe('export', () => {
  it('writes bundles, manifests and project.json under the sink prefix; bundles restore with plain git', async () => {
    const entries = [{ path: 'logo.png', sha256: sha256HexSync('png'), size: 3, mime: 'image/png', objectKey: `org/org1/res/res-brand/obj/${sha256HexSync('png')}` }];
    const manifest = { resourceId: 'res-brand' as never, parentManifestId: null, entries, createdAt: new Date().toISOString() };
    const manifestId = computeAssetManifestIdSync(manifest);
    const prefix = 'org/org1/exports/exp-1/';
    const job = {
      kind: 'export' as const,
      exportId: 'exp-1',
      snapshotId: sha256HexSync('snap'),
      resources: [
        { resourceId: 'res-site', coords: site.coords, sha: v2 },
        { resourceId: 'res-site-snap', coords: site.coords, sha: v2, historyMode: 'snapshot-only' as const },
      ],
      manifests: [{ ...manifest, manifestId }],
      sink: { kind: 'r2' as const, r2Prefix: prefix },
    };
    const d = await w.delivery(job);
    const r = await w.runner().execute(d);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    const items = (r.receipt as { items: Array<Record<string, unknown>> }).items;
    expect(items.map((i) => i.kind)).toEqual(['git-bundle', 'git-bundle', 'asset-manifest', 'project-structure']);
    for (const i of items) expect(String(i.r2Key).startsWith(prefix)).toBe(true);

    const full = items[0]!;
    const bytes = await readFile(w.blobPath(String(full.r2Key)));
    expect(sha256HexSync(bytes)).toBe(full.sha256);
    const restored = w.dir('restored');
    await w.git.ok(['clone', '-q', w.blobPath(String(full.r2Key)), restored], w.root);
    expect((await w.git.ok(['rev-parse', 'HEAD'], restored)).trim()).toBe(v2);
    expect((await w.git.ok(['rev-list', '--count', 'HEAD'], restored)).trim()).toBe('2');

    const snap = items[1]!;
    const restored2 = w.dir('restored-snap');
    await w.git.ok(['clone', '-q', w.blobPath(String(snap.r2Key)), restored2], w.root);
    expect((await w.git.ok(['rev-list', '--count', 'HEAD'], restored2)).trim()).toBe('1');
    expect(await readFile(`${restored2}/index.html`, 'utf8')).toBe('v2\n');
    expect(snap).toMatchObject({ historyMode: 'snapshot-only' });

    expect(items[2]).toMatchObject({ manifestId, objects: 1, bytes: 3 });
    const project = JSON.parse(await readFile(w.blobPath(`${prefix}project.json`), 'utf8'));
    expect(project).toMatchObject({ exportId: 'exp-1', resources: [{ sourceSha: v2, headSha: v2 }, { sourceSha: v2, historyMode: 'snapshot-only' }] });
    expect(JSON.stringify(project)).not.toContain('file://');
    expect(w.worker.issued.filter((t) => t.jobId === d.signedJob.jobId).every((t) => t.access === 'read')).toBe(true);
  });

  it('refuses a manifest whose id does not match its content', async () => {
    const entries = [{ path: 'a.bin', sha256: sha256HexSync('a'), size: 1, mime: 'application/octet-stream', objectKey: 'k' }];
    const r = await w.runner().execute(
      await w.delivery({
        kind: 'export',
        exportId: 'exp-2',
        snapshotId: sha256HexSync('snap'),
        resources: [],
        manifests: [{ manifestId: sha256HexSync('wrong') as never, resourceId: 'res-brand' as never, parentManifestId: null, entries, createdAt: new Date().toISOString() }],
        sink: { kind: 'r2', r2Prefix: 'org/org1/exports/exp-2/' },
      }),
    );
    expect(r).toMatchObject({ ok: false, code: 'scope_violation' });
  });
});
