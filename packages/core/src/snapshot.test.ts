import { describe, it, expect } from 'vitest';
import { computeSnapshotId } from './snapshot.js';
describe('computeSnapshotId', () => {
  const base = { projectId: 'p1', organizationId: 'o1', membershipRevision: 3, policyRevision: 1,
    entries: [
      { resourceId: 'r-b', revisionId: 'art:repo2:bbb', mode: 'pinned-reference', mountName: 'api', operations: ['read'] },
      { resourceId: 'r-a', revisionId: 'art:repo1:aaa', mode: 'must-match-accepted', mountName: 'website', operations: ['read','write'] },
    ] } as const;
  it('is order-independent over entries', async () => {
    const swapped = { ...base, entries: [base.entries[1], base.entries[0]] };
    expect(await computeSnapshotId(base)).toBe(await computeSnapshotId(swapped));
  });
  it('changes when any revision changes', async () => {
    const changed = { ...base, entries: [base.entries[0], { ...base.entries[1], revisionId: 'art:repo1:ccc' }] };
    expect(await computeSnapshotId(changed)).not.toBe(await computeSnapshotId(base));
  });
  it('is a 64-char hex sha256', async () => { expect(await computeSnapshotId(base)).toMatch(/^[0-9a-f]{64}$/); });
});
