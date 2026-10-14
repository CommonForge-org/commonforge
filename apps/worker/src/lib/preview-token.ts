/**
 * Per-preview expiring link tokens (Task 22, AT-37). Shared by the control plane (which mints a
 * token only for callers allowed to see the proposal) and the dedicated preview Worker (which
 * verifies it on every request). Stateless HMAC-SHA256 with `COMMONFORGE_PREVIEW_KEY`, bound to
 * the org, the preview id and the expiry; revocation is the preview's `meta.json` disappearing
 * from R2 (the preview Worker requires it on every request).
 *
 * Token: `<expiry ms base36>.<base64url HMAC>`; path: `/p/<org>/<previewId>/<token>/…`.
 */
import { base64Url } from "./crypto.js";

const enc = new TextEncoder();

export const PREVIEW_TOKEN_RE = /^[0-9a-z]{1,12}\.[A-Za-z0-9_-]{43}$/;

/** Object-store prefix of one preview (the runner writes `site/` and `bundles/<name>/` below it). */
export const previewPrefix = (orgId: string, previewId: string) => `org/${orgId}/previews/${previewId}/`;
export const previewMetaKey = (orgId: string, previewId: string) => `${previewPrefix(orgId, previewId)}meta.json`;

/** What the control plane publishes for the preview Worker when a preview is ready. */
export interface PreviewMeta {
  previewId: string;
  orgId: string;
  expiresAt: number;
  /** non-secret vars for the preview host */
  hostVars: Record<string, string>;
  /** bundle names under `bundles/` (the first one serves `/api/…`) */
  bundles: string[];
}

async function mac(key: string, orgId: string, previewId: string, exp: number): Promise<string> {
  if (!key || key.length < 32) throw new Error("COMMONFORGE_PREVIEW_KEY is not configured (>= 32 bytes)");
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(`cf.preview/1|${orgId}|${previewId}|${exp}`));
  return base64Url(new Uint8Array(sig));
}

export async function mintPreviewToken(key: string, orgId: string, previewId: string, expiresAt: number): Promise<string> {
  return `${expiresAt.toString(36)}.${await mac(key, orgId, previewId, expiresAt)}`;
}

/** The token's expiry if it is genuine for this org+preview and not expired; otherwise null. */
export async function verifyPreviewToken(key: string, orgId: string, previewId: string, token: string, now: number): Promise<number | null> {
  if (!PREVIEW_TOKEN_RE.test(token)) return null;
  const [expPart, sig] = token.split(".") as [string, string];
  const exp = parseInt(expPart, 36);
  if (!Number.isSafeInteger(exp) || exp <= now) return null;
  const expected = await mac(key, orgId, previewId, exp);
  let diff = expected.length ^ sig.length;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ (sig.charCodeAt(i) || 0);
  return diff === 0 ? exp : null;
}
