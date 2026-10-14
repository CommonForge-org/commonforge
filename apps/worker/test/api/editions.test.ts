/**
 * Client Workspace Editions over HTTP (Task 21): policy → build-edition → grant → session →
 * ZIP download → return (R2 staging → edition-return → candidate → proposal), with the fake runner
 * mirroring the real jobs (apps/runner has the real-git versions of AT-26/AT-28/AT-29).
 *
 * AT-25 (no canonical access), AT-26 (canary + hidden module absent from the edition and from all
 * client-visible responses), AT-28 (ZIP traversal / symlink / ratio, metadata tampering), AT-29
 * (partial vs full returns), AT-30 (edition records its source release and bases; a return
 * against a moved head is refused), O-1 (no raw revision ids for clients).
 */
import { describe, expect, it } from "vitest";
import { crc32, writeZip } from "../../src/lib/zip.js";
import { canonicalNs, freezeAndPropose, harness, member, ownerWithOrg, projectWith, waitUntil, type Harness } from "../helpers.js";
import { FakeRunner } from "./../fakes/runner.js";

const CANARY = "cfcanary-7f3a9d2e-DO-NOT-SHIP";
const HIDDEN = "hidden-module";

const enc = new TextEncoder();
const dec = new TextDecoder();

const SITE = {
  "index.html": "<h1>Quote</h1>\n",
  "src/quote.ts": "export const q = 1;\n",
  "src/quote-view.ts": "export const view = 'v1';\n",
  "package.json": '{"name":"site"}\n',
  "vite.config.ts": "export default {};\n",
  "tests/quote-view.test.ts": "test('v', () => {});\n",
  "tests/quote-contract.test.ts": "test('contract', () => {});\n",
  ".env": "API_KEY=real-secret\n",
  // inside the write prefix `tests`, never published (review M-2)
  "tests/fixtures/customers.json": '{"vip":"ACME-INTERNAL"}\n',
  [`${HIDDEN}/pricing-engine.ts`]: `export const key = '${CANARY}';\n`,
};

const POLICY = {
  name: "Website pages",
  sources: [
    {
      mountName: "website",
      include: ["index.html", "src/**", "tests/quote-view.test.ts", "package.json", "vite.config.ts", ".env"],
      write: ["index.html", "src", "tests", "package.json"],
    },
  ],
  protectedPaths: ["package.json", "vite.config.ts", "tests/quote-contract.test.ts"],
};

/** Canonical website with an old commit holding the canary in history, an api the edition never shows. */
/**
 * The client holds a project grant and its edition grant only: **no** canonical resource grant
 * (ruling I-1). `clientResourceRead` adds one, for the O-1 checks of canonical read routes.
 */
async function world(h: Harness, runnerOpts: ConstructorParameters<typeof FakeRunner>[1] = {}, opts: { clientResourceRead?: boolean } = {}) {
  const runner = new FakeRunner(h, runnerOpts);
  const o = await ownerWithOrg(h);
  const mk = async (name: string, commits: Array<Record<string, string>>) => {
    const r = await h.api("POST", `/api/orgs/${o.orgId}/resources`, { token: o.token, body: { name, provider: "artifacts" } });
    expect(r.status).toBe(201);
    let parent: string[] = [];
    let sha = "";
    for (const files of commits) {
      sha = h.artifacts.makeCommit(files, parent);
      parent = [sha];
      h.artifacts.push(canonicalNs(o.orgId), r.body.resourceId, "main", sha);
    }
    const a = await h.api("POST", `/api/orgs/${o.orgId}/resources/${r.body.resourceId}/adopt-head`, { token: o.token });
    expect(a.status).toBe(200);
    return { resourceId: r.body.resourceId as string, repoId: r.body.coords.repoId as string, sha, revisionId: a.body.revisionId as string };
  };
  // old history: the canary secret in a config file that was later deleted
  const web = await mk("website", [{ ...SITE, "config/secrets.json": `{"token":"${CANARY}"}` }, SITE]);
  const api = await mk("api", [{ "src/app.ts": "export const SECRET_PRICING = 42;\n" }]);
  const pid = await projectWith(h, o, [
    { mountName: "website", resourceId: web.resourceId },
    { mountName: "api", resourceId: api.resourceId, mode: "pinned-reference" },
  ]);
  const client = await member(h, o, "client");
  for (const scope of [{ kind: "project", id: pid }, ...(opts.clientResourceRead ? [{ kind: "resource", id: web.resourceId }] : [])]) {
    expect((await h.api("PUT", `/api/orgs/${o.orgId}/grants`, { token: o.token, body: { userId: client.userId, scope, operations: ["read"] } })).status).toBeLessThan(300);
  }
  return { runner, o, web, api, pid, client };
}

async function publish(h: Harness, w: Awaited<ReturnType<typeof world>>, policy: unknown = POLICY) {
  const e = await h.api("POST", `/api/orgs/${w.o.orgId}/projects/${w.pid}/editions`, { token: w.o.token, body: policy });
  expect(e.status, JSON.stringify(e.body)).toBe(201);
  const editionId = e.body.editionId as string;
  const b = await h.api("POST", `/api/orgs/${w.o.orgId}/editions/${editionId}/builds`, { token: w.o.token });
  expect(b.status).toBe(202);
  await h.drainSteps();
  await waitUntil(async () => (await h.api("GET", `/api/orgs/${w.o.orgId}/editions/${editionId}`, { token: w.o.token })).body.builds[0].state !== "queued");
  expect(w.runner.errors).toEqual([]);
  const g = await h.api("PUT", `/api/orgs/${w.o.orgId}/editions/${editionId}/grants`, { token: w.o.token, body: { userId: w.client.userId } });
  expect(g.status).toBe(201);
  return editionId;
}

async function startUpdate(h: Harness, w: Awaited<ReturnType<typeof world>>, editionId: string, token = w.client.token) {
  const s = await h.api("POST", `/api/orgs/${w.o.orgId}/editions/${editionId}/sessions`, { token, body: { title: "Explain the quote", request: "Add a line under the total" } });
  expect(s.status, JSON.stringify(s.body)).toBe(201);
  return s.body.sessionId as string;
}

/** Download the session's ZIP as raw bytes (the harness decodes bodies as text). */
async function download(h: Harness, orgId: string, sessionId: string, token: string): Promise<{ status: number; files: Record<string, string>; bytes: Uint8Array; headers: Headers }> {
  const { createExecutionContext, waitOnExecutionContext } = await import("cloudflare:test");
  const { env } = await import("cloudflare:workers");
  const ctx = createExecutionContext();
  const res = await h.worker.fetch(new Request(`https://worker.test/api/orgs/${orgId}/edition-sessions/${sessionId}/download`, { headers: { authorization: `Bearer ${token}` } }), env, ctx);
  await waitOnExecutionContext(ctx);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const files: Record<string, string> = {};
  if (res.status === 200) {
    const { readReturnZip, RETURN_ZIP_LIMITS } = await import("../../src/lib/zip.js");
    for (const e of (await readReturnZip(bytes, RETURN_ZIP_LIMITS, null)).entries) files[e.path] = dec.decode(e.data);
  }
  return { status: res.status, files, bytes, headers: res.headers };
}

function zipOf(files: Record<string, string>): Uint8Array {
  return writeZip(Object.entries(files).map(([path, s]) => ({ path, data: enc.encode(s) })));
}

async function sendBack(h: Harness, orgId: string, sessionId: string, token: string, zip: Uint8Array, query = "") {
  return h.api("POST", `/api/orgs/${orgId}/edition-sessions/${sessionId}/returns${query}`, { token, raw: zip, headers: { "content-type": "application/zip", "content-length": String(zip.length) } });
}

/**
 * Run the return through the queue steps and the fake runner until it settles. The runner's result
 * POST updates the return's state before it fails the task and abandons the workspace (failReturn),
 * so wait for the runner to go idle before reading: a settled state must mean a finished handler.
 */
async function settle(h: Harness, w: Awaited<ReturnType<typeof world>>, returnId: string, token: string) {
  const orgId = w.o.orgId;
  const done = new Set(["proposed", "no_changes", "stale", "conflict", "refused", "failed"]);
  for (let i = 0; i < 20; i++) {
    await w.runner.idle();
    await h.drainSteps();
    await w.runner.idle();
    const r = await h.api("GET", `/api/orgs/${orgId}/edition-returns/${returnId}`, { token });
    if (done.has(r.body.state)) {
      await h.drainSteps(); // candidate.prepare
      return (await h.api("GET", `/api/orgs/${orgId}/edition-returns/${returnId}`, { token })).body;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("return did not settle");
}

/** Hand-made ZIP entries (for hostile archives the writer refuses to make). */
function rawZip(entries: Array<{ name: string; data: Uint8Array; mode?: number; method?: 0 | 8; usize?: number; crc?: number }>): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const usize = e.usize ?? e.data.length;
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, e.method ?? 0, true);
    lv.setUint32(14, e.crc ?? crc32(e.data), true);
    lv.setUint32(18, e.data.length, true);
    lv.setUint32(22, usize, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, (3 << 8) | 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, e.method ?? 0, true);
    cv.setUint32(16, e.crc ?? crc32(e.data), true);
    cv.setUint32(20, e.data.length, true);
    cv.setUint32(24, usize, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(38, ((e.mode ?? 0o100644) << 16) >>> 0, true);
    cv.setUint32(42, offset, true);
    cd.set(name, 46);
    parts.push(local, e.data);
    central.push(cd);
    offset += local.length + e.data.length;
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + cdSize + 22);
  let p = 0;
  for (const part of [...parts, ...central, eocd]) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer());
}

describe("editions: policy, build, access (AT-25, AT-26, AT-30)", () => {
  it("a developer configures the policy; the build is one fresh commit of the allowlist in -editions and records its source release and bases", async () => {
    const h = harness();
    const w = await world(h);
    const editionId = await publish(h, w);
    const view = (await h.api("GET", `/api/orgs/${w.o.orgId}/editions/${editionId}`, { token: w.o.token })).body;
    expect(view.state).toBe("ready");
    expect(view.policy.sources[0].write).toEqual(["index.html", "src", "tests", "package.json"]);
    expect(view.repo.namespace).toBe(`commonforge-dev-${w.o.orgId}-editions`);
    // AT-30: the edition records the live release it was published from (none is live in this
    // test → null; see "editions record the live release") and the exact canonical bases
    expect(view.builds[0].sourceReleaseId).toBeNull();
    expect(view.builds[0].canonicalBases).toEqual([{ resourceId: w.web.resourceId, revisionId: w.web.revisionId }]);

    const repo = h.artifacts.repo(view.repo.namespace, view.repo.repoName);
    const sha = repo.refs.get("main")!;
    expect(h.artifacts.commits.get(sha)!.parents).toEqual([]); // fresh history
    // only the allowlist; .env stripped by the default exclude; the hidden module never selected
    expect(Object.keys(h.artifacts.files.get(sha)!).sort()).toEqual(["index.html", "package.json", "src/quote-view.ts", "src/quote.ts", "tests/quote-view.test.ts", "vite.config.ts"]);
    // the create token of the edition repo is never kept
    expect(h.artifacts.activeTokens(view.repo.namespace, view.repo.repoName)).toEqual([]);
    // only the edition repo is written by the job; canonical is read only
    const job = w.runner.handled.find((j) => j.job.kind === "build-edition")!;
    expect(w.runner.credentials.filter((c) => c.jobId === job.jobId).map((c) => [c.repo.split("/")[0]!.split("-").pop(), c.access])).toEqual([
      ["canonical", "read"],
      ["editions", "write"],
    ]);
  });

  it("only owners and developers with write on the sources configure, build and grant; clients see the client view only", async () => {
    const h = harness();
    const w = await world(h);
    const editionId = await publish(h, w);
    const dev = await member(h, w.o, "developer");
    const viewer = await member(h, w.o, "viewer");
    // a developer without grants cannot even see it; a client cannot configure
    expect((await h.api("GET", `/api/orgs/${w.o.orgId}/editions/${editionId}`, { token: dev.token })).status).toBe(404);
    expect((await h.api("POST", `/api/orgs/${w.o.orgId}/projects/${w.pid}/editions`, { token: w.client.token, body: POLICY })).status).toBe(403);
    expect((await h.api("POST", `/api/orgs/${w.o.orgId}/editions/${editionId}/builds`, { token: w.client.token })).status).toBe(403);
    expect((await h.api("PUT", `/api/orgs/${w.o.orgId}/editions/${editionId}/grants`, { token: w.client.token, body: { userId: viewer.userId } })).status).toBe(403);
    expect((await h.api("PUT", `/api/orgs/${w.o.orgId}/editions/${editionId}/grants`, { token: w.o.token, body: { userId: viewer.userId } })).body.error.code).toBe("grant_exceeds_role");
    // the viewer has no edition grant: 404, no existence leak
    expect((await h.api("GET", `/api/orgs/${w.o.orgId}/editions/${editionId}`, { token: viewer.token })).status).toBe(404);
    const c = await h.api("GET", `/api/orgs/${w.o.orgId}/editions/${editionId}`, { token: w.client.token });
    expect(c.status).toBe(200);
    expect(c.body).not.toHaveProperty("policy");
    expect(c.body).not.toHaveProperty("repo");
    expect(c.body).not.toHaveProperty("builds");
    expect(c.body.editable).toEqual(["index.html", "src", "tests", "package.json"]);
    expect(c.body.protected).toEqual(["package.json", "vite.config.ts", "tests/quote-contract.test.ts"]);
    expect(c.body.canStartUpdate).toBe(true);
    // policy validation: only one writable source; overlapping prefixes refused
    const bad = await h.api("POST", `/api/orgs/${w.o.orgId}/projects/${w.pid}/editions`, {
      token: w.o.token,
      body: { name: "x", sources: [{ mountName: "website", include: ["**"], write: ["src"] }, { mountName: "api", include: ["**"], write: ["src"] }] },
    });
    expect(bad.status).toBe(400);
    const glob = await h.api("POST", `/api/orgs/${w.o.orgId}/projects/${w.pid}/editions`, { token: w.o.token, body: { name: "x", sources: [{ mountName: "website", include: ["../x"], write: ["src/**"] }] } });
    expect(glob.status).toBe(400);
  });

  it("AT-25: a client gets a read token on the edition repo only; no canonical coordinates, tokens or tasks", async () => {
    const h = harness();
    const w = await world(h);
    const editionId = await publish(h, w);
    const sessionId = await startUpdate(h, w, editionId);
    const cred = await h.api("POST", `/api/orgs/${w.o.orgId}/edition-sessions/${sessionId}/credential`, { token: w.client.token, body: { ttlSeconds: 600 } });
    expect(cred.status).toBe(200);
    expect(cred.headers.get("cache-control")).toBe("no-store");
    expect(cred.body.scope).toBe("read");
    const where = h.artifacts.tokenByPlaintext(cred.body.secret)!;
    expect(where.ns).toBe(`commonforge-dev-${w.o.orgId}-editions`);
    expect(where.token.scope).toBe("read");
    expect(cred.body.remoteUrl).toContain("-editions/");

    // every token that exists on a canonical repo was minted for runner jobs, never for the client
    for (const [key, repo] of h.artifacts.repos) {
      if (!key.includes("-canonical/")) continue;
      for (const t of repo.tokens) expect(t.plaintext).not.toBe(cred.body.secret);
    }
    // the client cannot reach canonical through any other door
    expect((await h.api("GET", `/api/orgs/${w.o.orgId}/resources/${w.web.resourceId}`, { token: w.client.token })).status).toBe(404);
    expect((await h.api("GET", `/api/orgs/${w.o.orgId}/projects/${w.pid}/tree?mount=website`, { token: w.client.token })).status).toBe(404);
    expect((await h.api("GET", `/api/orgs/${w.o.orgId}/projects/${w.pid}/tasks`, { token: w.client.token })).status).toBe(403);
    const forged = { job: { kind: "seed-workspace" }, jobId: "job-x", issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), credentialBroker: "https://worker.test/api/runner/credential", kid: "k1", sig: "0".repeat(64) };
    const canonical = { kind: "artifacts", namespace: canonicalNs(w.o.orgId), repoName: w.web.resourceId, repoId: w.web.repoId, remoteUrl: h.artifacts.repo(canonicalNs(w.o.orgId), w.web.resourceId).info.remote };
    const broker = await h.api("POST", "/api/runner/credential", { token: w.client.token, body: { signedJob: forged, repo: canonical, access: "read" } });
    expect(broker.status).toBe(403);
    // another client of the org without the edition grant gets nothing
    const other = await member(h, w.o, "client");
    expect((await h.api("GET", `/api/orgs/${w.o.orgId}/edition-sessions/${sessionId}`, { token: other.token })).status).toBe(404);
    expect((await h.api("POST", `/api/orgs/${w.o.orgId}/edition-sessions/${sessionId}/credential`, { token: other.token, body: {} })).status).toBe(404);
    // revoking the edition grant revokes the client's edition tokens
    expect((await h.api("DELETE", `/api/orgs/${w.o.orgId}/editions/${editionId}/grants`, { token: w.o.token, body: { userId: w.client.userId } })).status).toBe(200);
    expect(where.token.state).toBe("revoked");
    expect((await h.api("GET", `/api/orgs/${w.o.orgId}/edition-sessions/${sessionId}`, { token: w.client.token })).status).toBe(404);
  });

  it("AT-26: the canary in old history and the hidden module are absent from the edition, the ZIP and every client-visible response", async () => {
    const h = harness();
    const w = await world(h);
    const editionId = await publish(h, w);
    const sessionId = await startUpdate(h, w, editionId);
    const ed = (await h.api("GET", `/api/orgs/${w.o.orgId}/editions/${editionId}`, { token: w.o.token })).body;
    // every object reachable in the edition repo
    const repo = h.artifacts.repo(ed.repo.namespace, ed.repo.repoName);
    const reachable = [...h.artifacts.objectsIn.get(`${ed.repo.namespace}/${ed.repo.repoName}`)!];
    expect(reachable).toEqual([repo.refs.get("main")]);
    const editionText = JSON.stringify(reachable.map((s) => h.artifacts.files.get(s)));
    const zip = await download(h, w.o.orgId, sessionId, w.client.token);
    expect(zip.status).toBe(200);
    expect(zip.headers.get("content-type")).toBe("application/zip");
    expect(Object.keys(zip.files).sort()).toEqual(["index.html", "package.json", "src/quote-view.ts", "src/quote.ts", "tests/quote-view.test.ts", "vite.config.ts"]);

    // a full client round trip, so the proposal and events are client-visible too
    const ret = await sendBack(h, w.o.orgId, sessionId, w.client.token, zipOf({ "src/quote.ts": "export const q = 2;\n" }));
    expect(ret.status).toBe(202);
    const settled = await settle(h, w, ret.body.returnId, w.client.token);
    expect(settled.state).toBe("proposed");
    // I-1: the client reviews and approves its own update through edition access alone
    const prop = await h.api("GET", `/api/orgs/${w.o.orgId}/proposals/${settled.proposalId}`, { token: w.client.token });
    expect(prop.status).toBe(200);
    expect(prop.body.edition).toEqual({ editionId, name: "Website pages" });
    expect(prop.body.candidates[0].changedPaths).toEqual(["src/quote.ts"]);
    expect((await h.api("POST", `/api/orgs/${w.o.orgId}/proposals/${settled.proposalId}/approvals`, { token: w.client.token, body: { proposalHash: prop.body.proposalHash } })).status).toBe(201);
    // canonical read routes stay closed: no tree, no file, no resource, no versions
    const closed = [
      `/projects/${w.pid}/tree?mount=website`,
      `/projects/${w.pid}/tree?mount=website&path=${HIDDEN}`,
      `/projects/${w.pid}/file?mount=website&path=${HIDDEN}/pricing-engine.ts`,
      `/projects/${w.pid}/file?mount=website&path=.env`,
      `/projects/${w.pid}/file?mount=website&path=src/quote.ts`,
      `/resources/${w.web.resourceId}`,
      `/resources/${w.web.resourceId}/versions`,
      `/resources/${w.api.resourceId}`,
    ];
    const closedBodies = [];
    for (const path of closed) {
      const res = await h.api("GET", `/api/orgs/${w.o.orgId}${path}`, { token: w.client.token });
      expect(res.status, path).toBe(404);
      closedBodies.push(res.body);
    }
    const visible = [
      ...closedBodies,
      prop.body,
      (await h.api("GET", `/api/orgs/${w.o.orgId}/proposals/${settled.proposalId}/approvals`, { token: w.client.token })).body,
      (await h.api("GET", `/api/orgs/${w.o.orgId}/edition-returns/${ret.body.returnId}`, { token: w.client.token })).body,
      (await h.api("GET", `/api/orgs/${w.o.orgId}/events`, { token: w.client.token })).body,
      editionText,
      dec.decode(zip.bytes),
      (await h.api("GET", `/api/orgs/${w.o.orgId}/editions`, { token: w.client.token })).body,
      (await h.api("GET", `/api/orgs/${w.o.orgId}/editions/${editionId}`, { token: w.client.token })).body,
      (await h.api("GET", `/api/orgs/${w.o.orgId}/edition-sessions/${sessionId}`, { token: w.client.token })).body,
      (await h.api("POST", `/api/orgs/${w.o.orgId}/edition-sessions/${sessionId}/credential`, { token: w.client.token, body: {} })).body,
      settled,
      (await h.api("GET", `/api/orgs/${w.o.orgId}/proposals/${settled.proposalId}`, { token: w.client.token })).body,
      (await h.api("GET", `/api/orgs/${w.o.orgId}/proposals?projectId=${w.pid}`, { token: w.client.token })).body,
      (await h.api("GET", `/api/orgs/${w.o.orgId}/events?projectId=${w.pid}`, { token: w.client.token })).body,
      (await h.api("GET", `/api/orgs/${w.o.orgId}/projects/${w.pid}`, { token: w.client.token })).body,
      (await h.api("GET", `/api/orgs/${w.o.orgId}/projects/${w.pid}/snapshot`, { token: w.client.token })).body,
    ]
      .map((x) => (typeof x === "string" ? x : JSON.stringify(x)))
      .join("\n");
    const canonRepoId = h.artifacts.repo(canonicalNs(w.o.orgId), w.web.resourceId).info.id;
    for (const needle of [CANARY, HIDDEN, "real-secret", "SECRET_PRICING", "ACME-INTERNAL", "customers.json", "-canonical", canonRepoId, w.web.sha, `art:`, "-tasks"]) {
      expect(visible, needle).not.toContain(needle);
    }
    // the client's activity includes its own update's events (edition access), nothing more
    const actions = (await h.api("GET", `/api/orgs/${w.o.orgId}/events`, { token: w.client.token })).body.events.map((e: any) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["edition.session_started", "edition.returned", "proposal.created", "proposal.approved"]));
  });

  it("AT-26 tripwire: a canary inside an allowlisted file fails the build; nothing is published", async () => {
    const h = harness();
    const w = await world(h, { canaries: [CANARY] });
    const e = await h.api("POST", `/api/orgs/${w.o.orgId}/projects/${w.pid}/editions`, { token: w.o.token, body: { ...POLICY, sources: [{ ...POLICY.sources[0], include: ["**"] }], exclude: [] } });
    const b = await h.api("POST", `/api/orgs/${w.o.orgId}/editions/${e.body.editionId}/builds`, { token: w.o.token });
    expect(b.status).toBe(202);
    await h.drainSteps();
    await waitUntil(async () => (await h.api("GET", `/api/orgs/${w.o.orgId}/editions/${e.body.editionId}`, { token: w.o.token })).body.builds[0].state !== "queued");
    const view = (await h.api("GET", `/api/orgs/${w.o.orgId}/editions/${e.body.editionId}`, { token: w.o.token })).body;
    expect(view.state).toBe("failed");
    expect(view.builds[0].error).toContain("scope_violation");
    expect(view.ready).toBe(false);
    await h.api("PUT", `/api/orgs/${w.o.orgId}/editions/${e.body.editionId}/grants`, { token: w.o.token, body: { userId: w.client.userId } });
    const s = await h.api("POST", `/api/orgs/${w.o.orgId}/editions/${e.body.editionId}/sessions`, { token: w.client.token, body: { title: "x" } });
    expect(s.status).toBe(409);
    expect(s.body.error.code).toBe("edition_not_ready");
  });
});

describe("client view (O-1, M-8)", () => {
  it("rewrites art:, cand:, gh: and local: ids, whole or embedded", async () => {
    const { clientValue } = await import("../../src/lib/client-view.js");
    const out = clientValue({ a: "gh:acme/site:" + "a".repeat(40), b: "local:repo1:" + "b".repeat(40), c: `moved from art:r1:${"c".repeat(40)} to cand:tw-1:${"d".repeat(40)}`, sha: "x" }) as Record<string, string>;
    expect(out.a).toMatch(/^rev-[0-9a-f]{16}$/);
    expect(out.b).toMatch(/^rev-[0-9a-f]{16}$/);
    expect(out.c).toMatch(/^moved from rev-[0-9a-f]{16} to rev-[0-9a-f]{16}$/);
    expect(out).not.toHaveProperty("sha");
  });
});

describe("editions: returns (AT-28, AT-29, AT-30, O-1)", () => {
  it("a partial return becomes a candidate in a new task workspace and a normal proposal the client can approve and the developer accept", async () => {
    const h = harness();
    const w = await world(h);
    const editionId = await publish(h, w);
    const sessionId = await startUpdate(h, w, editionId);
    const zip = await download(h, w.o.orgId, sessionId, w.client.token);
    // the client edits one file in their tool and sends back only that file (partial, the default)
    const ret = await sendBack(h, w.o.orgId, sessionId, w.client.token, zipOf({ ...zip.files, "src/quote.ts": "export const q = 2; // explained\n" }), "?tool=cursor");
    expect(ret.status, JSON.stringify(ret.body)).toBe(202);
    expect(ret.body.changes).toEqual([{ path: "src/quote.ts", kind: "modified" }]);
    expect(ret.body).not.toHaveProperty("taskId");
    const r = await settle(h, w, ret.body.returnId, w.client.token);
    expect(r.state).toBe("proposed");
    expect(w.runner.errors).toEqual([]);

    // the runner job: canonical read, the fresh task repo write; never the edition or canonical write
    const job = w.runner.handled.find((j) => j.job.kind === "edition-return")!;
    expect(w.runner.credentials.filter((c) => c.jobId === job.jobId).map((c) => [c.repo.split("/")[0]!.split("-").pop(), c.access])).toEqual([
      ["canonical", "read"],
      ["tasks", "write"],
    ]);
    // developer view: the task, its frozen candidate, changed paths computed server-side
    const dev = (await h.api("GET", `/api/orgs/${w.o.orgId}/edition-returns/${ret.body.returnId}`, { token: w.o.token })).body;
    const task = (await h.api("GET", `/api/tasks/${dev.taskId}`, { token: w.o.token })).body;
    expect(task.state).toBe("submitted");
    expect(task.candidates[0].changedPaths).toEqual(["src/quote.ts"]);
    const candSha = task.candidates[0].sha;
    expect(h.artifacts.files.get(candSha)!["src/quote.ts"]).toBe("export const q = 2; // explained\n");
    // untouched canonical files (also ones the edition never published) are preserved
    expect(h.artifacts.files.get(candSha)![`${HIDDEN}/pricing-engine.ts`]).toContain(CANARY);
    expect(h.artifacts.commits.get(candSha)!.parents).toEqual([w.web.sha]);

    // proposal flow: prepared → integrate → client approves → developer accepts
    const p0 = (await h.api("GET", `/api/orgs/${w.o.orgId}/proposals/${r.proposalId}`, { token: w.o.token })).body;
    expect(p0.state).toBe("prepared");
    expect((await h.api("POST", `/api/orgs/${w.o.orgId}/proposals/${r.proposalId}/integrate`, { token: w.o.token })).status).toBe(202);
    await waitUntil(async () => (await h.api("GET", `/api/orgs/${w.o.orgId}/proposals/${r.proposalId}`, { token: w.o.token })).body.integration?.forCurrentHash === true);
    const pc = (await h.api("GET", `/api/orgs/${w.o.orgId}/proposals/${r.proposalId}`, { token: w.client.token })).body;
    expect(pc.proposalHash).toBe(p0.proposalHash);
    expect((await h.api("POST", `/api/orgs/${w.o.orgId}/proposals/${r.proposalId}/approvals`, { token: w.client.token, body: { proposalHash: pc.proposalHash } })).status).toBe(201);
    const acc = await h.api("POST", `/api/orgs/${w.o.orgId}/proposals/${r.proposalId}/accept`, { token: w.o.token, body: { idempotencyKey: "edition-accept-1" } });
    expect(acc.status, JSON.stringify(acc.body)).toBe(200);
  });

  it("O-1: clients never receive raw revision ids; developers still do", async () => {
    const h = harness();
    const w = await world(h, {}, { clientResourceRead: true });
    const editionId = await publish(h, w);
    const sessionId = await startUpdate(h, w, editionId);
    const ret = await sendBack(h, w.o.orgId, sessionId, w.client.token, zipOf({ "index.html": "<h1>Better</h1>\n" }));
    const r = await settle(h, w, ret.body.returnId, w.client.token);
    const asClient = (await h.api("GET", `/api/orgs/${w.o.orgId}/proposals/${r.proposalId}`, { token: w.client.token })).body;
    const asOwner = (await h.api("GET", `/api/orgs/${w.o.orgId}/proposals/${r.proposalId}`, { token: w.o.token })).body;
    expect(asOwner.resourceChanges[0].baseRevision).toBe(w.web.revisionId);
    expect(asClient.resourceChanges[0].baseRevision).toMatch(/^rev-[0-9a-f]{16}$/);
    // stable: the candidate and its change still match up for the client
    expect(asClient.candidates[0].candidateId).toBe(asClient.resourceChanges[0].candidateId);
    expect(asClient.candidates[0]).not.toHaveProperty("taskWorkspaceId");
    expect(asClient.candidates[0]).not.toHaveProperty("sha");
    expect(asClient.candidates[0].submitter).toEqual({ kind: "user" });
    for (const path of [`/proposals/${r.proposalId}`, `/projects/${w.pid}/snapshot`, `/resources/${w.web.resourceId}`, `/resources/${w.web.resourceId}/versions`, `/projects/${w.pid}/tree?mount=website`]) {
      const res = await h.api("GET", `/api/orgs/${w.o.orgId}${path}`, { token: w.client.token });
      expect(res.status, path).toBe(200);
      expect(JSON.stringify(res.body), path).not.toMatch(/art:|cand:/);
    }
    const file = await h.api("GET", `/api/orgs/${w.o.orgId}/projects/${w.pid}/file?mount=website&path=index.html`, { token: w.client.token });
    expect(file.headers.get("x-commonforge-revision")).toMatch(/^rev-/);
    expect((await h.api("GET", `/api/orgs/${w.o.orgId}/projects/${w.pid}/snapshot`, { token: w.o.token })).body.entries[0].revisionId).toMatch(/^art:/);
  });

  it("AT-29: partial keeps omitted files; full deletes them; explicit deletions and renames are reported exactly", async () => {
    const h = harness();
    const w = await world(h);
    const editionId = await publish(h, w);
    const sessionId = await startUpdate(h, w, editionId);
    const { files } = await download(h, w.o.orgId, sessionId, w.client.token);

    // partial: only the changed file; everything else is kept as is
    const partial = await sendBack(h, w.o.orgId, sessionId, w.client.token, zipOf({ "src/quote.ts": "export const q = 3;\n" }), "?mode=partial");
    expect(partial.status).toBe(202);
    expect(partial.body.changes).toEqual([{ path: "src/quote.ts", kind: "modified" }]);
    expect(partial.body.keptAsIs).toBe(5);

    // partial with an explicit deletion intent
    const del = await sendBack(h, w.o.orgId, sessionId, w.client.token, zipOf({ "src/quote.ts": "export const q = 4;\n" }), "?mode=partial&delete=src/quote-view.ts");
    expect(del.body.changes).toEqual([
      { path: "src/quote-view.ts", kind: "deleted" },
      { path: "src/quote.ts", kind: "modified" },
    ]);

    // full: a published file missing from the upload is a deletion; an identical file under a new name is a rename
    const { "src/quote-view.ts": moved, "index.html": _gone, ...rest } = files;
    const full = await sendBack(h, w.o.orgId, sessionId, w.client.token, zipOf({ ...rest, "src/views/quote-view.ts": moved! }), "?mode=full");
    expect(full.status).toBe(202);
    expect(full.body.changes).toEqual([
      { path: "index.html", kind: "deleted" },
      { path: "src/views/quote-view.ts", kind: "renamed", oldPath: "src/quote-view.ts" },
    ]);
    const r = await settle(h, w, full.body.returnId, w.client.token);
    expect(r.state).toBe("proposed");
    const dev = (await h.api("GET", `/api/orgs/${w.o.orgId}/edition-returns/${full.body.returnId}`, { token: w.o.token })).body;
    const task = (await h.api("GET", `/api/tasks/${dev.taskId}`, { token: w.o.token })).body;
    const tree = h.artifacts.files.get(task.candidates[0].sha)!;
    expect(tree["index.html"]).toBeUndefined();
    expect(tree["src/views/quote-view.ts"]).toBe(SITE["src/quote-view.ts"]);
    expect(tree["src/quote-view.ts"]).toBeUndefined();
    // unpublished files are never deleted by a full return
    expect(tree[".env"]).toBe(SITE[".env"]);
    expect(tree["tests/quote-contract.test.ts"]).toBe(SITE["tests/quote-contract.test.ts"]);
  });

  it("AT-28: traversal, symlinks, special files and zip bombs refuse the whole upload; nothing is staged", async () => {
    const h = harness();
    const w = await world(h);
    const editionId = await publish(h, w);
    const sessionId = await startUpdate(h, w, editionId);
    const ok = enc.encode("export const q = 9;\n");
    const zeros = new Uint8Array(2 * 1024 * 1024);
    const bomb = await deflate(zeros);
    const cases: Array<[string, Uint8Array, string]> = [
      ["traversal", rawZip([{ name: "src/quote.ts", data: ok }, { name: "../api/src/app.ts", data: ok }]), "path_escape"],
      ["absolute", rawZip([{ name: "/etc/passwd", data: ok }]), "path_escape"],
      ["symlink", rawZip([{ name: "src/link.ts", data: enc.encode("../../api/src/app.ts"), mode: 0o120777 }]), "symlink"],
      ["fifo", rawZip([{ name: "src/pipe", data: new Uint8Array(), mode: 0o010644 }]), "special_file"],
      ["ratio", rawZip([{ name: "src/big.ts", data: bomb, method: 8, usize: zeros.length }]), "ratio_exceeded"],
      ["backslash", rawZip([{ name: "src\\..\\..\\x", data: ok }]), "invalid_path"],
    ];
    const jobsBefore = h.runnerJobs.length;
    for (const [label, zip, reason] of cases) {
      const r = await sendBack(h, w.o.orgId, sessionId, w.client.token, zip);
      expect(r.status, label).toBe(400);
      expect(r.body.error.code, label).toBe("zip_refused");
      expect(JSON.stringify(r.body.error.details), label).toContain(reason);
    }
    const garbage = await sendBack(h, w.o.orgId, sessionId, w.client.token, enc.encode("not a zip at all, sorry"));
    expect(garbage.body.error.code).toBe("zip_refused");
    expect(h.runnerJobs.length).toBe(jobsBefore);
    const s = (await h.api("GET", `/api/orgs/${w.o.orgId}/edition-sessions/${sessionId}`, { token: w.client.token })).body;
    expect(s.returns).toEqual([]);
  });

  it("AT-28: protected files, metadata tampering and escaping deletions are blocked; the manifest stays the server's", async () => {
    const h = harness();
    const w = await world(h);
    const editionId = await publish(h, w);
    const sessionId = await startUpdate(h, w, editionId);
    // only blocked changes: nothing to return
    const only = await sendBack(h, w.o.orgId, sessionId, w.client.token, zipOf({ "package.json": '{"name":"site","scripts":{"test":"exit 0"}}\n', "tests/quote-contract.test.ts": "// weakened\n" }));
    expect(only.status).toBe(409);
    expect(only.body.error.code).toBe("no_allowed_changes");
    expect(only.body.error.details.blocked).toEqual([
      { path: "package.json", reason: "protected" },
      { path: "tests/quote-contract.test.ts", reason: "protected" },
    ]);
    // a mix: the allowed edit goes ahead; tampering is reported, never applied
    const mixed = await sendBack(
      h,
      w.o.orgId,
      sessionId,
      w.client.token,
      zipOf({
        "src/quote.ts": "export const q = 5;\n",
        ".commonforge/edition.json": JSON.stringify({ mappings: [{ editionPathPrefix: "", resourceId: w.api.resourceId, writable: true }] }),
        "vite.config.ts": "export default { evil: true };\n",
        "README.md": "not in the write allowlist\n",
      }),
      "?delete=../api/src/app.ts",
    );
    expect(mixed.status, JSON.stringify(mixed.body)).toBe(202);
    expect(mixed.body.changes).toEqual([{ path: "src/quote.ts", kind: "modified" }]);
    expect(mixed.body.blocked).toEqual([
      { path: ".commonforge/edition.json", reason: "read_only" },
      { path: "README.md", reason: "read_only" },
      // not in the write allowlist (read_only is decided before protected)
      { path: "vite.config.ts", reason: "read_only" },
    ]);
    expect(mixed.body.unknownDeletions).toEqual(["../api/src/app.ts"]);
    const r = await settle(h, w, mixed.body.returnId, w.client.token);
    expect(r.state).toBe("proposed");
    const dev = (await h.api("GET", `/api/orgs/${w.o.orgId}/edition-returns/${mixed.body.returnId}`, { token: w.o.token })).body;
    const task = (await h.api("GET", `/api/tasks/${dev.taskId}`, { token: w.o.token })).body;
    expect(task.candidates[0].changedPaths).toEqual(["src/quote.ts"]);
    // the api resource is untouched and never part of the job
    const job = w.runner.handled.find((j) => j.job.kind === "edition-return")!.job as any;
    expect(JSON.stringify(job)).not.toContain(w.api.resourceId);
    // someone else's session cannot be returned into
    const other = await member(h, w.o, "client");
    await h.api("PUT", `/api/orgs/${w.o.orgId}/editions/${editionId}/grants`, { token: w.o.token, body: { userId: other.userId } });
    expect((await sendBack(h, w.o.orgId, sessionId, other.token, zipOf({ "src/quote.ts": "x\n" }))).status).toBe(404);
  });

  it("M-4: only the download's own root folder is unwrapped; a genuinely new top-level folder is kept; OS metadata is ignored", async () => {
    const h = harness();
    const w = await world(h);
    const editionId = await publish(h, w, { ...POLICY, sources: [{ ...POLICY.sources[0], write: [...POLICY.sources[0]!.write, "components"] }] });
    const sessionId = await startUpdate(h, w, editionId);
    const session = (await h.api("GET", `/api/orgs/${w.o.orgId}/edition-sessions/${sessionId}`, { token: w.client.token })).body;
    const zip = await download(h, w.o.orgId, sessionId, w.client.token);
    expect(zip.headers.get("content-disposition")).toContain(`${session.downloadRoot}.zip`);
    const root = session.downloadRoot as string;
    const wrapped: Record<string, string> = { "__MACOSX/x/._index.html": "junk", [`${root}/.DS_Store`]: "junk" };
    for (const [p, c] of Object.entries(zip.files)) wrapped[`${root}/${p}`] = p === "index.html" ? "<h1>Wrapped</h1>\n" : c;
    const r = await sendBack(h, w.o.orgId, sessionId, w.client.token, zipOf(wrapped), "?mode=full");
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(r.body.strippedFolder).toBe(root);
    expect(r.body.changes).toEqual([{ path: "index.html", kind: "modified" }]);
    expect(r.body.ignored.sort()).toEqual(["__MACOSX/x/._index.html", `${root}/.DS_Store`].sort());
    // a partial return that only adds a new folder is not flattened
    const added = await sendBack(h, w.o.orgId, sessionId, w.client.token, zipOf({ "components/Button.tsx": "export const B = 1;\n" }));
    expect(added.status, JSON.stringify(added.body)).toBe(202);
    expect(added.body.strippedFolder).toBeNull();
    expect(added.body.changes).toEqual([{ path: "components/Button.tsx", kind: "added" }]);
  });

  it("I-2, M-2, M-3: case variants, adds onto unpublished files and excluded paths are blocked without telling what exists", async () => {
    const h = harness();
    const w = await world(h);
    const editionId = await publish(h, w);
    const sessionId = await startUpdate(h, w, editionId);
    const r = await sendBack(
      h,
      w.o.orgId,
      sessionId,
      w.client.token,
      zipOf({
        "src/quote.ts": "export const q = 11;\n",
        "tests/Quote-View.test.ts": "// case shadow of a published file\n",
        "tests/Quote-Contract.test.ts": "// case shadow of the protected (unpublished) contract test\n",
        "src/.env.production": "API_KEY=client-guess\n",
      }),
    );
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(r.body.changes).toEqual([{ path: "src/quote.ts", kind: "modified" }]);
    expect(r.body.blocked).toEqual([
      { path: "src/.env.production", reason: "protected" },
      { path: "tests/Quote-Contract.test.ts", reason: "protected" },
      { path: "tests/Quote-View.test.ts", reason: "case_collision" },
    ]);
    // an add onto an unpublished existing file answers the same whether the guess is right or not
    const outcomes = [];
    for (const guess of [SITE["tests/fixtures/customers.json"], '{"vip":"nobody"}\n']) {
      const ret = await sendBack(h, w.o.orgId, sessionId, w.client.token, zipOf({ "index.html": `<h1>${guess.length}</h1>\n`, "tests/fixtures/customers.json": guess }));
      expect(ret.status).toBe(202);
      const done = await settle(h, w, ret.body.returnId, w.client.token);
      outcomes.push({ state: done.state, changes: done.changes, blocked: done.blocked });
    }
    expect(outcomes[0]).toEqual(outcomes[1]);
    expect(outcomes[0]).toEqual({ state: "proposed", changes: [{ path: "index.html", kind: "modified" }], blocked: [{ path: "tests/fixtures/customers.json", reason: "not_mapped" }] });
  });

  it("R-1: a file over a folder or a path below a file never replaces canonical entries (fixture `tests` example)", async () => {
    const h = harness();
    const w = await world(h);
    const editionId = await publish(h, w);
    const sessionId = await startUpdate(h, w, editionId);
    // published folder `tests/` (core): refused in the preview already
    const pre = await sendBack(h, w.o.orgId, sessionId, w.client.token, zipOf({ "index.html": "<h1>R1</h1>\n", tests: "flat file over the tests folder\n", "Src/new.ts": "case variant of a published folder\n" }));
    expect(pre.status, JSON.stringify(pre.body)).toBe(202);
    expect(pre.body.blocked).toEqual([
      { path: "Src/new.ts", reason: "path_conflict" },
      { path: "tests", reason: "path_conflict" },
    ]);
    // unpublished folder / file (runner): blocked as not_mapped, like any path outside the edition
    for (const path of ["tests/fixtures", "tests/fixtures/customers.json/x", "tests/Fixtures/new.json"]) {
      const ret = await sendBack(h, w.o.orgId, sessionId, w.client.token, zipOf({ "index.html": `<h1>${path}</h1>\n`, [path]: "x\n" }));
      expect(ret.status, path).toBe(202);
      expect(ret.body.changes.map((c: any) => c.path).sort(), path).toEqual(["index.html", path].sort());
      const done = await settle(h, w, ret.body.returnId, w.client.token);
      expect(done.state, path).toBe("proposed");
      expect(done.changes, path).toEqual([{ path: "index.html", kind: "modified" }]);
      expect(done.blocked, path).toEqual([{ path, reason: "not_mapped" }]);
      const dev = (await h.api("GET", `/api/orgs/${w.o.orgId}/edition-returns/${ret.body.returnId}`, { token: w.o.token })).body;
      const tree = h.artifacts.files.get((await h.api("GET", `/api/tasks/${dev.taskId}`, { token: w.o.token })).body.candidates[0].sha)!;
      expect(tree["tests/fixtures/customers.json"]).toBe(SITE["tests/fixtures/customers.json"]);
      expect(tree["tests/quote-contract.test.ts"]).toBe(SITE["tests/quote-contract.test.ts"]);
      // the client's view never names the unpublished file
      const prop = (await h.api("GET", `/api/orgs/${w.o.orgId}/proposals/${done.proposalId}`, { token: w.client.token })).body;
      expect(JSON.stringify(prop)).not.toContain("customers.json");
    }
  });

  it("full returns that match none of the working copy are refused; a client's approval stops counting without edition access (m-2)", async () => {
    const h = harness();
    const w = await world(h);
    const editionId = await publish(h, w);
    const sessionId = await startUpdate(h, w, editionId);
    const { files } = await download(h, w.o.orgId, sessionId, w.client.token);
    const renamed: Record<string, string> = {};
    for (const [p, c] of Object.entries(files)) renamed[`my-copy/${p}`] = c;
    const full = await sendBack(h, w.o.orgId, sessionId, w.client.token, zipOf(renamed), "?mode=full");
    expect(full.status).toBe(400);
    expect(full.body.error.code).toBe("full_return_unmatched");

    const ret = await sendBack(h, w.o.orgId, sessionId, w.client.token, zipOf({ "src/quote.ts": "export const q = 12;\n" }));
    const done = await settle(h, w, ret.body.returnId, w.client.token);
    const p = (await h.api("GET", `/api/orgs/${w.o.orgId}/proposals/${done.proposalId}`, { token: w.client.token })).body;
    expect((await h.api("POST", `/api/orgs/${w.o.orgId}/proposals/${done.proposalId}/integrate`, { token: w.o.token })).status).toBe(202);
    await waitUntil(async () => (await h.api("GET", `/api/orgs/${w.o.orgId}/proposals/${done.proposalId}`, { token: w.o.token })).body.integration?.forCurrentHash === true);
    expect((await h.api("POST", `/api/orgs/${w.o.orgId}/proposals/${done.proposalId}/approvals`, { token: w.client.token, body: { proposalHash: p.proposalHash } })).status).toBe(201);
    await h.api("DELETE", `/api/orgs/${w.o.orgId}/editions/${editionId}/grants`, { token: w.o.token, body: { userId: w.client.userId } });
    const acc = await h.api("POST", `/api/orgs/${w.o.orgId}/proposals/${done.proposalId}/accept`, { token: w.o.token, body: { idempotencyKey: "edition-accept-m2" } });
    expect(acc.status).toBe(409);
    expect(acc.body.error.code).toBe("approval_invalid");
  });

  it("M-5: a build requested before a policy change is never promoted", async () => {
    const h = harness();
    const w = await world(h, { manual: true });
    const e = await h.api("POST", `/api/orgs/${w.o.orgId}/projects/${w.pid}/editions`, { token: w.o.token, body: POLICY });
    await h.api("POST", `/api/orgs/${w.o.orgId}/editions/${e.body.editionId}/builds`, { token: w.o.token });
    await h.drainSteps();
    await h.api("PUT", `/api/orgs/${w.o.orgId}/editions/${e.body.editionId}/policy`, { token: w.o.token, body: { ...POLICY, sources: [{ ...POLICY.sources[0], include: ["index.html", "src/**"], write: ["src"] }] } });
    await w.runner.runPending();
    const view = (await h.api("GET", `/api/orgs/${w.o.orgId}/editions/${e.body.editionId}`, { token: w.o.token })).body;
    expect(view.builds[0].state).toBe("ready");
    expect(view.ready).toBe(false);
    expect(view.state).toBe("draft");
  });

  it("M-6, M-7: edition events reach only edition users; demotion to viewer or removal ends edition access", async () => {
    const h = harness();
    const w = await world(h);
    const editionId = await publish(h, w);
    await startUpdate(h, w, editionId);
    // another client of the same project, without the edition grant
    const other = await member(h, w.o, "client");
    await h.api("PUT", `/api/orgs/${w.o.orgId}/grants`, { token: w.o.token, body: { userId: other.userId, scope: { kind: "project", id: w.pid }, operations: ["read"] } });
    const theirs = (await h.api("GET", `/api/orgs/${w.o.orgId}/events`, { token: other.token })).body.events;
    expect(theirs.filter((e: any) => e.subject.kind === "edition")).toEqual([]);
    expect((await h.api("GET", `/api/orgs/${w.o.orgId}/events`, { token: w.client.token })).body.events.some((e: any) => e.action === "edition.session_started")).toBe(true);
    // demotion to viewer: grant and session access gone
    const sessionId = await startUpdate(h, w, editionId);
    await h.api("POST", `/api/orgs/${w.o.orgId}/edition-sessions/${sessionId}/credential`, { token: w.client.token, body: {} });
    expect((await h.api("PATCH", `/api/orgs/${w.o.orgId}/members/${w.client.userId}`, { token: w.o.token, body: { role: "viewer" } })).status).toBe(200);
    expect((await h.api("GET", `/api/orgs/${w.o.orgId}/editions/${editionId}/grants`, { token: w.o.token })).body.grants).toEqual([]);
    expect((await h.api("GET", `/api/orgs/${w.o.orgId}/edition-sessions/${sessionId}`, { token: w.client.token })).status).toBe(404);
    const ed = (await h.api("GET", `/api/orgs/${w.o.orgId}/editions/${editionId}`, { token: w.o.token })).body;
    expect(h.artifacts.activeTokens(ed.repo.namespace, ed.repo.repoName)).toEqual([]);
    // removal of another grant holder
    await h.api("PUT", `/api/orgs/${w.o.orgId}/editions/${editionId}/grants`, { token: w.o.token, body: { userId: other.userId } });
    expect((await h.api("DELETE", `/api/orgs/${w.o.orgId}/members/${other.userId}`, { token: w.o.token })).status).toBe(200);
    expect((await h.api("GET", `/api/orgs/${w.o.orgId}/editions/${editionId}/grants`, { token: w.o.token })).body.grants).toEqual([]);
  });

  it("project access set to none ends the person's grants on that project's editions and revokes their edition tokens; other projects' editions are kept", async () => {
    const h = harness();
    const w = await world(h);
    const editionId = await publish(h, w);
    // the same folder in a second project with its own edition, also granted to the client
    const pid2 = await projectWith(h, w.o, [{ mountName: "website", resourceId: w.web.resourceId }]);
    const otherEdition = await publish(h, { ...w, pid: pid2 });
    const sessionId = await startUpdate(h, w, editionId);
    const cred = await h.api("POST", `/api/orgs/${w.o.orgId}/edition-sessions/${sessionId}/credential`, { token: w.client.token, body: {} });
    expect(cred.status).toBe(200);
    const otherSession = await startUpdate(h, w, otherEdition);
    const otherCred = await h.api("POST", `/api/orgs/${w.o.orgId}/edition-sessions/${otherSession}/credential`, { token: w.client.token, body: {} });
    expect(otherCred.status).toBe(200);

    const put = await h.api("PUT", `/api/orgs/${w.o.orgId}/projects/${w.pid}/access`, { token: w.o.token, body: { userId: w.client.userId, level: "none" } });
    expect(put.status).toBe(200);
    expect((await h.api("GET", `/api/orgs/${w.o.orgId}/editions/${editionId}/grants`, { token: w.o.token })).body.grants).toEqual([]);
    expect(h.artifacts.tokenByPlaintext(cred.body.secret)!.token.state).toBe("revoked");
    expect((await h.api("GET", `/api/orgs/${w.o.orgId}/editions/${editionId}`, { token: w.client.token })).status).toBe(404);
    expect((await h.api("GET", `/api/orgs/${w.o.orgId}/edition-sessions/${sessionId}`, { token: w.client.token })).status).toBe(404);
    expect((await h.api("POST", `/api/orgs/${w.o.orgId}/editions/${editionId}/sessions`, { token: w.client.token, body: { title: "again", request: "" } })).status).toBe(404);
    const revoked = (await h.api("GET", `/api/orgs/${w.o.orgId}/events`, { token: w.o.token })).body.events.filter((e: any) => e.action === "edition.grant_revoked");
    expect(revoked.map((e: any) => [e.subject.id, e.detail?.userId])).toEqual([[editionId, w.client.userId]]);
    // the other project's edition is untouched
    expect((await h.api("GET", `/api/orgs/${w.o.orgId}/editions/${otherEdition}/grants`, { token: w.o.token })).body.grants.map((g: any) => g.userId)).toEqual([w.client.userId]);
    expect(h.artifacts.tokenByPlaintext(otherCred.body.secret)!.token.state).toBe("active");
    expect((await h.api("GET", `/api/orgs/${w.o.orgId}/edition-sessions/${otherSession}`, { token: w.client.token })).status).toBe(200);
  });

  it("project access set to none for someone already at none leaves their edition grants alone", async () => {
    const h = harness();
    const w = await world(h);
    const editionId = await publish(h, w);
    // an edition-only client: the edition grant, no project grant
    const other = await member(h, w.o, "client");
    expect((await h.api("PUT", `/api/orgs/${w.o.orgId}/editions/${editionId}/grants`, { token: w.o.token, body: { userId: other.userId } })).status).toBe(201);
    expect((await h.api("PUT", `/api/orgs/${w.o.orgId}/projects/${w.pid}/access`, { token: w.o.token, body: { userId: other.userId, level: "none" } })).status).toBe(200);
    const grants = (await h.api("GET", `/api/orgs/${w.o.orgId}/editions/${editionId}/grants`, { token: w.o.token })).body.grants.map((g: any) => g.userId);
    expect(grants).toContain(other.userId);
  });

  it("AT-30: a return against a moved head is refused (Worker check and runner check); a policy change invalidates sessions", async () => {
    const h = harness();
    const w = await world(h);
    const editionId = await publish(h, w);
    const sessionId = await startUpdate(h, w, editionId);

    // runner-side: the head moves after the Worker staged the return → stale_base → state "stale"
    w.runner.opts.manual = true;
    const ret = await sendBack(h, w.o.orgId, sessionId, w.client.token, zipOf({ "src/quote.ts": "export const q = 7;\n" }));
    expect(ret.status).toBe(202);
    await h.drainSteps();
    const held = w.runner.pending.splice(0);
    expect(held.map((j) => j.job.kind)).toEqual(["edition-return"]);
    // a developer change to the website is accepted meanwhile
    const t = await h.api("POST", `/api/orgs/${w.o.orgId}/projects/${w.pid}/tasks`, { token: w.o.token, body: { title: "dev change", writeMounts: ["website"] } });
    w.runner.opts.manual = false;
    await w.runner.runPending();
    await h.drainSteps();
    const { proposal } = await freezeAndPropose(h, w.o, t.body.taskId, { "src/quote.ts": "export const q = 100;\n" });
    await h.drainSteps();
    await h.api("POST", `/api/orgs/${w.o.orgId}/proposals/${proposal.proposalId}/integrate`, { token: w.o.token });
    await waitUntil(async () => (await h.api("GET", `/api/orgs/${w.o.orgId}/proposals/${proposal.proposalId}`, { token: w.o.token })).body.integration?.forCurrentHash === true);
    await h.api("POST", `/api/orgs/${w.o.orgId}/proposals/${proposal.proposalId}/approvals`, { token: w.o.token, body: { proposalHash: proposal.proposalHash } });
    expect((await h.api("POST", `/api/orgs/${w.o.orgId}/proposals/${proposal.proposalId}/accept`, { token: w.o.token, body: { idempotencyKey: "dev-accept-30" } })).status).toBe(200);
    // the queued edition-return job now runs: the runner finds the ledger head moved
    for (const j of held) await w.runner.run(j);
    const stale = await settle(h, w, ret.body.returnId, w.client.token);
    expect(stale.state).toBe("stale");
    expect(stale.error.code).toBe("stale_base");
    expect(stale.error).not.toHaveProperty("detail");
    expect(stale.proposalId).toBeNull();
    // nothing of the old working copy reached the website: the head is the developer's change
    const head = (await h.api("GET", `/api/orgs/${w.o.orgId}/resources/${w.web.resourceId}`, { token: w.o.token })).body.head.revisionId;
    expect(head).not.toBe(w.web.revisionId);

    // Worker-side: further returns from this session are refused at once
    const again = await sendBack(h, w.o.orgId, sessionId, w.client.token, zipOf({ "src/quote.ts": "export const q = 8;\n" }));
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("edition_stale");
    expect((await h.api("GET", `/api/orgs/${w.o.orgId}/edition-sessions/${sessionId}`, { token: w.client.token })).body.stale).toBe(true);

    // a rebuild publishes the new live state; a new session can return again
    await h.api("POST", `/api/orgs/${w.o.orgId}/editions/${editionId}/builds`, { token: w.o.token });
    await h.drainSteps();
    await waitUntil(async () => (await h.api("GET", `/api/orgs/${w.o.orgId}/editions/${editionId}`, { token: w.o.token })).body.builds[0].state === "ready");
    const fresh = await startUpdate(h, w, editionId);
    const { files } = await download(h, w.o.orgId, fresh, w.client.token);
    expect(files["src/quote.ts"]).toBe("export const q = 100;\n");

    // a policy change invalidates open sessions, and the old build is no longer served (M-5)
    const cred = await h.api("POST", `/api/orgs/${w.o.orgId}/edition-sessions/${fresh}/credential`, { token: w.client.token, body: {} });
    await h.api("PUT", `/api/orgs/${w.o.orgId}/editions/${editionId}/policy`, { token: w.o.token, body: { ...POLICY, sources: [{ ...POLICY.sources[0], include: ["index.html", "src/**"], write: ["src"] }] } });
    const changed = await sendBack(h, w.o.orgId, fresh, w.client.token, zipOf({ "src/quote.ts": "export const q = 101;\n" }));
    expect(changed.status).toBe(409);
    expect(changed.body.error.code).toBe("edition_policy_changed");
    expect((await download(h, w.o.orgId, fresh, w.client.token)).status).toBe(409);
    expect(h.artifacts.tokenByPlaintext(cred.body.secret)!.token.state).toBe("revoked");
    expect((await h.api("POST", `/api/orgs/${w.o.orgId}/edition-sessions/${fresh}/credential`, { token: w.client.token, body: {} })).status).toBe(409);
    const late = await h.api("POST", `/api/orgs/${w.o.orgId}/editions/${editionId}/sessions`, { token: w.client.token, body: { title: "x" } });
    expect(late.body.error.code).toBe("edition_not_ready");
  });

  it("a conflict found by the runner and an empty return are reported to the client without runner text", async () => {
    const h = harness();
    const w = await world(h, { fail: { "edition-return": { code: "textual_conflict", detail: "res-x: conflict in src/quote.ts (internal detail)" } } });
    const editionId = await publish(h, w);
    const sessionId = await startUpdate(h, w, editionId);
    const ret = await sendBack(h, w.o.orgId, sessionId, w.client.token, zipOf({ "src/quote.ts": "export const q = 7;\n" }));
    const r = await settle(h, w, ret.body.returnId, w.client.token);
    expect(r.state).toBe("conflict");
    expect(r.error.code).toBe("textual_conflict");
    expect(JSON.stringify(r)).not.toContain("internal detail");
    const dev = (await h.api("GET", `/api/orgs/${w.o.orgId}/edition-returns/${ret.body.returnId}`, { token: w.o.token })).body;
    expect(dev.error.detail).toContain("internal detail");
    // the abandoned task workspace is left for GC (the runner's result is applied in the background:
    // failReturn records the return's state first, then abandons the workspace and fails the task)
    await waitUntil(async () => (await h.api("GET", `/api/tasks/${dev.taskId}`, { token: w.o.token })).body.state === "failed");
    const task = (await h.api("GET", `/api/tasks/${dev.taskId}`, { token: w.o.token })).body;
    expect(task.state).toBe("failed");
    expect(task.workspaces[0].state).toBe("abandoned");
    // an identical upload has nothing to send
    const same = await sendBack(h, w.o.orgId, sessionId, w.client.token, zipOf({ "src/quote.ts": SITE["src/quote.ts"] }));
    expect(same.status).toBe(409);
    expect(same.body.error.code).toBe("no_allowed_changes");
  });
});

describe("editions in a staging-mode project (staging phase 4-2, P42-2)", () => {
  it("no new edition, update or return once staging is on; the edition and an open session's download stay readable", async () => {
    const h = harness();
    const w = await world(h);
    const editionId = await publish(h, w);
    const sessionId = await startUpdate(h, w, editionId);
    const zip = await download(h, w.o.orgId, sessionId, w.client.token);
    const release = {
      recipe: { recipeId: "site-release", revision: 1, steps: [{ stepId: "build", mountName: "website", command: "pnpm run build" }] },
      targets: [{ targetId: "website", kind: "worker", mountName: "website", outputPath: "dist", main: "index.js", workerName: `cfapp-${w.o.orgId}-website` }],
      healthCheck: { targetId: "website" },
    };
    const put = await h.api("PUT", `/api/orgs/${w.o.orgId}/projects/${w.pid}/policy`, { token: w.o.token, body: { release, staging: {} } });
    expect(put.status, JSON.stringify(put.body)).toBe(200);

    const refused = (r: { status: number; body: any }) => {
      expect(r.status, JSON.stringify(r.body)).toBe(409);
      expect(r.body.error.code).toBe("staging_mode");
      expect(r.body.error.message).toMatch(/staging-mode projects use client tasks/);
    };
    refused(await h.api("POST", `/api/orgs/${w.o.orgId}/editions/${editionId}/sessions`, { token: w.client.token, body: { title: "Another", request: "" } }));
    refused(await sendBack(h, w.o.orgId, sessionId, w.client.token, zipOf({ ...zip.files, "src/quote.ts": "export const q = 3;\n" })));
    refused(await h.api("POST", `/api/orgs/${w.o.orgId}/projects/${w.pid}/editions`, { token: w.o.token, body: { ...POLICY, name: "Second" } }));
    // nothing else about the edition changes
    expect((await h.api("GET", `/api/orgs/${w.o.orgId}/editions/${editionId}`, { token: w.client.token })).status).toBe(200);
    expect((await download(h, w.o.orgId, sessionId, w.client.token)).status).toBe(200);

    // staging off again: updates start as before
    expect((await h.api("PUT", `/api/orgs/${w.o.orgId}/projects/${w.pid}/policy`, { token: w.o.token, body: {} })).status).toBe(200);
    await startUpdate(h, w, editionId);
  });
});

describe("editions record the live release (AT-30, Task 22)", () => {
  it("a build made after a release went live records that release as its sourceReleaseId", async () => {
    const { releasePolicy, orgKv } = await import("../release-fixtures.js");
    const h = harness();
    const w = await world(h);
    const live = new Map<string, Record<string, string>>();
    w.runner.opts.onDeploy = (name, vars) => live.set(name, vars);
    h.deps.healthFetch = async (url: string) => {
      const name = /^https:\/\/([a-z0-9-]+)\.demo\.workers\.dev\/version$/.exec(url)?.[1];
      const vars = name ? live.get(name) : undefined;
      return vars ? Response.json({ name, version: "1.0.0", release: vars.COMMONFORGE_RELEASE_ID }) : new Response("no", { status: 404 });
    };
    expect((await h.api("PUT", `/api/orgs/${w.o.orgId}/projects/${w.pid}/policy`, { token: w.o.token, body: { release: releasePolicy(w.o.orgId, await orgKv(h, w.o)) } })).status).toBe(200);
    const prep = await h.api("POST", `/api/orgs/${w.o.orgId}/projects/${w.pid}/releases`, { token: w.o.token, body: {} });
    expect(prep.status).toBe(202);
    const rid = prep.body.releaseId as string;
    await waitUntil(async () => (await h.api("GET", `/api/orgs/${w.o.orgId}/releases/${rid}`, { token: w.o.token })).body.buildState === "built");
    const rel = (await h.api("GET", `/api/orgs/${w.o.orgId}/releases/${rid}`, { token: w.o.token })).body;
    expect((await h.api("POST", `/api/orgs/${w.o.orgId}/releases/${rid}/publish-approvals`, { token: w.o.token, body: { outputDigest: rel.outputDigest } })).status).toBe(201);
    expect((await h.api("POST", `/api/orgs/${w.o.orgId}/releases/${rid}/deploy`, { token: w.o.token, body: { idempotencyKey: "deploy-ed-0001" } })).status).toBe(202);
    await waitUntil(async () => (await h.api("GET", `/api/orgs/${w.o.orgId}/releases/${rid}`, { token: w.o.token })).body.state === "health_verification");
    await h.drainSteps();
    expect((await h.api("GET", `/api/orgs/${w.o.orgId}/releases/${rid}`, { token: w.o.token })).body.state).toBe("live");

    const editionId = await publish(h, w);
    const view = (await h.api("GET", `/api/orgs/${w.o.orgId}/editions/${editionId}`, { token: w.o.token })).body;
    expect(view.builds[0].sourceReleaseId).toBe(rid);
  });
});
