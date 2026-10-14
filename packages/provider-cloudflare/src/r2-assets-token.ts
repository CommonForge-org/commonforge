/**
 * Short-lived HMAC-SHA256 tokens for Worker-served asset URLs (P0 choice instead of R2 presigned
 * URLs: no S3 credentials in the Worker, the grant is re-checked by our own route, and the token
 * names exactly one key and one operation).
 *
 * Format: `v1.<base64url(payload JSON)>.<base64url(HMAC-SHA256(key, "v1." + payloadB64))>`.
 */
import { CoreError } from '@commonforge-org/core';

export type AssetTokenOp = 'get' | 'put';

export interface AssetTokenPayload {
  v: 1;
  /** The single object key this token authorizes. */
  k: string;
  op: AssetTokenOp;
  org: string;
  /** Resource id (get) — omitted for staging uploads. */
  res?: string;
  /** Principal `kind:id` the grant was issued to (audit only). */
  sub?: string;
  /** ReadGrant purpose (audit only). */
  pur?: string;
  /** Expiry, epoch seconds. */
  exp: number;
}

export type AssetTokenErrorCode = 'asset_token_invalid' | 'asset_token_expired' | 'asset_token_scope';

export class AssetTokenError extends CoreError<AssetTokenErrorCode> {
  constructor(code: AssetTokenErrorCode, message?: string) {
    super(code, message);
    this.name = 'AssetTokenError';
  }
}

/** HMAC key material: raw bytes (>= 32) or an imported HMAC-SHA256 `CryptoKey`. */
export type AssetSigningKey = Uint8Array | CryptoKey;

const enc = new TextEncoder();
const dec = new TextDecoder();
const keyCache = new WeakMap<Uint8Array, Promise<CryptoKey>>();

async function hmacKey(key: AssetSigningKey): Promise<CryptoKey> {
  if (!(key instanceof Uint8Array)) return key;
  let p = keyCache.get(key);
  if (!p) {
    if (key.length < 32) throw new AssetTokenError('asset_token_invalid', 'signing key must be at least 32 bytes');
    p = crypto.subtle.importKey('raw', key as Uint8Array<ArrayBuffer>, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    keyCache.set(key, p);
  }
  return p;
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new AssetTokenError('asset_token_invalid', 'bad base64url');
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function signAssetToken(payload: AssetTokenPayload, key: AssetSigningKey): Promise<string> {
  const body = `v1.${base64UrlEncode(enc.encode(JSON.stringify(payload)))}`;
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(key), enc.encode(body)));
  return `${body}.${base64UrlEncode(sig)}`;
}

/**
 * Verify a token for the Worker route that serves/accepts the bytes. Checks the MAC (constant time
 * via WebCrypto), expiry, and that it names exactly `objectKey` and `op` (both required so a route
 * cannot accidentally accept any valid token for any key) and, when given, `organizationId`.
 */
export async function verifyAssetToken(input: {
  token: string;
  key: AssetSigningKey;
  now: Date;
  objectKey: string;
  op: AssetTokenOp;
  organizationId?: string;
}): Promise<AssetTokenPayload> {
  const parts = input.token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') throw new AssetTokenError('asset_token_invalid', 'malformed token');
  const sig = base64UrlDecode(parts[2]!);
  const ok = await crypto.subtle.verify(
    'HMAC',
    await hmacKey(input.key),
    sig as Uint8Array<ArrayBuffer>,
    enc.encode(`${parts[0]}.${parts[1]}`),
  );
  if (!ok) throw new AssetTokenError('asset_token_invalid', 'bad signature');
  let payload: AssetTokenPayload;
  try {
    payload = JSON.parse(dec.decode(base64UrlDecode(parts[1]!))) as AssetTokenPayload;
  } catch {
    throw new AssetTokenError('asset_token_invalid', 'bad payload');
  }
  if (payload.v !== 1 || typeof payload.k !== 'string' || typeof payload.exp !== 'number') {
    throw new AssetTokenError('asset_token_invalid', 'bad payload');
  }
  if (Math.floor(input.now.getTime() / 1000) >= payload.exp) throw new AssetTokenError('asset_token_expired');
  if (payload.k !== input.objectKey) throw new AssetTokenError('asset_token_scope', 'key mismatch');
  if (payload.op !== input.op) throw new AssetTokenError('asset_token_scope', 'op mismatch');
  if (input.organizationId !== undefined && payload.org !== input.organizationId) {
    throw new AssetTokenError('asset_token_scope', 'organization mismatch');
  }
  return payload;
}
