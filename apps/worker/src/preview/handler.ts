/**
 * The dedicated preview Worker's request handling (Task 22; owner decision 2026-10-06: path-based
 * previews on their own `workers.dev` Worker, token-gated and expiring, sharing one origin).
 *
 *   /p/<org>/<previewId>/<token>/<path>     static site from R2 (`org/<org>/previews/<id>/site/`)
 *   /p/<org>/<previewId>/<token>/api/<path> the preview host in the preview's container (api bundle,
 *                                           fixture bindings only, no internet)
 *
 * AT-37 (preview-origin boundary):
 * - this Worker is another origin than the app and the API. It never sees their cookies, it forwards
 *   no `Cookie`/`Authorization` header and no `Set-Cookie` back, and preview script cannot plant a
 *   session cookie for the app either: the app's cookie is `__Host-` (no `Domain`, review I-2);
 * - no Service Worker (`worker-src 'none'`, `Service-Worker: script` refused, `Service-Worker-Allowed`
 *   stripped), so one preview cannot intercept another preview's navigations (review I-1);
 * - every request needs a valid per-preview token (HMAC over org, preview id and expiry) AND the
 *   preview's `meta.json` (deleted on revoke) with an unexpired expiry; anything else is a 404;
 * - responses carry a CSP whose `connect-src 'self'` keeps preview code off the app/API origins,
 *   `Referrer-Policy: no-referrer` (the token is in the path), and `no-store`.
 * Shared-origin limitation (P0 shortcut, README): all previews share this one origin, so preview
 * storage (localStorage, IndexedDB) is shared between previews in the same browser; Service Workers
 * and cookies are blocked. A preview domain with per-preview hostnames removes the rest.
 */
import { previewMetaKey, previewPrefix, verifyPreviewToken, type PreviewMeta } from "../lib/preview-token.js";

export interface PreviewBoxClient {
  serve(meta: PreviewMeta, request: Request): Promise<Response>;
}

export interface PreviewHandlerDeps {
  bucket: R2Bucket;
  key: string;
  box(orgId: string, previewId: string): PreviewBoxClient;
  now(): number;
}

const SEG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PATH_RE = /^\/p\/([^/]+)\/([^/]+)\/([^/]+)(\/.*)?$/;

export const PREVIEW_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  // review I-1: no Service Worker may be registered on the shared preview origin
  "worker-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

function secure(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.delete("set-cookie");
  // review I-1: a preview must never widen a Service Worker's scope or wipe other previews' data
  headers.delete("service-worker-allowed");
  headers.delete("clear-site-data");
  headers.set("content-security-policy", PREVIEW_CSP);
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-robots-tag", "noindex, nofollow");
  headers.set("cache-control", "private, no-store");
  headers.set("cross-origin-resource-policy", "same-origin");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

const notFound = () => secure(new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } }));

export async function handlePreviewRequest(request: Request, deps: PreviewHandlerDeps): Promise<Response> {
  const url = new URL(request.url);
  // review I-1: Service Worker script fetches are refused outright (with worker-src 'none' as well)
  if (request.headers.get("service-worker") === "script") return secure(new Response("Service Workers are not allowed on previews", { status: 403 }));
  if (url.pathname === "/" || url.pathname === "/health") {
    return secure(new Response("CommonForge private previews. Open a preview link from CommonForge.", { headers: { "content-type": "text/plain; charset=utf-8" } }));
  }
  const m = PATH_RE.exec(url.pathname);
  if (!m) return notFound();
  const [, org, previewId, token, rest] = m as unknown as [string, string, string, string, string | undefined];
  if (!SEG.test(org) || !SEG.test(previewId)) return notFound();
  const now = deps.now();
  if ((await verifyPreviewToken(deps.key, org, previewId, token, now)) === null) return notFound();
  const metaObj = await deps.bucket.get(previewMetaKey(org, previewId));
  if (!metaObj) return notFound(); // revoked, or never ready
  let meta: PreviewMeta;
  try {
    meta = JSON.parse(await metaObj.text()) as PreviewMeta;
  } catch {
    return notFound();
  }
  if (meta.previewId !== previewId || meta.orgId !== org || !(meta.expiresAt > now)) return notFound();
  if (rest === undefined) return secure(Response.redirect(`${url.origin}${url.pathname}/${url.search}`, 308));

  const path = rest.slice(1);
  if ((path === "api" || path.startsWith("api/")) && meta.bundles.length > 0) {
    const headers = new Headers(request.headers);
    for (const h of ["cookie", "authorization", "cf-connecting-ip", "x-forwarded-for", "cf-ray"]) headers.delete(h);
    const inner = new Request(`http://preview/${path.slice(4)}${url.search}`, {
      method: request.method,
      headers,
      ...(request.method === "GET" || request.method === "HEAD" ? {} : { body: await request.arrayBuffer() }),
    });
    try {
      return secure(await deps.box(org, previewId).serve(meta, inner));
    } catch (e) {
      return secure(new Response(`preview api unavailable: ${String((e as Error)?.message ?? e).slice(0, 200)}`, { status: 502 }));
    }
  }

  if (request.method !== "GET" && request.method !== "HEAD") return secure(new Response("Method not allowed", { status: 405 }));
  if (path.split("/").some((s) => s === ".." || s === ".")) return notFound();
  const site = `${previewPrefix(org, previewId)}site/`;
  let obj = await deps.bucket.get(`${site}${path === "" || path.endsWith("/") ? `${path}index.html` : path}`);
  // single-page fallback for extension-less paths
  if (!obj && !/\.[A-Za-z0-9]+$/.test(path)) obj = await deps.bucket.get(`${site}index.html`);
  if (!obj) return notFound();
  const headers = new Headers();
  headers.set("content-type", obj.httpMetadata?.contentType ?? "application/octet-stream");
  headers.set("etag", obj.httpEtag);
  return secure(new Response(request.method === "HEAD" ? null : obj.body, { headers }));
}
