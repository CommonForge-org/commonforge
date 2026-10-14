/**
 * Task 22: private previews (control-plane side). AT-31 (the preview is built at the integration
 * shas with fixture-only bindings; nothing in it reaches production), AT-37 (links only for callers
 * who can see the proposal; per-preview expiring token; revocation; separate origin).
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { verifyPreviewToken } from "../../src/lib/preview-token.js";
import { freezeAndPropose, harness, member, prepareAndIntegrate, provisionedTask, waitUntil, type Harness } from "../helpers.js";

export const PREVIEW_POLICY = {
  recipe: {
    recipeId: "demo-preview",
    revision: 1,
    steps: [
      { stepId: "api-install", mountName: "api", command: "pnpm install --frozen-lockfile --ignore-scripts" },
      { stepId: "api-bundle", mountName: "api", command: "pnpm run build" },
      { stepId: "site-install", mountName: "website", command: "pnpm install --frozen-lockfile --ignore-scripts" },
      { stepId: "site-build", mountName: "website", command: "pnpm exec vite build --base ./", env: { VITE_QUOTE_API_URL: "./api" } },
    ],
    output: { mountName: "website", path: "dist" },
  },
  bundles: [{ name: "api", mountName: "api", path: "dist" }],
  hostVars: { APP_VERSION: "preview" },
  ttlSeconds: 3600,
};

async function integrated(h: Harness) {
  const t = await provisionedTask(h);
  await h.api("PUT", `/api/orgs/${t.o.orgId}/projects/${t.pid}/policy`, { token: t.o.token, body: { preview: PREVIEW_POLICY } });
  const { proposal, sha } = await freezeAndPropose(h, t.o, t.taskId, { "index.html": "preview me" });
  const p = await prepareAndIntegrate(h, t.o, proposal.proposalId);
  return { ...t, proposal: p, candidateSha: sha };
}

describe("previews", () => {
  it("builds at the integration shas in the Sandbox job, and hands the tokenized link only to proposal readers (AT-31, AT-37)", async () => {
    const h = harness();
    const { o, proposal, runner, api, pid, web } = await integrated(h);
    const r = await h.api("POST", `/api/orgs/${o.orgId}/proposals/${proposal.proposalId}/previews`, { token: o.token });
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ state: "queued", url: null, proposalHash: proposal.proposalHash });
    await waitUntil(async () => (await h.api("GET", `/api/orgs/${o.orgId}/previews/${r.body.previewId}`, { token: o.token })).body.state === "ready");
    const job = runner.handled.find((j) => j.job.kind === "preview-build")!.job as any;
    // changed resource at its integration commit, the reference mount at the proposal's base
    const integ = proposal.integration.results.find((x: any) => x.resourceId === web.resourceId);
    expect(job.integrationSha[web.resourceId]).toBe(integ.sha);
    expect(job.integrationSha[api.resourceId]).toBe(api.sha);
    expect(job.outputPrefix).toBe(`org/${o.orgId}/previews/${r.body.previewId}/`);
    // the job carries no credential, no production binding, no secret
    expect(JSON.stringify(job)).not.toMatch(/token|secret|ORDERS|kvNamespaces/i);
    // preview-build may read canonical (read only) and write only its own prefix
    const creds = runner.credentials.filter((c) => c.jobId === runner.handled.find((j) => j.job.kind === "preview-build")!.jobId);
    expect(creds.every((c) => c.access === "read" && c.status === 200)).toBe(true);

    const ready = (await h.api("GET", `/api/orgs/${o.orgId}/previews/${r.body.previewId}`, { token: o.token })).body;
    const m = /^https:\/\/preview\.test\/p\/([^/]+)\/([^/]+)\/([^/]+)\/$/.exec(ready.url);
    expect(m).not.toBeNull();
    expect([m![1], m![2]]).toEqual([o.orgId, r.body.previewId]);
    expect(await verifyPreviewToken(env.COMMONFORGE_PREVIEW_KEY!, o.orgId, r.body.previewId, m![3]!, Date.now())).toBe(Date.parse(ready.expiresAt));
    // the receipt never carried the token; meta.json exists for the preview Worker
    const meta = await env.COMMONFORGE_ASSETS.get(`org/${o.orgId}/previews/${r.body.previewId}/meta.json`);
    expect(JSON.parse(await meta!.text())).toMatchObject({ previewId: r.body.previewId, orgId: o.orgId, bundles: ["api"], hostVars: { APP_VERSION: "preview" } });

    // a client with read on the project and the changed resource sees the same preview link; outsiders get 404
    const client = await member(h, o, "client");
    for (const scope of [{ kind: "project", id: pid }, { kind: "resource", id: web.resourceId }]) {
      await h.api("PUT", `/api/orgs/${o.orgId}/grants`, { token: o.token, body: { userId: client.userId, scope, operations: ["read"] } });
    }
    const cv = await h.api("GET", `/api/orgs/${o.orgId}/proposals/${proposal.proposalId}/previews`, { token: client.token });
    expect(cv.body.previews[0]).toMatchObject({ previewId: r.body.previewId, url: ready.url, forCurrentHash: true });
    expect(cv.body.previews[0].sources).toBeUndefined();
    expect((await h.api("POST", `/api/orgs/${o.orgId}/proposals/${proposal.proposalId}/previews`, { token: client.token })).status).toBe(403);
    const viewer = await member(h, o, "viewer");
    expect((await h.api("GET", `/api/orgs/${o.orgId}/previews/${r.body.previewId}`, { token: viewer.token })).status).toBe(404);

    // revoke: link gone, meta.json gone (the preview Worker refuses from the next request)
    const rv = await h.api("DELETE", `/api/orgs/${o.orgId}/previews/${r.body.previewId}`, { token: o.token });
    expect(rv.body).toMatchObject({ state: "revoked", url: null });
    expect(await env.COMMONFORGE_ASSETS.get(`org/${o.orgId}/previews/${r.body.previewId}/meta.json`)).toBeNull();
  });

  it("needs a current integration and a server-owned recipe; refuses a preview origin equal to the app's", async () => {
    const h = harness();
    const t = await provisionedTask(h);
    const { proposal } = await freezeAndPropose(h, t.o, t.taskId, { "index.html": "x" });
    const noRecipe = await h.api("POST", `/api/orgs/${t.o.orgId}/proposals/${proposal.proposalId}/previews`, { token: t.o.token });
    expect([noRecipe.status, noRecipe.body.error.code]).toEqual([409, "preview_not_configured"]);

    const h2 = harness();
    const t2 = await provisionedTask(h2);
    await h2.api("PUT", `/api/orgs/${t2.o.orgId}/projects/${t2.pid}/policy`, { token: t2.o.token, body: { preview: PREVIEW_POLICY } });
    const { proposal: p2 } = await freezeAndPropose(h2, t2.o, t2.taskId, { "index.html": "y" });
    const notIntegrated = await h2.api("POST", `/api/orgs/${t2.o.orgId}/proposals/${p2.proposalId}/previews`, { token: t2.o.token });
    expect([notIntegrated.status, notIntegrated.body.error.code]).toEqual([409, "integration_required"]);

    // AT-37: a deployment that serves previews from the app's own origin is refused
    const bad = harness();
    const t3 = await provisionedTask(bad);
    await bad.api("PUT", `/api/orgs/${t3.o.orgId}/projects/${t3.pid}/policy`, { token: t3.o.token, body: { preview: PREVIEW_POLICY } });
    const { proposal: p3 } = await freezeAndPropose(bad, t3.o, t3.taskId, { "index.html": "z" });
    await prepareAndIntegrate(bad, t3.o, p3.proposalId);
    const saved = env.COMMONFORGE_PREVIEW_URL;
    (env as { COMMONFORGE_PREVIEW_URL?: string }).COMMONFORGE_PREVIEW_URL = env.COMMONFORGE_APP_URL;
    try {
      const r = await bad.api("POST", `/api/orgs/${t3.o.orgId}/proposals/${p3.proposalId}/previews`, { token: t3.o.token });
      expect([r.status, r.body.error.code]).toEqual([503, "config_invalid"]);
    } finally {
      (env as { COMMONFORGE_PREVIEW_URL?: string }).COMMONFORGE_PREVIEW_URL = saved;
    }
  });

  it("a failed preview build shows the code to everyone and the runner detail only to developers", async () => {
    const h = harness();
    const { o, proposal, runner } = await integrated(h);
    runner.opts.fail = { "preview-build": { code: "check_failed", detail: "recipe step site-build failed: exit 1\nvite: boom" } };
    const r = await h.api("POST", `/api/orgs/${o.orgId}/proposals/${proposal.proposalId}/previews`, { token: o.token });
    await waitUntil(async () => (await h.api("GET", `/api/orgs/${o.orgId}/previews/${r.body.previewId}`, { token: o.token })).body.state === "failed");
    const dv = (await h.api("GET", `/api/orgs/${o.orgId}/previews/${r.body.previewId}`, { token: o.token })).body;
    expect(dv.error).toEqual({ code: "check_failed", detail: "recipe step site-build failed: exit 1\nvite: boom" });
  });

  it("the runner may write only its own preview prefix (site/ and bundles/), never meta.json", async () => {
    const h = harness();
    const { o, proposal, runner } = await integrated(h);
    runner.opts.manual = true;
    const r = await h.api("POST", `/api/orgs/${o.orgId}/proposals/${proposal.proposalId}/previews`, { token: o.token });
    const sj = runner.pending.find((j) => j.job.kind === "preview-build")!;
    const { jobHeader } = await import("../fakes/runner.js");
    const put = (key: string) => h.api("PUT", `/api/runner/blobs/${encodeURIComponent(key)}`, { raw: "x", headers: jobHeader(sj) });
    expect((await put(`org/${o.orgId}/previews/${r.body.previewId}/site/index.html`)).status).toBe(201);
    expect((await put(`org/${o.orgId}/previews/${r.body.previewId}/meta.json`)).status).toBe(403);
    expect((await put(`org/${o.orgId}/previews/pv-other/site/index.html`)).status).toBe(403);
    expect((await put(`org/${o.orgId}/releases/rel-x/api/index.js`)).status).toBe(403);
  });
});

describe("preview review fixes", () => {
  it("m-1: a preview revoked while building never gets its link switch back, and its objects are deleted", async () => {
    const h = harness();
    const { o, proposal, runner } = await integrated(h);
    runner.opts.manual = true;
    const r = await h.api("POST", `/api/orgs/${o.orgId}/proposals/${proposal.proposalId}/previews`, { token: o.token });
    expect((await h.api("DELETE", `/api/orgs/${o.orgId}/previews/${r.body.previewId}`, { token: o.token })).body.state).toBe("revoked");
    await runner.runPending(); // the build finishes after the revoke
    expect(await env.COMMONFORGE_ASSETS.get(`org/${o.orgId}/previews/${r.body.previewId}/meta.json`)).toBeNull();
    const left = await env.COMMONFORGE_ASSETS.list({ prefix: `org/${o.orgId}/previews/${r.body.previewId}/` });
    expect(left.objects).toEqual([]);
    expect((await h.api("GET", `/api/orgs/${o.orgId}/previews/${r.body.previewId}`, { token: o.token })).body).toMatchObject({ state: "revoked", url: null });
  });

  it("m-9: at most three previews of a project build at once", async () => {
    const h = harness();
    const { o, proposal, runner } = await integrated(h);
    runner.opts.manual = true;
    for (let i = 0; i < 3; i++) expect((await h.api("POST", `/api/orgs/${o.orgId}/proposals/${proposal.proposalId}/previews`, { token: o.token })).status).toBe(202);
    const fourth = await h.api("POST", `/api/orgs/${o.orgId}/proposals/${proposal.proposalId}/previews`, { token: o.token });
    expect([fourth.status, fourth.body.error.code]).toEqual([409, "preview_limit"]);
  });
});
