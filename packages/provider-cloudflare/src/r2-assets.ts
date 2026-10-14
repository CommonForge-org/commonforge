/**
 * `R2AssetProvider` (plan §A.7, §B.11, §I Q5): content-addressed binary assets in R2.
 *
 * Key layout (one provider instance is scoped to one organization):
 * - staging:   `org/<orgId>/staging/<taskWorkspaceId>/<uploadId>` (+ `<...>.intent.json` sidecar)
 * - immutable: `org/<orgId>/res/<resourceId>/obj/<sha256>`
 * - manifest:  `org/<orgId>/res/<resourceId>/manifest/<manifestId>.json`
 * - id index:  `org/<orgId>/manifest-index/<manifestId>` → `{ resourceId }` (lets `readManifest(id)`
 *   find a manifest without a resource id; the B.11 signature carries none)
 * - LFS source: `org/<orgId>/lfs/<resourceId>/obj/<stagingId>`, written and verified by the Worker's
 *   upload routes; this provider only reads it (`adoptVerified`), never writes or deletes it.
 *
 * `stageUpload` has no `resourceId` (B.11), so staging keys are per task workspace and the resource
 * is chosen at `promoteStaged`. The provider never decides authorization or reachability: `objectUrl`
 * takes a caller-checked `ReadGrant` and `collectUnreachable` takes a caller-computed `reachable` set.
 *
 * Works in a Worker over the `R2Bucket` binding and in Node over any {@link R2PortBucket}.
 */
import {
  AssetManifestSchema,
  CoreError,
  DEFAULT_CAPABILITIES,
  IdSegmentSchema,
  ReadGrantSchema,
  ResourceIdSchema,
  SHA256_HEX_RE,
  TaskWorkspaceIdSchema,
  computeAssetManifestId,
  canonicalAssetManifestPayload,
  normalizePath,
  type AssetManifest,
  type AssetProvider,
  type ManifestId,
  type ProviderCapabilities,
  type ReadGrant,
  type ResourceId,
  type TaskWorkspaceId,
} from '@commonforge-org/core';
import { Sha256 } from './r2-assets-sha256.js';
import { signAssetToken, type AssetSigningKey } from './r2-assets-token.js';
import {
  R2_MAX_DELETE_KEYS,
  R2_MAX_PARTS,
  R2_MIN_PART_BYTES,
  type R2PortBucket,
  type R2PortObject,
  type R2PortReader,
  type R2PortStream,
  type R2PortUploadedPart,
} from './r2-port.js';

export type R2AssetErrorCode =
  | 'asset_invalid_input'
  | 'asset_wrong_organization'
  | 'asset_staging_missing'
  | 'asset_size_mismatch'
  | 'asset_sha256_mismatch'
  | 'asset_object_missing'
  | 'asset_object_conflict'
  | 'asset_manifest_parent_missing'
  | 'asset_manifest_corrupt'
  | 'asset_grant_denied'
  | 'asset_gc_unsafe';

export class R2AssetError extends CoreError<R2AssetErrorCode> {
  constructor(code: R2AssetErrorCode, message?: string, details?: Record<string, unknown>) {
    super(code, message, details);
    this.name = 'R2AssetError';
  }
}

export interface R2AssetProviderOptions {
  bucket: R2PortBucket;
  /** Every key this instance reads, writes or collects lives under `org/<organizationId>/`. */
  organizationId: string;
  /** HMAC key for `objectUrl`/`uploadUrl` tokens (verify with `verifyAssetToken`). */
  signingKey: AssetSigningKey;
  /** Worker route prefix serving `<urlBase>/<objectKey>?token=…`. Default `/v1/assets`. */
  urlBase?: string;
  /** Staging objects older than this are swept by `collectUnreachable`. Default 86 400 s. */
  stagingTtlSeconds?: number;
  /** Multipart part size (>= 5 MiB, R2 minimum). Objects at or below it use a single put. Default 8 MiB. */
  partSize?: number;
  /** Upper bound for `objectUrl` / upload-token TTLs. Default 3 600 s. */
  maxUrlTtlSeconds?: number;
  /** When true, `stageUpload` returns a signed Worker `uploadUrl`. Default true. */
  issueUploadUrls?: boolean;
  now?: () => Date;
  /** Random staging id; must match `[A-Za-z0-9_-]{8,128}`. Default `crypto.randomUUID()`. */
  randomId?: () => string;
}

/** Contents of the `<stagingKey>.intent.json` sidecar written by `stageUpload`. */
export interface StagingIntent {
  v: 1;
  organizationId: string;
  taskWorkspaceId: string;
  path: string;
  size: number;
  mime: string;
  createdAt: string;
}

/** Bytes source accepted by `putStaged`. */
export type StagedBody = Uint8Array | R2PortStream;

const MiB = 1024 * 1024;
const STAGING_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
const INTENT_SUFFIX = '.intent.json';
const dec = new TextDecoder();

function parseOrThrow<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { message: string } } }, value: unknown, label: string): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new R2AssetError('asset_invalid_input', `${label}: ${r.error.message}`);
  return r.data;
}

function bytesReader(bytes: Uint8Array): R2PortReader {
  let done = false;
  return {
    read: async () => {
      if (done || bytes.length === 0) {
        done = true;
        return { done: true };
      }
      done = true;
      return { done: false, value: bytes };
    },
    releaseLock: () => {},
    cancel: async () => {
      done = true;
    },
  };
}

/** Pure key helpers (exported for the Worker route and the consuming app). */
export const r2AssetKeys = {
  orgPrefix: (org: string) => `org/${org}/`,
  resourcePrefix: (org: string, res: string) => `org/${org}/res/${res}/`,
  object: (org: string, res: string, sha256: string) => `org/${org}/res/${res}/obj/${sha256}`,
  manifest: (org: string, res: string, manifestId: string) => `org/${org}/res/${res}/manifest/${manifestId}.json`,
  manifestIndex: (org: string, manifestId: string) => `org/${org}/manifest-index/${manifestId}`,
  lfsObject: (org: string, res: string, stagingId: string) => `org/${org}/lfs/${res}/obj/${stagingId}`,
  stagingPrefix: (org: string) => `org/${org}/staging/`,
  staging: (org: string, ws: string, id: string) => `org/${org}/staging/${ws}/${id}`,
  intent: (stagingKey: string) => `${stagingKey}${INTENT_SUFFIX}`,
};

const SEG = '([^/]+)';
const OBJECT_KEY_RE = new RegExp(`^org/${SEG}/res/${SEG}/obj/([0-9a-f]{64})$`);
const MANIFEST_KEY_RE = new RegExp(`^org/${SEG}/res/${SEG}/manifest/([0-9a-f]{64})\\.json$`);
const STAGING_KEY_RE = new RegExp(`^org/${SEG}/staging/${SEG}/([A-Za-z0-9_-]{8,128})$`);
const LFS_OBJECT_KEY_RE = new RegExp(`^org/${SEG}/lfs/${SEG}/obj/([A-Za-z0-9_-]{8,128})$`);

/** Parsed immutable object or manifest key, or null for anything else. */
export function parseAssetKey(
  key: string,
): { kind: 'object'; org: string; resourceId: string; sha256: string } | { kind: 'manifest'; org: string; resourceId: string; manifestId: string } | null {
  let m = OBJECT_KEY_RE.exec(key);
  if (m) return { kind: 'object', org: m[1]!, resourceId: m[2]!, sha256: m[3]! };
  m = MANIFEST_KEY_RE.exec(key);
  if (m) return { kind: 'manifest', org: m[1]!, resourceId: m[2]!, manifestId: m[3]! };
  return null;
}

/**
 * Convenience for the consuming app: the `reachable` set for `collectUnreachable` covering the given
 * manifests (their ids and every entry's object key). The app decides which manifests to pass.
 */
export function reachableFromManifests(manifests: Iterable<Pick<AssetManifest, 'manifestId' | 'entries'>>): Set<string> {
  const out = new Set<string>();
  for (const m of manifests) {
    out.add(m.manifestId);
    for (const e of m.entries) out.add(e.objectKey);
  }
  return out;
}

export class R2AssetProvider implements AssetProvider {
  readonly organizationId: string;
  private readonly bucket: R2PortBucket;
  private readonly signingKey: AssetSigningKey;
  private readonly urlBase: string;
  private readonly stagingTtlSeconds: number;
  private readonly partSize: number;
  private readonly maxUrlTtlSeconds: number;
  private readonly issueUploadUrls: boolean;
  private readonly now: () => Date;
  private readonly randomId: () => string;

  constructor(opts: R2AssetProviderOptions) {
    this.bucket = opts.bucket;
    this.organizationId = parseOrThrow(IdSegmentSchema, opts.organizationId, 'organizationId');
    this.signingKey = opts.signingKey;
    this.urlBase = (opts.urlBase ?? '/v1/assets').replace(/\/+$/, '');
    this.stagingTtlSeconds = opts.stagingTtlSeconds ?? 86_400;
    this.partSize = opts.partSize ?? 8 * MiB;
    this.maxUrlTtlSeconds = opts.maxUrlTtlSeconds ?? 3600;
    this.issueUploadUrls = opts.issueUploadUrls ?? true;
    this.now = opts.now ?? (() => new Date());
    this.randomId = opts.randomId ?? (() => crypto.randomUUID());
    if (!Number.isInteger(this.partSize) || this.partSize < R2_MIN_PART_BYTES) {
      throw new R2AssetError('asset_invalid_input', `partSize must be an integer >= ${R2_MIN_PART_BYTES}`);
    }
    if (!(this.stagingTtlSeconds > 0) || !(this.maxUrlTtlSeconds > 0)) {
      throw new R2AssetError('asset_invalid_input', 'stagingTtlSeconds and maxUrlTtlSeconds must be > 0');
    }
  }

  capabilities(): ProviderCapabilities {
    return { ...DEFAULT_CAPABILITIES['r2-assets'] };
  }

  // -------------------------------------------------------------------------------------------
  // Staging
  // -------------------------------------------------------------------------------------------

  async stageUpload(input: {
    organizationId: string;
    taskWorkspaceId: TaskWorkspaceId;
    path: string;
    size: number;
    mime: string;
  }): Promise<{ stagingKey: string; uploadUrl?: string }> {
    this.assertOrg(input.organizationId);
    const ws = parseOrThrow(TaskWorkspaceIdSchema, input.taskWorkspaceId, 'taskWorkspaceId');
    let path: string;
    try {
      path = normalizePath(input.path);
    } catch (e) {
      throw new R2AssetError('asset_invalid_input', `path: ${(e as Error).message}`);
    }
    if (!Number.isSafeInteger(input.size) || input.size < 0) throw new R2AssetError('asset_invalid_input', 'size must be a non-negative integer');
    if (input.size > this.partSize * R2_MAX_PARTS) throw new R2AssetError('asset_invalid_input', 'size exceeds partSize * 10000');
    if (typeof input.mime !== 'string' || input.mime.length < 1 || input.mime.length > 255) {
      throw new R2AssetError('asset_invalid_input', 'mime must be 1..255 chars');
    }
    const id = this.randomId();
    if (!STAGING_ID_RE.test(id)) throw new R2AssetError('asset_invalid_input', 'randomId produced an invalid staging id');
    const stagingKey = r2AssetKeys.staging(this.organizationId, ws, id);
    const now = this.now();
    const intent: StagingIntent = {
      v: 1,
      organizationId: this.organizationId,
      taskWorkspaceId: ws,
      path,
      size: input.size,
      mime: input.mime,
      createdAt: now.toISOString(),
    };
    await this.bucket.put(r2AssetKeys.intent(stagingKey), JSON.stringify(intent), {
      httpMetadata: { contentType: 'application/json' },
    });
    if (!this.issueUploadUrls) return { stagingKey };
    const exp = Math.floor(now.getTime() / 1000) + Math.min(this.stagingTtlSeconds, this.maxUrlTtlSeconds);
    const token = await signAssetToken({ v: 1, k: stagingKey, op: 'put', org: this.organizationId, exp }, this.signingKey);
    return { stagingKey, uploadUrl: this.url(stagingKey, token) };
  }

  /**
   * Write the bytes of a staged upload (the Worker upload route, intake, or a Node caller). Uses a
   * multipart upload when the declared size exceeds `partSize`. Refuses bodies whose length differs
   * from the size declared at `stageUpload`.
   */
  async putStaged(stagingKey: string, body: StagedBody): Promise<{ size: number }> {
    this.parseStagingKey(stagingKey);
    const intent = await this.readIntent(stagingKey);
    const reader = body instanceof Uint8Array ? bytesReader(body) : body.getReader();
    await this.pipe(reader, {
      key: stagingKey,
      size: intent.size,
      httpMetadata: { contentType: intent.mime },
    });
    return { size: intent.size };
  }

  // -------------------------------------------------------------------------------------------
  // Promotion
  // -------------------------------------------------------------------------------------------

  async promoteStaged(input: {
    stagingKey: string;
    expectedSha256: string;
    resourceId: ResourceId;
  }): Promise<{ objectKey: string; sha256: string; size: number }> {
    this.parseStagingKey(input.stagingKey);
    const resourceId = parseOrThrow(ResourceIdSchema, input.resourceId, 'resourceId');
    const expected = input.expectedSha256;
    if (typeof expected !== 'string' || !SHA256_HEX_RE.test(expected)) {
      throw new R2AssetError('asset_invalid_input', 'expectedSha256 must be lowercase sha256 hex');
    }
    const objectKey = r2AssetKeys.object(this.organizationId, resourceId, expected);
    const intent = await this.tryReadIntent(input.stagingKey);
    // HEAD-verify the staged length against the declared size before reading any bytes.
    const head = intent ? await this.bucket.head(input.stagingKey) : null;
    if (!intent || !head) return this.promotedAlready(input.stagingKey, objectKey, expected);
    if (head.size !== intent.size) {
      throw new R2AssetError('asset_size_mismatch', `staged ${head.size} bytes, declared ${intent.size}`, {
        staged: head.size,
        declared: intent.size,
      });
    }
    const existing = await this.bucket.head(objectKey);
    if (existing) this.assertImmutableMatches(existing, expected);

    const staged = await this.bucket.get(input.stagingKey);
    if (!staged) return this.promotedAlready(input.stagingKey, objectKey, expected);
    const hasher = new Sha256();
    // Always (re)write the verified bytes, even when the immutable key already exists (dedupe): the
    // fresh `uploaded` restarts the GC grace window for an object that may have been unreachable
    // for longer than the grace period, and it repairs an object lacking sha256 metadata.
    await this.pipe(staged.body.getReader(), {
      key: objectKey,
      size: intent.size,
      httpMetadata: { contentType: intent.mime },
      customMetadata: { sha256: expected },
      sha256: expected,
      onChunk: (c) => hasher.update(c),
      beforeCommit: () => {
        const actual = hasher.digestHex();
        if (actual !== expected) {
          throw new R2AssetError('asset_sha256_mismatch', `expected ${expected}, staged bytes hash to ${actual}`, {
            expected,
            actual,
          });
        }
      },
    });
    await this.deleteKeys([input.stagingKey, r2AssetKeys.intent(input.stagingKey)]);
    return { objectKey, sha256: expected, size: intent.size };
  }

  /**
   * Retry / lost-response path: the staging upload is gone. Succeed iff the immutable object for the
   * requested sha exists and was written by a verified promote (its sha256 metadata matches).
   */
  private async promotedAlready(
    stagingKey: string,
    objectKey: string,
    expected: string,
  ): Promise<{ objectKey: string; sha256: string; size: number }> {
    const h = await this.bucket.head(objectKey);
    if (h && h.customMetadata?.sha256 === expected) return { objectKey, sha256: expected, size: h.size };
    throw new R2AssetError('asset_staging_missing', stagingKey);
  }

  /**
   * Copy a verified upload that lives outside the provider's staging area (an LFS-staged object at
   * `org/<org>/lfs/<resourceId>/obj/<id>`) into the resource's content key `res/<rid>/obj/<sha256>`.
   *
   * - Already done (idempotent, dedupe): the content key exists with matching sha256 metadata.
   * - Otherwise the source is read only if its etag still matches (a missing or changed source is
   *   `asset_staging_missing`) and piped to the content key, hashing as it goes; a different hash is
   *   `asset_sha256_mismatch` and nothing becomes visible.
   * - The source is never deleted: the caller owns it and deletes it once nothing references it.
   */
  async adoptVerified(input: {
    sourceKey: string;
    etag: string;
    sha256: string;
    size: number;
    mime: string;
    resourceId: ResourceId;
  }): Promise<{ objectKey: string; sha256: string; size: number }> {
    const resourceId = parseOrThrow(ResourceIdSchema, input.resourceId, 'resourceId');
    const m = typeof input.sourceKey === 'string' ? LFS_OBJECT_KEY_RE.exec(input.sourceKey) : null;
    if (!m || m[1] !== this.organizationId || m[2] !== resourceId) {
      throw new R2AssetError('asset_invalid_input', `not an LFS object key of ${this.organizationId}/${resourceId}: ${String(input.sourceKey)}`);
    }
    const expected = input.sha256;
    if (typeof expected !== 'string' || !SHA256_HEX_RE.test(expected)) {
      throw new R2AssetError('asset_invalid_input', 'sha256 must be lowercase sha256 hex');
    }
    if (!Number.isSafeInteger(input.size) || input.size < 0) throw new R2AssetError('asset_invalid_input', 'size must be a non-negative integer');
    if (input.size > this.partSize * R2_MAX_PARTS) throw new R2AssetError('asset_invalid_input', 'size exceeds partSize * 10000');
    if (typeof input.mime !== 'string' || input.mime.length < 1 || input.mime.length > 255) {
      throw new R2AssetError('asset_invalid_input', 'mime must be 1..255 chars');
    }
    const etag = typeof input.etag === 'string' ? unquoteEtag(input.etag) : '';
    if (etag.length === 0) throw new R2AssetError('asset_invalid_input', 'etag must be a non-empty string');

    const objectKey = r2AssetKeys.object(this.organizationId, resourceId, expected);
    const existing = await this.bucket.head(objectKey);
    if (existing && existing.customMetadata?.sha256 === expected) {
      if (existing.size !== input.size) {
        throw new R2AssetError('asset_object_conflict', `immutable ${objectKey} has ${existing.size} bytes, expected ${input.size}`);
      }
      return { objectKey, sha256: expected, size: existing.size };
    }
    if (existing) this.assertImmutableMatches(existing, expected);

    const src = await this.bucket.get(input.sourceKey, { onlyIf: { etagMatches: etag } });
    // A failed precondition resolves to metadata without a body; ports that ignore `onlyIf` are
    // caught by comparing the etag of what was actually returned.
    if (!src || !('body' in src) || unquoteEtag(src.etag) !== etag) {
      if (src && 'body' in src) await src.body.getReader().cancel().catch(() => {});
      throw new R2AssetError('asset_staging_missing', `${input.sourceKey} is missing or changed`);
    }
    if (src.size !== input.size) {
      await src.body.getReader().cancel().catch(() => {});
      throw new R2AssetError('asset_size_mismatch', `source has ${src.size} bytes, expected ${input.size}`, {
        source: src.size,
        expected: input.size,
      });
    }
    const hasher = new Sha256();
    await this.pipe(src.body.getReader(), {
      key: objectKey,
      size: input.size,
      httpMetadata: { contentType: input.mime },
      customMetadata: { sha256: expected },
      sha256: expected,
      onChunk: (c) => hasher.update(c),
      beforeCommit: () => {
        const actual = hasher.digestHex();
        if (actual !== expected) {
          throw new R2AssetError('asset_sha256_mismatch', `expected ${expected}, source bytes hash to ${actual}`, { expected, actual });
        }
      },
    });
    return { objectKey, sha256: expected, size: input.size };
  }

  // -------------------------------------------------------------------------------------------
  // Manifests
  // -------------------------------------------------------------------------------------------

  async writeManifest(m: Omit<AssetManifest, 'manifestId' | 'createdAt'>): Promise<AssetManifest> {
    const resourceId = parseOrThrow(ResourceIdSchema, m.resourceId, 'resourceId');
    let payload: ReturnType<typeof canonicalAssetManifestPayload>;
    let manifestId: ManifestId;
    try {
      payload = canonicalAssetManifestPayload(m);
      manifestId = await computeAssetManifestId(m);
    } catch (e) {
      throw new R2AssetError('asset_invalid_input', (e as Error).message);
    }
    if (m.parentManifestId !== null) {
      if (!SHA256_HEX_RE.test(m.parentManifestId)) throw new R2AssetError('asset_invalid_input', 'parentManifestId');
      const parent = await this.bucket.head(r2AssetKeys.manifest(this.organizationId, resourceId, m.parentManifestId));
      if (!parent) throw new R2AssetError('asset_manifest_parent_missing', m.parentManifestId);
    }
    // Every entry must point at this org+resource's immutable key for its sha, and that object must
    // exist with the declared size (manifests only ever reference promoted bytes).
    for (const e of payload.entries) {
      const want = r2AssetKeys.object(this.organizationId, resourceId, e.sha256);
      if (e.objectKey !== want) {
        throw new R2AssetError('asset_invalid_input', `entry ${e.path}: objectKey must be ${want}`);
      }
    }
    await mapLimit(payload.entries, 16, async (e) => {
      const h = await this.bucket.head(e.objectKey);
      if (!h) throw new R2AssetError('asset_object_missing', e.objectKey, { path: e.path });
      if (h.size !== e.size) {
        throw new R2AssetError('asset_size_mismatch', `${e.path}: object has ${h.size} bytes, entry says ${e.size}`);
      }
    });

    const key = r2AssetKeys.manifest(this.organizationId, resourceId, manifestId);
    // Re-put even when it already exists (keeping the first createdAt): the fresh `uploaded` restarts
    // the GC grace window for a manifest that may have been unreachable longer than the grace period.
    const manifest: AssetManifest = (await this.readManifestAt(key, manifestId)) ?? {
      manifestId,
      resourceId,
      parentManifestId: m.parentManifestId as ManifestId | null,
      entries: payload.entries,
      createdAt: this.now().toISOString(),
    };
    await this.bucket.put(key, JSON.stringify(manifest), {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { manifestId },
    });
    await this.bucket.put(r2AssetKeys.manifestIndex(this.organizationId, manifestId), JSON.stringify({ resourceId }), {
      httpMetadata: { contentType: 'application/json' },
    });
    return manifest;
  }

  /**
   * Read and verify a manifest (recomputes the id; a mismatch throws `asset_manifest_corrupt`).
   * `resourceId` is optional (B.11 passes only the id); without it the org's id index is consulted.
   */
  async readManifest(manifestId: ManifestId | string, resourceId?: ResourceId | string): Promise<AssetManifest | null> {
    if (typeof manifestId !== 'string' || !SHA256_HEX_RE.test(manifestId)) {
      throw new R2AssetError('asset_invalid_input', 'manifestId must be lowercase sha256 hex');
    }
    let res = resourceId;
    if (res === undefined) {
      const idx = await this.bucket.get(r2AssetKeys.manifestIndex(this.organizationId, manifestId));
      if (!idx) return null;
      try {
        res = (JSON.parse(dec.decode(await idx.arrayBuffer())) as { resourceId: string }).resourceId;
      } catch {
        throw new R2AssetError('asset_manifest_corrupt', `index entry for ${manifestId}`);
      }
    }
    const rid = parseOrThrow(ResourceIdSchema, res, 'resourceId');
    return this.readManifestAt(r2AssetKeys.manifest(this.organizationId, rid, manifestId), manifestId);
  }

  // -------------------------------------------------------------------------------------------
  // URLs
  // -------------------------------------------------------------------------------------------

  /**
   * P0: a Worker-served path `<urlBase>/<objectKey>?token=<hmac token>` rather than an R2 presigned
   * URL. The grant must name this org and the key's resource; expiry is min(now+ttl, grant.expiresAt).
   */
  async objectUrl(objectKey: string, grant: ReadGrant, ttlSeconds: number): Promise<string> {
    const g = parseOrThrow(ReadGrantSchema, grant, 'grant');
    const parsed = parseAssetKey(objectKey);
    if (!parsed) throw new R2AssetError('asset_invalid_input', `not an immutable asset key: ${objectKey}`);
    if (g.organizationId !== this.organizationId || parsed.org !== this.organizationId) {
      throw new R2AssetError('asset_grant_denied', 'grant/key organization mismatch');
    }
    if (parsed.resourceId !== g.resourceId) throw new R2AssetError('asset_grant_denied', 'grant/key resource mismatch');
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > this.maxUrlTtlSeconds) {
      throw new R2AssetError('asset_invalid_input', `ttlSeconds must be 1..${this.maxUrlTtlSeconds}`);
    }
    const nowS = Math.floor(this.now().getTime() / 1000);
    const grantExp = Math.floor(Date.parse(g.expiresAt) / 1000);
    if (grantExp <= nowS) throw new R2AssetError('asset_grant_denied', 'grant expired');
    const token = await signAssetToken(
      {
        v: 1,
        k: objectKey,
        op: 'get',
        org: this.organizationId,
        res: g.resourceId,
        sub: `${g.principal.kind}:${g.principal.id}`,
        pur: g.purpose,
        exp: Math.min(nowS + ttlSeconds, grantExp),
      },
      this.signingKey,
    );
    return this.url(objectKey, token);
  }

  // -------------------------------------------------------------------------------------------
  // GC
  // -------------------------------------------------------------------------------------------

  /**
   * Garbage-collect this org's assets. `reachable` holds object keys and manifest ids (or full
   * manifest keys); a bare 64-hex string is taken as a manifest id.
   *
   * 1. A manifest is kept if it is reachable or younger than `graceSeconds`. Every kept manifest is
   *    read and its entries' objects are protected, so keeping a root never orphans what it references.
   *    If a reachable manifest is missing, or any kept manifest is unreadable/corrupt, GC aborts with
   *    `asset_gc_unsafe` and deletes nothing.
   * 2. An immutable object is deleted iff it is not in `reachable`, not referenced by a kept
   *    manifest, and older than `graceSeconds`. Manifest-index entries follow their manifest's rule.
   * 3. Every key under the provider-owned `org/<org>/staging/` prefix older than the staging TTL is
   *    deleted (uploads and intent sidecars); younger staging keys are never touched.
   * 4. Just before deleting, manifests are re-listed: any manifest not seen in pass 1, or (re)written
   *    at or after `now`, is read and its manifest key, index entry and entries' objects are dropped
   *    from the delete set (Task 13 re-review: a manifest written during a run that references an old,
   *    unreferenced object). This shrinks that race to the re-list → delete gap.
   *
   * Callers must run GC serialized (one run per org at a time), pass `now` = the run start, and
   * compute `reachable` no earlier than `now`. Unrecognised keys under `org/<org>/res/` and other
   * orgs' keys are never touched.
   */
  async collectUnreachable(input: { reachable: Set<string>; graceSeconds: number; now: string }): Promise<{ deleted: string[] }> {
    const nowMs = Date.parse(input.now);
    if (Number.isNaN(nowMs)) throw new R2AssetError('asset_invalid_input', 'now must be an ISO timestamp');
    if (!Number.isFinite(input.graceSeconds) || input.graceSeconds < 0) {
      throw new R2AssetError('asset_invalid_input', 'graceSeconds must be >= 0');
    }
    const graceCutoff = nowMs - input.graceSeconds * 1000;
    const stagingCutoff = nowMs - this.stagingTtlSeconds * 1000;
    const reachableManifestIds = new Set<string>();
    for (const r of input.reachable) {
      if (SHA256_HEX_RE.test(r)) reachableManifestIds.add(r);
      const p = parseAssetKey(r);
      if (p?.kind === 'manifest' && p.org === this.organizationId) reachableManifestIds.add(p.manifestId);
    }
    const old = (o: R2PortObject, cutoff: number) => o.uploaded.getTime() <= cutoff;
    const org = this.organizationId;

    // Pass 1: inventory; decide manifests and protect the entries of every kept manifest.
    const objects: R2PortObject[] = [];
    const doomed: string[] = [];
    const keptManifestIds = new Set<string>();
    const protectedObjects = new Set<string>();
    const seenManifests = new Set<string>();
    for await (const o of this.listAll(`org/${org}/res/`)) {
      const p = parseAssetKey(o.key);
      if (!p || p.org !== org) continue;
      if (p.kind === 'object') {
        objects.push(o);
        continue;
      }
      seenManifests.add(o.key);
      const reachable = reachableManifestIds.has(p.manifestId);
      if (!reachable && old(o, graceCutoff)) {
        doomed.push(o.key);
        continue;
      }
      let m: AssetManifest | null;
      try {
        m = await this.readManifestAt(o.key, p.manifestId);
      } catch (e) {
        throw new R2AssetError('asset_gc_unsafe', `kept manifest ${o.key} is unreadable: ${(e as Error).message}`);
      }
      if (!m) throw new R2AssetError('asset_gc_unsafe', `kept manifest ${o.key} vanished during GC`);
      keptManifestIds.add(p.manifestId);
      for (const e of m.entries) protectedObjects.add(e.objectKey);
    }
    for (const id of reachableManifestIds) {
      if (!keptManifestIds.has(id)) throw new R2AssetError('asset_gc_unsafe', `reachable manifest ${id} not found`);
    }

    // Pass 2: objects, index entries, staging.
    for (const o of objects) {
      if (old(o, graceCutoff) && !input.reachable.has(o.key) && !protectedObjects.has(o.key)) doomed.push(o.key);
    }
    const indexPrefix = `org/${org}/manifest-index/`;
    for await (const o of this.listAll(indexPrefix)) {
      const id = o.key.slice(indexPrefix.length);
      if (SHA256_HEX_RE.test(id) && !keptManifestIds.has(id) && old(o, graceCutoff)) doomed.push(o.key);
    }
    for await (const o of this.listAll(r2AssetKeys.stagingPrefix(org))) {
      if (old(o, stagingCutoff)) doomed.push(o.key);
    }

    // Pass 3: manifests written during this run protect themselves and their entries.
    const spared = new Set<string>();
    for await (const o of this.listAll(`org/${org}/res/`)) {
      const p = parseAssetKey(o.key);
      if (!p || p.org !== org || p.kind !== 'manifest') continue;
      if (seenManifests.has(o.key) && o.uploaded.getTime() < nowMs) continue;
      let m: AssetManifest | null;
      try {
        m = await this.readManifestAt(o.key, p.manifestId);
      } catch (e) {
        throw new R2AssetError('asset_gc_unsafe', `manifest ${o.key} written during GC is unreadable: ${(e as Error).message}`);
      }
      if (!m) continue; // deleted meanwhile: protects nothing
      spared.add(o.key);
      spared.add(r2AssetKeys.manifestIndex(org, p.manifestId));
      for (const e of m.entries) spared.add(e.objectKey);
    }
    const finalDoomed = spared.size === 0 ? doomed : doomed.filter((k) => !spared.has(k));
    await this.deleteKeys(finalDoomed);
    return { deleted: finalDoomed };
  }

  // -------------------------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------------------------

  private url(key: string, token: string): string {
    return `${this.urlBase}/${key.split('/').map(encodeURIComponent).join('/')}?token=${encodeURIComponent(token)}`;
  }

  private assertOrg(org: string): void {
    if (org !== this.organizationId) throw new R2AssetError('asset_wrong_organization', `${org} != ${this.organizationId}`);
  }

  private parseStagingKey(key: string): { org: string; ws: string; id: string } {
    const m = typeof key === 'string' ? STAGING_KEY_RE.exec(key) : null;
    if (!m) throw new R2AssetError('asset_invalid_input', `not a staging key: ${String(key)}`);
    this.assertOrg(m[1]!);
    return { org: m[1]!, ws: m[2]!, id: m[3]! };
  }

  private async readIntent(stagingKey: string): Promise<StagingIntent> {
    const intent = await this.tryReadIntent(stagingKey);
    if (!intent) throw new R2AssetError('asset_staging_missing', `no staging intent for ${stagingKey}`);
    return intent;
  }

  /** The staging intent, or null when absent; throws when present but invalid. */
  private async tryReadIntent(stagingKey: string): Promise<StagingIntent | null> {
    const o = await this.bucket.get(r2AssetKeys.intent(stagingKey));
    if (!o) return null;
    let intent: StagingIntent;
    try {
      intent = JSON.parse(dec.decode(await o.arrayBuffer())) as StagingIntent;
    } catch {
      throw new R2AssetError('asset_staging_missing', `unreadable staging intent for ${stagingKey}`);
    }
    if (intent.v !== 1 || intent.organizationId !== this.organizationId || !Number.isSafeInteger(intent.size)) {
      throw new R2AssetError('asset_staging_missing', `invalid staging intent for ${stagingKey}`);
    }
    return intent;
  }

  /** An existing immutable object that claims a different sha256 is corruption: refuse to touch it. */
  private assertImmutableMatches(o: R2PortObject, sha: string): void {
    const meta = o.customMetadata?.sha256;
    if (meta !== undefined && meta !== sha) {
      throw new R2AssetError('asset_object_conflict', `immutable ${o.key} exists with different content`, {
        size: o.size,
        sha256: meta,
      });
    }
  }

  private async readManifestAt(key: string, manifestId: string): Promise<AssetManifest | null> {
    const o = await this.bucket.get(key);
    if (!o) return null;
    let parsed: AssetManifest;
    try {
      const r = AssetManifestSchema.safeParse(JSON.parse(dec.decode(await o.arrayBuffer())));
      if (!r.success) throw new Error(r.error.message);
      parsed = r.data;
    } catch (e) {
      throw new R2AssetError('asset_manifest_corrupt', `${key}: ${(e as Error).message}`);
    }
    const actual = await computeAssetManifestId(parsed);
    if (actual !== manifestId || parsed.manifestId !== manifestId) {
      throw new R2AssetError('asset_manifest_corrupt', `${key}: content hashes to ${actual}`, { expected: manifestId, actual });
    }
    return parsed;
  }

  private async *listAll(prefix: string): AsyncGenerator<R2PortObject> {
    let cursor: string | undefined;
    do {
      const page = await this.bucket.list(cursor === undefined ? { prefix } : { prefix, cursor });
      yield* page.objects;
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor !== undefined);
  }

  private async deleteKeys(keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += R2_MAX_DELETE_KEYS) {
      await this.bucket.delete(keys.slice(i, i + R2_MAX_DELETE_KEYS));
    }
  }

  /**
   * Stream `reader` (exactly `size` bytes) into `key` — single put when `size <= partSize`, else a
   * multipart upload with fixed-size parts — calling `onChunk` on every byte and `beforeCommit`
   * before the object becomes visible (a throw aborts; nothing is written). `key: null` only reads.
   */
  private async pipe(
    reader: R2PortReader,
    o: {
      key: string | null;
      size: number;
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
      sha256?: string;
      onChunk?: (c: Uint8Array) => void;
      beforeCommit?: () => void;
    },
  ): Promise<void> {
    const single = o.size <= this.partSize;
    const bufSize = single ? o.size : this.partSize;
    let buf = new Uint8Array(o.key === null ? 0 : bufSize);
    let fill = 0;
    let total = 0;
    let partNumber = 0;
    const parts: R2PortUploadedPart[] = [];
    let upload: Awaited<ReturnType<R2PortBucket['createMultipartUpload']>> | null = null;
    const meta = { httpMetadata: o.httpMetadata ?? {}, customMetadata: o.customMetadata ?? {} };

    const flushPart = async () => {
      if (!upload) upload = await this.bucket.createMultipartUpload(o.key!, meta);
      partNumber++;
      parts.push(await upload.uploadPart(partNumber, buf.slice(0, fill)));
      fill = 0;
    };

    try {
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        let chunk = r.value;
        total += chunk.length;
        if (total > o.size) throw new R2AssetError('asset_size_mismatch', `body exceeds declared ${o.size} bytes`);
        o.onChunk?.(chunk);
        if (o.key === null) continue;
        while (chunk.length > 0) {
          const take = Math.min(bufSize - fill, chunk.length);
          buf.set(chunk.subarray(0, take), fill);
          fill += take;
          chunk = chunk.subarray(take);
          if (!single && fill === bufSize) await flushPart();
        }
      }
      if (total !== o.size) throw new R2AssetError('asset_size_mismatch', `body has ${total} bytes, declared ${o.size}`);
      o.beforeCommit?.();
      if (o.key === null) return;
      if (single) {
        await this.bucket.put(o.key, buf, o.sha256 === undefined ? meta : { ...meta, sha256: o.sha256 });
        return;
      }
      if (fill > 0) await flushPart();
      const done = await upload!.complete(parts);
      upload = null; // completed: nothing to abort any more
      if (done.size !== o.size) {
        await this.bucket.delete(o.key).catch(() => {});
        throw new R2AssetError('asset_size_mismatch', `multipart ${o.key} completed with ${done.size} bytes, expected ${o.size}`);
      }
    } catch (e) {
      await reader.cancel(e).catch(() => {});
      if (upload) await (upload as { abort(): Promise<void> }).abort().catch(() => {});
      throw e;
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // already released / errored stream
      }
      buf = new Uint8Array(0);
    }
  }
}

function unquoteEtag(e: string): string {
  return e.replace(/^(?:W\/)?"(.*)"$/, '$1');
}

async function mapLimit<T>(items: readonly T[], limit: number, fn: (t: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]!);
  });
  await Promise.all(workers);
}

