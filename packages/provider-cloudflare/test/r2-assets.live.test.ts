/**
 * Live R2 test (plan §G.3 "R2 staged→promote with HEAD verification; GC deletes only unreachable").
 *
 * Runs only under `pnpm test:live` (COMMONFORGE_LIVE=1) with CF_ACCOUNT_ID + CF_API_TOKEN (or the
 * CLOUDFLARE_* names). Transport: the R2 S3-compatible API via `S3R2Port` (SigV4 over fetch, creds
 * derived from the API token). Creates a disposable bucket, runs a 50 MiB multipart round trip +
 * promote + manifest + GC, then empties and deletes the bucket.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { ResourceId, TaskWorkspaceId } from '@commonforge-org/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { R2AssetProvider, r2AssetKeys } from '../src/index.js';
import { r2Bucket, S3R2Port, s3CredsFromApiToken } from './r2-s3-port.js';

const accountId = process.env.CF_ACCOUNT_ID ?? process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CF_API_TOKEN ?? process.env.CLOUDFLARE_API_TOKEN;
const enabled = process.env.COMMONFORGE_LIVE === '1' && !!accountId && !!apiToken;

const MiB = 1024 * 1024;
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const suffix = randomBytes(4).toString('hex');
const bucketName = `commonforge-spike-assets-${suffix}`;
const ORG = `live-${suffix}`;
const RES = 'assets' as ResourceId;
const WS = 'ws-live' as TaskWorkspaceId;

describe.skipIf(!enabled)('R2AssetProvider live (S3 API)', () => {
  let port: S3R2Port;
  let provider: R2AssetProvider;
  let bucketCreated = false;
  const timings: Record<string, number> = {};
  const timed = async <T>(name: string, f: () => Promise<T>): Promise<T> => {
    const t = performance.now();
    try {
      return await f();
    } finally {
      timings[name] = Math.round(performance.now() - t);
    }
  };

  beforeAll(async () => {
    await r2Bucket(accountId!, apiToken!, 'create', bucketName);
    bucketCreated = true;
    port = new S3R2Port(await s3CredsFromApiToken(accountId!, apiToken!), bucketName);
    provider = new R2AssetProvider({ bucket: port, organizationId: ORG, signingKey: randomBytes(32), partSize: 8 * MiB });
  }, 60_000);

  afterAll(async () => {
    // Best effort: a failed S3 call during cleanup must not leak the disposable bucket.
    if (port) {
      try {
        let leftovers = 0;
        for (;;) {
          const page = await port.list({ prefix: '' });
          if (page.objects.length === 0) break;
          leftovers += page.objects.length;
          await port.delete(page.objects.map((o) => o.key));
        }
        console.log(`[live] cleanup removed ${leftovers} leftover object(s)`);
      } catch (e) {
        console.log(`[live] cleanup listing failed: ${(e as Error).message}`);
      }
    }
    if (bucketCreated) {
      await r2Bucket(accountId!, apiToken!, 'delete', bucketName);
      console.log(`[live] bucket ${bucketName} deleted`);
    }
    console.log(`[live] timings(ms) ${JSON.stringify(timings)}`);
  }, 120_000);

  it('50 MiB: multipart staging upload, HEAD+stream-hash promote, manifest, GC', async () => {
    const big = randomBytes(50 * MiB);
    const bigSha = sha(big);
    const small = randomBytes(4096);

    // Stage + multipart upload (7 parts of 8 MiB).
    const staged = await provider.stageUpload({ organizationId: ORG, taskWorkspaceId: WS, path: 'video/demo.mp4', size: big.length, mime: 'video/mp4' });
    await timed('putStaged50MiB', () => provider.putStaged(staged.stagingKey, big));
    expect((await port.head(staged.stagingKey))?.size).toBe(big.length);

    // Wrong expected sha is refused; nothing appears at the immutable key; staging survives.
    const wrong = sha(small);
    await expect(provider.promoteStaged({ stagingKey: staged.stagingKey, expectedSha256: wrong, resourceId: RES })).rejects.toMatchObject({
      code: 'asset_sha256_mismatch',
    });
    expect(await port.head(r2AssetKeys.object(ORG, RES, wrong))).toBeNull();
    expect(await port.head(staged.stagingKey)).not.toBeNull();

    // Promote: HEAD verify, stream-hash 50 MiB, multipart copy to immutable key, delete staging.
    const promoted = await timed('promote50MiB', () =>
      provider.promoteStaged({ stagingKey: staged.stagingKey, expectedSha256: bigSha, resourceId: RES }),
    );
    expect(promoted).toEqual({ objectKey: r2AssetKeys.object(ORG, RES, bigSha), sha256: bigSha, size: big.length });
    expect(await port.head(staged.stagingKey)).toBeNull();
    // Lost-response retry of the identical call succeeds from the immutable object's metadata.
    expect(await provider.promoteStaged({ stagingKey: staged.stagingKey, expectedSha256: bigSha, resourceId: RES })).toEqual(promoted);
    const head = await port.head(promoted.objectKey);
    expect(head?.size).toBe(big.length);
    expect(head?.customMetadata?.sha256).toBe(bigSha);

    // Round trip: download and compare.
    const back = await timed('get50MiB', async () => new Uint8Array(await (await port.get(promoted.objectKey))!.arrayBuffer()));
    expect(sha(back)).toBe(bigSha);

    // A small asset via single put (put-time sha256).
    const s = await provider.stageUpload({ organizationId: ORG, taskWorkspaceId: WS, path: 'logo.png', size: small.length, mime: 'image/png' });
    await provider.putStaged(s.stagingKey, small);
    const ps = await provider.promoteStaged({ stagingKey: s.stagingKey, expectedSha256: sha(small), resourceId: RES });

    const mBig = await provider.writeManifest({
      resourceId: RES,
      parentManifestId: null,
      entries: [{ path: 'video/demo.mp4', sha256: bigSha, size: big.length, mime: 'video/mp4', objectKey: promoted.objectKey }],
    });
    const mSmall = await provider.writeManifest({
      resourceId: RES,
      parentManifestId: null,
      entries: [{ path: 'logo.png', sha256: ps.sha256, size: ps.size, mime: 'image/png', objectKey: ps.objectKey }],
    });
    expect(await provider.readManifest(mBig.manifestId)).toEqual(mBig);

    // A fresh staging upload inside its TTL must survive GC.
    const fresh = await provider.stageUpload({ organizationId: ORG, taskWorkspaceId: WS, path: 'tmp.bin', size: 3, mime: 'x/y' });
    await provider.putStaged(fresh.stagingKey, new Uint8Array([1, 2, 3]));

    // GC with only the small manifest's id reachable (its entries are protected via the manifest),
    // grace 0: the 50 MiB object and its manifest go.
    const now = new Date(Date.now() + 5_000).toISOString();
    const { deleted } = await timed('gc', () =>
      provider.collectUnreachable({ reachable: new Set([mSmall.manifestId]), graceSeconds: 0, now }),
    );
    expect(new Set(deleted)).toEqual(
      new Set([promoted.objectKey, r2AssetKeys.manifest(ORG, RES, mBig.manifestId), r2AssetKeys.manifestIndex(ORG, mBig.manifestId)]),
    );
    expect(await port.head(promoted.objectKey)).toBeNull();
    expect(await port.head(ps.objectKey)).not.toBeNull();
    expect(await port.head(fresh.stagingKey)).not.toBeNull();
    expect(await provider.readManifest(mSmall.manifestId)).toEqual(mSmall);
    expect(await provider.readManifest(mBig.manifestId)).toBeNull();
  }, 600_000);
});
