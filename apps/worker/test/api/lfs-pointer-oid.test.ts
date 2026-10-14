/**
 * LFS pointer ids (plan phase 3, P3-2): the hash step records the git blob id of each verified
 * object's pointer text, so tree entries (which carry blob ids) are recognised as LFS files without
 * reading them. Also the GC backfill of rows verified before the column existed, the
 * `pointerObjects` lookup and `dropObjects`.
 */
import { lfsPointer } from "@commonforge-org/runner-protocol";
import { sha256Hex } from "@commonforge-org/core";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createServices } from "../../src/context.js";
import { gitBlobSha1 } from "../../src/lib/crypto.js";
import { MAX_POINTER_BACKFILL_PER_PASS, runGc } from "../../src/services/gc.js";
import { enqueueHash } from "../../src/services/lfs-hash.js";
import { createLfsObject, dropObjects, getLfsObject, markChanged, markUploaded, markVerified, pointerObjects, promoteObjects } from "../../src/services/lfs-store.js";
import { harness, uniq } from "../helpers.js";
import { uploadFile, world } from "../lfs/lfs-helpers.js";

const pointerOid = (sha: string, size: number) => gitBlobSha1(new TextEncoder().encode(lfsPointer(sha, size)));
const bytes = (s: string) => new TextEncoder().encode(s);
const svcOf = () => createServices(env, harness().deps);

/** a verified object in `org`/r1 with this pointer oid, created at `createdAt` */
async function verifiedRow(svc: ReturnType<typeof svcOf>, org: string, sha: string, pointer: string, createdAt: string) {
  const row = await createLfsObject(svc, { orgId: org, resourceId: "r1", size: 3, source: "browser", userId: "u1", state: "uploading" });
  await markUploaded(svc, row.staging_id);
  await markVerified(svc, row.staging_id, sha, false, "etag-1", pointer);
  await env.DB.prepare("UPDATE lfs_objects SET created_at = ? WHERE staging_id = ?").bind(createdAt, row.staging_id).run();
  return row.staging_id;
}

describe("lfs.hash records the pointer oid", () => {
  it("pointer_oid is the git blob id of the object's LFS pointer text", async () => {
    const h = harness();
    const svc = createServices(env, h.deps);
    const org = uniq("o");
    const content = bytes("a video, honestly");
    const row = await createLfsObject(svc, { orgId: org, resourceId: "r1", size: content.length, source: "browser", userId: "u1", state: "uploading" });
    await env.COMMONFORGE_ASSETS.put(row.r2_key, content);
    await markUploaded(svc, row.staging_id);
    await enqueueHash(svc, org, row.staging_id);
    await h.drainSteps();
    const sha = await sha256Hex(content);
    expect(await getLfsObject(svc, org, row.staging_id)).toMatchObject({ state: "verified", sha256: sha, pointer_oid: await pointerOid(sha, content.length) });
  });

  it("a rejected upload gets no pointer oid", async () => {
    const h = harness();
    const svc = createServices(env, h.deps);
    const org = uniq("o");
    const row = await createLfsObject(svc, { orgId: org, resourceId: "r1", size: 3, source: "lfs", userId: "u1", claimedOid: "a".repeat(64), state: "uploading" });
    await env.COMMONFORGE_ASSETS.put(row.r2_key, bytes("abc"));
    await markUploaded(svc, row.staging_id);
    await enqueueHash(svc, org, row.staging_id);
    await h.drainSteps();
    expect(await getLfsObject(svc, org, row.staging_id)).toMatchObject({ state: "rejected", pointer_oid: null });
  });
});

describe("pointerObjects", () => {
  it("accepted only unless staged; prefers the accepted row, then the newest; skips rejected and uploading rows", async () => {
    const svc = svcOf();
    const org = uniq("o");
    const [p1, p2, p3, p4, p5] = ["1", "2", "3", "4", "5"].map((c) => c.repeat(40));
    // p1: an accepted row and a newer staged one
    const accepted = await verifiedRow(svc, org, "a".repeat(64), p1!, "2026-01-01T00:00:00.000Z");
    await verifiedRow(svc, org, "a".repeat(64), p1!, "2026-02-01T00:00:00.000Z");
    await promoteObjects(svc, org, [accepted]);
    // p2: two staged rows
    await verifiedRow(svc, org, "b".repeat(64), p2!, "2026-01-01T00:00:00.000Z");
    const newer = await verifiedRow(svc, org, "b".repeat(64), p2!, "2026-03-01T00:00:00.000Z");
    // p3: verified, then its bytes changed (rejected)
    const changed = await verifiedRow(svc, org, "c".repeat(64), p3!, "2026-01-01T00:00:00.000Z");
    await markChanged(svc, changed, "etag-1");
    // p4: still uploading (a pointer oid set by hand: the state alone must exclude it)
    const uploading = await createLfsObject(svc, { orgId: org, resourceId: "r1", size: 3, source: "browser", userId: "u1", state: "uploading" });
    await env.DB.prepare("UPDATE lfs_objects SET pointer_oid = ? WHERE staging_id = ?").bind(p4, uploading.staging_id).run();
    // p5: another folder's object
    const other = await createLfsObject(svc, { orgId: org, resourceId: "r2", size: 3, source: "browser", userId: "u1", state: "uploading" });
    await markUploaded(svc, other.staging_id);
    await markVerified(svc, other.staging_id, "e".repeat(64), false, "etag-1", p5!);
    await promoteObjects(svc, org, [other.staging_id]);

    // more oids than one statement binds (90 per chunk)
    const filler = Array.from({ length: 200 }, (_, i) => i.toString(16).padStart(40, "f"));
    const oids = [...filler, p1!, p2!, p3!, p4!, p5!];

    const acc = await pointerObjects(svc, { orgId: org, resourceId: "r1", oids, staged: false });
    expect([...acc.keys()]).toEqual([p1]);
    expect(acc.get(p1!)?.staging_id).toBe(accepted);

    const all = await pointerObjects(svc, { orgId: org, resourceId: "r1", oids, staged: true });
    expect([...all.keys()].sort()).toEqual([p1, p2].sort());
    expect(all.get(p1!)?.staging_id).toBe(accepted);
    expect(all.get(p2!)?.staging_id).toBe(newer);

    expect((await pointerObjects(svc, { orgId: org, resourceId: "r1", oids: [], staged: true })).size).toBe(0);
  });
});

describe("GC backfills pointer oids", () => {
  it("fills verified rows without one, at most 500 per pass; leaves other rows alone", async () => {
    const { h, o, pid, site } = await world();
    const svc = createServices(env, h.deps);
    const content = bytes("verified before migration 0013");
    const id = await uploadFile(h, o, pid, "big.bin", content);
    const sha = await sha256Hex(content);
    await env.DB.prepare("UPDATE lfs_objects SET pointer_oid = NULL WHERE staging_id = ?").bind(id).run();
    // a verified row with an oid already is not rewritten; uploaded and rejected rows get none
    const kept = await verifiedRow(svc, o.orgId, "d".repeat(64), "k".repeat(40), "2026-01-01T00:00:00.000Z");
    const pending = await createLfsObject(svc, { orgId: o.orgId, resourceId: site.resourceId, size: 3, source: "browser", userId: o.userId, state: "uploading" });
    await markUploaded(svc, pending.staging_id);
    const rejected = await verifiedRow(svc, o.orgId, "e".repeat(64), "r".repeat(40), "2026-01-01T00:00:00.000Z");
    await markChanged(svc, rejected, "etag-1");
    await env.DB.prepare("UPDATE lfs_objects SET pointer_oid = NULL WHERE staging_id = ?").bind(rejected).run();
    // many more rows than one pass fills
    const now = new Date().toISOString();
    const stmts = Array.from({ length: MAX_POINTER_BACKFILL_PER_PASS }, (_, i) =>
      env.DB.prepare(
        "INSERT INTO lfs_objects (staging_id, org_id, resource_id, r2_key, size, sha256, binary, etag, state, source, user_id, created_at, updated_at, last_used_at) VALUES (?, ?, 'r9', ?, 1, ?, 0, 'e', 'verified', 'browser', 'u1', ?, ?, ?)",
      ).bind(`lfs-bf-${o.orgId}-${i}`, o.orgId, `org/${o.orgId}/lfs/r9/obj/bf-${i}`, i.toString(16).padStart(64, "0"), now, now, now),
    );
    await env.DB.batch(stmts);

    const first = await runGc(svc, { orgs: [o.orgId] });
    expect(first.errors).toEqual([]);
    expect(first.lfsPointerBackfill).toBe(MAX_POINTER_BACKFILL_PER_PASS);
    const second = await runGc(svc, { orgs: [o.orgId] });
    expect(second.lfsPointerBackfill).toBe(1);
    const third = await runGc(svc, { orgs: [o.orgId] });
    expect(third.lfsPointerBackfill).toBe(0);

    expect((await getLfsObject(svc, o.orgId, id))?.pointer_oid).toBe(await pointerOid(sha, content.length));
    const sample = await getLfsObject(svc, o.orgId, `lfs-bf-${o.orgId}-7`);
    expect(sample?.pointer_oid).toBe(await pointerOid((7).toString(16).padStart(64, "0"), 1));
    expect((await getLfsObject(svc, o.orgId, kept))?.pointer_oid).toBe("k".repeat(40));
    expect((await getLfsObject(svc, o.orgId, pending.staging_id))?.pointer_oid).toBeNull();
    expect((await getLfsObject(svc, o.orgId, rejected))?.pointer_oid).toBeNull();
  });
});

describe("dropObjects", () => {
  it("deletes unaccepted rows and their keys; accepted rows and keys stay", async () => {
    const svc = svcOf();
    const org = uniq("o");
    const a = await verifiedRow(svc, org, "a".repeat(64), "1".repeat(40), "2026-01-01T00:00:00.000Z");
    const b = await verifiedRow(svc, org, "b".repeat(64), "2".repeat(40), "2026-01-01T00:00:00.000Z");
    const keep = await verifiedRow(svc, org, "c".repeat(64), "3".repeat(40), "2026-01-01T00:00:00.000Z");
    await promoteObjects(svc, org, [keep]);
    const otherOrg = uniq("o");
    const foreign = await verifiedRow(svc, otherOrg, "d".repeat(64), "4".repeat(40), "2026-01-01T00:00:00.000Z");
    const keys = new Map<string, string>();
    for (const [o, id] of [[org, a], [org, b], [org, keep], [otherOrg, foreign]] as const) {
      const r = (await getLfsObject(svc, o, id))!;
      await env.COMMONFORGE_ASSETS.put(r.r2_key, bytes("abc"));
      keys.set(id, r.r2_key);
    }

    expect(await dropObjects(svc, org, [a, b, keep, foreign, "lfs-missing"])).toBe(2);
    expect(await getLfsObject(svc, org, a)).toBeNull();
    expect(await getLfsObject(svc, org, b)).toBeNull();
    expect(await env.COMMONFORGE_ASSETS.head(keys.get(a)!)).toBeNull();
    expect(await env.COMMONFORGE_ASSETS.head(keys.get(b)!)).toBeNull();
    expect(await getLfsObject(svc, org, keep)).not.toBeNull();
    expect(await env.COMMONFORGE_ASSETS.head(keys.get(keep)!)).not.toBeNull();
    // another org's id is not this org's to drop
    expect(await getLfsObject(svc, otherOrg, foreign)).not.toBeNull();
    expect(await env.COMMONFORGE_ASSETS.head(keys.get(foreign)!)).not.toBeNull();

    expect(await dropObjects(svc, org, [])).toBe(0);
  });
});
