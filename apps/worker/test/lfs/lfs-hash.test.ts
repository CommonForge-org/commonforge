import { sha256Hex } from "@commonforge-org/core";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createServices } from "../../src/context.js";
import { enqueueHash, wakeFileChanges } from "../../src/services/lfs-hash.js";
import { createLfsObject, getLfsObject, markUploaded } from "../../src/services/lfs-store.js";
import { MAX_STEP_ATTEMPTS } from "../../src/services/steps.js";
import { harness, uniq } from "../helpers.js";

const EMPTY_SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** every message pushed onto the step queue from now on (drainSteps empties h.steps as it delivers) */
function recordSteps(h: ReturnType<typeof harness>): unknown[] {
  const sent: unknown[] = [];
  const push = h.steps.push.bind(h.steps);
  h.steps.push = (...items: unknown[]) => {
    sent.push(...items);
    return push(...items);
  };
  return sent;
}

/** change ids are global primary keys, so each seeded change gets a unique one; returns it */
async function seedChange(org: string, label: string, resourceId: string, jobId: string | null = null, state = "applying"): Promise<string> {
  const id = `${label}-${org}`;
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO file_changes (change_id, org_id, project_id, resource_id, mount_name, user_id, title, ops_json, has_edits, state, job_id, created_at, updated_at) VALUES (?, ?, 'p1', ?, 'site', 'u1', 't', '[]', 0, ?, ?, ?, ?)",
  ).bind(id, org, resourceId, state, jobId, now, now).run();
  return id;
}

async function uploaded(h: ReturnType<typeof harness>, bytes: Uint8Array, claimedOid: string | null) {
  const svc = createServices(env, h.deps);
  const org = uniq("o");
  const row = await createLfsObject(svc, { orgId: org, resourceId: "r1", size: bytes.length, source: claimedOid ? "lfs" : "browser", userId: "u1", claimedOid, state: "uploading" });
  await env.COMMONFORGE_ASSETS.put(row.r2_key, bytes);
  await markUploaded(svc, row.staging_id);
  await enqueueHash(svc, org, row.staging_id);
  await h.drainSteps();
  return { svc, org, row };
}

describe("lfs.hash", () => {
  it("verifies a browser upload: records sha256 and the binary flag", async () => {
    const h = harness();
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]);
    const { svc, org, row } = await uploaded(h, bytes, null);
    expect(await getLfsObject(svc, org, row.staging_id)).toMatchObject({ state: "verified", sha256: await sha256Hex(bytes), binary: 1 });
  });

  it("text is not binary", async () => {
    const h = harness();
    const { svc, org, row } = await uploaded(h, new TextEncoder().encode("hello\n"), null);
    expect((await getLfsObject(svc, org, row.staging_id))?.binary).toBe(0);
  });

  it("a git-lfs upload whose bytes do not hash to the claimed oid is rejected and deleted", async () => {
    const h = harness();
    const { svc, org, row } = await uploaded(h, new TextEncoder().encode("not what was claimed"), "e".repeat(64));
    expect(await getLfsObject(svc, org, row.staging_id)).toMatchObject({ state: "rejected", error: "hash_mismatch" });
    expect(await env.COMMONFORGE_ASSETS.head(row.r2_key)).toBeNull();
  });

  it("a size that differs from the declared size is rejected", async () => {
    const h = harness();
    const svc = createServices(env, h.deps);
    const org = uniq("o");
    const row = await createLfsObject(svc, { orgId: org, resourceId: "r1", size: 99, source: "browser", userId: "u1", state: "uploading" });
    await env.COMMONFORGE_ASSETS.put(row.r2_key, new Uint8Array(5));
    await markUploaded(svc, row.staging_id);
    await enqueueHash(svc, org, row.staging_id);
    await h.drainSteps();
    expect(await getLfsObject(svc, org, row.staging_id)).toMatchObject({ state: "rejected", error: "size_mismatch" });
  });

  it("is idempotent: a second delivery changes nothing", async () => {
    const h = harness();
    const { svc, org, row } = await uploaded(h, new TextEncoder().encode("x"), null);
    const before = await getLfsObject(svc, org, row.staging_id);
    await enqueueHash(svc, org, row.staging_id);
    await h.drainSteps();
    expect(await getLfsObject(svc, org, row.staging_id)).toEqual(before);
  });

  it("wakes file changes of the folder that wait for their uploads", async () => {
    const h = harness();
    const svc = createServices(env, h.deps);
    const org = uniq("o");
    const fc = await seedChange(org, "fc-1", "r1");
    const row = await createLfsObject(svc, { orgId: org, resourceId: "r1", size: 1, source: "browser", userId: "u1", state: "uploading" });
    await env.COMMONFORGE_ASSETS.put(row.r2_key, new Uint8Array([65]));
    await markUploaded(svc, row.staging_id);
    // drainSteps delivers (and acks) the files.apply message in its own next round, so h.steps is empty
    // afterwards; record every message pushed onto the step queue instead
    const sent = recordSteps(h);
    await enqueueHash(svc, org, row.staging_id);
    await h.drainSteps();
    expect(sent).toContainEqual({ type: "files.apply", orgId: org, changeId: fc });
  });

  it("a zero-byte upload is verified with the empty sha and is not binary", async () => {
    const h = harness();
    const { svc, org, row } = await uploaded(h, new Uint8Array(0), null);
    expect(await getLfsObject(svc, org, row.staging_id)).toMatchObject({ state: "verified", sha256: EMPTY_SHA, binary: 0 });
  });

  it("a zero-byte git-lfs upload must still match its claimed oid", async () => {
    const h = harness();
    const ok = await uploaded(h, new Uint8Array(0), EMPTY_SHA);
    expect((await getLfsObject(ok.svc, ok.org, ok.row.staging_id))?.state).toBe("verified");
    const bad = await uploaded(h, new Uint8Array(0), "f".repeat(64));
    expect(await getLfsObject(bad.svc, bad.org, bad.row.staging_id)).toMatchObject({ state: "rejected", error: "hash_mismatch" });
  });

  it("a zero-byte object that is missing or not empty is rejected as size_mismatch", async () => {
    const h = harness();
    const svc = createServices(env, h.deps);
    const org = uniq("o");
    const missing = await createLfsObject(svc, { orgId: org, resourceId: "r1", size: 0, source: "browser", userId: "u1", state: "uploading" });
    await markUploaded(svc, missing.staging_id);
    const full = await createLfsObject(svc, { orgId: org, resourceId: "r1", size: 0, source: "browser", userId: "u1", state: "uploading" });
    await env.COMMONFORGE_ASSETS.put(full.r2_key, new Uint8Array(3));
    await markUploaded(svc, full.staging_id);
    await enqueueHash(svc, org, missing.staging_id);
    await enqueueHash(svc, org, full.staging_id);
    await h.drainSteps();
    expect(await getLfsObject(svc, org, missing.staging_id)).toMatchObject({ state: "rejected", error: "size_mismatch" });
    expect(await getLfsObject(svc, org, full.staging_id)).toMatchObject({ state: "rejected", error: "size_mismatch" });
    expect(await env.COMMONFORGE_ASSETS.head(full.r2_key)).toBeNull();
  });

  it("an object that vanished before the step is rejected as missing", async () => {
    const h = harness();
    const svc = createServices(env, h.deps);
    const org = uniq("o");
    const row = await createLfsObject(svc, { orgId: org, resourceId: "r1", size: 4, source: "browser", userId: "u1", state: "uploading" });
    await markUploaded(svc, row.staging_id);
    await enqueueHash(svc, org, row.staging_id);
    await h.drainSteps();
    expect(await getLfsObject(svc, org, row.staging_id)).toMatchObject({ state: "rejected", error: "missing" });
  });

  it("an R2 error is retried, not acked", async () => {
    const h = harness();
    const svc = createServices(env, h.deps);
    const org = uniq("o");
    const row = await createLfsObject(svc, { orgId: org, resourceId: "r1", size: 1, source: "browser", userId: "u1", state: "uploading" });
    await env.COMMONFORGE_ASSETS.put(row.r2_key, new Uint8Array([1]));
    await markUploaded(svc, row.staging_id);
    const flaky = { ...env, COMMONFORGE_ASSETS: { get: async () => { throw new Error("r2 down"); }, head: async () => { throw new Error("r2 down"); }, delete: async () => {} } } as unknown as Cloudflare.Env;
    h.envOverrides = flaky as unknown as Record<string, string>;
    const r = await h.deliver("commonforge-steps", [{ type: "lfs.hash", orgId: org, stagingId: row.staging_id }]);
    expect(r.acked).toEqual([]);
    expect(r.retried).toHaveLength(1);
    expect((await getLfsObject(svc, org, row.staging_id))?.state).toBe("uploaded");
  });

  it("after the last attempt the upload is rejected as hash_failed and waiting changes are woken", async () => {
    const h = harness();
    const svc = createServices(env, h.deps);
    const org = uniq("o");
    const fc = await seedChange(org, "fc-1", "r1");
    const row = await createLfsObject(svc, { orgId: org, resourceId: "r1", size: 1, source: "browser", userId: "u1", state: "uploading" });
    await markUploaded(svc, row.staging_id);
    const flaky = { ...env, COMMONFORGE_ASSETS: { get: async () => { throw new Error("r2 down"); }, head: async () => { throw new Error("r2 down"); }, delete: async () => {} } } as unknown as Cloudflare.Env;
    h.envOverrides = flaky as unknown as Record<string, string>;
    const sent = recordSteps(h);
    const r = await h.deliver("commonforge-steps", [{ type: "lfs.hash", orgId: org, stagingId: row.staging_id }], MAX_STEP_ATTEMPTS);
    expect(r.retried).toEqual([]);
    expect(await getLfsObject(svc, org, row.staging_id)).toMatchObject({ state: "rejected", error: "hash_failed: r2 down" });
    expect(sent).toContainEqual({ type: "files.apply", orgId: org, changeId: fc });
  });

  it("a redelivery for an already verified row re-sends the wake", async () => {
    const h = harness();
    const { svc, org, row } = await uploaded(h, new TextEncoder().encode("x"), null);
    const late = await seedChange(org, "fc-late", "r1");
    const sent = recordSteps(h);
    await enqueueHash(svc, org, row.staging_id);
    await h.drainSteps();
    expect(sent).toContainEqual({ type: "files.apply", orgId: org, changeId: late });
  });

  it("a rejection wakes waiting changes too", async () => {
    const h = harness();
    const svc = createServices(env, h.deps);
    const org = uniq("o");
    const fc = await seedChange(org, "fc-1", "r1");
    const row = await createLfsObject(svc, { orgId: org, resourceId: "r1", size: 3, source: "lfs", userId: "u1", claimedOid: "a".repeat(64), state: "uploading" });
    await env.COMMONFORGE_ASSETS.put(row.r2_key, new Uint8Array([1, 2, 3]));
    await markUploaded(svc, row.staging_id);
    const sent = recordSteps(h);
    await enqueueHash(svc, org, row.staging_id);
    await h.drainSteps();
    expect((await getLfsObject(svc, org, row.staging_id))?.state).toBe("rejected");
    expect(sent).toContainEqual({ type: "files.apply", orgId: org, changeId: fc });
  });

  it("does not wake changes of another folder, of another org, or that already have a job", async () => {
    const h = harness();
    const svc = createServices(env, h.deps);
    const org = uniq("o");
    await seedChange(org, "fc-other-folder", "r2");
    await seedChange(org, "fc-has-job", "r1", "job-1");
    await seedChange(org, "fc-added", "r1", null, "added");
    await seedChange(uniq("o"), "fc-other-org", "r1"); // different org, same folder id
    const yes = await seedChange(org, "fc-yes", "r1");
    await wakeFileChanges(svc, org, "r1");
    const woken = h.steps.map((s) => (s as { changeId: string }).changeId);
    expect(woken).toEqual([yes]);
  });
});
