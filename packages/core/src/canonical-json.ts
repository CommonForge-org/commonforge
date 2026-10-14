/**
 * Canonical JSON and SHA-256 helpers used for every content identity in CommonForge.
 *
 * Canonical form (a strict subset of RFC 8785 / JCS sufficient for our data):
 * - object keys sorted by UTF-16 code unit order (JS default sort), no whitespace;
 * - properties whose value is `undefined` are omitted (as `JSON.stringify` does);
 * - strings are serialized with `JSON.stringify` escaping and are NOT Unicode-normalized here
 *   (callers normalize specific fields such as paths and mount names before hashing);
 * - only finite numbers are allowed; integers are the expected case;
 * - arrays keep their order (callers sort arrays that are semantically sets);
 * - `undefined` inside arrays, functions, symbols, bigints, non-finite numbers and
 *   non-plain objects (Date, Map, class instances, typed arrays) are rejected.
 *
 * Worker-safe: uses only `TextEncoder` and `crypto.subtle`.
 */
import { CoreError } from './errors.js';
import { sha256Sync } from './sha256-sync.js';

export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue | undefined };

function isPlainObject(v: object): boolean {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function serialize(value: unknown, path: string): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) {
        throw new CoreError('invalid_canonical_json', `non-finite number at ${path}`);
      }
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        // Index loop (not .map) so sparse-array holes are visited and rejected like undefined.
        const parts: string[] = [];
        for (let i = 0; i < value.length; i++) {
          const item: unknown = value[i];
          if (item === undefined) {
            throw new CoreError('invalid_canonical_json', `undefined or missing array element at ${path}[${i}]`);
          }
          parts.push(serialize(item, `${path}[${i}]`));
        }
        return `[${parts.join(',')}]`;
      }
      if (!isPlainObject(value)) {
        throw new CoreError('invalid_canonical_json', `non-plain object at ${path}`);
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      const parts: string[] = [];
      for (const key of keys) {
        const v = record[key];
        if (v === undefined) continue;
        parts.push(`${JSON.stringify(key)}:${serialize(v, `${path}.${key}`)}`);
      }
      return `{${parts.join(',')}}`;
    }
    default:
      throw new CoreError('invalid_canonical_json', `unsupported ${typeof value} at ${path}`);
  }
}

/** Serialize a JSON-compatible value to its canonical string form. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) {
    throw new CoreError('invalid_canonical_json', 'top-level value is undefined');
  }
  return serialize(value, '$');
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += HEX[b];
  return out;
}

/** Lowercase hex SHA-256 of a UTF-8 string or raw bytes, via WebCrypto. */
export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return bytesToHex(new Uint8Array(digest));
}

/** SHA-256 over the canonical JSON form of `value`. */
export function hashCanonical(value: unknown): Promise<string> {
  return sha256Hex(canonicalJson(value));
}

/** Synchronous lowercase hex SHA-256 of a UTF-8 string or raw bytes (pure TypeScript, no WebCrypto). */
export function sha256HexSync(data: string | Uint8Array): string {
  return bytesToHex(sha256Sync(typeof data === 'string' ? new TextEncoder().encode(data) : data));
}

/** Synchronous SHA-256 over the canonical JSON form of `value`; identical output to {@link hashCanonical}. */
export function hashCanonicalSync(value: unknown): string {
  return sha256HexSync(canonicalJson(value));
}
