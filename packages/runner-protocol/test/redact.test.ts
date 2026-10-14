import { describe, expect, it } from 'vitest';
import { REDACTED, containsSecret, findSecrets, redact, redactDeep } from '../src/index.js';

const ART = 'art_v1_0123456789abcdef0123456789abcdef01234567';
const ART2 = 'art_v2_x_0123456789abcdefABCDEF0123456789abcdef';

describe('redact', () => {
  it.each([
    ['Authorization: Bearer abc.def-ghi_jkl123456', 'abc.def-ghi_jkl123456'],
    ['git -c http.extraHeader="Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.e30.sig" clone', 'eyJhbGciOiJIUzI1NiJ9.e30.sig'],
    ['bearer lowercase-token-value-1234', 'lowercase-token-value-1234'],
    ['token=vc-resource-v1.eyJyZXNvdXJjZSI6InIxIn0.c2lnbmF0dXJl rest', 'vc-resource-v1.eyJyZXNvdXJjZSI6InIxIn0.c2lnbmF0dXJl'],
    [`remote: ${ART}?expires=1790000000 ok`, ART],
    [`raw ${ART} token`, ART],
    [`raw ${ART2} token`, ART2],
    [`remote: ${ART2}?expires=1790000000 ok`, ART2],
    ['clone https://user:s3cr3t-pass@acct.artifacts.cloudflare.net/git/ns/r.git', 's3cr3t-pass'],
    ['fetch https://x-access-token:ghs_abcdefghijklmnopqrstuvwxyz0123@github.com/o/r.git', 'ghs_abcdefghijklmnopqrstuvwxyz0123'],
    ['https://ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/o/r', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
    ['Authorization: Basic dXNlcjpwYXNzd29yZA==', 'dXNlcjpwYXNzd29yZA=='],
    ['authorization: token gho_abcdefghijklmnopqrstuvwxyz0123', 'gho_abcdefghijklmnopqrstuvwxyz0123'],
    ['pat github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz here', 'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz'],
    ['GET https://api.example.test/x?access_token=abc123def456&page=2', 'abc123def456'],
    ['wss://host/socket?foo=1&token=s3cr3tvalue', 's3cr3tvalue'],
  ])('removes the secret from %j', (input, secret) => {
    const out = redact(input);
    expect(out).not.toContain(secret);
    expect(out).toContain(REDACTED);
    expect(containsSecret(input)).toBe(true);
    expect(containsSecret(out)).toBe(false);
  });

  it('keeps useful context around redactions', () => {
    expect(redact('Authorization: Bearer abcdefghijklmnop')).toBe(`Authorization: ${REDACTED}`);
    expect(redact('x vc-resource-v1.abc.def y')).toBe(`x vc-resource-v1.${REDACTED} y`);
    expect(redact('https://u:p@host/path')).toBe(`https://${REDACTED}@host/path`);
  });

  it('removes explicitly provided secrets anywhere', () => {
    expect(redact('the value plain-secret-xyz leaked twice: plain-secret-xyz', 'plain-secret-xyz')).toBe(
      `the value ${REDACTED} leaked twice: ${REDACTED}`,
    );
    expect(redact('nothing', '')).toBe('nothing');
  });

  it('is idempotent and leaves ordinary text alone', () => {
    const s = `Authorization: Bearer abcdefghijklmnop and ${ART} and https://a:b@h/`;
    expect(redact(redact(s))).toBe(redact(s));
    const plain = 'git clone https://acct.artifacts.cloudflare.net/git/ns/r.git; ssh git@github.com:o/r';
    expect(redact(plain)).toBe(plain);
    expect(containsSecret(plain)).toBe(false);
  });

  it('reports which kinds of secrets were found', () => {
    expect(findSecrets(`Bearer abcdefghijklmnop ${ART}`).sort()).toEqual(['artifacts-token', 'bearer']);
  });

  it('redactDeep walks objects and arrays without mutating input', () => {
    const input = { a: ['Bearer abcdefghijklmnop', 1, null], b: { c: `url https://u:p@h/` }, d: true };
    const out = redactDeep(input);
    expect(out).toEqual({ a: [`Bearer ${REDACTED}`, 1, null], b: { c: `url https://${REDACTED}@h/` }, d: true });
    expect(input.a[0]).toBe('Bearer abcdefghijklmnop');
  });
});
