import { describe, expect, it } from 'vitest';
import { computeSnapshotId, verifySnapshotId } from './snapshot.js';
import { ProjectSnapshotSchema } from './schemas.js';

const SHA = (c: string) => c.repeat(40);
const base = {
  projectId: 'p1',
  organizationId: 'o1',
  membershipRevision: 3,
  policyRevision: 1,
  entries: [
    { resourceId: 'r-a', revisionId: `art:repo1:${SHA('a')}`, mode: 'must-match-accepted', mountName: 'website', operations: ['read', 'write'] },
    { resourceId: 'r-b', revisionId: `art:repo2:${SHA('b')}`, mode: 'pinned-reference', mountName: 'api', operations: ['read'] },
  ],
} as const;

describe('computeSnapshotId (determinism)', () => {
  it('treats composed and decomposed unicode mount names identically', async () => {
    const composed = { ...base, entries: [{ ...base.entries[0], mountName: 'café' }, base.entries[1]] };
    const decomposed = { ...base, entries: [{ ...base.entries[0], mountName: 'café' }, base.entries[1]] };
    expect(await computeSnapshotId(composed)).toBe(await computeSnapshotId(decomposed));
  });
  it('ignores operation order and duplicates', async () => {
    const reordered = { ...base, entries: [{ ...base.entries[0], operations: ['write', 'read', 'read'] }, base.entries[1]] } as const;
    expect(await computeSnapshotId(reordered)).toBe(await computeSnapshotId(base));
  });
  it.each([
    ['projectId', { projectId: 'p2' }],
    ['organizationId', { organizationId: 'o2' }],
    ['membershipRevision', { membershipRevision: 4 }],
    ['policyRevision', { policyRevision: 2 }],
  ])('changes with %s', async (_f, patch) => {
    expect(await computeSnapshotId({ ...base, ...patch })).not.toBe(await computeSnapshotId(base));
  });
  it.each([
    ['mode', { mode: 'pinned-reference' }],
    ['mountName', { mountName: 'site' }],
    ['operations', { operations: ['read'] }],
    ['resourceId', { resourceId: 'r-c' }],
  ] as const)('changes with entry %s', async (_f, patch) => {
    const changed = { ...base, entries: [{ ...base.entries[0], ...patch }, base.entries[1]] };
    expect(await computeSnapshotId(changed)).not.toBe(await computeSnapshotId(base));
  });
  it('ignores snapshotId/createdAt and verifies', async () => {
    const id = await computeSnapshotId(base);
    const snap = { ...base, snapshotId: id, createdAt: '2026-10-06T00:00:00.000Z' };
    expect(await computeSnapshotId(snap)).toBe(id);
    expect(await verifySnapshotId(snap)).toBe(true);
    expect(await verifySnapshotId({ ...snap, policyRevision: 9 })).toBe(false);
    expect(ProjectSnapshotSchema.parse(snap)).toEqual(snap);
  });
  it('refuses duplicate mount names', async () => {
    const dup = { ...base, entries: [base.entries[0], { ...base.entries[1], mountName: 'website' }] };
    await expect(computeSnapshotId(dup)).rejects.toThrow(/invalid_snapshot/);
  });
});
