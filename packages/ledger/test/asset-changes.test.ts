import {
  candidateRetentionRef,
  computeProposalHashSync,
  r2mRevisionId,
  resourceId,
  sha256HexSync,
  type AcceptInput,
  type ProposalHash,
} from '@commonforge-org/core';
import { describe, expect, it } from 'vitest';
import { FIXTURE_TIME, acceptFixture } from '../src/index.js';
import { accepted, commit, storeWith } from './helpers.js';

const m0 = sha256HexSync('manifest-0');
const m1 = sha256HexSync('manifest-1');

/** r1 code change plus an a1 asset-manifest change m0 -> m1 (or null -> m1). */
function assetWorld(baseManifestId: string | null) {
  const f = acceptFixture();
  const proposal = structuredClone(f.proposal);
  proposal.assetManifestChanges = [{ resourceId: resourceId('a1'), baseManifestId: baseManifestId as never, newManifestId: m1 as never }];
  proposal.preparedReceipts.push({ resourceId: resourceId('a1'), receiptId: 'prep-a1' });
  const hash = computeProposalHashSync(proposal) as ProposalHash;
  proposal.proposalHash = hash;
  const input: AcceptInput = structuredClone(f.input);
  input.proposalHash = hash;
  input.approvals = input.approvals.map((a) => ({ ...a, proposalHash: hash }));
  input.evidence = input.evidence.map((e) => ({ ...e, proposalHash: hash }));
  input.expectedHeads.push({ resourceId: resourceId('a1'), revisionId: r2mRevisionId(m0) });
  input.newHeads.push({ resourceId: resourceId('a1'), revisionId: r2mRevisionId(m1), preparedReceiptId: 'prep-a1' });
  const seed = {
    ...f.seed,
    heads: [...f.seed.heads!, { organizationId: 'org-1', resourceId: 'a1', revisionId: r2mRevisionId(m0), versionSeq: 1 }],
    proposals: [proposal],
    preparedReceipts: [
      ...f.seed.preparedReceipts!,
      {
        receiptId: 'prep-a1',
        jobId: 'job-prep-a1',
        candidateId: f.proposal.resourceChanges[0]!.candidateId,
        resourceId: 'a1',
        canonicalRef: candidateRetentionRef(f.proposal.resourceChanges[0]!.candidateId),
        sha: 'a'.repeat(40),
        revisionId: r2mRevisionId(m1),
        verifiedAssetObjects: ['org/org-1/res/a1/obj/x'],
        preparedAt: FIXTURE_TIME.prepared,
      },
    ],
  };
  return { f, input, seed };
}

describe('planCommit: asset manifest changes', () => {
  it('advances code and asset heads together', () => {
    const w = assetWorld(m0);
    const store = storeWith(w.seed);
    const d = accepted(commit(store, w.input));
    expect(store.head('a1')).toMatchObject({ revisionId: r2mRevisionId(m1), versionSeq: 2, acceptedVersionId: d.acceptedVersionId });
    expect(store.head('r1').revisionId).toBe(w.f.candidate.r1);
  });

  it('refuses an asset change whose base manifest is not the expected head', () => {
    const w = assetWorld(null);
    const store = storeWith(w.seed);
    expect(commit(store, w.input)).toMatchObject({ ok: false, code: 'expected_head_stale', resourceId: 'a1' });
    expect(store.head('r1').versionSeq).toBe(1);
  });

  it('refuses an asset new head that is not the proposal manifest', () => {
    const w = assetWorld(m0);
    w.input.newHeads[1]!.revisionId = r2mRevisionId(sha256HexSync('other'));
    expect(commit(storeWith(w.seed), w.input)).toMatchObject({ ok: false, code: 'receipt_missing', resourceId: 'a1' });
  });
});
