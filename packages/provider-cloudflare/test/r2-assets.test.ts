import { createHash, randomBytes } from 'node:crypto';
import {
  computeAssetManifestId,
  type AssetManifestEntry,
  type ManifestId,
  type ReadGrant,
  type ResourceId,
  type TaskWorkspaceId,
} from '@commonforge-org/core';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  R2AssetError,
  R2AssetProvider,
  r2AssetKeys,
  reachableFromManifests,
  verifyAssetToken,
  type R2AssetErrorCode,
} from '../src/index.js';
import { MemoryR2 } from './r2-memory.js';

const MiB = 1024 * 1024;
const ORG = 'org1';
const RES = 'brand' as ResourceId;
const WS = 'ws1' as TaskWorkspaceId;
const KEY = new Uint8Array(32).fill(7);
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

let clock: Date;
let r2: MemoryR2;
let provider: R2AssetProvider;
let ids: number;

function makeProvider(extra: Partial<ConstructorParameters<typeof R2AssetProvider>[0]> = {}) {
  return new R2AssetProvider({
    bucket: r2,
    organizationId: ORG,
    signingKey: KEY,
    partSize: 5 * MiB,
    stagingTtlSeconds: 3600,
    now: () => clock,
    randomId: () => `stage-${String(++ids).padStart(4, '0')}`,
    ...extra,
  });
}

beforeEach(() => {
  clock = new Date('2026-10-06T12:00:00.000Z');
  r2 = new MemoryR2(() => clock);
  ids = 0;
  provider = makeProvider();
});

async function expectCode(p: Promise<unknown>, code: R2AssetErrorCode) {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e, `expected ${code}`).toBeInstanceOf(R2AssetError);
  expect((e as R2AssetError).code).toBe(code);
}

async function stageBytes(bytes: Uint8Array, path = 'media/clip.bin', mime = 'application/octet-stream') {
  const { stagingKey } = await provider.stageUpload({ organizationId: ORG, taskWorkspaceId: WS, path, size: bytes.length, mime });
  await provider.putStaged(stagingKey, bytes);
  return stagingKey;
}

async function promote(bytes: Uint8Array, path?: string) {
  const stagingKey = await stageBytes(bytes, path);
  return provider.promoteStaged({ stagingKey, expectedSha256: sha(bytes), resourceId: RES });
}

describe('R2AssetProvider: staging', () => {
  it('stages under org/<org>/staging/<ws>/<id> with an intent sidecar and a signed put URL', async () => {
    const r = await provider.stageUpload({ organizationId: ORG, taskWorkspaceId: WS, path: './a//b.png', size: 3, mime: 'image/png' });
    expect(r.stagingKey).toBe('org/org1/staging/ws1/stage-0001');
    const intent = JSON.parse(new TextDecoder().decode(r2.objects.get(`${r.stagingKey}.intent.json`)!.bytes));
    expect(intent).toMatchObject({ v: 1, organizationId: ORG, taskWorkspaceId: WS, path: 'a/b.png', size: 3, mime: 'image/png' });
    expect(r.uploadUrl).toMatch(/^\/v1\/assets\/org\/org1\/staging\/ws1\/stage-0001\?token=/);
    const token = decodeURIComponent(r.uploadUrl!.split('token=')[1]!);
    const payload = await verifyAssetToken({ token, key: KEY, now: clock, objectKey: r.stagingKey, op: 'put' });
    expect(payload.org).toBe(ORG);
    expect(r2.objects.has(r.stagingKey)).toBe(false); // bytes not written yet
  });

  it('refuses another organization, bad paths, sizes and mime', async () => {
    const base = { organizationId: ORG, taskWorkspaceId: WS, path: 'a.bin', size: 1, mime: 'x/y' };
    await expectCode(provider.stageUpload({ ...base, organizationId: 'org2' }), 'asset_wrong_organization');
    await expectCode(provider.stageUpload({ ...base, path: '../etc/passwd' }), 'asset_invalid_input');
    await expectCode(provider.stageUpload({ ...base, size: -1 }), 'asset_invalid_input');
    await expectCode(provider.stageUpload({ ...base, size: 1.5 }), 'asset_invalid_input');
    await expectCode(provider.stageUpload({ ...base, mime: '' }), 'asset_invalid_input');
    await expectCode(provider.stageUpload({ ...base, taskWorkspaceId: 'a/b' as TaskWorkspaceId }), 'asset_invalid_input');
  });

  it('putStaged refuses bodies longer or shorter than declared and leaves nothing visible', async () => {
    const { stagingKey } = await provider.stageUpload({ organizationId: ORG, taskWorkspaceId: WS, path: 'a', size: 10, mime: 'x/y' });
    await expectCode(provider.putStaged(stagingKey, new Uint8Array(11)), 'asset_size_mismatch');
    await expectCode(provider.putStaged(stagingKey, new Uint8Array(9)), 'asset_size_mismatch');
    expect(r2.objects.has(stagingKey)).toBe(false);
  });

  it('putStaged uses multipart above partSize and aborts it on a short stream', async () => {
    const size = 11 * MiB;
    const { stagingKey } = await provider.stageUpload({ organizationId: ORG, taskWorkspaceId: WS, path: 'a', size, mime: 'x/y' });
    const short = randomBytes(size - 1);
    await expectCode(provider.putStaged(stagingKey, short), 'asset_size_mismatch');
    expect(r2.abortedMultipart).toBe(1);
    expect(r2.objects.has(stagingKey)).toBe(false);
  });

  it('refuses staging keys outside this org or malformed', async () => {
    await expectCode(provider.putStaged('org/org2/staging/ws1/stage-0001', new Uint8Array(1)), 'asset_wrong_organization');
    await expectCode(provider.putStaged('org/org1/res/x/obj/abc', new Uint8Array(1)), 'asset_invalid_input');
    await expectCode(provider.putStaged('org/org1/staging/ws1/stage-0001.intent.json', new Uint8Array(1)), 'asset_invalid_input');
  });
});

describe('R2AssetProvider: promoteStaged', () => {
  it('small object: HEAD-verifies, hashes, writes the immutable key with put-time sha256, deletes staging', async () => {
    const bytes = randomBytes(1000);
    const stagingKey = await stageBytes(bytes, 'logo.png', 'image/png');
    r2.calls.length = 0;
    const r = await provider.promoteStaged({ stagingKey, expectedSha256: sha(bytes), resourceId: RES });
    expect(r).toEqual({ objectKey: `org/org1/res/brand/obj/${sha(bytes)}`, sha256: sha(bytes), size: 1000 });
    const obj = r2.objects.get(r.objectKey)!;
    expect(Buffer.from(obj.bytes).equals(bytes)).toBe(true);
    expect(obj.httpMetadata.contentType).toBe('image/png');
    expect(obj.customMetadata.sha256).toBe(sha(bytes));
    expect(r2.objects.has(stagingKey)).toBe(false);
    expect(r2.objects.has(`${stagingKey}.intent.json`)).toBe(false);
    // HEAD of staging happens before the body is read.
    expect(r2.calls.indexOf(`head ${stagingKey}`)).toBeLessThan(r2.calls.indexOf(`get ${stagingKey}`));
  });

  it('large object: streams the full body through the hasher and copies via fixed-size multipart parts', async () => {
    const bytes = randomBytes(11 * MiB + 123);
    const stagingKey = await stageBytes(bytes);
    expect(r2.completedMultipart).toBe(1); // putStaged
    r2.chunkSize = 777_777; // odd, unaligned read chunks
    const r = await provider.promoteStaged({ stagingKey, expectedSha256: sha(bytes), resourceId: RES });
    expect(r2.completedMultipart).toBe(2);
    expect(r.size).toBe(bytes.length);
    expect(sha(r2.objects.get(r.objectKey)!.bytes)).toBe(sha(bytes));
    expect(r2.objects.has(stagingKey)).toBe(false);
  });

  it('refuses when HEAD size differs from the declared size, without reading bytes', async () => {
    const { stagingKey } = await provider.stageUpload({ organizationId: ORG, taskWorkspaceId: WS, path: 'a', size: 5, mime: 'x/y' });
    r2.seed(stagingKey, 'six!!!'); // written out-of-band with the wrong length
    r2.calls.length = 0;
    await expectCode(provider.promoteStaged({ stagingKey, expectedSha256: sha(new Uint8Array(5)), resourceId: RES }), 'asset_size_mismatch');
    expect(r2.calls).not.toContain(`get ${stagingKey}`);
    expect(r2.objects.has(stagingKey)).toBe(true);
  });

  it.each([
    ['small', 2000],
    ['multipart', 11 * MiB],
  ])('refuses a sha256 mismatch (%s): nothing becomes visible, staging kept for the TTL sweep', async (_n, size) => {
    const bytes = randomBytes(size);
    const stagingKey = await stageBytes(bytes);
    const wrong = sha(randomBytes(8));
    await expectCode(provider.promoteStaged({ stagingKey, expectedSha256: wrong, resourceId: RES }), 'asset_sha256_mismatch');
    expect(r2.objects.has(r2AssetKeys.object(ORG, RES, wrong))).toBe(false);
    expect([...r2.objects.keys()].some((k) => k.includes('/obj/'))).toBe(false);
    expect(r2.openUploads.size).toBe(0);
    expect(r2.objects.has(stagingKey)).toBe(true);
  });

  it('dedupe: same content again re-verifies and rewrites the immutable key, refreshing its GC age (I-1)', async () => {
    const bytes = randomBytes(3000);
    const first = await promote(bytes);
    clock = new Date(clock.getTime() + 60_000);
    const stagingKey = await stageBytes(bytes);
    r2.calls.length = 0;
    const second = await provider.promoteStaged({ stagingKey, expectedSha256: sha(bytes), resourceId: RES });
    expect(second).toEqual(first);
    expect(r2.calls).toContain(`put ${first.objectKey}`);
    expect(r2.objects.get(first.objectKey)!.uploaded).toEqual(clock);
    expect(r2.objects.has(stagingKey)).toBe(false);
    // ...and still refuses wrong staged bytes even though the target exists.
    const other = await stageBytes(randomBytes(3000));
    await expectCode(provider.promoteStaged({ stagingKey: other, expectedSha256: sha(bytes), resourceId: RES }), 'asset_sha256_mismatch');
  });

  it('probe A (I-1): re-promoting an old unreachable object then writing a manifest keeps it through GC', async () => {
    const t0 = new Date(clock);
    const bytes = randomBytes(500);
    await promote(bytes); // X at t0, unreferenced
    clock = new Date(t0.getTime() + 60 * 60_000);
    const x = await promote(bytes); // dedupe path
    const m = await provider.writeManifest({
      resourceId: RES,
      parentManifestId: null,
      entries: [{ path: 'x.bin', sha256: x.sha256, size: x.size, mime: 'x/y', objectKey: x.objectKey }],
    });
    // Ledger has not recorded M yet: nothing reachable.
    const { deleted } = await provider.collectUnreachable({ reachable: new Set(), graceSeconds: 1800, now: clock.toISOString() });
    expect(deleted).toEqual([]);
    expect(r2.objects.has(x.objectKey)).toBe(true);
    expect(await provider.readManifest(m.manifestId)).toEqual(m);
  });

  it('writeManifest re-puts an existing manifest (fresh age) while keeping its first createdAt (I-1)', async () => {
    const x = await promote(randomBytes(50));
    const input = { resourceId: RES, parentManifestId: null, entries: [{ path: 'x', sha256: x.sha256, size: x.size, mime: 'x/y', objectKey: x.objectKey }] };
    const m1 = await provider.writeManifest(input);
    const t1 = new Date(clock.getTime() + 2 * 3600_000);
    clock = t1;
    const m2 = await provider.writeManifest(input);
    expect(m2).toEqual(m1);
    expect(r2.objects.get(r2AssetKeys.manifest(ORG, RES, m1.manifestId))!.uploaded).toEqual(t1);
    expect(r2.objects.get(r2AssetKeys.manifestIndex(ORG, m1.manifestId))!.uploaded).toEqual(t1);
  });

  it('retrying a completed promote returns the same result (I-3)', async () => {
    for (const size of [700, 11 * MiB]) {
      const bytes = randomBytes(size);
      const stagingKey = await stageBytes(bytes);
      const input = { stagingKey, expectedSha256: sha(bytes), resourceId: RES };
      const first = await provider.promoteStaged(input);
      expect(await provider.promoteStaged(input)).toEqual(first);
    }
    // A retry naming a sha whose object does not exist still fails.
    const bytes = randomBytes(10);
    const stagingKey = await stageBytes(bytes);
    await provider.promoteStaged({ stagingKey, expectedSha256: sha(bytes), resourceId: RES });
    await expectCode(provider.promoteStaged({ stagingKey, expectedSha256: sha(randomBytes(10)), resourceId: RES }), 'asset_staging_missing');
    // ...or that exists without verified sha256 metadata.
    const bare = randomBytes(10);
    r2.seed(r2AssetKeys.object(ORG, RES, sha(bare)), bare);
    await expectCode(provider.promoteStaged({ stagingKey, expectedSha256: sha(bare), resourceId: RES }), 'asset_staging_missing');
  });

  it('refuses when the immutable key claims a different sha256; rewrites one lacking metadata (M-4)', async () => {
    const bytes = randomBytes(100);
    const key = r2AssetKeys.object(ORG, RES, sha(bytes));
    r2.seed(key, randomBytes(100));
    r2.objects.get(key)!.customMetadata = { sha256: 'e'.repeat(64) };
    const stagingKey = await stageBytes(bytes);
    await expectCode(provider.promoteStaged({ stagingKey, expectedSha256: sha(bytes), resourceId: RES }), 'asset_object_conflict');
    // Same key, no metadata, wrong bytes (size differs): the verified staged bytes replace it.
    r2.seed(key, randomBytes(99));
    await provider.promoteStaged({ stagingKey, expectedSha256: sha(bytes), resourceId: RES });
    expect(sha(r2.objects.get(key)!.bytes)).toBe(sha(bytes));
    expect(r2.objects.get(key)!.customMetadata.sha256).toBe(sha(bytes));
  });

  it('verifies the size reported by multipart complete and removes a short object (M-3)', async () => {
    const bytes = randomBytes(11 * MiB);
    const stagingKey = await stageBytes(bytes);
    const orig = r2.createMultipartUpload.bind(r2);
    r2.createMultipartUpload = async (key, opts) => {
      const u = await orig(key, opts);
      return { ...u, key: u.key, uploadId: u.uploadId, uploadPart: u.uploadPart, abort: u.abort, complete: async (parts) => ({ ...(await u.complete(parts)), size: 1 }) };
    };
    await expectCode(provider.promoteStaged({ stagingKey, expectedSha256: sha(bytes), resourceId: RES }), 'asset_size_mismatch');
    expect(r2.objects.has(r2AssetKeys.object(ORG, RES, sha(bytes)))).toBe(false);
    expect(r2.objects.has(stagingKey)).toBe(true);
  });

  it('refuses missing staging, invalid sha and invalid resource', async () => {
    const { stagingKey } = await provider.stageUpload({ organizationId: ORG, taskWorkspaceId: WS, path: 'a', size: 1, mime: 'x/y' });
    const h = sha(new Uint8Array(1));
    await expectCode(provider.promoteStaged({ stagingKey, expectedSha256: h, resourceId: RES }), 'asset_staging_missing');
    await expectCode(provider.promoteStaged({ stagingKey: 'org/org1/staging/ws1/nope-0000', expectedSha256: h, resourceId: RES }), 'asset_staging_missing');
    await expectCode(provider.promoteStaged({ stagingKey, expectedSha256: h.toUpperCase(), resourceId: RES }), 'asset_invalid_input');
    await expectCode(provider.promoteStaged({ stagingKey, expectedSha256: h, resourceId: '../x' as ResourceId }), 'asset_invalid_input');
  });
});

describe('R2AssetProvider: adoptVerified', () => {
  const lfsKey = (id = 'lfs-0123456789abcdef01234567', org = ORG, res: string = RES) => `org/${org}/lfs/${res}/obj/${id}`;

  function seedLfs(bytes: Uint8Array, key = lfsKey()) {
    r2.seed(key, bytes);
    return { sourceKey: key, etag: r2.objects.get(key)!.etag };
  }

  const adopt = (bytes: Uint8Array, src: { sourceKey: string; etag: string }, extra: Partial<Parameters<R2AssetProvider['adoptVerified']>[0]> = {}) =>
    provider.adoptVerified({ ...src, sha256: sha(bytes), size: bytes.length, mime: 'video/mp4', resourceId: RES, ...extra });

  it('copies a verified LFS object into the content key with sha256 metadata and keeps the source', async () => {
    const bytes = randomBytes(4000);
    const src = seedLfs(bytes);
    const r = await adopt(bytes, src);
    expect(r).toEqual({ objectKey: `org/org1/res/brand/obj/${sha(bytes)}`, sha256: sha(bytes), size: 4000 });
    const obj = r2.objects.get(r.objectKey)!;
    expect(Buffer.from(obj.bytes).equals(bytes)).toBe(true);
    expect(obj.customMetadata.sha256).toBe(sha(bytes));
    expect(obj.httpMetadata.contentType).toBe('video/mp4');
    expect(r2.objects.has(src.sourceKey)).toBe(true);
  });

  it('a second call is a no-op: the content key already holds the verified bytes', async () => {
    const bytes = randomBytes(500);
    const src = seedLfs(bytes);
    const first = await adopt(bytes, src);
    r2.calls.length = 0;
    r2.objects.delete(src.sourceKey); // not even needed any more
    expect(await adopt(bytes, src)).toEqual(first);
    expect(r2.calls).toEqual([`head ${first.objectKey}`]);
  });

  it('dedupes against an object already promoted for the same resource', async () => {
    const bytes = randomBytes(700);
    const promoted = await promote(bytes);
    r2.calls.length = 0;
    expect(await adopt(bytes, seedLfs(bytes))).toEqual(promoted);
    expect(r2.calls.some((c) => c.startsWith('put ') || c.startsWith('get '))).toBe(false);
  });

  it('a changed etag or a missing source gives asset_staging_missing, with nothing written', async () => {
    const bytes = randomBytes(600);
    const src = seedLfs(bytes);
    await expectCode(adopt(bytes, { ...src, etag: 'not-the-etag' }), 'asset_staging_missing');
    expect(r2.calls).toContain(`get ${src.sourceKey}`);
    await expectCode(adopt(bytes, { sourceKey: lfsKey('lfs-missing0000000000'), etag: src.etag }), 'asset_staging_missing');
    expect([...r2.objects.keys()].some((k) => k.includes('/res/'))).toBe(false);
  });

  it.each([
    ['small', 2000],
    ['multipart', 11 * MiB],
  ])('altered bytes give asset_sha256_mismatch (%s), with nothing written', async (_n, size) => {
    const bytes = randomBytes(size);
    const src = seedLfs(randomBytes(size)); // same length, different content
    await expectCode(adopt(bytes, src), 'asset_sha256_mismatch');
    expect([...r2.objects.keys()].some((k) => k.includes('/res/'))).toBe(false);
    expect(r2.openUploads.size).toBe(0);
    expect(r2.objects.has(src.sourceKey)).toBe(true);
  });

  it('a source whose length differs from the declared size gives asset_size_mismatch', async () => {
    const bytes = randomBytes(100);
    await expectCode(adopt(bytes, seedLfs(bytes), { size: 99 }), 'asset_size_mismatch');
    expect([...r2.objects.keys()].some((k) => k.includes('/res/'))).toBe(false);
  });

  it('copies a multipart-sized object whole, through fixed-size parts', async () => {
    const bytes = randomBytes(11 * MiB + 321);
    const src = seedLfs(bytes);
    r2.chunkSize = 777_777;
    const r = await adopt(bytes, src);
    expect(r2.completedMultipart).toBe(1);
    expect(r.size).toBe(bytes.length);
    expect(sha(r2.objects.get(r.objectKey)!.bytes)).toBe(sha(bytes));
    expect(r2.objects.get(r.objectKey)!.customMetadata.sha256).toBe(sha(bytes));
  });

  it('refuses a content key that claims a different sha256 (asset_object_conflict)', async () => {
    const bytes = randomBytes(100);
    const key = r2AssetKeys.object(ORG, RES, sha(bytes));
    r2.seed(key, randomBytes(100));
    r2.objects.get(key)!.customMetadata = { sha256: 'e'.repeat(64) };
    await expectCode(adopt(bytes, seedLfs(bytes)), 'asset_object_conflict');
  });

  it('refuses a foreign org key, another resource, malformed keys and bad inputs (asset_invalid_input)', async () => {
    const bytes = randomBytes(10);
    const src = seedLfs(bytes);
    for (const sourceKey of [
      lfsKey(undefined, 'other'),
      lfsKey(undefined, ORG, 'otherres'),
      lfsKey('short'),
      lfsKey('lfs-../x0000000'),
      `org/${ORG}/staging/ws1/stage-0001`,
      `org/${ORG}/res/${RES}/obj/${sha(bytes)}`,
      `${lfsKey()}/extra`,
    ]) {
      await expectCode(adopt(bytes, { ...src, sourceKey }), 'asset_invalid_input');
    }
    await expectCode(adopt(bytes, src, { sha256: sha(bytes).toUpperCase() }), 'asset_invalid_input');
    await expectCode(adopt(bytes, src, { size: -1 }), 'asset_invalid_input');
    await expectCode(adopt(bytes, src, { mime: '' }), 'asset_invalid_input');
    await expectCode(adopt(bytes, src, { etag: '' }), 'asset_invalid_input');
    await expectCode(adopt(bytes, src, { resourceId: '../x' as ResourceId }), 'asset_invalid_input');
    expect([...r2.objects.keys()].some((k) => k.includes('/res/'))).toBe(false);
  });
});

describe('R2AssetProvider: manifests', () => {
  async function entry(path: string, bytes = randomBytes(64)): Promise<AssetManifestEntry> {
    const r = await promote(bytes, path);
    return { path, sha256: r.sha256, size: r.size, mime: 'application/octet-stream', objectKey: r.objectKey };
  }

  it('writeManifest id = computeAssetManifestId (sha256 of canonical JSON); stored at res/<id>/manifest/<id>.json', async () => {
    const entries = [await entry('b.bin'), await entry('a.bin')];
    const input = { resourceId: RES, parentManifestId: null, entries };
    const m = await provider.writeManifest(input);
    expect(m.manifestId).toBe(await computeAssetManifestId(input));
    expect(m.entries.map((e) => e.path)).toEqual(['a.bin', 'b.bin']);
    expect(m.createdAt).toBe(clock.toISOString());
    expect(r2.objects.has(`org/org1/res/brand/manifest/${m.manifestId}.json`)).toBe(true);
    expect(await provider.readManifest(m.manifestId)).toEqual(m);
    expect(await provider.readManifest(m.manifestId, RES)).toEqual(m);
    expect(await provider.readManifest('0'.repeat(64))).toBeNull();
  });

  it('is idempotent (keeps the first createdAt) and supports a parent chain', async () => {
    const e1 = await entry('a.bin');
    const m1 = await provider.writeManifest({ resourceId: RES, parentManifestId: null, entries: [e1] });
    clock = new Date(clock.getTime() + 1000);
    expect(await provider.writeManifest({ resourceId: RES, parentManifestId: null, entries: [e1] })).toEqual(m1);
    const m2 = await provider.writeManifest({ resourceId: RES, parentManifestId: m1.manifestId, entries: [e1, await entry('c.bin')] });
    expect(m2.parentManifestId).toBe(m1.manifestId);
    await expectCode(provider.writeManifest({ resourceId: RES, parentManifestId: 'f'.repeat(64) as ManifestId, entries: [] }), 'asset_manifest_parent_missing');
  });

  it('refuses entries pointing outside this org/resource, missing objects, size mismatches and duplicates', async () => {
    const e = await entry('a.bin');
    const other = { ...e, objectKey: `org/org1/res/other/obj/${e.sha256}` };
    await expectCode(provider.writeManifest({ resourceId: RES, parentManifestId: null, entries: [other] }), 'asset_invalid_input');
    const ghost = 'a'.repeat(64);
    await expectCode(
      provider.writeManifest({ resourceId: RES, parentManifestId: null, entries: [{ ...e, path: 'g', sha256: ghost, objectKey: r2AssetKeys.object(ORG, RES, ghost) }] }),
      'asset_object_missing',
    );
    await expectCode(provider.writeManifest({ resourceId: RES, parentManifestId: null, entries: [{ ...e, size: e.size + 1 }] }), 'asset_size_mismatch');
    await expectCode(provider.writeManifest({ resourceId: RES, parentManifestId: null, entries: [e, { ...e }] }), 'asset_invalid_input');
  });

  it('readManifest verifies the id on read', async () => {
    const m = await provider.writeManifest({ resourceId: RES, parentManifestId: null, entries: [await entry('a.bin')] });
    const key = r2AssetKeys.manifest(ORG, RES, m.manifestId);
    const tampered = { ...m, entries: [{ ...m.entries[0]!, mime: 'text/html' }] };
    r2.seed(key, JSON.stringify(tampered));
    await expectCode(provider.readManifest(m.manifestId), 'asset_manifest_corrupt');
    r2.seed(key, '{not json');
    await expectCode(provider.readManifest(m.manifestId), 'asset_manifest_corrupt');
  });
});

describe('R2AssetProvider: objectUrl', () => {
  const grant = (over: Partial<ReadGrant> = {}): ReadGrant => ({
    principal: { kind: 'user', id: 'u1' },
    organizationId: ORG,
    resourceId: RES,
    purpose: 'preview',
    expiresAt: '2026-10-06T13:00:00.000Z',
    ...over,
  });

  it('returns a Worker-served path with a short-lived HMAC token scoped to the key', async () => {
    const key = r2AssetKeys.object(ORG, RES, 'a'.repeat(64));
    const url = await provider.objectUrl(key, grant(), 300);
    expect(url.startsWith(`/v1/assets/${key}?token=`)).toBe(true);
    const token = decodeURIComponent(url.split('token=')[1]!);
    const p = await verifyAssetToken({ token, key: KEY, now: clock, objectKey: key, op: 'get' });
    expect(p).toMatchObject({ org: ORG, res: RES, sub: 'user:u1', pur: 'preview', exp: clock.getTime() / 1000 + 300 });
    await expect(verifyAssetToken({ token, key: KEY, now: new Date(clock.getTime() + 300_000), objectKey: key, op: 'get' })).rejects.toMatchObject({ code: 'asset_token_expired' });
    await expect(verifyAssetToken({ token, key: KEY, now: clock, objectKey: `${key}x`, op: 'get' })).rejects.toMatchObject({ code: 'asset_token_scope' });
    await expect(verifyAssetToken({ token, key: KEY, now: clock, objectKey: key, op: 'put' })).rejects.toMatchObject({ code: 'asset_token_scope' });
    await expect(verifyAssetToken({ token, key: new Uint8Array(32).fill(8), now: clock, objectKey: key, op: 'get' })).rejects.toMatchObject({ code: 'asset_token_invalid' });
    await expect(verifyAssetToken({ token, key: KEY, now: clock, objectKey: key, op: 'get', organizationId: 'org2' })).rejects.toMatchObject({ code: 'asset_token_scope' });
    const [v, body, sig] = token.split('.');
    await expect(verifyAssetToken({ token: `${v}.${body}x.${sig}`, key: KEY, now: clock, objectKey: key, op: 'get' })).rejects.toMatchObject({ code: 'asset_token_invalid' });
  });

  it('clamps expiry to the grant and refuses mismatched or expired grants and bad TTLs', async () => {
    const key = r2AssetKeys.object(ORG, RES, 'a'.repeat(64));
    const url = await provider.objectUrl(key, grant({ expiresAt: '2026-10-06T12:01:00.000Z' }), 3600);
    const p = await verifyAssetToken({ token: decodeURIComponent(url.split('token=')[1]!), key: KEY, now: clock, objectKey: key, op: 'get' });
    expect(p.exp).toBe(Date.parse('2026-10-06T12:01:00.000Z') / 1000);
    await expectCode(provider.objectUrl(key, grant({ resourceId: 'other' as ResourceId }), 60), 'asset_grant_denied');
    await expectCode(provider.objectUrl(key, grant({ organizationId: 'org2' }), 60), 'asset_grant_denied');
    await expectCode(provider.objectUrl(key, grant({ expiresAt: '2026-10-06T11:00:00.000Z' }), 60), 'asset_grant_denied');
    await expectCode(provider.objectUrl(key, grant(), 0), 'asset_invalid_input');
    await expectCode(provider.objectUrl(key, grant(), 3601), 'asset_invalid_input');
    await expectCode(provider.objectUrl('org/org1/staging/ws1/stage-0001', grant(), 60), 'asset_invalid_input');
    await expectCode(provider.objectUrl(r2AssetKeys.object('org2', RES, 'a'.repeat(64)), grant(), 60), 'asset_grant_denied');
  });
});

describe('R2AssetProvider: collectUnreachable', () => {
  it('deletes only unreachable immutable/manifest keys older than grace, and staging older than the TTL', async () => {
    r2.listPageSize = 2; // exercise pagination
    const t0 = new Date(clock);
    // Old objects/manifests (t0).
    const keepBytes = randomBytes(10);
    const dropBytes = randomBytes(11);
    const keep = await promote(keepBytes, 'keep.bin');
    const drop = await promote(dropBytes, 'drop.bin');
    const mKeep = await provider.writeManifest({
      resourceId: RES,
      parentManifestId: null,
      entries: [{ path: 'keep.bin', sha256: keep.sha256, size: keep.size, mime: 'x/y', objectKey: keep.objectKey }],
    });
    const mDrop = await provider.writeManifest({
      resourceId: RES,
      parentManifestId: null,
      entries: [{ path: 'drop.bin', sha256: drop.sha256, size: drop.size, mime: 'x/y', objectKey: drop.objectKey }],
    });
    const oldStaging = await stageBytes(randomBytes(5));
    // Young (t0 + 50 min): unreachable but inside grace; young staging inside TTL.
    clock = new Date(t0.getTime() + 50 * 60_000);
    const young = await promote(randomBytes(12), 'young.bin');
    const youngStaging = await stageBytes(randomBytes(6));
    const unknownKey = 'org/org1/res/brand/something-else';
    r2.seed(unknownKey, 'x', t0);
    r2.seed(`org/org2/res/brand/obj/${'b'.repeat(64)}`, 'x', t0);
    r2.seed('org/org10/staging/ws/old-old-old', 'x', t0);

    clock = new Date(t0.getTime() + 61 * 60_000);
    const reachable = reachableFromManifests([mKeep]);
    const { deleted } = await provider.collectUnreachable({ reachable, graceSeconds: 30 * 60, now: clock.toISOString() });
    expect(new Set(deleted)).toEqual(
      new Set([
        drop.objectKey,
        r2AssetKeys.manifest(ORG, RES, mDrop.manifestId),
        r2AssetKeys.manifestIndex(ORG, mDrop.manifestId),
        oldStaging,
        `${oldStaging}.intent.json`,
      ]),
    );
    for (const k of deleted) expect(r2.objects.has(k)).toBe(false);
    for (const k of [
      keep.objectKey,
      r2AssetKeys.manifest(ORG, RES, mKeep.manifestId),
      r2AssetKeys.manifestIndex(ORG, mKeep.manifestId),
      young.objectKey,
      youngStaging,
      `${youngStaging}.intent.json`,
      unknownKey,
      `org/org2/res/brand/obj/${'b'.repeat(64)}`,
      'org/org10/staging/ws/old-old-old',
    ]) {
      expect(r2.objects.has(k), k).toBe(true);
    }
    expect(await provider.readManifest(mKeep.manifestId)).toEqual(mKeep);
    expect(await provider.readManifest(mDrop.manifestId)).toBeNull();
  });

  it('probe B (I-2): reachable manifest ids alone protect their entries\' objects', async () => {
    const y = await promote(randomBytes(40), 'y.bin');
    const z = await promote(randomBytes(41), 'z.bin');
    const my = await provider.writeManifest({
      resourceId: RES,
      parentManifestId: null,
      entries: [{ path: 'y.bin', sha256: y.sha256, size: y.size, mime: 'x/y', objectKey: y.objectKey }],
    });
    const now = new Date(clock.getTime() + 2 * 3600_000).toISOString();
    const { deleted } = await provider.collectUnreachable({ reachable: new Set([my.manifestId]), graceSeconds: 1800, now });
    expect(deleted).toEqual([z.objectKey]);
    expect(r2.objects.has(y.objectKey)).toBe(true);
  });

  it('young unreachable manifests protect their (old) objects', async () => {
    const y = await promote(randomBytes(40), 'y.bin');
    clock = new Date(clock.getTime() + 2 * 3600_000);
    await provider.writeManifest({
      resourceId: RES,
      parentManifestId: null,
      entries: [{ path: 'y.bin', sha256: y.sha256, size: y.size, mime: 'x/y', objectKey: y.objectKey }],
    });
    const { deleted } = await provider.collectUnreachable({ reachable: new Set(), graceSeconds: 1800, now: clock.toISOString() });
    expect(deleted).toEqual([]);
  });

  it('aborts and deletes nothing when a reachable manifest is missing or a kept manifest is corrupt (I-2)', async () => {
    const y = await promote(randomBytes(40), 'y.bin');
    const drop = await promote(randomBytes(41), 'd.bin');
    const my = await provider.writeManifest({
      resourceId: RES,
      parentManifestId: null,
      entries: [{ path: 'y.bin', sha256: y.sha256, size: y.size, mime: 'x/y', objectKey: y.objectKey }],
    });
    const now = new Date(clock.getTime() + 2 * 3600_000).toISOString();
    const before = new Set(r2.objects.keys());
    await expectCode(provider.collectUnreachable({ reachable: new Set([my.manifestId, 'c'.repeat(64)]), graceSeconds: 1800, now }), 'asset_gc_unsafe');
    r2.seed(r2AssetKeys.manifest(ORG, RES, my.manifestId), '{"corrupt":true}', clock);
    await expectCode(provider.collectUnreachable({ reachable: new Set([my.manifestId]), graceSeconds: 1800, now }), 'asset_gc_unsafe');
    expect(new Set(r2.objects.keys())).toEqual(before);
    expect(r2.objects.has(drop.objectKey)).toBe(true);
  });

  it('a manifest written during the run (after the inventory) protects its old objects (Task 13 re-review race)', async () => {
    const y = await promote(randomBytes(40), 'y.bin'); // old and unreferenced
    const z = await promote(randomBytes(41), 'z.bin'); // old and unreferenced: still collected
    const runStart = new Date(clock.getTime() + 2 * 3600_000);
    clock = runStart;
    let written: string | null = null;
    const list = r2.list.bind(r2);
    r2.list = async (opts) => {
      // the first listing after the res/ inventory: a dedupe-style manifest lands on y mid-run
      if (written === null && opts?.prefix === `org/${ORG}/manifest-index/`) {
        clock = new Date(runStart.getTime() + 1000);
        const m = await provider.writeManifest({
          resourceId: RES,
          parentManifestId: null,
          entries: [{ path: 'y.bin', sha256: y.sha256, size: y.size, mime: 'x/y', objectKey: y.objectKey }],
        });
        written = m.manifestId;
      }
      return list(opts);
    };
    const { deleted } = await provider.collectUnreachable({ reachable: new Set(), graceSeconds: 1800, now: runStart.toISOString() });
    expect(written).not.toBeNull();
    expect(deleted).toEqual([z.objectKey]);
    expect(r2.objects.has(y.objectKey)).toBe(true);
    expect(await provider.readManifest(written!)).not.toBeNull();
  });

  it('accepts manifest keys in reachable and validates inputs', async () => {
    const e = await promote(randomBytes(10), 'a.bin');
    const m = await provider.writeManifest({
      resourceId: RES,
      parentManifestId: null,
      entries: [{ path: 'a.bin', sha256: e.sha256, size: e.size, mime: 'x/y', objectKey: e.objectKey }],
    });
    const now = new Date(clock.getTime() + 1e7).toISOString();
    const r = await provider.collectUnreachable({ reachable: new Set([r2AssetKeys.manifest(ORG, RES, m.manifestId), e.objectKey]), graceSeconds: 0, now });
    expect(r.deleted).toEqual([]);
    await expectCode(provider.collectUnreachable({ reachable: new Set(), graceSeconds: -1, now }), 'asset_invalid_input');
    await expectCode(provider.collectUnreachable({ reachable: new Set(), graceSeconds: 0, now: 'yesterday' }), 'asset_invalid_input');
  });
});

describe('R2AssetProvider: misc', () => {
  it('reports r2-assets capabilities and rejects bad options', () => {
    expect(provider.capabilities()).toMatchObject({ kind: 'r2-assets', binaryAssets: true, gitTransport: false });
    expect(() => makeProvider({ partSize: 1024 })).toThrow(R2AssetError);
    expect(() => makeProvider({ organizationId: 'a/b' })).toThrow(R2AssetError);
  });
});
