/**
 * Proposal identity (plan §A.5): proposalHash = sha256(canonicalJson({
 *   $t: 'cf.proposal/1',            // domain/version tag
 *   baseSnapshotId, candidateSnapshotId,
 *   resourceChanges[]      sorted by (resourceId, candidateId),
 *   readDependencies[]     sorted by (resourceId, revisionId, mode),
 *   assetManifestChanges[] sorted by (resourceId, newManifestId),
 *   policyRevision
 * }))
 *
 * The arrays are semantically sets, so their input order never changes the hash; any field value
 * does. Exact duplicates are refused (they would make two spellings of one proposal).
 * ID formats are not validated here; `ProposalRecordSchema` validates at wire boundaries.
 */
import { z } from 'zod';
import { canonicalJson, hashCanonical, hashCanonicalSync } from './canonical-json.js';
import { CoreError } from './errors.js';
import type { ProposalHash } from './ids.js';
import { DependencyModeSchema } from './schemas.js';
import type { DeepReadonly } from './types.js';

/** Domain/version tag inside the hashed proposal payload. */
export const PROPOSAL_HASH_TAG = 'cf.proposal/1';

const NonEmpty = z.string().min(1);

export const ProposalHashInputSchema = z.object({
  baseSnapshotId: NonEmpty,
  candidateSnapshotId: NonEmpty,
  resourceChanges: z.array(
    z.object({ resourceId: NonEmpty, baseRevision: NonEmpty, candidateId: NonEmpty, candidateRevision: NonEmpty }),
  ),
  readDependencies: z.array(z.object({ resourceId: NonEmpty, revisionId: NonEmpty, mode: DependencyModeSchema })),
  assetManifestChanges: z.array(
    z.object({ resourceId: NonEmpty, baseManifestId: NonEmpty.nullable(), newManifestId: NonEmpty }),
  ),
  policyRevision: z.number().int().nonnegative(),
});
export type ProposalHashInput = DeepReadonly<z.input<typeof ProposalHashInputSchema>>;

function sortedSet<T>(items: T[], keys: (t: T) => string[], label: string): T[] {
  const out = [...items].sort((a, b) => {
    const ka = keys(a);
    const kb = keys(b);
    for (let i = 0; i < ka.length; i++) {
      if (ka[i]! < kb[i]!) return -1;
      if (ka[i]! > kb[i]!) return 1;
    }
    return 0;
  });
  for (let i = 1; i < out.length; i++) {
    if (canonicalJson(out[i]) === canonicalJson(out[i - 1])) {
      throw new CoreError('invalid_proposal', `duplicate ${label} entry`);
    }
  }
  return out;
}

/** The canonical object that is hashed; exported for transparency and cross-language verification. */
export function canonicalProposalPayload(input: ProposalHashInput) {
  const r = ProposalHashInputSchema.safeParse(input);
  if (!r.success) throw new CoreError('invalid_proposal', r.error.message);
  const p = r.data;
  return {
    $t: PROPOSAL_HASH_TAG,
    baseSnapshotId: p.baseSnapshotId,
    candidateSnapshotId: p.candidateSnapshotId,
    resourceChanges: sortedSet(
      p.resourceChanges,
      (c) => [c.resourceId, c.candidateId, c.baseRevision, c.candidateRevision],
      'resourceChanges',
    ),
    readDependencies: sortedSet(p.readDependencies, (d) => [d.resourceId, d.revisionId, d.mode], 'readDependencies'),
    assetManifestChanges: sortedSet(
      p.assetManifestChanges,
      (a) => [a.resourceId, a.newManifestId, a.baseManifestId ?? ''],
      'assetManifestChanges',
    ),
    policyRevision: p.policyRevision,
  };
}

/** sha256 over the canonical proposal payload. Async because it uses WebCrypto. */
export async function computeProposalHash(input: ProposalHashInput): Promise<ProposalHash> {
  return (await hashCanonical(canonicalProposalPayload(input))) as ProposalHash;
}

/** Synchronous variant (pure-TS sha256) for use inside synchronous ledger transactions. */
export function computeProposalHashSync(input: ProposalHashInput): ProposalHash {
  return hashCanonicalSync(canonicalProposalPayload(input)) as ProposalHash;
}

/** True when `proposal.proposalHash` matches its hashed fields. */
export async function verifyProposalHash(proposal: ProposalHashInput & { readonly proposalHash: string }): Promise<boolean> {
  return (await computeProposalHash(proposal)) === proposal.proposalHash;
}
