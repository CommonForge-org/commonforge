/**
 * Asset manifest identity (plan §B.11): manifestId = sha256(canonicalJson({$t: 'cf.asset-manifest/1',
 * resourceId, parentManifestId, entries})) with entries parsed through `AssetManifestEntrySchema`
 * (unknown keys stripped) and sorted by path. `createdAt` is excluded.
 */
import { hashCanonical, hashCanonicalSync } from './canonical-json.js';
import { CoreError } from './errors.js';
import type { ManifestId } from './ids.js';
import { normalizePath } from './path-policy.js';
import { AssetManifestEntrySchema, type AssetManifestEntry } from './schemas.js';
import type { DeepReadonly } from './types.js';

/** Domain/version tag inside the hashed manifest payload. */
export const ASSET_MANIFEST_HASH_TAG = 'cf.asset-manifest/1';

export interface AssetManifestHashInput {
  readonly resourceId: string;
  readonly parentManifestId: string | null;
  readonly entries: readonly DeepReadonly<AssetManifestEntry>[];
}

export function canonicalAssetManifestPayload(input: AssetManifestHashInput) {
  const entries = input.entries
    .map((e) => {
      const r = AssetManifestEntrySchema.safeParse({ ...e, path: normalizePath(e.path) });
      if (!r.success) throw new CoreError('invalid_manifest', r.error.message);
      return r.data;
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (let i = 1; i < entries.length; i++) {
    if (entries[i]!.path === entries[i - 1]!.path) {
      throw new CoreError('invalid_manifest', `duplicate manifest path ${entries[i]!.path}`);
    }
  }
  return { $t: ASSET_MANIFEST_HASH_TAG, resourceId: input.resourceId, parentManifestId: input.parentManifestId, entries };
}

export async function computeAssetManifestId(input: AssetManifestHashInput): Promise<ManifestId> {
  return (await hashCanonical(canonicalAssetManifestPayload(input))) as ManifestId;
}

export function computeAssetManifestIdSync(input: AssetManifestHashInput): ManifestId {
  return hashCanonicalSync(canonicalAssetManifestPayload(input)) as ManifestId;
}
