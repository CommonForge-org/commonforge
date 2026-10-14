/**
 * Snapshot identity (plan §A.5, §B.3).
 *
 * SnapshotId = sha256(canonicalJson({
 *   $t: 'cf.snapshot/1',            // domain/version tag
 *   projectId, organizationId, membershipRevision, policyRevision,
 *   entries: [{ resourceId, revisionId, mode, mountName(NFC), operations(sorted, deduped) }]
 *            sorted by resourceId, then mountName
 * }))
 *
 * `organizationId`, `mountName` and `operations` are included beyond the §A.5 minimum because
 * B.3's signature hashes the whole snapshot minus id/timestamp: a different mount layout or grant is
 * a different snapshot. ID formats are not validated here (hashing is format-agnostic); wire
 * boundaries validate with `ProjectSnapshotSchema`.
 */
import { z } from 'zod';
import { hashCanonical, hashCanonicalSync } from './canonical-json.js';
import { CoreError } from './errors.js';
import type { SnapshotId } from './ids.js';
import { DependencyModeSchema, OperationSchema } from './schemas.js';
import type { DeepReadonly } from './types.js';

const NonEmpty = z.string().min(1);
const Int = z.number().int().nonnegative();

export const SnapshotHashInputSchema = z.object({
  projectId: NonEmpty,
  organizationId: NonEmpty,
  membershipRevision: Int,
  policyRevision: Int,
  entries: z.array(
    z.object({
      resourceId: NonEmpty,
      revisionId: NonEmpty,
      mode: DependencyModeSchema,
      mountName: NonEmpty,
      operations: z.array(OperationSchema).min(1),
    }),
  ),
});
export type SnapshotHashInput = DeepReadonly<z.input<typeof SnapshotHashInputSchema>>;

/** Domain/version tag inside the hashed snapshot payload. */
export const SNAPSHOT_HASH_TAG = 'cf.snapshot/1';

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The canonical object that is hashed; exported for transparency and cross-language verification. */
export function canonicalSnapshotPayload(input: SnapshotHashInput) {
  const r = SnapshotHashInputSchema.safeParse(input);
  if (!r.success) throw new CoreError('invalid_snapshot', r.error.message);
  const s = r.data;
  const entries = s.entries
    .map((e) => ({
      resourceId: e.resourceId,
      revisionId: e.revisionId,
      mode: e.mode,
      mountName: e.mountName.normalize('NFC'),
      operations: [...new Set(e.operations)].sort(),
    }))
    .sort((a, b) => cmp(a.resourceId, b.resourceId) || cmp(a.mountName, b.mountName));
  const mounts = new Set(entries.map((e) => e.mountName));
  if (mounts.size !== entries.length) throw new CoreError('invalid_snapshot', 'duplicate mountName');
  return {
    $t: SNAPSHOT_HASH_TAG,
    projectId: s.projectId,
    organizationId: s.organizationId,
    membershipRevision: s.membershipRevision,
    policyRevision: s.policyRevision,
    entries,
  };
}

/** sha256 over the canonical snapshot payload. Async because it uses WebCrypto. */
export async function computeSnapshotId(input: SnapshotHashInput): Promise<SnapshotId> {
  return (await hashCanonical(canonicalSnapshotPayload(input))) as SnapshotId;
}

/** Synchronous variant (pure-TS sha256); identical output to {@link computeSnapshotId}. */
export function computeSnapshotIdSync(input: SnapshotHashInput): SnapshotId {
  return hashCanonicalSync(canonicalSnapshotPayload(input)) as SnapshotId;
}

/** True when `snapshot.snapshotId` matches its content. */
export async function verifySnapshotId(snapshot: SnapshotHashInput & { readonly snapshotId: string }): Promise<boolean> {
  return (await computeSnapshotId(snapshot)) === snapshot.snapshotId;
}
