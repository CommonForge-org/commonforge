/**
 * The Files tab sees real files (plan folders phase 3, Task 2; P3-1, P3-2): a git folder's tree
 * shows an LFS file's real size with `lfs: true`, and `GET …/file` streams the object instead of its
 * pointer. At the accepted head any reader gets accepted objects; at an explicit revision
 * (developers only) staged ones too. A pointer to an object CommonForge does not hold is served as
 * pointer text with `x-commonforge-lfs: missing`. Project mounts say whether the viewer may write.
 */
import { sha256Hex } from "@commonforge-org/core";
import { lfsPointer } from "@commonforge-org/runner-protocol";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { codeResource, member, projectWith, type Harness } from "../helpers.js";
import { uploadFile, world } from "../lfs/lfs-helpers.js";

type Owner = { token: string; orgId: string };

const MiB = 1_048_576;
/** a 2 MiB binary file (NUL bytes), different per seed */
const video = (seed = 0) => new Uint8Array(2 * MiB).map((_, i) => (i % 7 === 0 ? 0 : (i + seed) % 251));

/** GET with the response body as bytes (`h.api` decodes it as text). */
async function getBytes(h: Harness, path: string, token: string) {
  const ctx = createExecutionContext();
  const res = await h.worker.fetch(new Request(`https://worker.test${path}`, { headers: { authorization: `Bearer ${token}`, "cf-connecting-ip": "192.0.2.9" } }), h.env(), ctx);
  const bytes = new Uint8Array(await res.arrayBuffer());
  await waitOnExecutionContext(ctx);
  return { status: res.status, headers: res.headers, bytes };
}

const getChange = async (h: Harness, o: Owner, id: string) => (await h.api("GET", `/api/orgs/${o.orgId}/file-changes/${id}`, { token: o.token })).body;

async function land(h: Harness, o: Owner, changeId: string) {
  for (let i = 0; i < 150; i++) {
    await h.drainSteps();
    const c = await getChange(h, o, changeId);
    if (["added", "failed", "waiting_approval"].includes(c.state)) return c;
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error(`change ${changeId} did not land: ${JSON.stringify(await getChange(h, o, changeId))}`);
}

async function setApprovalRoles(h: Harness, o: Owner, pid: string, approvalRoles: string[]) {
  const r = await h.api("PUT", `/api/orgs/${o.orgId}/projects/${pid}/policy`, { token: o.token, body: { checks: [], contracts: [], rules: [], approvalRoles, publishRoles: ["owner"] } });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

async function withAccess(h: Harness, o: Owner, pid: string, role: string, level: "read" | "write") {
  const m = await member(h, o, role);
  expect((await h.api("PUT", `/api/orgs/${o.orgId}/projects/${pid}/access`, { token: o.token, body: { userId: m.userId, level } })).status).toBe(200);
  return { ...m, orgId: o.orgId };
}

const fileUrl = (o: Owner, pid: string, path: string, revision?: string) =>
  `/api/orgs/${o.orgId}/projects/${pid}/file?mount=site&path=${encodeURIComponent(path)}${revision ? `&revision=${encodeURIComponent(revision)}` : ""}`;
const treeUrl = (o: Owner, pid: string, path: string, revision?: string) =>
  `/api/orgs/${o.orgId}/projects/${pid}/tree?mount=site&path=${encodeURIComponent(path)}${revision ? `&revision=${encodeURIComponent(revision)}` : ""}`;

describe("browsing LFS files", () => {
  it("an upload landed through a file change: the tree shows its real size and lfs, and the file route streams the object to owner and client", async () => {
    const { h, o, pid, runner } = await world();
    const client = await withAccess(h, o, pid, "client", "read");
    const vid = video();
    const sha = await sha256Hex(vid);
    const a = await uploadFile(h, o, pid, "videos/demo.mp4", vid, { mime: "video/mp4" });
    const r = await h.api("POST", `/api/orgs/${o.orgId}/projects/${pid}/folders/site/changes`, { token: o.token, body: { ops: [{ put: "videos/demo.mp4", stagingId: a }] } });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect((await land(h, o, r.body.changeId)).state).toBe("added");
    expect(runner.errors).toEqual([]);

    for (const who of [o, client]) {
      const tree = await h.api("GET", treeUrl(o, pid, "videos"), { token: who.token });
      expect(tree.status).toBe(200);
      expect(tree.body.entries).toEqual([{ path: "videos/demo.mp4", type: "file", size: vid.length, lfs: true }]);

      const f = await getBytes(h, fileUrl(o, pid, "videos/demo.mp4"), who.token);
      expect(f.status).toBe(200);
      expect(f.headers.get("x-commonforge-lfs")).toBe(sha);
      expect(f.headers.get("x-commonforge-sha256")).toBe(sha);
      expect(f.headers.get("content-length")).toBe(String(vid.length));
      expect(f.headers.get("x-commonforge-blob")).toBeNull();
      expect(f.headers.get("x-commonforge-revision")).toBeTruthy();
      expect(f.headers.get("content-disposition")).toBe("attachment");
      expect(f.headers.get("x-content-type-options")).toBe("nosniff");
      expect(f.bytes.length).toBe(vid.length);
      expect(await sha256Hex(f.bytes)).toBe(sha);
    }

    // small text files are unchanged: no lfs flag, and the blob id an edit sends back
    const root = await h.api("GET", treeUrl(o, pid, ""), { token: o.token });
    for (const e of root.body.entries) expect(e).not.toHaveProperty("lfs");
    const cfg = await getBytes(h, fileUrl(o, pid, "config.json"), o.token);
    expect(cfg.status).toBe(200);
    expect(cfg.headers.get("x-commonforge-blob")).toMatch(/^[0-9a-f]{40}$/);
    expect(cfg.headers.get("x-commonforge-lfs")).toBeNull();
  });

  it("a staged object: a developer at the change's candidate revision gets it, a client asking for that revision is refused, and at head it does not exist yet", async () => {
    const { h, o, pid, runner } = await world();
    await setApprovalRoles(h, o, pid, ["owner"]);
    const dev = await withAccess(h, o, pid, "developer", "write");
    const client = await withAccess(h, o, pid, "client", "read");
    const vid = video(3);
    const sha = await sha256Hex(vid);
    const a = await uploadFile(h, dev, pid, "videos/staged.mp4", vid);
    const r = await h.api("POST", `/api/orgs/${o.orgId}/projects/${pid}/folders/site/changes`, { token: dev.token, body: { ops: [{ put: "videos/staged.mp4", stagingId: a }] } });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    const c = await land(h, o, r.body.changeId);
    expect(runner.errors).toEqual([]);
    expect(c.state).toBe("waiting_approval");
    const p = (await h.api("GET", `/api/orgs/${o.orgId}/proposals/${c.proposalId}`, { token: o.token })).body;
    const rev = p.resourceChanges[0].candidateRevision as string;

    const tree = await h.api("GET", treeUrl(o, pid, "videos", rev), { token: dev.token });
    expect(tree.status, JSON.stringify(tree.body)).toBe(200);
    expect(tree.body.entries).toEqual([{ path: "videos/staged.mp4", type: "file", size: vid.length, lfs: true }]);
    const f = await getBytes(h, fileUrl(o, pid, "videos/staged.mp4", rev), dev.token);
    expect(f.status).toBe(200);
    expect(f.headers.get("x-commonforge-lfs")).toBe(sha);
    expect(await sha256Hex(f.bytes)).toBe(sha);

    expect((await h.api("GET", fileUrl(o, pid, "videos/staged.mp4", rev), { token: client.token })).status).toBe(403);
    const ct = await h.api("GET", treeUrl(o, pid, "videos", rev), { token: client.token });
    expect(ct.status).toBe(403);
    expect(ct.body.error?.code ?? ct.body.code).toBe("revision_not_allowed");
    // not accepted: the head does not have the file at all
    expect((await h.api("GET", fileUrl(o, pid, "videos/staged.mp4"), { token: dev.token })).status).toBe(404);
  });

  it("a pointer to an object CommonForge does not hold is pointer text with x-commonforge-lfs: missing", async () => {
    const { h, o, pid } = await world();
    const unknown = "ab".repeat(32);
    const pointer = lfsPointer(unknown, 123_456);
    const site2 = await codeResource(h, o, "imported", { "big.bin": pointer, "readme.txt": "hi\n" });
    const pid2 = await projectWith(h, o, [{ mountName: "site", resourceId: site2.resourceId }]);
    void pid;
    const tree = await h.api("GET", treeUrl(o, pid2, ""), { token: o.token });
    expect(tree.status).toBe(200);
    const big = tree.body.entries.find((e: { path: string }) => e.path === "big.bin");
    expect(big).not.toHaveProperty("lfs");
    const f = await getBytes(h, fileUrl(o, pid2, "big.bin"), o.token);
    expect(f.status).toBe(200);
    expect(f.headers.get("x-commonforge-lfs")).toBe("missing");
    expect(f.headers.get("x-commonforge-blob")).toMatch(/^[0-9a-f]{40}$/);
    expect(new TextDecoder().decode(f.bytes)).toBe(pointer);
  });

  it("an accepted object whose bytes are gone answers 404 object_missing", async () => {
    const { h, o, pid } = await world();
    const vid = video(5);
    const a = await uploadFile(h, o, pid, "videos/gone.mp4", vid);
    const r = await h.api("POST", `/api/orgs/${o.orgId}/projects/${pid}/folders/site/changes`, { token: o.token, body: { ops: [{ put: "videos/gone.mp4", stagingId: a }] } });
    expect((await land(h, o, r.body.changeId)).state).toBe("added");
    const row = await env.DB.prepare("SELECT r2_key FROM lfs_objects WHERE staging_id = ?").bind(a).first<{ r2_key: string }>();
    await env.COMMONFORGE_ASSETS.delete(row!.r2_key);
    const f = await h.api("GET", fileUrl(o, pid, "videos/gone.mp4"), { token: o.token });
    expect(f.status).toBe(404);
    expect(JSON.stringify(f.body)).toContain("object_missing");
  });
});

describe("mounts say canWrite", () => {
  it("true for an owner and a developer with write; false for a developer with read and for a client", async () => {
    const { h, o, pid } = await world();
    const devW = await withAccess(h, o, pid, "developer", "write");
    const devR = await withAccess(h, o, pid, "developer", "read");
    const client = await withAccess(h, o, pid, "client", "read");
    const canWrite = async (token: string) => {
      const r = await h.api("GET", `/api/orgs/${o.orgId}/projects/${pid}`, { token });
      expect(r.status).toBe(200);
      return r.body.mounts.map((m: { mountName: string; canWrite: boolean }) => [m.mountName, m.canWrite]);
    };
    expect(await canWrite(o.token)).toEqual([["site", true]]);
    expect(await canWrite(devW.token)).toEqual([["site", true]]);
    expect(await canWrite(devR.token)).toEqual([["site", false]]);
    expect(await canWrite(client.token)).toEqual([["site", false]]);
  });
});
