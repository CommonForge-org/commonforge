import { describe, expect, it } from 'vitest';
import { computeProposalHash, verifyProposalHash, type ProposalHashInput } from './proposal.js';

const S = (c: string) => c.repeat(64);
const G = (c: string) => c.repeat(40);

const base: ProposalHashInput = {
  baseSnapshotId: S('1'),
  candidateSnapshotId: S('2'),
  resourceChanges: [
    { resourceId: 'web', baseRevision: `art:web:${G('a')}`, candidateId: `cand:ws1:${G('b')}`, candidateRevision: `art:web:${G('b')}` },
    { resourceId: 'api', baseRevision: `art:api:${G('c')}`, candidateId: `cand:ws2:${G('d')}`, candidateRevision: `art:api:${G('d')}` },
  ],
  readDependencies: [
    { resourceId: 'req', revisionId: `art:req:${G('e')}`, mode: 'pinned-reference' },
    { resourceId: 'web', revisionId: `art:web:${G('a')}`, mode: 'must-match-accepted' },
  ],
  assetManifestChanges: [{ resourceId: 'brand', baseManifestId: S('3'), newManifestId: S('4') }],
  policyRevision: 5,
};

describe('computeProposalHash', () => {
  it('is a sha256 hex', async () => {
    expect(await computeProposalHash(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is independent of array order', async () => {
    const shuffled: ProposalHashInput = {
      ...base,
      resourceChanges: [...base.resourceChanges].reverse(),
      readDependencies: [...base.readDependencies].reverse(),
    };
    expect(await computeProposalHash(shuffled)).toBe(await computeProposalHash(base));
  });

  const mutations: Array<[string, (p: ProposalHashInput) => ProposalHashInput]> = [
    ['baseSnapshotId', (p) => ({ ...p, baseSnapshotId: S('9') })],
    ['candidateSnapshotId', (p) => ({ ...p, candidateSnapshotId: S('9') })],
    ['policyRevision', (p) => ({ ...p, policyRevision: 6 })],
    ['resourceChanges.resourceId', (p) => ({ ...p, resourceChanges: [{ ...p.resourceChanges[0]!, resourceId: 'web2' }, p.resourceChanges[1]!] })],
    ['resourceChanges.baseRevision', (p) => ({ ...p, resourceChanges: [{ ...p.resourceChanges[0]!, baseRevision: `art:web:${G('f')}` }, p.resourceChanges[1]!] })],
    ['resourceChanges.candidateId', (p) => ({ ...p, resourceChanges: [{ ...p.resourceChanges[0]!, candidateId: `cand:ws9:${G('b')}` }, p.resourceChanges[1]!] })],
    ['resourceChanges.candidateRevision', (p) => ({ ...p, resourceChanges: [{ ...p.resourceChanges[0]!, candidateRevision: `art:web:${G('f')}` }, p.resourceChanges[1]!] })],
    ['resourceChanges removed', (p) => ({ ...p, resourceChanges: [p.resourceChanges[0]!] })],
    ['readDependencies.revisionId', (p) => ({ ...p, readDependencies: [{ ...p.readDependencies[0]!, revisionId: `art:req:${G('f')}` }, p.readDependencies[1]!] })],
    ['readDependencies.mode', (p) => ({ ...p, readDependencies: [{ ...p.readDependencies[0]!, mode: 'must-match-accepted' }, p.readDependencies[1]!] })],
    ['readDependencies.resourceId', (p) => ({ ...p, readDependencies: [{ ...p.readDependencies[0]!, resourceId: 'req2' }, p.readDependencies[1]!] })],
    ['readDependencies removed', (p) => ({ ...p, readDependencies: [] })],
    ['assetManifestChanges.resourceId', (p) => ({ ...p, assetManifestChanges: [{ ...p.assetManifestChanges[0]!, resourceId: 'brand2' }] })],
    ['assetManifestChanges.baseManifestId', (p) => ({ ...p, assetManifestChanges: [{ ...p.assetManifestChanges[0]!, baseManifestId: null }] })],
    ['assetManifestChanges.newManifestId', (p) => ({ ...p, assetManifestChanges: [{ ...p.assetManifestChanges[0]!, newManifestId: S('8') }] })],
    ['assetManifestChanges removed', (p) => ({ ...p, assetManifestChanges: [] })],
  ];

  it.each(mutations)('changes when %s changes', async (_name, mutate) => {
    expect(await computeProposalHash(mutate(base))).not.toBe(await computeProposalHash(base));
  });

  it('produces distinct hashes for every single-field mutation', async () => {
    const hashes = await Promise.all(mutations.map(([, m]) => computeProposalHash(m(base))));
    expect(new Set([...hashes, await computeProposalHash(base)]).size).toBe(mutations.length + 1);
  });

  it('ignores non-hashed fields and verifies', async () => {
    const proposalHash = await computeProposalHash(base);
    const record = { ...base, proposalHash, state: 'open', updatedAt: 'x' };
    expect(await computeProposalHash(record)).toBe(proposalHash);
    expect(await verifyProposalHash(record)).toBe(true);
    expect(await verifyProposalHash({ ...record, policyRevision: 7 })).toBe(false);
  });

  it('refuses exact duplicate set entries and malformed input', async () => {
    await expect(
      computeProposalHash({ ...base, readDependencies: [base.readDependencies[0]!, base.readDependencies[0]!] }),
    ).rejects.toThrow(/invalid_proposal/);
    await expect(computeProposalHash({ ...base, policyRevision: -1 })).rejects.toThrow(/invalid_proposal/);
  });
});
