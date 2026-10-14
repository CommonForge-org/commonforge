/**
 * AWS SigV4 query presigning (WebCrypto only) for R2's S3 API: one method on one key until the URL
 * expires. `host` is signed (plus any `headers` given, which the client must then send exactly) and
 * the payload is UNSIGNED-PAYLOAD, so the URL limits neither size nor content (spike RESULTS
 * Limits 10): the hash step verifies every upload afterwards. LFS upload URLs also sign
 * `if-none-match: *`, so a URL cannot write a key that already holds an object.
 */
import type { Env } from "../env.js";

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha256 = async (s: string) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, enc.encode(data));
}
/** RFC 3986 encoding as SigV4 wants it (encodeURIComponent leaves !'()* alone). */
export const rfc3986 = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export interface PresignInput {
  method: "GET" | "PUT";
  host: string;
  /** canonical URI: already encoded, starts with "/" */
  path: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  expiresSeconds: number;
  now: Date;
  /** extra headers to sign (lower-case names): the request must carry exactly these values */
  headers?: Record<string, string>;
}

/** The SigV4 canonical request and string to sign of a presigned URL (exported for the tests). */
export function presignParts(o: PresignInput): { amzDate: string; scope: string; canonicalQuery: string; canonicalRequest: string } {
  const amzDate = o.now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const scope = `${day}/${o.region}/${o.service}/aws4_request`;
  const headers: Record<string, string> = { host: o.host };
  for (const [k, v] of Object.entries(o.headers ?? {})) {
    if (k !== k.toLowerCase() || k === "host") throw new Error(`presign: header names are lower-case and not host (${k})`);
    headers[k] = v.trim();
  }
  const names = Object.keys(headers).sort();
  const signedHeaders = names.join(";");
  const q: Record<string, string> = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${o.accessKeyId}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(o.expiresSeconds),
    "X-Amz-SignedHeaders": signedHeaders,
  };
  const canonicalQuery = Object.keys(q)
    .sort()
    .map((k) => `${rfc3986(k)}=${rfc3986(q[k]!)}`)
    .join("&");
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]}\n`).join("");
  const canonicalRequest = [o.method, o.path, canonicalQuery, canonicalHeaders, signedHeaders, "UNSIGNED-PAYLOAD"].join("\n");
  return { amzDate, scope, canonicalQuery, canonicalRequest };
}

export async function presignUrl(o: PresignInput): Promise<string> {
  const { amzDate, scope, canonicalQuery, canonicalRequest } = presignParts(o);
  const day = amzDate.slice(0, 8);
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256(canonicalRequest)].join("\n");
  let k: ArrayBuffer = await hmac(enc.encode(`AWS4${o.secretAccessKey}`), day);
  for (const part of [o.region, o.service, "aws4_request"]) k = await hmac(k, part);
  return `https://${o.host}${o.path}?${canonicalQuery}&X-Amz-Signature=${hex(await hmac(k, stringToSign))}`;
}

export interface R2PresignConfig {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** The R2 S3 credentials, or null when this deployment has none (LFS uploads then answer 503). */
export function r2PresignConfig(env: Env): R2PresignConfig | null {
  const { CF_ACCOUNT_ID: accountId, COMMONFORGE_ASSETS_BUCKET: bucket, COMMONFORGE_R2_ACCESS_KEY_ID: accessKeyId, COMMONFORGE_R2_SECRET_ACCESS_KEY: secretAccessKey } = env;
  return accountId && bucket && accessKeyId && secretAccessKey ? { accountId, bucket, accessKeyId, secretAccessKey } : null;
}

/** Headers an LFS upload URL signs (and the batch response hands to git-lfs as the action's `header`). */
export const CREATE_ONLY_HEADERS = { "if-none-match": "*" } as const;

export function presignR2(cfg: R2PresignConfig, key: string, method: "GET" | "PUT", expiresSeconds: number, now: Date, headers?: Record<string, string>): Promise<string> {
  return presignUrl({
    method,
    host: `${cfg.accountId}.r2.cloudflarestorage.com`,
    path: `/${cfg.bucket}/${key.split("/").map(rfc3986).join("/")}`,
    region: "auto",
    service: "s3",
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    expiresSeconds,
    now,
    ...(headers ? { headers } : {}),
  });
}
