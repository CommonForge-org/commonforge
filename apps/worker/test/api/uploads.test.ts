import { sha256Hex } from "@commonforge-org/core";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { uploadPath } from "../../src/routes/uploads.js";
import { codeResource, fileCollection, harness, member, ownerWithOrg, projectWith, provisionedTask, type Harness } from "../helpers.js";

const PART = 5_242_880;

async function world() {
  const h = harness();
  h.envOverrides.COMMONFORGE_UPLOAD_PART_BYTES = String(PART);
  const o = await ownerWithOrg(h);
  const site = await codeResource(h, o, "site", { "index.html": "v1" });
  const pid = await projectWith(h, o, [{ mountName: "site", resourceId: site.resourceId }]);
  return { h, o, site, pid };
}

const start = (h: Harness, token: string, org: string, pid: string, body: unknown, mount = "site") => h.api("POST", `/api/orgs/${org}/projects/${pid}/folders/${mount}/uploads`, { token, body });
const putPart = (h: Harness, token: string, org: string, id: string, n: number, bytes: Uint8Array) =>
  h.api("PUT", `/api/orgs/${org}/uploads/${id}/parts/${n}`, { token, raw: bytes, headers: { "content-length": String(bytes.length) } });

describe("browser uploads", () => {
  it("two parts, complete, then the hash step verifies the object", async () => {
    const { h, o, pid } = await world();
    const data = new Uint8Array(PART + 10).map((_, i) => i % 251);
    const s = await start(h, o.token, o.orgId, pid, { path: "videos/demo.mp4", size: data.length, mime: "video/mp4" });
    expect(s.status).toBe(201);
    expect(s.body).toMatchObject({ partSize: PART, parts: 2 });
    const p1 = await putPart(h, o.token, o.orgId, s.body.uploadId, 1, data.slice(0, PART));
    const p2 = await putPart(h, o.token, o.orgId, s.body.uploadId, 2, data.slice(PART));
    expect([p1.status, p2.status]).toEqual([200, 200]);
    const done = await h.api("POST", `/api/orgs/${o.orgId}/uploads/${s.body.uploadId}/complete`, { token: o.token, body: { parts: [{ n: 1, etag: p1.body.etag }, { n: 2, etag: p2.body.etag }] } });
    expect(done.status).toBe(200);
    expect(done.body).toEqual({ stagingId: s.body.uploadId, size: data.length });
    await h.drainSteps();
    const st = await h.api("GET", `/api/orgs/${o.orgId}/uploads/${s.body.uploadId}`, { token: o.token });
    expect(st.body).toMatchObject({ state: "verified", sha256: await sha256Hex(data), size: data.length });
  });

  it("a part of the wrong size is refused; a part over the part size is 413", async () => {
    const { h, o, pid } = await world();
    const s = await start(h, o.token, o.orgId, pid, { path: "a.bin", size: PART + 10, mime: "application/octet-stream" });
    expect((await putPart(h, o.token, o.orgId, s.body.uploadId, 1, new Uint8Array(PART - 1))).body.error.code).toBe("part_size_mismatch");
    expect((await putPart(h, o.token, o.orgId, s.body.uploadId, 1, new Uint8Array(PART + 1))).status).toBe(413);
    expect((await putPart(h, o.token, o.orgId, s.body.uploadId, 3, new Uint8Array(10))).status).toBe(400);
  });

  it("only owners and developers with write may start; only the uploader may continue", async () => {
    const { h, o, pid } = await world();
    const dev = await member(h, o, "developer");
    const client = await member(h, o, "client");
    expect((await start(h, client.token, o.orgId, pid, { path: "a.txt", size: 1, mime: "text/plain" })).status).toBe(403);
    // a developer with read only
    const acc = await h.api("PUT", `/api/orgs/${o.orgId}/projects/${pid}/access`, { token: o.token, body: { userId: dev.userId, level: "read" } });
    expect(acc.status).toBe(200);
    const ro = await start(h, dev.token, o.orgId, pid, { path: "a.txt", size: 1, mime: "text/plain" });
    expect(ro.status).toBe(403);
    expect(ro.body.error.code).toBe("no_write_grant");
    const s = await start(h, o.token, o.orgId, pid, { path: "a.txt", size: 1, mime: "text/plain" });
    expect((await putPart(h, dev.token, o.orgId, s.body.uploadId, 1, new Uint8Array(1))).status).toBe(404);
  });

  it("size and path limits", async () => {
    const { h, o, pid } = await world();
    expect((await start(h, o.token, o.orgId, pid, { path: "big.iso", size: 5_000_000_001, mime: "x/y" })).status).toBe(413);
    expect((await start(h, o.token, o.orgId, pid, { path: "../x", size: 1, mime: "x/y" })).status).toBe(400);
    expect((await start(h, o.token, o.orgId, pid, { path: ".git/config", size: 1, mime: "x/y" })).status).toBe(400);
    expect((await start(h, o.token, o.orgId, pid, { path: "neg.txt", size: -1, mime: "x/y" })).body.error.code).toBe("invalid_size");
  });

  it("an empty file: parts 0, no part is taken, complete with no parts writes an empty object that the hash step verifies", async () => {
    const { h, o, pid } = await world();
    const s = await start(h, o.token, o.orgId, pid, { path: "pkg/__init__.py", size: 0, mime: "text/x-python" });
    expect(s.status, JSON.stringify(s.body)).toBe(201);
    expect(s.body).toMatchObject({ partSize: PART, parts: 0 });
    const row = await env.DB.prepare("SELECT r2_key, upload_id, state FROM lfs_objects WHERE staging_id = ?").bind(s.body.uploadId).first<{ r2_key: string; upload_id: string | null; state: string }>();
    // no R2 multipart upload was created (nothing to leak)
    expect(row).toMatchObject({ upload_id: null, state: "uploading" });
    const p1 = await putPart(h, o.token, o.orgId, s.body.uploadId, 1, new Uint8Array(0));
    expect([p1.status, p1.body.error.code]).toEqual([400, "invalid_part"]);
    const complete = (parts: unknown[]) => h.api("POST", `/api/orgs/${o.orgId}/uploads/${s.body.uploadId}/complete`, { token: o.token, body: { parts } });
    expect((await complete([{ n: 1, etag: "x" }])).body.error.code).toBe("parts_mismatch");
    const done = await complete([]);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toEqual({ stagingId: s.body.uploadId, size: 0 });
    expect((await env.COMMONFORGE_ASSETS.head(row!.r2_key))?.size).toBe(0);
    // a retry after a lost 200
    expect((await complete([])).body).toEqual({ stagingId: s.body.uploadId, size: 0 });
    await h.drainSteps();
    const st = await h.api("GET", `/api/orgs/${o.orgId}/uploads/${s.body.uploadId}`, { token: o.token });
    expect(st.body).toMatchObject({ state: "verified", size: 0, sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" });
    expect((await env.DB.prepare("SELECT binary FROM lfs_objects WHERE staging_id = ?").bind(s.body.uploadId).first<{ binary: number }>())!.binary).toBe(0);
  });

  it("an unfinished empty upload can be canceled: row gone, nothing at R2", async () => {
    const { h, o, pid } = await world();
    const s = await start(h, o.token, o.orgId, pid, { path: ".gitkeep", size: 0, mime: "text/plain" });
    expect((await h.api("DELETE", `/api/orgs/${o.orgId}/uploads/${s.body.uploadId}`, { token: o.token })).status).toBe(204);
    expect(await env.DB.prepare("SELECT 1 FROM lfs_objects WHERE staging_id = ?").bind(s.body.uploadId).first()).toBeNull();
    expect((await h.api("POST", `/api/orgs/${o.orgId}/uploads/${s.body.uploadId}/complete`, { token: o.token, body: { parts: [] } })).status).toBe(404);
    expect((await env.COMMONFORGE_ASSETS.list({ prefix: `org/${o.orgId}/lfs/` })).objects).toEqual([]);
  });

  it("uploadPath refuses paths longer than 1,024 characters", () => {
    expect(uploadPath("a".repeat(1024))).toBe("a".repeat(1024));
    expect(() => uploadPath("a".repeat(1025))).toThrow(expect.objectContaining({ status: 400, code: "invalid_path" }));
    expect(() => uploadPath(`${"d/".repeat(600)}f`)).toThrow(expect.objectContaining({ status: 400, code: "invalid_path" }));
  });

  it("a file collection folder takes uploads (plan phase 3, Task 5)", async () => {
    const { h, o, pid } = await world();
    await fileCollection(h, o, pid, "brand");
    expect((await start(h, o.token, o.orgId, pid, { path: "a.png", size: 1, mime: "image/png" }, "brand")).status).toBe(201);
  });

  it("abort aborts the R2 multipart upload; later parts and complete are 404", async () => {
    const { h, o, site, pid } = await world();
    const s = await start(h, o.token, o.orgId, pid, { path: "a.txt", size: 3, mime: "text/plain" });
    const p = await putPart(h, o.token, o.orgId, s.body.uploadId, 1, new Uint8Array(3));
    const row = await env.DB.prepare("SELECT r2_key, upload_id FROM lfs_objects WHERE staging_id = ?").bind(s.body.uploadId).first<{ r2_key: string; upload_id: string }>();
    expect(row!.r2_key).toBe(`org/${o.orgId}/lfs/${site.resourceId}/obj/${s.body.uploadId}`);
    expect((await h.api("DELETE", `/api/orgs/${o.orgId}/uploads/${s.body.uploadId}`, { token: o.token })).status).toBe(204);
    // R2 itself no longer knows the multipart upload
    await expect(env.COMMONFORGE_ASSETS.resumeMultipartUpload(row!.r2_key, row!.upload_id).uploadPart(1, new Uint8Array(3))).rejects.toThrow();
    expect(await env.DB.prepare("SELECT 1 FROM lfs_objects WHERE staging_id = ?").bind(s.body.uploadId).first()).toBeNull();
    expect((await putPart(h, o.token, o.orgId, s.body.uploadId, 1, new Uint8Array(3))).status).toBe(404);
    expect((await h.api("POST", `/api/orgs/${o.orgId}/uploads/${s.body.uploadId}/complete`, { token: o.token, body: { parts: [{ n: 1, etag: p.body.etag }] } })).status).toBe(404);
    expect((await env.COMMONFORGE_ASSETS.list({ prefix: `org/${o.orgId}/lfs/` })).objects).toEqual([]);
  });

  it("a body shorter or longer than its content-length is part_size_mismatch", async () => {
    const { h, o, pid } = await world();
    const s = await start(h, o.token, o.orgId, pid, { path: "a.bin", size: 10, mime: "application/octet-stream" });
    const put = (body: Uint8Array, len: number) => h.api("PUT", `/api/orgs/${o.orgId}/uploads/${s.body.uploadId}/parts/1`, { token: o.token, raw: body, headers: { "content-length": String(len) } });
    // content-length says 10 (the right size) but fewer bytes arrive
    const short = await put(new Uint8Array(4), 10);
    expect([short.status, short.body.error.code]).toEqual([400, "part_size_mismatch"]);
    const long = await put(new Uint8Array(14), 10);
    expect([long.status, long.body.error.code]).toEqual([400, "part_size_mismatch"]);
    // the upload is still usable afterwards
    expect((await put(new Uint8Array(10), 10)).status).toBe(200);
  });

  it("complete with a bogus etag is upload_incomplete and the upload stays usable", async () => {
    const { h, o, pid } = await world();
    const s = await start(h, o.token, o.orgId, pid, { path: "a.txt", size: 3, mime: "text/plain" });
    const p = await putPart(h, o.token, o.orgId, s.body.uploadId, 1, new Uint8Array([1, 2, 3]));
    const complete = (etag: string) => h.api("POST", `/api/orgs/${o.orgId}/uploads/${s.body.uploadId}/complete`, { token: o.token, body: { parts: [{ n: 1, etag }] } });
    const bad = await complete("0123456789abcdef0123456789abcdef");
    expect([bad.status, bad.body.error.code]).toEqual([400, "upload_incomplete"]);
    expect((await h.api("GET", `/api/orgs/${o.orgId}/uploads/${s.body.uploadId}`, { token: o.token })).body.state).toBe("uploading");
    expect((await complete(p.body.etag)).status).toBe(200);
  });

  it("an undersized non-final part is upload_incomplete", async () => {
    const { h, o, pid } = await world();
    const s = await start(h, o.token, o.orgId, pid, { path: "a.bin", size: PART + 10, mime: "application/octet-stream" });
    // bypass the Worker's size check: upload a tiny part 1 straight to R2
    const row = await env.DB.prepare("SELECT r2_key, upload_id FROM lfs_objects WHERE staging_id = ?").bind(s.body.uploadId).first<{ r2_key: string; upload_id: string }>();
    const mp = env.COMMONFORGE_ASSETS.resumeMultipartUpload(row!.r2_key, row!.upload_id);
    const p1 = await mp.uploadPart(1, new Uint8Array(5));
    const p2 = await mp.uploadPart(2, new Uint8Array(10));
    const r = await h.api("POST", `/api/orgs/${o.orgId}/uploads/${s.body.uploadId}/complete`, { token: o.token, body: { parts: [{ n: 1, etag: p1.etag }, { n: 2, etag: p2.etag }] } });
    expect([r.status, r.body.error.code]).toEqual([400, "upload_incomplete"]);
  });

  it("complete is idempotent: a retry after a lost 200, or after a lost database write, succeeds", async () => {
    const { h, o, pid } = await world();
    const s = await start(h, o.token, o.orgId, pid, { path: "a.txt", size: 3, mime: "text/plain" });
    const p = await putPart(h, o.token, o.orgId, s.body.uploadId, 1, new Uint8Array([1, 2, 3]));
    const complete = () => h.api("POST", `/api/orgs/${o.orgId}/uploads/${s.body.uploadId}/complete`, { token: o.token, body: { parts: [{ n: 1, etag: p.body.etag }] } });
    expect((await complete()).status).toBe(200);
    // retry while uploaded
    expect(await complete()).toMatchObject({ status: 200, body: { stagingId: s.body.uploadId, size: 3 } });
    // R2 finished the multipart upload but the row never left `uploading`
    await env.DB.prepare("UPDATE lfs_objects SET state = 'uploading' WHERE staging_id = ?").bind(s.body.uploadId).run();
    expect(await complete()).toMatchObject({ status: 200, body: { stagingId: s.body.uploadId, size: 3 } });
    expect((await h.api("GET", `/api/orgs/${o.orgId}/uploads/${s.body.uploadId}`, { token: o.token })).body.state).toBe("uploaded");
    await h.drainSteps();
    // retry once verified
    expect((await h.api("GET", `/api/orgs/${o.orgId}/uploads/${s.body.uploadId}`, { token: o.token })).body.state).toBe("verified");
    expect((await complete()).status).toBe(200);
    await h.drainSteps();
  });

  it("a long path answers invalid_path over HTTP", async () => {
    const { h, o, pid } = await world();
    const r = await start(h, o.token, o.orgId, pid, { path: "a".repeat(1025), size: 1, mime: "x/y" });
    expect([r.status, r.body.error.code]).toEqual([400, "invalid_path"]);
    const ok = await start(h, o.token, o.orgId, pid, { path: "a".repeat(1024), size: 1, mime: "x/y" });
    expect(ok.status).toBe(201);
  });

  it("parts_mismatch, upload_finished and length_required", async () => {
    const { h, o, pid } = await world();
    const s = await start(h, o.token, o.orgId, pid, { path: "a.bin", size: PART + 10, mime: "application/octet-stream" });
    const complete = (parts: unknown[]) => h.api("POST", `/api/orgs/${o.orgId}/uploads/${s.body.uploadId}/complete`, { token: o.token, body: { parts } });
    const p1 = await putPart(h, o.token, o.orgId, s.body.uploadId, 1, new Uint8Array(PART));
    // 411: no content-length (a chunked body)
    const chunked = new ReadableStream<Uint8Array>({ start: (c) => (c.enqueue(new Uint8Array(10)), c.close()) });
    const noLen = await h.api("PUT", `/api/orgs/${o.orgId}/uploads/${s.body.uploadId}/parts/2`, { token: o.token, raw: chunked });
    expect([noLen.status, noLen.body.error.code]).toEqual([411, "length_required"]);
    const p2 = await putPart(h, o.token, o.orgId, s.body.uploadId, 2, new Uint8Array(10));
    for (const parts of [[{ n: 1, etag: p1.body.etag }], [{ n: 2, etag: p2.body.etag }, { n: 1, etag: p1.body.etag }], [{ n: 1, etag: p1.body.etag }, { n: 3, etag: p2.body.etag }]]) {
      const r = await complete(parts);
      expect([r.status, r.body.error.code]).toEqual([400, "parts_mismatch"]);
    }
    expect((await complete([{ n: 1, etag: p1.body.etag }, { n: 2, etag: p2.body.etag }])).status).toBe(200);
    const late = await putPart(h, o.token, o.orgId, s.body.uploadId, 1, new Uint8Array(PART));
    expect([late.status, late.body.error.code]).toEqual([409, "upload_finished"]);
  });

  it("anyone but the uploader gets 404; so does a user who cannot read the folder; agents are refused", async () => {
    const { h, o, pid } = await world();
    const s = await start(h, o.token, o.orgId, pid, { path: "a.txt", size: 1, mime: "text/plain" });
    const dev = await member(h, o, "developer");
    expect((await h.api("GET", `/api/orgs/${o.orgId}/uploads/${s.body.uploadId}`, { token: dev.token })).status).toBe(404);
    expect((await h.api("DELETE", `/api/orgs/${o.orgId}/uploads/${s.body.uploadId}`, { token: dev.token })).status).toBe(404);
    expect((await h.api("POST", `/api/orgs/${o.orgId}/uploads/${s.body.uploadId}/complete`, { token: dev.token, body: { parts: [{ n: 1, etag: "x" }] } })).status).toBe(404);
    // the upload survived the stranger's DELETE
    expect((await h.api("GET", `/api/orgs/${o.orgId}/uploads/${s.body.uploadId}`, { token: o.token })).status).toBe(200);
    // a developer with no access to the project cannot even see the folder
    expect((await start(h, dev.token, o.orgId, pid, { path: "a.txt", size: 1, mime: "text/plain" })).status).toBe(404);
  });

  it("task lease tokens are refused", async () => {
    const h = harness();
    const { o, pid, taskId } = await provisionedTask(h);
    const agent = (await h.api("POST", `/api/tasks/${taskId}/lease`, { token: o.token, body: {} })).body.leaseToken as string;
    expect(agent).toMatch(/^cfl_/);
    const r = await start(h, agent, o.orgId, pid, { path: "a.txt", size: 1, mime: "text/plain" }, "website");
    expect([r.status, r.body.error.code]).toEqual([403, "agent_not_allowed"]);
    expect((await h.api("GET", `/api/orgs/${o.orgId}/uploads/lfs-x`, { token: agent })).status).toBe(403);
    expect((await h.api("DELETE", `/api/orgs/${o.orgId}/uploads/lfs-x`, { token: agent })).status).toBe(403);
  });
});
