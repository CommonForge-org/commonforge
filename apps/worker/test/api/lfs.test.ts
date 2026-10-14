import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createServices } from "../../src/context.js";
import { getLfsObject, promoteObjects } from "../../src/services/lfs-store.js";
import { harness, member, provisionedTask } from "../helpers.js";
import { LFS_TYPE, basic, batch, lfsHeaders, lfsUpload, parse, world } from "../lfs/lfs-helpers.js";

describe("LFS batch API", () => {
  it("401 without credentials carries LFS-Authenticate", async () => {
    const { h, base } = await world();
    const r = await h.api("POST", `${base}/objects/batch`, { raw: JSON.stringify({ operation: "download", objects: [] }), headers: { "content-type": "application/vnd.git-lfs+json" } });
    expect(r.status).toBe(401);
    expect(r.headers.get("lfs-authenticate")).toMatch(/^Basic realm=/);
    // git-lfs reads LFS-Authenticate; WWW-Authenticate would make browsers prompt for and cache Basic credentials
    expect(r.headers.get("www-authenticate")).toBeNull();
    expect(r.headers.get("content-type")).toContain("application/vnd.git-lfs+json");
  });

  it("a Bearer token works as well as Basic", async () => {
    const { h, o, base } = await world();
    const r = await h.api("POST", `${base}/objects/batch`, { token: o.token, headers: { "content-type": "application/vnd.git-lfs+json" }, raw: JSON.stringify({ operation: "download", objects: [] }) });
    expect(r.status).toBe(200);
  });

  it("owner upload: presigned PUT to the object's key for 15 min, verify, hash; the batch then skips an accepted copy", async () => {
    const { h, o, base, site } = await world();
    const bytes = new TextEncoder().encode("video bytes");
    const { oid, key, obj } = await lfsUpload(h, base, o.token, bytes);
    expect(obj.actions.upload.expires_in).toBe(900);
    expect(new URL(obj.actions.upload.href).host).toBe(`${env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`);
    // the URL only creates: if-none-match: * is signed, and git-lfs sends the action's header
    expect(new URL(obj.actions.upload.href).searchParams.get("X-Amz-SignedHeaders")).toBe("host;if-none-match");
    expect(obj.actions.upload.header).toEqual({ "If-None-Match": "*" });
    expect(key.startsWith(`org/${o.orgId}/lfs/${site.resourceId}/obj/`)).toBe(true);
    const svc = createServices(env, h.deps);
    const stagingId = key.split("/").pop()!;
    expect((await getLfsObject(svc, o.orgId, stagingId))?.state).toBe("verified");
    // not accepted yet: a second upload batch still asks for the bytes (never skip unverified/unaccepted)
    expect(parse(await batch(h, base, o.token, "upload", [{ oid, size: bytes.length }])).objects[0].actions?.upload).toBeTruthy();
    await promoteObjects(svc, o.orgId, [stagingId]);
    expect(parse(await batch(h, base, o.token, "upload", [{ oid, size: bytes.length }])).objects[0].actions).toBeUndefined();
  });

  it("download streams the object through the Worker", async () => {
    const { h, o, base } = await world();
    const bytes = new TextEncoder().encode("hello lfs");
    const { oid } = await lfsUpload(h, base, o.token, bytes);
    const d = parse(await batch(h, base, o.token, "download", [{ oid, size: bytes.length }]));
    const href = new URL(d.objects[0].actions.download.href);
    expect(href.pathname).toBe(`${base}/objects/${oid}`);
    const got = await h.api("GET", href.pathname, { headers: d.objects[0].actions.download.header });
    expect(got.status).toBe(200);
    expect(got.body).toBe("hello lfs");
  });

  it("a retried batch reuses the caller's pending row; a retried verify answers 200", async () => {
    const { h, o, base } = await world();
    const bytes = new TextEncoder().encode("retry me");
    const { oid } = await lfsUpload(h, base, o.token, bytes);
    // the verify already went through (lfsUpload): a retry, e.g. after a lost response, answers 200 again
    const v = await h.api("POST", `${base}/verify`, { headers: { ...basic(o.token), "content-type": LFS_TYPE }, raw: JSON.stringify({ oid, size: bytes.length }) });
    expect(v.status).toBe(200);
    // the verified-but-unaccepted copy is not skipped: a fresh row is offered
    expect(parse(await batch(h, base, o.token, "upload", [{ oid, size: bytes.length }])).objects[0].actions.upload).toBeTruthy();
    // pending rows are reused across batch retries
    const oid2 = "c".repeat(64);
    const a = parse(await batch(h, base, o.token, "upload", [{ oid: oid2, size: 4 }])).objects[0];
    const b = parse(await batch(h, base, o.token, "upload", [{ oid: oid2, size: 4 }])).objects[0];
    expect(new URL(a.actions.upload.href).pathname).toBe(new URL(b.actions.upload.href).pathname);
    // ...until its key holds bytes (a push interrupted between PUT and verify): the create-only URL
    // could not write it again, so a fresh key is offered
    await env.COMMONFORGE_ASSETS.put(decodeURIComponent(new URL(a.actions.upload.href).pathname.split("/").slice(2).join("/")), "abcd");
    const c = parse(await batch(h, base, o.token, "upload", [{ oid: oid2, size: 4 }])).objects[0];
    expect(new URL(c.actions.upload.href).pathname).not.toBe(new URL(a.actions.upload.href).pathname);
  });

  it("bytes written again after verification are never served: the GET answers 404 and the object is rejected (accepted or not)", async () => {
    const { h, o, base } = await world();
    const svc = createServices(env, h.deps);
    for (const accept of [false, true]) {
      const bytes = new TextEncoder().encode(`verified bytes ${accept}`);
      const { oid, key } = await lfsUpload(h, base, o.token, bytes);
      const stagingId = key.split("/").pop()!;
      if (accept) await promoteObjects(svc, o.orgId, [stagingId]);
      expect((await getLfsObject(svc, o.orgId, stagingId))?.etag).toBeTruthy();
      expect((await h.api("GET", `${base}/objects/${oid}`, { headers: basic(o.token) })).body).toBe(`verified bytes ${accept}`);
      // the presigned URL had not expired: the key is written again
      await env.COMMONFORGE_ASSETS.put(key, "other bytes");
      const g = await h.api("GET", `${base}/objects/${oid}`, { headers: basic(o.token) });
      expect(g.status).toBe(404);
      const row = await getLfsObject(svc, o.orgId, stagingId);
      expect(row?.state).toBe("rejected");
      expect(row?.error).toBe("object_changed");
      // nothing is deleted here (GC handles rejected rows), and the batch no longer offers it
      expect(await env.COMMONFORGE_ASSETS.head(key)).not.toBeNull();
      expect(parse(await batch(h, base, o.token, "download", [{ oid, size: bytes.length }])).objects[0].error.code).toBe(404);
    }
  });

  it("locks/verify answers an empty lock list with the same credentials; other lock calls are 404", async () => {
    const { h, o, base } = await world();
    const r = await h.api("POST", `${base}/locks/verify`, { headers: lfsHeaders(o.token), raw: "{}" });
    expect(r.status).toBe(200);
    expect(parse(r)).toEqual({ ours: [], theirs: [] });
    expect((await h.api("GET", `${base}/locks`, { headers: lfsHeaders(o.token) })).status).toBe(404);
    expect((await h.api("POST", `${base}/locks`, { headers: lfsHeaders(o.token), raw: "{}" })).status).toBe(404);
  });

  it("a non-member gets 404; a client cannot upload", async () => {
    const { h, o, base } = await world();
    const stranger = await h.signIn("stranger-lfs@example.test");
    expect((await batch(h, base, stranger, "download", [])).status).toBe(404);
    const client = await member(h, o, "client");
    const r = await batch(h, base, client.token, "upload", [{ oid: "a".repeat(64), size: 1 }]);
    expect([403, 404]).toContain(r.status);
  });

  it("503 for uploads when this deployment has no R2 S3 credentials", async () => {
    const { h, o, base } = await world();
    h.envOverrides.COMMONFORGE_R2_ACCESS_KEY_ID = "";
    const r = await batch(h, base, o.token, "upload", [{ oid: "a".repeat(64), size: 1 }]);
    expect(r.status).toBe(503);
  });

  it("verify refuses a missing object or a size that differs (422)", async () => {
    const { h, o, base } = await world();
    const oid = "d".repeat(64);
    const b = parse(await batch(h, base, o.token, "upload", [{ oid, size: 5 }]));
    const v = await h.api("POST", new URL(b.objects[0].actions.verify.href).pathname, { headers: { ...b.objects[0].actions.verify.header }, raw: JSON.stringify({ oid, size: 5 }) });
    expect(v.status).toBe(422);
    await env.COMMONFORGE_ASSETS.put(decodeURIComponent(new URL(b.objects[0].actions.upload.href).pathname.split("/").slice(2).join("/")), new Uint8Array(3));
    const v2 = await h.api("POST", new URL(b.objects[0].actions.verify.href).pathname, { headers: { ...b.objects[0].actions.verify.header }, raw: JSON.stringify({ oid, size: 5 }) });
    expect(v2.status).toBe(422);
  });

  it("objects over 5 GB get a per-object 422", async () => {
    const { h, o, base } = await world();
    const r = parse(await batch(h, base, o.token, "upload", [{ oid: "f".repeat(64), size: 5_000_000_001 }]));
    expect(r.objects[0].error.code).toBe(422);
  });

  it("a batch is capped at 100 objects (413)", async () => {
    const { h, o, base } = await world();
    const objs = (n: number) => Array.from({ length: n }, (_, i) => ({ oid: i.toString(16).padStart(64, "0"), size: 1 }));
    const r = await batch(h, base, o.token, "download", objs(101));
    expect(r.status).toBe(413);
    expect(parse(r).message).toBe("at most 100 objects per batch");
    expect((await batch(h, base, o.token, "download", objs(100))).status).toBe(200);
  });

  it("a body that is not a JSON object answers 422", async () => {
    const { h, o, base } = await world();
    for (const raw of ["null", "5", '"x"', "[]"]) {
      expect((await h.api("POST", `${base}/objects/batch`, { headers: lfsHeaders(o.token), raw })).status).toBe(422);
      expect((await h.api("POST", `${base}/verify`, { headers: lfsHeaders(o.token), raw })).status).toBe(422);
    }
    expect((await h.api("POST", `${base}/objects/batch`, { headers: lfsHeaders(o.token), raw: "{" })).status).toBe(400);
  });

  it("responses are not cacheable; downloads are attachments that browsers do not sniff", async () => {
    const { h, o, base } = await world();
    const bytes = new TextEncoder().encode("<script>alert(1)</script>");
    const { oid } = await lfsUpload(h, base, o.token, bytes);
    const b = await batch(h, base, o.token, "download", [{ oid, size: bytes.length }]);
    expect(b.headers.get("cache-control")).toBe("no-store");
    expect((await h.api("POST", `${base}/locks/verify`, { headers: lfsHeaders(o.token), raw: "{}" })).headers.get("cache-control")).toBe("no-store");
    const g = await h.api("GET", `${base}/objects/${oid}`, { headers: basic(o.token) });
    expect(g.headers.get("x-content-type-options")).toBe("nosniff");
    expect(g.headers.get("content-disposition")).toBe("attachment");
    expect(g.headers.get("cache-control")).toBe("private, no-store");
    expect(g.headers.get("content-type")).toBe("application/octet-stream");
  });

  it("a lease holder demoted to client gets 403 on the batch", async () => {
    const h = harness();
    const { o, web, taskId } = await provisionedTask(h);
    const base = `/api/lfs/${o.orgId}/${web.resourceId}/info/lfs`;
    const agent = (await h.api("POST", `/api/tasks/${taskId}/lease`, { token: o.token, body: {} })).body.leaseToken as string;
    expect((await batch(h, base, agent, "download", [])).status).toBe(200);
    const svc = createServices(env, h.deps);
    await svc.db.prepare("UPDATE memberships SET role = 'client' WHERE org_id = ? AND user_id = ?").bind(o.orgId, o.userId).run();
    expect((await batch(h, base, agent, "download", [])).status).toBe(403);
  });
});
