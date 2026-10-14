/** Compile-time contract checks (enforced by `pnpm typecheck`), with trivial runtime assertions. */
import { describe, expect, it } from 'vitest';
import type { RunnerSubmit } from './capabilities.js';
import { artRevisionId, type ResourceId, type RevisionId } from './ids.js';
import type { FrozenCandidate, PreparedReceipt, RepoCoords } from './schemas.js';

describe('type contracts', () => {
  it('branded ids do not accept plain strings', () => {
    // @ts-expect-error plain string is not a RevisionId
    const r: RevisionId = 'art:x:abc';
    // @ts-expect-error RevisionId is not a ResourceId
    const id: ResourceId = artRevisionId('x', 'a'.repeat(40));
    expect([r, id]).toHaveLength(2);
  });

  it('RunnerSubmit infers the receipt from the job kind and accepts runner-protocol job shapes', async () => {
    type PrepareJob = { kind: 'prepare-candidate'; candidate: FrozenCandidate; canonical: RepoCoords; retentionRef: string };
    const submit: RunnerSubmit = async () => ({ jobId: 'j', ok: false, code: 'provider_unavailable', detail: 'test' });
    const job = { kind: 'prepare-candidate', candidate: {} as FrozenCandidate, canonical: {} as RepoCoords, retentionRef: 'r' } satisfies PrepareJob;
    const out = await submit(job);
    if (out.ok) {
      const receipt: PreparedReceipt = out.receipt;
      expect(receipt).toBeDefined();
    }
    expect(out.ok).toBe(false);
  });
});
