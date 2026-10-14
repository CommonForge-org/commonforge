/**
 * HMAC-SHA256 helpers over WebCrypto (Worker-safe) and key-ring handling shared by job and
 * evidence signatures.
 */
import { bytesToHex } from '@commonforge-org/core';
import { RunnerProtocolError } from './errors.js';

/**
 * A job-signing key. `kid` identifies it for rotation (several keys may be valid at once);
 * `secret` is at least 32 bytes (UTF-8 for strings). Never log or persist a key.
 */
export interface JobSigningKey {
  readonly kid: string;
  readonly secret: string | Uint8Array;
}

/** The keys a verifier accepts: a list (rotation window) or an async resolver by key id. */
export type JobKeyring =
  | readonly JobSigningKey[]
  | ((kid: string) => JobSigningKey | undefined | null | Promise<JobSigningKey | undefined | null>);

export const MIN_KEY_BYTES = 32;
/** Key ids are opaque segments: they appear inside signature strings separated by `:`. */
export const KID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;

function keyBytes(key: JobSigningKey): Uint8Array {
  if (!KID_RE.test(key.kid)) throw new RunnerProtocolError('weak_job_key', `invalid key id ${JSON.stringify(key.kid)}`);
  const bytes = typeof key.secret === 'string' ? new TextEncoder().encode(key.secret) : key.secret;
  if (bytes.length < MIN_KEY_BYTES) throw new RunnerProtocolError('weak_job_key', `key ${key.kid} is shorter than ${MIN_KEY_BYTES} bytes`);
  return bytes;
}

async function importKey(key: JobSigningKey, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', keyBytes(key) as Uint8Array<ArrayBuffer>, { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

/** Raw HMAC-SHA256 of the UTF-8 message. */
export async function hmacSha256(key: JobSigningKey, message: string): Promise<Uint8Array> {
  const k = await importKey(key, 'sign');
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(message)));
}

/** Lowercase hex HMAC-SHA256 of the UTF-8 message. */
export async function hmacSha256Hex(key: JobSigningKey, message: string): Promise<string> {
  const k = await importKey(key, 'sign');
  const mac = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(message));
  return bytesToHex(new Uint8Array(mac));
}

/**
 * Constant-time check of a hex HMAC. WebCrypto `verify` compares in constant time; malformed hex
 * (wrong length or case) is refused before any comparison.
 */
export async function verifyHmacSha256Hex(key: JobSigningKey, message: string, macHex: string): Promise<boolean> {
  if (!HEX64_RE.test(macHex)) return false;
  const mac = new Uint8Array(32);
  for (let i = 0; i < 32; i++) mac[i] = Number.parseInt(macHex.slice(i * 2, i * 2 + 2), 16);
  const k = await importKey(key, 'verify');
  return crypto.subtle.verify('HMAC', k, mac, new TextEncoder().encode(message));
}

/** Constant-time byte comparison (length is not secret). */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** Find the key for `kid` in a keyring; `null` when unknown. */
export async function resolveKey(keyring: JobKeyring, kid: string): Promise<JobSigningKey | null> {
  if (typeof keyring === 'function') return (await keyring(kid)) ?? null;
  return keyring.find((k) => k.kid === kid) ?? null;
}
