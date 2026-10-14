/**
 * AT-37 (preview-origin boundary), on the dedicated preview Worker's handler: unauthorized,
 * foreign, tampered, expired and revoked links are denied; preview content never receives
 * platform cookies or credentials, never sets cookies, and is fenced off the app/API origins
 * by CSP. AT-31: the api part is answered by the preview box (fixture host), nothing else.
 */
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { mintPreviewToken, previewMetaKey, type PreviewMeta } from "../src/lib/preview-token.js";
import { handlePreviewRequest, PREVIEW_CSP, type PreviewBoxClient } from "../src/preview/handler.js";

const KEY = "test-preview-key-0123456789abcdef0123456789";
const ORG = "o-aaaaaaaaaaaa";
const PV = "pv-111111111111111111111111";
const PV2 = "pv-222222222222222222222222";
const NOW = Date.now();
const EXP = NOW + 3600_000;

const seen: Array<{ meta: PreviewMeta; url: string; method: string; headers: Record<string, string>; body: string }> = [];
const box: PreviewBoxClient = {
  async serve(meta, request) {
    const headers: Record<string, string> = {};
    request.headers.forEach((v, k) => (headers[k] = v));
    seen.push({ meta, url: request.url, method: request.method, headers, body: await request.text() });
    return new Response(JSON.stringify({ fixture: true }), { headers: { "content-type": "application/json", "set-cookie": "steal=1; Domain=workers.dev" } });
  },
};

const handle = (path: string, init: RequestInit = {}, now = NOW) =>
  handlePreviewRequest(new Request(`https://commonforge-preview.example.workers.dev${path}`, init), { bucket: env.COMMONFORGE_ASSETS, key: KEY, box: () => box, now: () => now });

async function publish(pv: string, expiresAt = EXP) {
  const meta: PreviewMeta = { previewId: pv, orgId: ORG, expiresAt, hostVars: {}, bundles: ["api"] };
  await env.COMMONFORGE_ASSETS.put(previewMetaKey(ORG, pv), JSON.stringify(meta));
  await env.COMMONFORGE_ASSETS.put(`org/${ORG}/previews/${pv}/site/index.html`, `<h1>${pv}</h1>`, { httpMetadata: { contentType: "text/html; charset=utf-8" } });
  await env.COMMONFORGE_ASSETS.put(`org/${ORG}/previews/${pv}/site/assets/app.js`, "console.log(1)", { httpMetadata: { contentType: "text/javascript" } });
}

let tok: string;
let tok2: string;
beforeAll(async () => {
  await publish(PV);
  await publish(PV2);
  tok = await mintPreviewToken(KEY, ORG, PV, EXP);
  tok2 = await mintPreviewToken(KEY, ORG, PV2, EXP);
});

describe("preview Worker (AT-37)", () => {
  it("serves the preview's site with a valid token, with the isolation headers", async () => {
    const r = await handle(`/p/${ORG}/${PV}/${tok}/`);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe(`<h1>${PV}</h1>`);
    expect(r.headers.get("content-security-policy")).toBe(PREVIEW_CSP);
    expect(PREVIEW_CSP).toContain("connect-src 'self'");
    expect(PREVIEW_CSP).toContain("frame-ancestors 'none'");
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    expect(r.headers.get("cache-control")).toBe("private, no-store");
    expect((await handle(`/p/${ORG}/${PV}/${tok}/assets/app.js`)).headers.get("content-type")).toBe("text/javascript");
    // SPA fallback only for extension-less paths
    expect((await handle(`/p/${ORG}/${PV}/${tok}/quotes/42`)).status).toBe(200);
    expect((await handle(`/p/${ORG}/${PV}/${tok}/missing.js`)).status).toBe(404);
    // no trailing slash → redirect into the preview's path
    const red = await handle(`/p/${ORG}/${PV}/${tok}`);
    expect(red.status).toBe(308);
  });

  it.each([
    ["no token", () => `/p/${ORG}/${PV}/`],
    ["garbage token", () => `/p/${ORG}/${PV}/not-a-token/`],
    ["tampered signature", () => `/p/${ORG}/${PV}/${tok.slice(0, -2)}xx/`],
    ["another preview's token", () => `/p/${ORG}/${PV}/${tok2}/`],
    ["another org", () => `/p/o-bbbbbbbbbbbb/${PV}/${tok}/`],
    ["extended expiry with the old signature", () => `/p/${ORG}/${PV}/${(EXP + 86_400_000).toString(36)}.${tok.split(".")[1]}/`],
    ["path traversal", () => `/p/${ORG}/${PV}/${tok}/../../${PV2}/site/index.html`],
    ["the app's paths", () => `/api/me`],
  ])("denies %s", async (_label, path) => {
    const r = await handle(path());
    expect(r.status).toBe(404);
    expect(await r.text()).not.toContain("<h1>");
  });

  it("denies expired links and revoked previews", async () => {
    expect((await handle(`/p/${ORG}/${PV}/${tok}/`, {}, EXP + 1)).status).toBe(404);
    const short = NOW + 1000;
    const pv = "pv-333333333333333333333333";
    await publish(pv, short);
    const t = await mintPreviewToken(KEY, ORG, pv, EXP); // token outlives the preview: meta expiry still wins
    expect((await handle(`/p/${ORG}/${pv}/${t}/`, {}, short + 1)).status).toBe(404);
    await env.COMMONFORGE_ASSETS.delete(previewMetaKey(ORG, pv));
    expect((await handle(`/p/${ORG}/${pv}/${t}/`)).status).toBe(404);
  });

  it("forwards api calls to the preview box without cookies or credentials, and strips Set-Cookie", async () => {
    seen.length = 0;
    const r = await handle(`/p/${ORG}/${PV}/${tok}/api/orders?x=1`, {
      method: "POST",
      headers: { cookie: "cf_session=cfs_victim", authorization: "Bearer cfs_victim", "content-type": "application/json" },
      body: JSON.stringify({ plan: "team", seats: 2 }),
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("set-cookie")).toBeNull();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("http://preview/orders?x=1");
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.headers.cookie).toBeUndefined();
    expect(seen[0]!.headers.authorization).toBeUndefined();
    expect(seen[0]!.body).toBe(JSON.stringify({ plan: "team", seats: 2 }));
    expect(seen[0]!.meta.previewId).toBe(PV);
  });

  it("static paths are read-only", async () => {
    expect((await handle(`/p/${ORG}/${PV}/${tok}/index.html`, { method: "POST", body: "x" })).status).toBe(405);
  });
});

describe("Service Workers on the shared preview origin (review I-1)", () => {
  it("are blocked: CSP worker-src 'none', Service-Worker-Allowed stripped, script fetches refused", async () => {
    expect(PREVIEW_CSP).toContain("worker-src 'none'");
    const evilBox: PreviewBoxClient = {
      serve: async () => new Response("self.addEventListener('fetch', () => {})", { headers: { "content-type": "text/javascript", "service-worker-allowed": "/", "clear-site-data": '"*"' } }),
    };
    const r = await handlePreviewRequest(new Request(`https://commonforge-preview.example.workers.dev/p/${ORG}/${PV}/${tok}/api/sw.js`), { bucket: env.COMMONFORGE_ASSETS, key: KEY, box: () => evilBox, now: () => NOW });
    expect(r.status).toBe(200);
    expect(r.headers.get("service-worker-allowed")).toBeNull();
    expect(r.headers.get("clear-site-data")).toBeNull();
    const reg = await handlePreviewRequest(new Request(`https://commonforge-preview.example.workers.dev/p/${ORG}/${PV}/${tok}/api/sw.js`, { headers: { "service-worker": "script" } }), { bucket: env.COMMONFORGE_ASSETS, key: KEY, box: () => evilBox, now: () => NOW });
    expect(reg.status).toBe(403);
  });
});
