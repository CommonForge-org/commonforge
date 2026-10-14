import { describe, expect, it } from 'vitest';
import { canonicalJson, hashCanonical, sha256Hex } from './canonical-json.js';
import { CoreError } from './errors.js';

describe('canonicalJson', () => {
  it('sorts keys recursively and drops undefined properties', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: true, y: null }], c: 'x' }, u: undefined })).toBe(
      '{"a":{"c":"x","d":[3,{"y":null,"z":true}]},"b":1}',
    );
  });
  it('is independent of key insertion order', () => {
    expect(canonicalJson({ x: 1, y: 2 })).toBe(canonicalJson({ y: 2, x: 1 }));
  });
  it('does not normalize strings', () => {
    expect(canonicalJson('é')).not.toBe(canonicalJson('e\u0301'));
  });
  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['bigint', 1n],
    ['Date', new Date(0)],
    ['Map', new Map()],
    ['undefined in array', [1, undefined]],
    ['function', () => 1],
    // eslint-disable-next-line no-sparse-arrays
    ['sparse array', [, 1]],
    ['NaN nested', { a: [Number.NaN] }],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['undefined', undefined],
  ])('rejects %s', (_l, v) => {
    expect(() => canonicalJson(v)).toThrow(CoreError);
  });
});

describe('sha256Hex', () => {
  it('matches known vectors', async () => {
    expect(await sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
  it('hashCanonical hashes the canonical form', async () => {
    expect(await hashCanonical({ b: 1, a: 2 })).toBe(await sha256Hex('{"a":2,"b":1}'));
  });
});
