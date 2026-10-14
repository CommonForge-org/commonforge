/**
 * Incremental (streaming) SHA-256 (FIPS 180-4), dependency-free and Worker-safe.
 *
 * WebCrypto has no streaming digest and `@commonforge-org/core`'s `sha256Sync` is one-shot, so
 * hashing a multi-gigabyte R2 object without buffering it needs this. Multipart part ETags are NOT
 * the object sha256; `promoteStaged` hashes the full byte stream with this class.
 *
 * Candidate to move into `@commonforge-org/core` next to `sha256Sync` (kept here to stay inside
 * this task's package boundary).
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export class Sha256 {
  private readonly h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  private readonly w = new Uint32Array(64);
  private readonly block = new Uint8Array(64);
  private readonly blockView = new DataView(this.block.buffer);
  private blockLen = 0;
  /** Total bytes hashed (exact up to 2^53). */
  private total = 0;
  private finished = false;

  /** Feed more bytes. */
  update(data: Uint8Array): this {
    if (this.finished) throw new Error('sha256: update after digest');
    this.total += data.length;
    let off = 0;
    if (this.blockLen > 0) {
      const take = Math.min(64 - this.blockLen, data.length);
      this.block.set(data.subarray(0, take), this.blockLen);
      this.blockLen += take;
      off = take;
      if (this.blockLen < 64) return this;
      this.compress(this.blockView, 0);
      this.blockLen = 0;
    }
    if (data.length - off >= 64) {
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      while (data.length - off >= 64) {
        this.compress(view, off);
        off += 64;
      }
    }
    if (off < data.length) {
      this.block.set(data.subarray(off), 0);
      this.blockLen = data.length - off;
    }
    return this;
  }

  /** Bytes fed so far. */
  get bytesHashed(): number {
    return this.total;
  }

  /** Finish and return the 32-byte digest. The instance cannot be reused. */
  digest(): Uint8Array {
    if (this.finished) throw new Error('sha256: digest called twice');
    this.finished = true;
    const bitHi = Math.floor(this.total / 0x20000000); // total*8 / 2^32
    const bitLo = (this.total * 8) >>> 0;
    this.block[this.blockLen++] = 0x80;
    if (this.blockLen > 56) {
      this.block.fill(0, this.blockLen);
      this.compress(this.blockView, 0);
      this.blockLen = 0;
    }
    this.block.fill(0, this.blockLen);
    this.blockView.setUint32(56, bitHi);
    this.blockView.setUint32(60, bitLo);
    this.compress(this.blockView, 0);
    const out = new Uint8Array(32);
    const ov = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) ov.setUint32(i * 4, this.h[i]!);
    return out;
  }

  /** Finish and return the lowercase hex digest. */
  digestHex(): string {
    return toHex(this.digest());
  }

  private compress(view: DataView, off: number): void {
    const W = this.w;
    const H = this.h;
    for (let t = 0; t < 16; t++) W[t] = view.getUint32(off + t * 4);
    for (let t = 16; t < 64; t++) {
      const w15 = W[t - 15]!;
      const w2 = W[t - 2]!;
      const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
      const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
      W[t] = (W[t - 16]! + s0 + W[t - 7]! + s1) | 0;
    }
    let a = H[0]!, b = H[1]!, c = H[2]!, d = H[3]!, e = H[4]!, f = H[5]!, g = H[6]!, h = H[7]!;
    for (let t = 0; t < 64; t++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[t]! + W[t]!) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    H[0] = H[0]! + a; H[1] = H[1]! + b; H[2] = H[2]! + c; H[3] = H[3]! + d;
    H[4] = H[4]! + e; H[5] = H[5]! + f; H[6] = H[6]! + g; H[7] = H[7]! + h;
  }
}

export function toHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i]!.toString(16).padStart(2, '0');
  return s;
}
