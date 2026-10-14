import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Sha256 } from '../src/r2-assets-sha256.js';

const ref = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

describe('incremental Sha256', () => {
  it('matches known vectors', () => {
    expect(new Sha256().digestHex()).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(new Sha256().update(new TextEncoder().encode('abc')).digestHex()).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('matches node crypto for every length 0..200 fed in random chunkings', () => {
    const data = randomBytes(200);
    for (let n = 0; n <= 200; n++) {
      const slice = data.subarray(0, n);
      const h = new Sha256();
      let off = 0;
      while (off < n) {
        const take = Math.min(n - off, 1 + Math.floor(Math.random() * 70));
        h.update(slice.subarray(off, off + take));
        off += take;
      }
      expect(h.digestHex(), `len ${n}`).toBe(ref(slice));
    }
  });

  it('hashes a 12 MiB buffer fed in odd-sized, unaligned chunks', () => {
    const data = randomBytes(12 * 1024 * 1024 + 7);
    const h = new Sha256();
    for (let off = 0; off < data.length; off += 1_000_003) h.update(data.subarray(off, off + 1_000_003));
    expect(h.bytesHashed).toBe(data.length);
    expect(h.digestHex()).toBe(ref(data));
  });

  it('refuses reuse after digest', () => {
    const h = new Sha256();
    h.digest();
    expect(() => h.update(new Uint8Array(1))).toThrow();
    expect(() => h.digest()).toThrow();
  });
});
