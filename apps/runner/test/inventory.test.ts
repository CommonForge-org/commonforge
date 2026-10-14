import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256HexSync } from '@commonforge-org/core';
import { World } from './helpers.js';
import { makeZip, type ZipSpec } from './zip-writer.js';

let w: World;
let seq = 0;
beforeAll(async () => {
  w = await World.create();
});
afterAll(() => w?.close());

async function put(bytes: Uint8Array): Promise<string> {
  const key = `org/org1/intake/up-${++seq}.zip`;
  await mkdir(dirname(w.blobPath(key)), { recursive: true });
  await writeFile(w.blobPath(key), bytes);
  return key;
}

const job = (r2Key: string, extra: Record<string, unknown> = {}, limits: Record<string, number> = {}) => ({
  kind: 'inventory' as const,
  intakeId: `intake-${seq}`,
  upload: { r2Key, ...extra },
  limits: { maxFiles: 100, maxTotalBytes: 50 * 1024 * 1024, maxCompressionRatio: 100, ...limits },
});

describe('inventory', () => {
  it('lists safe entries with sha256/size and reports unsafe ones without executing or extracting anything', async () => {
    const specs: ZipSpec[] = [
      { name: 'site/index.html', data: '<h1>x</h1>\n' },
      { name: 'site/../../etc/passwd', data: 'x' },
      { name: 'site/link', data: '/etc', mode: 0o120777 },
      { name: 'api/src/app.ts', data: 'export {};\n', method: 0 },
    ];
    const zip = makeZip(specs);
    const key = await put(zip);
    const r = await w.runner().execute(await w.delivery(job(key, { sha256: sha256HexSync(zip), size: zip.length })));
    expect(r).toMatchObject({
      ok: true,
      receipt: {
        entries: [
          { path: 'api/src/app.ts', size: 11, sha256: sha256HexSync('export {};\n') },
          { path: 'site/index.html', size: 11, sha256: sha256HexSync('<h1>x</h1>\n') },
        ],
        rejected: [
          { path: 'site/../../etc/passwd', reason: 'path_escape' },
          { path: 'site/link', reason: 'symlink' },
        ],
        totalBytes: 22,
      },
    });
    expect(w.worker.issued.length).toBe(0);
  });

  it('archive-level limits give an empty listing; a hash mismatch or garbage fails the job', async () => {
    const many = await put(makeZip(Array.from({ length: 5 }, (_, i) => ({ name: `f${i}`, data: 'x' }))));
    expect(await w.runner().execute(await w.delivery(job(many, {}, { maxFiles: 3 })))).toMatchObject({ ok: true, receipt: { entries: [], rejected: [{ path: '', reason: 'too_many_files' }] } });
    expect(await w.runner().execute(await w.delivery(job(many, { sha256: 'a'.repeat(64) })))).toMatchObject({ ok: false, code: 'scope_violation' });
    const junk = await put(new TextEncoder().encode('not a zip at all, definitely not'));
    expect(await w.runner().execute(await w.delivery(job(junk)))).toMatchObject({ ok: false, code: 'scope_violation' });
    expect(await w.runner().execute(await w.delivery(job('org/org1/intake/missing.zip')))).toMatchObject({ ok: false, code: 'provider_unavailable' });
  });
});
