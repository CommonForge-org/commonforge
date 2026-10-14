/** Small WebCrypto helpers: opaque random tokens, keyed hashes for stored secrets, id generators. */
import { bytesToHex } from "@commonforge-org/core";

const enc = new TextEncoder();

export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

export function base64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** `<prefix>_<43 chars of base64url>` (256 bits). */
export function randomToken(prefix: string): string {
  return `${prefix}_${base64Url(randomBytes(32))}`;
}

/** Short random hex id segment: `<prefix>-<hex>`. */
export function newId(prefix: string, bytes = 8): string {
  return `${prefix}-${bytesToHex(randomBytes(bytes))}`;
}

const keyCache = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let k = keyCache.get(secret);
  if (!k) {
    k = crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    keyCache.set(secret, k);
  }
  return k;
}

/** Lowercase hex HMAC-SHA256(secret, `${purpose}|${value}`): how bearer secrets are stored at rest. */
export async function keyedHash(secret: string, purpose: string, value: string): Promise<string> {
  if (!secret || secret.length < 16) throw new Error("server secret is not configured");
  const mac = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(`${purpose}|${value}`));
  return bytesToHex(new Uint8Array(mac));
}

/** Raw 32-byte HMAC-SHA256 (used to derive the asset-token signing key from the session secret). */
export async function deriveKeyBytes(secret: string, purpose: string): Promise<Uint8Array> {
  const mac = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(`cf.derive/1|${purpose}`));
  return new Uint8Array(mac);
}

/** git's blob id (`git hash-object`): SHA-1 of `blob <len>\0` + bytes, as lowercase hex. */
export async function gitBlobSha1(bytes: Uint8Array): Promise<string> {
  const header = enc.encode(`blob ${bytes.length}\0`);
  const all = new Uint8Array(header.length + bytes.length);
  all.set(header);
  all.set(bytes, header.length);
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-1", all)));
}
