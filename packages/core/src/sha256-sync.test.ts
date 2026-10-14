import { describe, expect, it } from 'vitest';
import { hashCanonical, hashCanonicalSync, sha256Hex, sha256HexSync } from './canonical-json.js';
import { computeProposalHash, computeProposalHashSync } from './proposal.js';
import { computeSnapshotId, computeSnapshotIdSync } from './snapshot.js';

function bytes(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

describe('sha256HexSync', () => {
  it('matches FIPS vectors', () => {
    expect(sha256HexSync('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256HexSync('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256HexSync('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it.each([0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000, 4096, 100_003])(
    'equals WebCrypto for %i random bytes',
    async (n) => {
      const b = bytes(n, n + 7);
      expect(sha256HexSync(b)).toBe(await sha256Hex(b));
    },
  );

  it.each(['', 'a', 'é', 'é', '日本語のテキスト', '🦀 emoji 𝄞', 'x'.repeat(1_000), 'mixé'.repeat(333)])(
    'equals WebCrypto for UTF-8 string %#',
    async (s) => {
      expect(sha256HexSync(s)).toBe(await sha256Hex(s));
    },
  );

  it('hashCanonicalSync equals hashCanonical', async () => {
    const v = { z: [1, 'two', { ü: null }], a: true, n: -0.5 };
    expect(hashCanonicalSync(v)).toBe(await hashCanonical(v));
  });

  it('sync snapshot/proposal ids equal async ones', async () => {
    const snap = { projectId: 'p', organizationId: 'o', membershipRevision: 1, policyRevision: 2, entries: [
      { resourceId: 'r', revisionId: `art:r:${'a'.repeat(40)}`, mode: 'pinned-reference', mountName: 'café', operations: ['read'] },
    ] } as const;
    expect(computeSnapshotIdSync(snap)).toBe(await computeSnapshotId(snap));
    const prop = { baseSnapshotId: '1'.repeat(64), candidateSnapshotId: '2'.repeat(64), resourceChanges: [], readDependencies: [], assetManifestChanges: [], policyRevision: 0 };
    expect(computeProposalHashSync(prop)).toBe(await computeProposalHash(prop));
  });
});
