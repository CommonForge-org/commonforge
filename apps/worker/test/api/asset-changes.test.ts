/**
 * Changes to file collections (plan phase 3, Task 5; spec 2026-10-07 §7): each verified upload is
 * copied once into the collection's content key (`files.assets.copy`), the new manifest is written,
 * a synthetic task workspace is frozen and its proposal built (`files.assets.manifest`), then the
 * phase 2 landing (`files.land`, `files.accept`) runs unchanged: content only, no checks, R6.
 */
import { sha256Hex } from "@commonforge-org/core";
import { r2AssetKeys } from "@commonforge-org/provider-cloudflare";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { fileCollection, harness, member, ownerWithOrg, projectWith, type Harness } from "../helpers.js";
import { uploadFile } from "../lfs/lfs-helpers.js";
import { FakeRunner } from "../fakes/runner.js";
import { stagingFixture } from "../staging-helpers.js";
import { createServices } from "../../src/context.js";
import { MAX_RECEIPT_BYTES, planManifest } from "../../src/services/asset-changes.js";
import type { FileChangeRow } from "../../src/services/file-changes.js";
import { runGc } from "../../src/services/gc.js";
import type { StepMessage } from "../../src/services/steps.js";

type Owner = { token: string; orgId: string };
const MOUNT = "brand-assets";
const bytes = (s: string) => new TextEncoder().encode(s);
/** binary bytes (NUL), different per seed */
const blob = (seed: number, n = 3000) => new Uint8Array(n).map((_, i) => (i % 5 === 0 ? 0 : (i * 7 + seed) % 251));

async function filesWorld(h: Harness = harness(), o?: Owner & { userId: string }, pid?: string) {
  const runner = new FakeRunner(h);
  const owner = o ?? (await ownerWithOrg(h));
  const project = pid ?? (await projectWith(h, owner, []));
  const rid = await fileCollection(h, owner, project, MOUNT);
  return { h, o: owner, pid: project, rid, runner };
}

const up = (h: Harness, o: Owner, pid: string, path: string, b: Uint8Array, mime = "image/png") => uploadFile(h, o, pid, path, b, { mount: MOUNT, mime });
const postChange = (h: Harness, o: Owner, pid: string, body: unknown) => h.api("POST", `/api/orgs/${o.orgId}/projects/${pid}/folders/${MOUNT}/changes`, { token: o.token, body });
const getChange = async (h: Harness, o: Owner, id: string) => (await h.api("GET", `/api/orgs/${o.orgId}/file-changes/${id}`, { token: o.token })).body;
const tree = async (h: Harness, o: Owner, pid: string, path = "") => (await h.api("GET", `/api/orgs/${o.orgId}/projects/${pid}/tree?mount=${MOUNT}&path=${encodeURIComponent(path)}`, { token: o.token })).body;
const paths = async (h: Harness, o: Owner, pid: string, path = "") => (await tree(h, o, pid, path)).entries.map((e: { path: string }) => e.path).sort();
const fileOf = (h: Harness, o: Owner, pid: string, path: string) => h.api("GET", `/api/orgs/${o.orgId}/projects/${pid}/file?mount=${MOUNT}&path=${encodeURIComponent(path)}`, { token: o.token });
const proposalState = async (h: Harness, o: Owner, id: string) => (await h.api("GET", `/api/orgs/${o.orgId}/proposals/${id}`, { token: o.token })).body.state as string;
const ENDED = ["added", "failed", "waiting_approval"];

async function land(h: Harness, o: Owner, changeId: string) {
  for (let i = 0; i < 150; i++) {
    await h.drainSteps();
    const c = await getChange(h, o, changeId);
    if (ENDED.includes(c.state)) return c;
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error(`change ${changeId} did not land: ${JSON.stringify(await getChange(h, o, changeId))} steps: ${JSON.stringify(h.steps).slice(0, 500)}`);
}

async function pumpUntil(h: Harness, cond: () => Promise<boolean>) {
  for (let i = 0; i < 150; i++) {
    await h.drainSteps();
    if (await cond()) return;
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error("condition not reached");
}

/** Upload these files and land them in one change. */
async function seed(h: Harness, o: Owner, pid: string, files: Record<string, Uint8Array>) {
  const ops = [];
  for (const [path, b] of Object.entries(files)) ops.push({ put: path, stagingId: await up(h, o, pid, path, b) });
  const r = await postChange(h, o, pid, { ops });
  expect(r.status, JSON.stringify(r.body)).toBe(202);
  const c = await land(h, o, r.body.changeId);
  expect(c.state, JSON.stringify(c)).toBe("added");
  return c;
}

async function setPolicy(h: Harness, o: Owner, pid: string, approvalRoles: string[]) {
  const r = await h.api("PUT", `/api/orgs/${o.orgId}/projects/${pid}/policy`, { token: o.token, body: { checks: [], contracts: [], rules: [], approvalRoles, publishRoles: ["owner"] } });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

const lfsRow = (id: string) => env.DB.prepare("SELECT * FROM lfs_objects WHERE staging_id = ?").bind(id).first<{ r2_key: string; sha256: string }>();
const integrateJobs = (h: Harness, proposalId: string) =>
  (h.runnerJobs as Array<{ signedJob: { job: { kind: string; proposalId?: string; checks: unknown[]; assetChanges?: unknown[] } } }>)
    .filter((m) => m.signedJob.job.kind === "integrate" && m.signedJob.job.proposalId === proposalId)
    .map((m) => m.signedJob.job);

/** Deliver captured steps one at a time, calling `after` after each (the fake runner answers jobs in between). */
async function stepByStep(h: Harness, after: (s: StepMessage) => Promise<void>, until: () => Promise<boolean>) {
  for (let i = 0; i < 400 && !(await until()); i++) {
    const s = h.steps.shift() as StepMessage | undefined;
    if (!s) {
      await new Promise((res) => setTimeout(res, 20));
      continue;
    }
    await h.deliver("commonforge-steps", [s]);
    await after(s);
  }
}

describe("changes to file collections", () => {
  it("an owner uploads two files: added; the tree lists them with sizes, the file is served from its content key, and the staged LFS rows and keys are gone", async () => {
    const { h, o, pid, rid, runner } = await filesWorld();
    const logo = blob(1);
    const notes = bytes("brand notes v1\n");
    const a = await up(h, o, pid, "logos/logo.png", logo);
    const b = await up(h, o, pid, "notes.txt", notes, "text/plain");
    const rows = [await lfsRow(a), await lfsRow(b)];
    const r = await postChange(h, o, pid, { ops: [{ put: "logos/logo.png", stagingId: a }, { put: "notes.txt", stagingId: b }] });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    const c = await land(h, o, r.body.changeId);
    expect(runner.errors).toEqual([]);
    expect(c.state).toBe("added");
    expect(c).not.toHaveProperty("error");
    expect(c.changedPaths).toEqual([
      { path: "logos/logo.png", change: "added", lfs: false, class: "content" },
      { path: "notes.txt", change: "added", lfs: false, class: "content" },
    ]);
    expect(await proposalState(h, o, c.proposalId)).toBe("accepted");
    // content: integrated with no checks, as an assets-only job
    const jobs = integrateJobs(h, c.proposalId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.checks).toEqual([]);
    expect(jobs[0]!.assetChanges).toHaveLength(1);

    expect(await paths(h, o, pid)).toEqual(["logos", "notes.txt"]);
    expect((await tree(h, o, pid, "logos")).entries).toEqual([{ path: "logos/logo.png", type: "file", size: logo.length }]);
    const f = await fileOf(h, o, pid, "logos/logo.png");
    expect(f.status).toBe(200);
    expect(f.headers.get("x-commonforge-sha256")).toBe(await sha256Hex(logo));
    const key = r2AssetKeys.object(o.orgId, rid, await sha256Hex(logo));
    const stored = await env.COMMONFORGE_ASSETS.get(key);
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(logo);
    expect(stored!.customMetadata?.sha256).toBe(await sha256Hex(logo));
    expect(stored!.httpMetadata?.contentType).toBe("image/png");
    expect((await fileOf(h, o, pid, "notes.txt")).body).toBe("brand notes v1\n");

    // the staged LFS rows and their keys are gone (nothing references them)
    expect(await lfsRow(a)).toBeNull();
    expect(await lfsRow(b)).toBeNull();
    for (const row of rows) expect(await env.COMMONFORGE_ASSETS.head(row!.r2_key)).toBeNull();
  });

  it("an empty upload becomes an empty manifest entry; the file serves no bytes", async () => {
    const { h, o, pid, rid, runner } = await filesWorld();
    const a = await up(h, o, pid, "docs/.keep", new Uint8Array(0), "text/plain");
    const r = await postChange(h, o, pid, { ops: [{ put: "docs/.keep", stagingId: a }] });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    const c = await land(h, o, r.body.changeId);
    expect(runner.errors).toEqual([]);
    expect(c.state, JSON.stringify(c)).toBe("added");
    expect((await tree(h, o, pid, "docs")).entries).toEqual([{ path: "docs/.keep", type: "file", size: 0 }]);
    const empty = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const stored = await env.COMMONFORGE_ASSETS.head(r2AssetKeys.object(o.orgId, rid, empty));
    expect(stored?.size).toBe(0);
    expect(stored?.customMetadata?.sha256).toBe(empty);
    const f = await fileOf(h, o, pid, "docs/.keep");
    expect(f.status).toBe(200);
    expect(f.headers.get("x-commonforge-sha256")).toBe(empty);
    // (the harness reads an empty body as null)
    expect(f.body).toBeNull();
  });

  it("delete and move (a file and a directory) produce the expected manifest; file_missing and path_exists fail cleanly", async () => {
    const { h, o, pid } = await filesWorld();
    await seed(h, o, pid, { "a/x.png": blob(1), "a/y.png": blob(2), "b.png": blob(3), "e.png": blob(4) });

    const mv = await postChange(h, o, pid, { ops: [{ move: "a", to: "c" }, { move: "b.png", to: "d.png" }] });
    expect(mv.status, JSON.stringify(mv.body)).toBe(202);
    const cm = await land(h, o, mv.body.changeId);
    expect(cm.state).toBe("added");
    expect(await paths(h, o, pid)).toEqual(["c", "d.png", "e.png"]);
    expect(await paths(h, o, pid, "c")).toEqual(["c/x.png", "c/y.png"]);
    expect((await fileOf(h, o, pid, "c/y.png")).headers.get("x-commonforge-sha256")).toBe(await sha256Hex(blob(2)));
    expect(cm.changedPaths.map((p: { path: string; change: string }) => `${p.change} ${p.path}`).sort()).toEqual(["added c/x.png", "added c/y.png", "added d.png", "deleted a/x.png", "deleted a/y.png", "deleted b.png"]);

    const del = await postChange(h, o, pid, { ops: [{ delete: "c" }] });
    expect((await land(h, o, del.body.changeId)).state).toBe("added");
    expect(await paths(h, o, pid)).toEqual(["d.png", "e.png"]);

    const missing = await postChange(h, o, pid, { ops: [{ delete: "nope.png" }] });
    const cmiss = await land(h, o, missing.body.changeId);
    expect(cmiss).toMatchObject({ state: "failed", error: { code: "file_missing" } });
    const exists = await postChange(h, o, pid, { ops: [{ move: "e.png", to: "d.png" }] });
    const cex = await land(h, o, exists.body.changeId);
    expect(cex).toMatchObject({ state: "failed", error: { code: "path_exists" } });
    // nothing moved
    expect(await paths(h, o, pid)).toEqual(["d.png", "e.png"]);
  });

  it("an edit op answers 400 edit_unsupported; a client uploading gets 403", async () => {
    const { h, o, pid } = await filesWorld();
    const r = await postChange(h, o, pid, { ops: [{ edit: "notes.txt", content: "x\n", baseBlob: "" }] });
    expect([r.status, r.body.error.code]).toEqual([400, "edit_unsupported"]);
    const client = await member(h, o, "client");
    const s = await h.api("POST", `/api/orgs/${o.orgId}/projects/${pid}/folders/${MOUNT}/uploads`, { token: client.token, body: { path: "a.png", size: 1, mime: "image/png" } });
    expect(s.status).toBe(403);
  });

  it("a developer not in approvalRoles waits for an approval; an owner's approval and accept add it", async () => {
    const { h, o, pid, rid, runner } = await filesWorld();
    await setPolicy(h, o, pid, ["owner"]);
    const dev = await member(h, o, "developer");
    expect((await h.api("PUT", `/api/orgs/${o.orgId}/projects/${pid}/access`, { token: o.token, body: { userId: dev.userId, level: "write" } })).status).toBe(200);
    const d = { ...dev, orgId: o.orgId };
    const a = await up(h, d, pid, "dev.png", blob(9));
    const r = await postChange(h, d, pid, { ops: [{ put: "dev.png", stagingId: a }] });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    const c = await land(h, o, r.body.changeId);
    expect(runner.errors).toEqual([]);
    expect(c.state).toBe("waiting_approval");
    expect(await paths(h, o, pid)).toEqual([]);
    const p = (await h.api("GET", `/api/orgs/${o.orgId}/proposals/${c.proposalId}`, { token: o.token })).body;
    expect(p.approvals).toEqual([]);
    expect(p.assetManifestChanges).toMatchObject([{ resourceId: rid }]);
    expect((await h.api("POST", `/api/orgs/${o.orgId}/proposals/${c.proposalId}/approvals`, { token: o.token, body: { proposalHash: p.proposalHash } })).status).toBe(201);
    const acc = await h.api("POST", `/api/orgs/${o.orgId}/proposals/${c.proposalId}/accept`, { token: o.token, body: { idempotencyKey: "asset-fc-accept" } });
    expect(acc.status, JSON.stringify(acc.body)).toBe(200);
    expect((await getChange(h, o, r.body.changeId)).state).toBe("added");
    expect(await paths(h, o, pid)).toEqual(["dev.png"]);
    expect(await lfsRow(a)).toBeNull();
  });

  it("another change accepted first: the change re-applies on the new manifest and lands; the third stale attempt fails stale_base", async () => {
    const { h, o, pid, runner } = await filesWorld();
    runner.opts.hold = ["integrate"];
    const ra = await postChange(h, o, pid, { ops: [{ put: "a.png", stagingId: await up(h, o, pid, "a.png", blob(1)) }] });
    const rb = await postChange(h, o, pid, { ops: [{ put: "b.png", stagingId: await up(h, o, pid, "b.png", blob(2)) }] });
    const A = ra.body.changeId as string;
    const B = rb.body.changeId as string;
    await pumpUntil(h, async () => (await getChange(h, o, A)).state === "checking" && (await getChange(h, o, B)).state === "checking");
    const pa = (await getChange(h, o, A)).proposalId as string;
    const pb = (await getChange(h, o, B)).proposalId as string;
    expect(await runner.runWhere((j) => j.kind === "integrate" && j.proposalId === pa)).toBe(1);
    await pumpUntil(h, async () => (await getChange(h, o, A)).state === "added");
    runner.opts.hold = [];
    await runner.runPending();
    const cb = await land(h, o, B);
    expect(runner.errors).toEqual([]);
    expect(cb).toMatchObject({ state: "added", attempt: 2 });
    expect(await proposalState(h, o, pb)).toBe("superseded");
    expect(await paths(h, o, pid)).toEqual(["a.png", "b.png"]);

    // a change on its third attempt whose base moves again fails stale_base
    runner.opts.hold = ["integrate"];
    const rc = await postChange(h, o, pid, { ops: [{ put: "c.png", stagingId: await up(h, o, pid, "c.png", blob(3)) }] });
    const rd = await postChange(h, o, pid, { ops: [{ put: "d.png", stagingId: await up(h, o, pid, "d.png", blob(4)) }] });
    const C = rc.body.changeId as string;
    const D = rd.body.changeId as string;
    await pumpUntil(h, async () => (await getChange(h, o, C)).state === "checking" && (await getChange(h, o, D)).state === "checking");
    await env.DB.prepare("UPDATE file_changes SET attempt = 3 WHERE change_id = ?").bind(C).run();
    const pd = (await getChange(h, o, D)).proposalId as string;
    expect(await runner.runWhere((j) => j.kind === "integrate" && j.proposalId === pd)).toBe(1);
    await pumpUntil(h, async () => (await getChange(h, o, D)).state === "added");
    runner.opts.hold = [];
    await runner.runPending();
    const cc = await land(h, o, C);
    expect(cc).toMatchObject({ state: "failed", attempt: 3, error: { code: "stale_base" } });
    expect(await paths(h, o, pid)).toEqual(["a.png", "b.png", "d.png"]);
  });

  it("bytes altered after hashing (the etag changed) fail hash_mismatch; nothing is added", async () => {
    const { h, o, pid, rid } = await filesWorld();
    const a = await up(h, o, pid, "a.png", blob(1));
    const row = await lfsRow(a);
    await env.COMMONFORGE_ASSETS.put(row!.r2_key, blob(7));
    const r = await postChange(h, o, pid, { ops: [{ put: "a.png", stagingId: a }] });
    const c = await land(h, o, r.body.changeId);
    expect(c).toMatchObject({ state: "failed", error: { code: "hash_mismatch" } });
    expect(await env.COMMONFORGE_ASSETS.head(r2AssetKeys.object(o.orgId, rid, row!.sha256))).toBeNull();
    expect(await paths(h, o, pid)).toEqual([]);
  });

  it("a GC run between writeManifest and accept keeps the new manifest and its objects", async () => {
    const { h, o, pid, rid, runner } = await filesWorld();
    runner.opts.hold = ["integrate"];
    const logo = blob(5);
    const r = await postChange(h, o, pid, { ops: [{ put: "logo.png", stagingId: await up(h, o, pid, "logo.png", logo) }] });
    await pumpUntil(h, async () => (await getChange(h, o, r.body.changeId)).state === "checking");
    const report = await runGc(createServices(env, h.deps), { orgs: [o.orgId], graceSeconds: 0 });
    expect(report.errors).toEqual([]);
    const key = r2AssetKeys.object(o.orgId, rid, await sha256Hex(logo));
    expect(report.deletedAssets).not.toContain(key);
    expect(report.deletedAssets.filter((k) => k.includes("/manifest/"))).toEqual([]);
    runner.opts.hold = [];
    await runner.runPending();
    expect((await land(h, o, r.body.changeId)).state).toBe("added");
    const f = await fileOf(h, o, pid, "logo.png");
    expect(f.status).toBe(200);
    expect(f.headers.get("x-commonforge-sha256")).toBe(await sha256Hex(logo));
  });
});

describe("file collections and the asset GC (Task 4 review)", () => {
  it("a content key swept after its copy and before the manifest is copied again; the change lands", async () => {
    const { h, o, pid, rid, runner } = await filesWorld();
    const logo = blob(11);
    const key = r2AssetKeys.object(o.orgId, rid, await sha256Hex(logo));
    const r = await postChange(h, o, pid, { ops: [{ put: "logo.png", stagingId: await up(h, o, pid, "logo.png", logo) }] });
    let copies = 0;
    let swept = false;
    await stepByStep(
      h,
      async (s) => {
        if (s.type !== "files.assets.copy") return;
        copies++;
        if (!swept) {
          // what a GC run that saw an old, unreferenced object does
          expect(await env.COMMONFORGE_ASSETS.head(key)).not.toBeNull();
          await env.COMMONFORGE_ASSETS.delete(key);
          swept = true;
        }
      },
      async () => ENDED.includes((await getChange(h, o, r.body.changeId)).state),
    );
    const c = await land(h, o, r.body.changeId);
    expect(runner.errors).toEqual([]);
    expect(c.state).toBe("added");
    expect(copies).toBe(2);
    expect(new Uint8Array(await (await env.COMMONFORGE_ASSETS.get(key))!.arrayBuffer())).toEqual(logo);
    expect((await fileOf(h, o, pid, "logo.png")).status).toBe(200);
  });

  it("the objects are verified again under the GC lock after the manifest is written; one swept by a run already deleting is copied again", async () => {
    const { h, o, pid, rid, runner } = await filesWorld();
    const logo = blob(12);
    const key = r2AssetKeys.object(o.orgId, rid, await sha256Hex(logo));
    // an earlier copy of the same bytes exists (adoptVerified's "already copied" path)
    await env.COMMONFORGE_ASSETS.put(key, logo, { customMetadata: { sha256: await sha256Hex(logo) } });
    const r = await postChange(h, o, pid, { ops: [{ put: "logo.png", stagingId: await up(h, o, pid, "logo.png", logo) }] });
    // a GC run holds its lock: the manifest step writes the manifest, then waits for the run
    const svc = createServices(env, h.deps);
    let release!: () => void;
    const held = new Promise<void>((res) => (release = res));
    let locked!: () => void;
    const isLocked = new Promise<void>((res) => (locked = res));
    const gc = svc.gate.withLock("gc", "sweep", 60_000, async () => {
      locked();
      await held;
    });
    await isLocked;
    const retried: Array<{ body: unknown; delaySeconds?: number }> = [];
    try {
      for (let i = 0; i < 30 && retried.length === 0; i++) {
        const s = h.steps.shift();
        if (!s) break;
        const out = await h.deliver("commonforge-steps", [s]);
        retried.push(...out.retried);
      }
      expect(retried).toHaveLength(1);
      expect(retried[0]).toMatchObject({ body: { type: "files.assets.manifest" } });
      const ws = await env.DB.prepare("SELECT w.state, w.asset_manifest_id FROM task_workspaces w JOIN file_changes f ON f.task_workspace_id = w.task_workspace_id WHERE f.change_id = ?").bind(r.body.changeId).first<{ state: string; asset_manifest_id: string }>();
      expect(ws).toMatchObject({ state: "frozen" });
      // the run deletes the object it listed as unreferenced before the manifest existed, then ends
      await env.COMMONFORGE_ASSETS.delete(key);
    } finally {
      release();
      await gc;
    }
    h.steps.push(retried[0]!.body);
    const c = await land(h, o, r.body.changeId);
    expect(runner.errors).toEqual([]);
    expect(c.state).toBe("added");
    const stored = await env.COMMONFORGE_ASSETS.get(key);
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(logo);
    expect((await fileOf(h, o, pid, "logo.png")).status).toBe(200);
  });
});

describe("file collections in a staging-mode project (M7, ruling R9)", { timeout: 60_000 }, () => {
  it("as for a git change, the change's submitted task is handed to staging.land (which stages nothing for a file collection, as for an agent's asset-only task); the change is added", async () => {
    const f = await stagingFixture();
    const { h, o, pid, runner } = await filesWorld(f.h, f.o, f.pid);
    const seen: StepMessage[] = [];
    const send = h.deps.stepQueue;
    h.deps.stepQueue = (e) => ({ send: async (b: StepMessage) => (seen.push(structuredClone(b)), send(e).send(b)) }) as never;
    const r = await postChange(h, o, pid, { ops: [{ put: "logo.png", stagingId: await up(h, o, pid, "logo.png", blob(3)) }] });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    const c = await land(h, o, r.body.changeId);
    expect(runner.errors).toEqual([]);
    expect(c.state).toBe("added");
    const taskId = (await env.DB.prepare("SELECT task_id FROM file_changes WHERE change_id = ?").bind(r.body.changeId).first<{ task_id: string }>())!.task_id;
    expect(seen.filter((s) => s.type === "staging.land")).toEqual([{ type: "staging.land", orgId: o.orgId, taskId }]);
    expect((await env.DB.prepare("SELECT state FROM tasks WHERE task_id = ?").bind(taskId).first<{ state: string }>())!.state).toBe("submitted");
    expect((await env.DB.prepare("SELECT count(*) AS n FROM staging_landings WHERE task_id = ?").bind(taskId).first<{ n: number }>())!.n).toBe(0);
    expect(await paths(h, o, pid)).toEqual(["logo.png"]);
  });
});

describe("file collections: review fixes", () => {
  it("I-1: a read sweep while a large copy is still running does not start a second copy of it", async () => {
    const { h, o, pid, runner } = await filesWorld();
    const logo = blob(21);
    const a = await up(h, o, pid, "big.png", logo);
    const src = (await lfsRow(a))!.r2_key;
    const r = await postChange(h, o, pid, { ops: [{ put: "big.png", stagingId: a }] });
    const id = r.body.changeId as string;
    // run the steps up to the copy
    let copy: StepMessage | undefined;
    for (let i = 0; i < 30 && !copy; i++) {
      const s = h.steps.shift() as StepMessage | undefined;
      if (!s) break;
      if (s.type === "files.assets.copy") copy = s;
      else await h.deliver("commonforge-steps", [s]);
    }
    expect(copy).toBeDefined();
    // the copy reads its source slowly (a 5 GB object): the first read blocks until released
    let reads = 0;
    let release!: () => void;
    const held = new Promise<void>((res) => (release = res));
    let reading!: () => void;
    const isReading = new Promise<void>((res) => (reading = res));
    const bucket = env.COMMONFORGE_ASSETS;
    (h.envOverrides as Record<string, unknown>).COMMONFORGE_ASSETS = new Proxy(bucket, {
      get(t, k) {
        if (k === "get")
          return async (key: string, opts?: unknown) => {
            if (key === src && reads++ === 0) {
              reading();
              await held;
            }
            return bucket.get(key, opts as never);
          };
        const v = (t as unknown as Record<string | symbol, unknown>)[k];
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const first = h.deliver("commonforge-steps", [copy]);
    await isReading;
    try {
      // the change has not moved for longer than FILE_CHANGE_STUCK_MS: a read re-enqueues files.apply
      await env.DB.prepare("UPDATE file_changes SET updated_at = ? WHERE change_id = ?").bind(new Date(Date.now() - 10 * 60_000).toISOString(), id).run();
      await getChange(h, o, id);
      expect(h.steps).toContainEqual(expect.objectContaining({ type: "files.apply" }));
      await h.drainSteps();
      expect(reads).toBe(1);
    } finally {
      release();
      await first;
    }
    const c = await land(h, o, id);
    expect(runner.errors).toEqual([]);
    expect(c.state).toBe("added");
    expect(reads).toBe(1);
    expect((await fileOf(h, o, pid, "big.png")).headers.get("x-commonforge-sha256")).toBe(await sha256Hex(logo));
  });

  it("I-2: an object of the folder's version (not one of the change's uploads) gone from R2 fails the change object_missing instead of looping", async () => {
    const { h, o, pid, rid, runner } = await filesWorld();
    const old = blob(31);
    await seed(h, o, pid, { "old.png": old });
    await env.COMMONFORGE_ASSETS.delete(r2AssetKeys.object(o.orgId, rid, await sha256Hex(old)));
    const r = await postChange(h, o, pid, { ops: [{ put: "new.png", stagingId: await up(h, o, pid, "new.png", blob(32)) }] });
    const c = await land(h, o, r.body.changeId);
    expect(runner.errors).toEqual([]);
    expect(c).toMatchObject({ state: "failed", error: { code: "object_missing" } });
    expect(c.error.message).toContain("old.png");
    expect(h.steps).toEqual([]);
  });

  it("I-2: one of the change's own uploads swept just before the manifest is written is copied again, the step retried with a delay", async () => {
    const { h, o, pid, rid, runner } = await filesWorld();
    const logo = blob(33);
    const key = r2AssetKeys.object(o.orgId, rid, await sha256Hex(logo));
    const r = await postChange(h, o, pid, { ops: [{ put: "logo.png", stagingId: await up(h, o, pid, "logo.png", logo) }] });
    // the GC sweeps the key between the manifest step's check and its writeManifest: the bucket's
    // head answers "there" once for the check, then the object is gone
    const bucket = env.COMMONFORGE_ASSETS;
    let armed = false;
    (h.envOverrides as Record<string, unknown>).COMMONFORGE_ASSETS = new Proxy(bucket, {
      get(t, k) {
        if (k === "head")
          return async (k2: string) => {
            const got = await bucket.head(k2);
            if (armed && k2 === key && got) {
              armed = false;
              await bucket.delete(key);
            }
            return got;
          };
        const v = (t as unknown as Record<string | symbol, unknown>)[k];
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const retried: Array<{ body: unknown; delaySeconds?: number }> = [];
    for (let i = 0; i < 30 && retried.length === 0; i++) {
      const s = h.steps.shift() as StepMessage | undefined;
      if (!s) break;
      // armed once the copy is done: the manifest step's next pass checks, then writes
      if (s.type === "files.assets.manifest" && s.copied) armed = true;
      const out = await h.deliver("commonforge-steps", [s]);
      retried.push(...out.retried);
    }
    expect(retried).toHaveLength(1);
    expect(retried[0]).toMatchObject({ body: { type: "files.assets.manifest" } });
    // retried (the step's attempt budget applies), not enqueued again at once
    expect(h.steps.filter((s) => (s as StepMessage).type === "files.assets.manifest")).toEqual([]);
    h.steps.push(retried[0]!.body);
    const c = await land(h, o, r.body.changeId);
    expect(runner.errors).toEqual([]);
    expect(c.state).toBe("added");
    expect(new Uint8Array(await (await bucket.get(key))!.arrayBuffer())).toEqual(logo);
  });

  it("final review 1: another upload swept just before the manifest is written, on a pass woken by a different upload's copy, is copied again when the step is retried", async () => {
    const { h, o, pid, rid, runner } = await filesWorld();
    const a = blob(34);
    const b = blob(35);
    const sa = await up(h, o, pid, "a.png", a);
    const sb = await up(h, o, pid, "b.png", b);
    const keyOf = new Map([[sa, r2AssetKeys.object(o.orgId, rid, await sha256Hex(a))], [sb, r2AssetKeys.object(o.orgId, rid, await sha256Hex(b))]]);
    const r = await postChange(h, o, pid, { ops: [{ put: "a.png", stagingId: sa }, { put: "b.png", stagingId: sb }] });
    // the GC sweeps the OTHER upload's key between the manifest step's check and its writeManifest
    const bucket = env.COMMONFORGE_ASSETS;
    let armed: string | null = null;
    (h.envOverrides as Record<string, unknown>).COMMONFORGE_ASSETS = new Proxy(bucket, {
      get(t, k) {
        if (k === "head")
          return async (k2: string) => {
            const got = await bucket.head(k2);
            if (armed && k2 === armed && got) {
              armed = null;
              await bucket.delete(k2);
            }
            return got;
          };
        const v = (t as unknown as Record<string | symbol, unknown>)[k];
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const retried: Array<{ body: unknown; delaySeconds?: number }> = [];
    let woken = false;
    for (let i = 0; i < 40 && retried.length === 0; i++) {
      const s = h.steps.shift() as StepMessage | undefined;
      if (!s) break;
      // both copies ran before this first wake-up: its pass checks both keys, then writes
      if (s.type === "files.assets.manifest" && s.copied && !woken && (woken = true)) armed = keyOf.get(s.copied === sa ? sb : sa)!;
      const out = await h.deliver("commonforge-steps", [s]);
      retried.push(...out.retried);
    }
    expect(retried).toHaveLength(1);
    const body = retried[0]!.body as StepMessage & { copied?: string };
    expect(body).toMatchObject({ type: "files.assets.manifest", copied: expect.any(String) });
    const swept = body.copied === sa ? sb : sa;
    // the retried delivery copies the swept upload again, though the message names the other one
    await h.deliver("commonforge-steps", [body], 2);
    expect(h.steps).toContainEqual(expect.objectContaining({ type: "files.assets.copy", stagingId: swept }));
    const c = await land(h, o, r.body.changeId);
    expect(runner.errors).toEqual([]);
    expect(c.state).toBe("added");
    expect(new Uint8Array(await (await bucket.get(keyOf.get(swept)!))!.arrayBuffer())).toEqual(swept === sa ? a : b);
  });

  it("M-1: a proposal opened by a manifest step that then gave up (its change could not record it) is withdrawn with the change", async () => {
    const { h, o, pid } = await filesWorld();
    const r = await postChange(h, o, pid, { ops: [{ put: "logo.png", stagingId: await up(h, o, pid, "logo.png", blob(41)) }] });
    const id = r.body.changeId as string;
    // D1 refuses to record the proposal on the change (every delivery)
    await env.DB.prepare(`CREATE TRIGGER fc_no_proposal BEFORE UPDATE OF proposal_id ON file_changes WHEN NEW.proposal_id IS NOT NULL AND NEW.change_id = '${id}' BEGIN SELECT RAISE(ABORT, 'test: D1 unavailable'); END`).run();
    try {
      const c = await land(h, o, id);
      expect(c).toMatchObject({ state: "failed", proposalId: null });
    } finally {
      await env.DB.prepare("DROP TRIGGER fc_no_proposal").run();
    }
    const { attempt } = (await env.DB.prepare("SELECT attempt FROM file_changes WHERE change_id = ?").bind(id).first<{ attempt: number }>())!;
    const { fileChangeProposalId } = await import("../../src/services/file-changes.js");
    expect(await proposalState(h, o, await fileChangeProposalId(id, attempt))).toBe("withdrawn");
  });

  it("M-3: the changed paths are counted, and the receipt's size bounded, before the manifest is written", () => {
    const fc = { org_id: "org-x", resource_id: "res-x" } as FileChangeRow;
    const entry = (path: string) => ({ path, sha256: "a".repeat(64), size: 1, mime: "image/png", objectKey: `org/org-x/res/res-x/obj/${"a".repeat(64)}`, source: { kind: "upload", ref: "s" } });
    const base = (paths: string[]) => ({ manifestId: "m", entries: paths.map(entry) }) as never;
    const many = Array.from({ length: 5001 }, (_, i) => `d/f${i}.png`);
    expect(planManifest(fc, base(many), [{ delete: "d" }], new Map())).toMatchObject({ ok: false, code: "limit_exceeded" });
    const long = Array.from({ length: 2000 }, (_, i) => `d/${String(i).padStart(4, "0")}${"x".repeat(1000)}.png`);
    const big = planManifest(fc, base(long), [{ delete: "d" }], new Map());
    expect(big).toMatchObject({ ok: false, code: "limit_exceeded" });
    expect(JSON.stringify(long).length).toBeGreaterThan(MAX_RECEIPT_BYTES);
    const ok = planManifest(fc, base(many.slice(0, 10)), [{ move: "d", to: "e" }], new Map());
    expect(ok.ok && ok.receipt.changedPaths.length).toBe(20);
    expect(ok.ok && ok.entries.map((e) => e.path).sort()).toEqual(many.slice(0, 10).map((p) => p.replace(/^d/, "e")).sort());
  });

  it("M-4: a change with no changes drops its staged uploads, as an added change does", async () => {
    const { h, o, pid, runner } = await filesWorld();
    await seed(h, o, pid, { "a.png": blob(51) });
    const a = await up(h, o, pid, "a.png", blob(51));
    const row = await lfsRow(a);
    const r = await postChange(h, o, pid, { ops: [{ put: "a.png", stagingId: a }] });
    const c = await land(h, o, r.body.changeId);
    expect(runner.errors).toEqual([]);
    expect(c).toMatchObject({ state: "added", note: "no_changes" });
    expect(await lfsRow(a)).toBeNull();
    expect(await env.COMMONFORGE_ASSETS.head(row!.r2_key)).toBeNull();
  });
});
