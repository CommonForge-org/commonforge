// apps/worker/test/lfs/lfs-store.test.ts
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createServices } from "../../src/context.js";
import {
  acceptedObject,
  createLfsObject,
  findPendingLfsUpload,
  getLfsObject,
  markRejected,
  markUploaded,
  markVerified,
  promoteObjects,
  promoteTask,
  servableObject,
} from "../../src/services/lfs-store.js";
import { harness, uniq } from "../helpers.js";

const svcOf = () => createServices(env, harness().deps);
const OID = "b".repeat(64);

describe("lfs_objects", () => {
  it("create → uploaded → verified; the key lives under the org and folder", async () => {
    const svc = svcOf();
    const org = uniq("o");
    const row = await createLfsObject(svc, { orgId: org, resourceId: "r1", size: 10, source: "lfs", userId: "u1", claimedOid: OID, state: "uploading" });
    expect(row.r2_key).toBe(`org/${org}/lfs/r1/obj/${row.staging_id}`);
    expect(row.staging_id).toMatch(/^lfs-[0-9a-f]{24}$/);
    expect(await markVerified(svc, row.staging_id, OID, false, "etag-1", "p".repeat(40))).toBe(false); // must be uploaded first
    expect(await markUploaded(svc, row.staging_id)).toBe(true);
    expect(await markUploaded(svc, row.staging_id)).toBe(false);
    expect(await markVerified(svc, row.staging_id, OID, true, "etag-1", "p".repeat(40))).toBe(true);
    const again = await getLfsObject(svc, org, row.staging_id);
    expect(again).toMatchObject({ state: "verified", sha256: OID, binary: 1, accepted_at: null });
  });

  it("pending git-lfs uploads are found per uploader (user or task)", async () => {
    const svc = svcOf();
    const org = uniq("o");
    const mine = await createLfsObject(svc, { orgId: org, resourceId: "r1", size: 10, source: "lfs", userId: "u1", claimedOid: OID, state: "uploading" });
    await createLfsObject(svc, { orgId: org, resourceId: "r1", size: 10, source: "lfs", userId: "u2", taskId: "t9", claimedOid: OID, state: "uploading" });
    expect((await findPendingLfsUpload(svc, { orgId: org, resourceId: "r1", oid: OID, userId: "u1", taskId: null }))?.staging_id).toBe(mine.staging_id);
    expect((await findPendingLfsUpload(svc, { orgId: org, resourceId: "r1", oid: OID, userId: "u2", taskId: "t9" }))?.task_id).toBe("t9");
    expect(await findPendingLfsUpload(svc, { orgId: org, resourceId: "r1", oid: OID, userId: "u2", taskId: null })).toBeNull();
  });

  it("servable: accepted for everyone with read; unaccepted only when staged reads are allowed (and only the task's own for agents)", async () => {
    const svc = svcOf();
    const org = uniq("o");
    const staged = await createLfsObject(svc, { orgId: org, resourceId: "r1", size: 3, source: "lfs", userId: "u1", taskId: "t1", claimedOid: OID, state: "uploading" });
    await markUploaded(svc, staged.staging_id);
    await markVerified(svc, staged.staging_id, OID, false, "etag-1", "p".repeat(40));
    expect(await servableObject(svc, { orgId: org, resourceId: "r1", oid: OID, staged: false })).toBeNull();
    expect((await servableObject(svc, { orgId: org, resourceId: "r1", oid: OID, staged: true }))?.staging_id).toBe(staged.staging_id);
    expect(await servableObject(svc, { orgId: org, resourceId: "r1", oid: OID, staged: true, taskId: "t2" })).toBeNull();
    expect((await servableObject(svc, { orgId: org, resourceId: "r1", oid: OID, staged: true, taskId: "t1" }))?.staging_id).toBe(staged.staging_id);
    expect(await acceptedObject(svc, org, "r1", OID)).toBeNull();
    expect(await promoteObjects(svc, org, [staged.staging_id])).toBe(1);
    expect((await servableObject(svc, { orgId: org, resourceId: "r1", oid: OID, staged: false }))?.staging_id).toBe(staged.staging_id);
    expect((await acceptedObject(svc, org, "r1", OID))?.staging_id).toBe(staged.staging_id);
  });

  it("task promotion accepts the task's verified objects now and later-verified ones when they verify", async () => {
    const svc = svcOf();
    const org = uniq("o");
    const early = await createLfsObject(svc, { orgId: org, resourceId: "r1", size: 3, source: "lfs", userId: "u1", taskId: "t1", claimedOid: OID, state: "uploading" });
    await markUploaded(svc, early.staging_id);
    await markVerified(svc, early.staging_id, OID, false, "etag-1", "p".repeat(40));
    const late = await createLfsObject(svc, { orgId: org, resourceId: "r1", size: 4, source: "lfs", userId: "u1", taskId: "t1", claimedOid: "c".repeat(64), state: "uploading" });
    await markUploaded(svc, late.staging_id);
    expect(await promoteTask(svc, org, "t1", ["r1"])).toBe(1);
    expect((await getLfsObject(svc, org, early.staging_id))?.accepted_at).not.toBeNull();
    expect((await getLfsObject(svc, org, late.staging_id))?.accepted_at).toBeNull();
    await markVerified(svc, late.staging_id, "c".repeat(64), false, "etag-1", "p".repeat(40));
    expect((await getLfsObject(svc, org, late.staging_id))?.accepted_at).not.toBeNull();
  });

  it("rejected objects are never servable", async () => {
    const svc = svcOf();
    const org = uniq("o");
    const row = await createLfsObject(svc, { orgId: org, resourceId: "r1", size: 3, source: "lfs", userId: "u1", claimedOid: OID, state: "uploading" });
    await markUploaded(svc, row.staging_id);
    await markRejected(svc, row.staging_id, "hash_mismatch");
    expect(await markVerified(svc, row.staging_id, OID, false, "etag-1", "p".repeat(40))).toBe(false);
    expect(await servableObject(svc, { orgId: org, resourceId: "r1", oid: OID, staged: true })).toBeNull();
    expect((await getLfsObject(svc, org, row.staging_id))?.error).toBe("hash_mismatch");
  });

  it("is org-scoped: another org cannot read, serve or promote the object", async () => {
    const svc = svcOf();
    const org = uniq("o");
    const other = uniq("o");
    const row = await createLfsObject(svc, { orgId: org, resourceId: "r1", size: 3, source: "lfs", userId: "u1", claimedOid: OID, state: "uploading" });
    await markUploaded(svc, row.staging_id);
    await markVerified(svc, row.staging_id, OID, false, "etag-1", "p".repeat(40));
    expect(await getLfsObject(svc, other, row.staging_id)).toBeNull();
    expect(await servableObject(svc, { orgId: other, resourceId: "r1", oid: OID, staged: true })).toBeNull();
    expect(await promoteObjects(svc, other, [row.staging_id])).toBe(0);
    expect((await getLfsObject(svc, org, row.staging_id))?.accepted_at).toBeNull();
  });

  it("promoteTask leaves other tasks and resources alone and is idempotent", async () => {
    const svc = svcOf();
    const org = uniq("o");
    const t1 = uniq("t");
    const t2 = uniq("t");
    const mk = async (resourceId: string, taskId: string, oid: string) => {
      const r = await createLfsObject(svc, { orgId: org, resourceId, size: 3, source: "lfs", userId: "u1", taskId, claimedOid: oid, state: "uploading" });
      await markUploaded(svc, r.staging_id);
      await markVerified(svc, r.staging_id, oid, false, "etag-1", "p".repeat(40));
      return r.staging_id;
    };
    const mine = await mk("r1", t1, OID);
    const otherTask = await mk("r1", t2, "d".repeat(64));
    const otherResource = await mk("r2", t1, "e".repeat(64));
    expect(await promoteTask(svc, org, t1, ["r1"])).toBe(1);
    expect(await promoteTask(svc, org, t1, ["r1"])).toBe(0);
    expect((await getLfsObject(svc, org, mine))?.accepted_at).not.toBeNull();
    expect((await getLfsObject(svc, org, otherTask))?.accepted_at).toBeNull();
    expect((await getLfsObject(svc, org, otherResource))?.accepted_at).toBeNull();
  });

  it("promoteObjects only accepts verified objects", async () => {
    const svc = svcOf();
    const org = uniq("o");
    const up = await createLfsObject(svc, { orgId: org, resourceId: "r1", size: 3, source: "lfs", userId: "u1", claimedOid: OID, state: "uploading" });
    expect(await promoteObjects(svc, org, [up.staging_id])).toBe(0); // uploading
    await markUploaded(svc, up.staging_id);
    expect(await promoteObjects(svc, org, [up.staging_id])).toBe(0); // uploaded, unverified
    const rej = await createLfsObject(svc, { orgId: org, resourceId: "r1", size: 3, source: "lfs", userId: "u1", claimedOid: OID, state: "uploading" });
    await markRejected(svc, rej.staging_id, "bad");
    expect(await promoteObjects(svc, org, [rej.staging_id])).toBe(0);
    expect((await getLfsObject(svc, org, up.staging_id))?.accepted_at).toBeNull();
    expect((await getLfsObject(svc, org, rej.staging_id))?.accepted_at).toBeNull();
  });

  it("markRejected cannot touch a verified object", async () => {
    const svc = svcOf();
    const org = uniq("o");
    const row = await createLfsObject(svc, { orgId: org, resourceId: "r1", size: 3, source: "lfs", userId: "u1", claimedOid: OID, state: "uploading" });
    await markUploaded(svc, row.staging_id);
    await markVerified(svc, row.staging_id, OID, false, "etag-1", "p".repeat(40));
    await markRejected(svc, row.staging_id, "late");
    expect(await getLfsObject(svc, org, row.staging_id)).toMatchObject({ state: "verified", error: null });
  });

  it("an object created after the task's promotion stays unaccepted when it verifies", async () => {
    const svc = svcOf();
    const org = uniq("o");
    const t1 = uniq("t");
    expect(await promoteTask(svc, org, t1, ["r1"])).toBe(0);
    const before = await createLfsObject(svc, { orgId: org, resourceId: "r1", size: 3, source: "lfs", userId: "u1", taskId: t1, claimedOid: OID, state: "uploading" });
    const after = await createLfsObject(svc, { orgId: org, resourceId: "r1", size: 3, source: "lfs", userId: "u1", taskId: t1, claimedOid: "c".repeat(64), state: "uploading" });
    await svc.db.prepare("UPDATE lfs_objects SET created_at = '2999-01-01T00:00:00.000Z' WHERE staging_id = ?").bind(after.staging_id).run();
    await svc.db.prepare("UPDATE lfs_objects SET created_at = '2000-01-01T00:00:00.000Z' WHERE staging_id = ?").bind(before.staging_id).run();
    for (const r of [before, after]) await markUploaded(svc, r.staging_id);
    await markVerified(svc, before.staging_id, OID, false, "etag-1", "p".repeat(40));
    await markVerified(svc, after.staging_id, "c".repeat(64), false, "etag-1", "p".repeat(40));
    expect((await getLfsObject(svc, org, before.staging_id))?.accepted_at).not.toBeNull();
    expect((await getLfsObject(svc, org, after.staging_id))?.accepted_at).toBeNull();
    // and promoteTask run again later does not sweep it in either, while it is in the future
    expect(await promoteTask(svc, org, t1, ["r1"])).toBe(0);
  });

  it("a repeated promoteTask never widens the cutoff to objects created after the first promotion", async () => {
    const svc = svcOf();
    const org = uniq("o");
    const t1 = uniq("t");
    expect(await promoteTask(svc, org, t1, ["r1"])).toBe(0);
    const later = await createLfsObject(svc, { orgId: org, resourceId: "r1", size: 3, source: "lfs", userId: "u1", taskId: t1, claimedOid: OID, state: "uploading" });
    await svc.db.prepare("UPDATE lfs_objects SET created_at = '2001-01-01T00:00:00.000Z' WHERE staging_id = ?").bind(later.staging_id).run();
    // the first promotion happened in 2000, between the (earlier) promotion and this object, and before "now"
    await svc.db.prepare("UPDATE lfs_task_promotions SET accepted_at = '2000-01-01T00:00:00.000Z' WHERE task_id = ?").bind(t1).run();
    await markUploaded(svc, later.staging_id);
    await markVerified(svc, later.staging_id, OID, false, "etag-1", "p".repeat(40));
    expect(await promoteTask(svc, org, t1, ["r1"])).toBe(0);
    expect((await getLfsObject(svc, org, later.staging_id))?.accepted_at).toBeNull();
  });
});

describe("promoteObjects (I2)", () => {
  it("promotes 200 objects in chunks of at most 90 ids in one batch; other orgs' and unverified rows stay", async () => {
    const svc = svcOf();
    const org = uniq("o");
    const now = new Date().toISOString();
    const ids = Array.from({ length: 200 }, (_, i) => `lfs-p-${org}-${i}`);
    const insert = (id: string, orgId: string, state: string) =>
      env.DB.prepare("INSERT INTO lfs_objects (staging_id, org_id, resource_id, r2_key, size, sha256, binary, etag, state, source, user_id, created_at, updated_at, last_used_at) VALUES (?, ?, 'r1', ?, 1, ?, 1, 'e', ?, 'browser', 'u1', ?, ?, ?)").bind(id, orgId, `k/${id}`, OID, state, now, now, now);
    await env.DB.batch(ids.slice(0, 100).map((id) => insert(id, org, "verified")));
    await env.DB.batch(ids.slice(100).map((id, i) => insert(id, org, i === 0 ? "uploaded" : "verified")));
    const foreign = `lfs-p-${org}-foreign`;
    await insert(foreign, `${org}-other`, "verified").run();
    // count the statements and batches the promotion sends
    const sizes: number[] = [];
    const prepared: string[] = [];
    const db = new Proxy(svc.db, {
      get(t, p) {
        if (p === "batch") return (s: unknown[]) => (sizes.push(s.length), t.batch(s as never));
        if (p === "prepare") return (q: string) => (prepared.push(q), t.prepare(q));
        const v = Reflect.get(t, p);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const n = await promoteObjects({ ...svc, db } as never, org, [...ids, ...ids.slice(0, 10), foreign]);
    expect(n).toBe(199); // the uploaded one and the other org's are not promoted
    expect(sizes).toEqual([3]); // ceil(201 distinct ids / 90) statements, one batch
    expect(prepared).toHaveLength(3);
    expect((await env.DB.prepare("SELECT accepted_at FROM lfs_objects WHERE staging_id = ?").bind(foreign).first<{ accepted_at: string | null }>())!.accepted_at).toBeNull();
    expect(await promoteObjects(svc, org, [])).toBe(0);
  });
});
