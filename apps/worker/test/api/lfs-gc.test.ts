/**
 * GC of uploads and LFS objects (spec 2026-10-07 §12): unfinished uploads expire after 24 h,
 * unaccepted objects 7 days after last use unless an open change or live task needs them; accepted
 * objects stay. Also: R2 artifacts of finished file changes, orphaned change prefixes, and the
 * sweep of stuck open file changes.
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createServices } from "../../src/context.js";
import { abortUnfinishedUpload, expireUnacceptedObject, runGc, type GcReport } from "../../src/services/gc.js";
import { changePrefix, editsKey, opsManifestKey } from "../../src/services/file-changes.js";
import { harness, provisionedTask, type Harness } from "../helpers.js";
import { uploadFile, world } from "../lfs/lfs-helpers.js";

const OLD = "2020-01-01T00:00:00.000Z";
const gc = (h: Harness, orgId: string) => runGc(createServices(env, h.deps), { orgs: [orgId] });
const row = (id: string) => env.DB.prepare("SELECT * FROM lfs_objects WHERE staging_id = ?").bind(id).first<{ state: string; accepted_at: string | null; r2_key: string }>();
const exists = async (key: string) => (await env.COMMONFORGE_ASSETS.head(key)) !== null;
const ageObject = (id: string) => env.DB.prepare("UPDATE lfs_objects SET created_at = ?, last_used_at = ? WHERE staging_id = ?").bind(OLD, OLD, id).run();
const emptyReport = (): GcReport => ({ startedAt: "", orgs: 0, expiredJobs: 0, canceledTasks: [], abandonedWorkspaces: [], collectedWorkspaces: [], sweptGhosts: [], revokedTokens: 0, reconcileRequests: 0, deletedAssets: [], lfsUploadsAborted: [], lfsObjectsExpired: [], lfsHashesRetried: [], lfsHashesGivenUp: [], fileChangeArtifactsDeleted: [], fileChangesSettled: 0, lfsPointerBackfill: 0, folderInitRequeued: 0, errors: [] });
const full = (id: string) => env.DB.prepare("SELECT staging_id, r2_key, state, source, upload_id FROM lfs_objects WHERE staging_id = ?").bind(id).first<any>();
const bytes = (s: string) => new TextEncoder().encode(s);

async function startUpload(h: Harness, o: { token: string; orgId: string }, pid: string, path: string) {
  const s = await h.api("POST", `/api/orgs/${o.orgId}/projects/${pid}/folders/site/uploads`, { token: o.token, body: { path, size: 10, mime: "application/octet-stream" } });
  expect(s.status, JSON.stringify(s.body)).toBe(201);
  return s.body.uploadId as string;
}

/** a verified object, stored bytes and all */
async function verified(h: Harness, o: { token: string; orgId: string }, pid: string, path: string) {
  const id = await uploadFile(h, o, pid, path, bytes(`content of ${path}`));
  expect((await row(id))?.state).toBe("verified");
  return id;
}

async function insertChange(orgId: string, rid: string, changeId: string, state: string, updatedAt: string, extra: { jobId?: string | null } = {}) {
  await env.DB.prepare(
    "INSERT INTO file_changes (change_id, org_id, project_id, resource_id, mount_name, user_id, title, ops_json, has_edits, state, attempt, job_id, created_at, updated_at) VALUES (?, ?, 'prj', ?, 'site', 'usr', 't', '[]', 0, ?, 1, ?, ?, ?)",
  )
    .bind(changeId, orgId, rid, state, extra.jobId ?? null, updatedAt, updatedAt)
    .run();
}

describe("GC: unfinished uploads", () => {
  it("an old unfinished browser upload is aborted and its row deleted; a fresh one is kept; second run is a no-op", async () => {
    const { h, o, pid } = await world();
    const oldId = await startUpload(h, o, pid, "old.bin");
    const freshId = await startUpload(h, o, pid, "fresh.bin");
    const oldRow = (await row(oldId))!;
    const uploadId = (await env.DB.prepare("SELECT upload_id FROM lfs_objects WHERE staging_id = ?").bind(oldId).first<{ upload_id: string }>())!.upload_id;
    await ageObject(oldId);

    const r = await gc(h, o.orgId);
    expect(r.errors).toEqual([]);
    expect(r.lfsUploadsAborted).toEqual([oldId]);
    expect(await row(oldId)).toBeNull();
    expect(await row(freshId)).not.toBeNull();
    // the multipart upload is gone at R2
    await expect(env.COMMONFORGE_ASSETS.resumeMultipartUpload(oldRow.r2_key, uploadId).uploadPart(1, bytes("x"))).rejects.toThrow();

    const again = await gc(h, o.orgId);
    expect(again.lfsUploadsAborted).toEqual([]);
    expect(await row(freshId)).not.toBeNull();
  });

  it("an old git-lfs upload loses its key (if any) and row; a failing abort does not stop the row going", async () => {
    const { h, o, site } = await world();
    const now = new Date().toISOString();
    const mk = async (id: string, uploadId: string | null, source: "lfs" | "browser") => {
      const key = `org/${o.orgId}/lfs/${site.resourceId}/obj/${id}`;
      await env.DB.prepare(
        "INSERT INTO lfs_objects (staging_id, org_id, resource_id, r2_key, size, state, source, user_id, upload_id, created_at, updated_at, last_used_at) VALUES (?, ?, ?, ?, 3, 'uploading', ?, ?, ?, ?, ?, ?)",
      )
        .bind(id, o.orgId, site.resourceId, key, source, o.userId, uploadId, OLD, OLD, now)
        .run();
      return key;
    };
    const withKey = await mk("lfs_withkey", null, "lfs");
    await env.COMMONFORGE_ASSETS.put(withKey, bytes("abc"));
    await mk("lfs_nokey", null, "lfs");
    await mk("br_bogus", "no-such-upload", "browser");
    // an empty browser upload has no multipart upload; its key (written by a complete that lost the race) goes too
    const emptyKey = await mk("br_empty", null, "browser");
    await env.COMMONFORGE_ASSETS.put(emptyKey, new Uint8Array(0));
    const r = await gc(h, o.orgId);
    expect(r.errors).toEqual([]);
    expect([...r.lfsUploadsAborted].sort()).toEqual(["br_bogus", "br_empty", "lfs_nokey", "lfs_withkey"]);
    expect(await exists(withKey)).toBe(false);
    expect(await exists(emptyKey)).toBe(false);
    for (const id of ["lfs_withkey", "lfs_nokey", "br_bogus", "br_empty"]) expect(await row(id)).toBeNull();
  });
});

describe("GC: unaccepted objects", () => {
  it("an old unaccepted verified object loses key and row; an old accepted one stays; second run changes nothing", async () => {
    const { h, o, pid } = await world();
    const gone = await verified(h, o, pid, "gone.bin");
    const kept = await verified(h, o, pid, "kept.bin");
    const fresh = await verified(h, o, pid, "fresh.bin");
    await env.DB.prepare("UPDATE lfs_objects SET accepted_at = ? WHERE staging_id = ?").bind(OLD, kept).run();
    await ageObject(gone);
    await ageObject(kept);
    const goneKey = (await row(gone))!.r2_key;
    const keptKey = (await row(kept))!.r2_key;
    expect(await exists(goneKey)).toBe(true);

    const r = await gc(h, o.orgId);
    expect(r.errors).toEqual([]);
    expect(r.lfsObjectsExpired).toEqual([gone]);
    expect(await row(gone)).toBeNull();
    expect(await exists(goneKey)).toBe(false);
    expect(await row(kept)).not.toBeNull();
    expect(await exists(keptKey)).toBe(true);
    expect(await row(fresh)).not.toBeNull();

    const again = await gc(h, o.orgId);
    expect(again.lfsObjectsExpired).toEqual([]);
    expect(again.lfsUploadsAborted).toEqual([]);
    expect(await row(kept)).not.toBeNull();
  });

  it("rejected and uploaded objects expire too, and a rejected object's key is deleted", async () => {
    const { h, o, pid } = await world();
    const rej = await verified(h, o, pid, "rej.bin");
    const upl = await verified(h, o, pid, "upl.bin");
    await env.DB.prepare("UPDATE lfs_objects SET state = 'rejected' WHERE staging_id = ?").bind(rej).run();
    await env.DB.prepare("UPDATE lfs_objects SET state = 'uploaded' WHERE staging_id = ?").bind(upl).run();
    await ageObject(rej);
    await ageObject(upl);
    const keys = [(await row(rej))!.r2_key, (await row(upl))!.r2_key];
    const r = await gc(h, o.orgId);
    expect([...r.lfsObjectsExpired].sort()).toEqual([rej, upl].sort());
    for (const k of keys) expect(await exists(k)).toBe(false);
  });

  it("an object an open change references is kept; once the change is failed it is deleted", async () => {
    const { h, o, pid, site } = await world();
    const id = await verified(h, o, pid, "ref.bin");
    await ageObject(id);
    await insertChange(o.orgId, site.resourceId, "chg_wait", "waiting_approval", new Date().toISOString());
    await env.DB.prepare("INSERT INTO file_change_objects (change_id, staging_id) VALUES ('chg_wait', ?)").bind(id).run();
    let r = await gc(h, o.orgId);
    expect(r.lfsObjectsExpired).toEqual([]);
    expect(await row(id)).not.toBeNull();
    for (const state of ["applying", "checking"]) {
      await env.DB.prepare("UPDATE file_changes SET state = ? WHERE change_id = 'chg_wait'").bind(state).run();
      expect((await gc(h, o.orgId)).lfsObjectsExpired).toEqual([]);
    }
    await env.DB.prepare("UPDATE file_changes SET state = 'failed' WHERE change_id = 'chg_wait'").run();
    r = await gc(h, o.orgId);
    expect(r.lfsObjectsExpired).toEqual([id]);
    expect(await row(id)).toBeNull();
  });

  it("an object of a live task is kept; of a finished task it expires", async () => {
    const h = harness();
    const t = await provisionedTask(h);
    const mk = async (id: string) => {
      const key = `org/${t.o.orgId}/lfs/${t.web.resourceId}/obj/${id}`;
      await env.COMMONFORGE_ASSETS.put(key, bytes("agent bytes"));
      await env.DB.prepare(
        "INSERT INTO lfs_objects (staging_id, org_id, resource_id, r2_key, size, state, source, user_id, task_id, created_at, updated_at, last_used_at) VALUES (?, ?, ?, ?, 11, 'verified', 'lfs', ?, ?, ?, ?, ?)",
      )
        .bind(id, t.o.orgId, t.web.resourceId, key, t.o.userId, t.taskId, OLD, OLD, OLD)
        .run();
      return key;
    };
    const key = await mk("lfs_task_obj");
    for (const state of ["provisioning", "ready", "running", "submitted"]) {
      await env.DB.prepare("UPDATE tasks SET state = ? WHERE task_id = ?").bind(state, t.taskId).run();
      const r = await gc(h, t.o.orgId);
      expect(r.lfsObjectsExpired, state).toEqual([]);
      expect(await exists(key), state).toBe(true);
    }
    await env.DB.prepare("UPDATE tasks SET state = 'canceled' WHERE task_id = ?").bind(t.taskId).run();
    const r = await gc(h, t.o.orgId);
    expect(r.lfsObjectsExpired).toEqual(["lfs_task_obj"]);
    expect(await exists(key)).toBe(false);
  });

  it("handles at most 100 rows per kind per pass", async () => {
    const { h, o, site } = await world();
    const stmts = [];
    for (let i = 0; i < 103; i++) {
      stmts.push(
        env.DB.prepare(
          "INSERT INTO lfs_objects (staging_id, org_id, resource_id, r2_key, size, state, source, user_id, created_at, updated_at, last_used_at) VALUES (?, ?, ?, ?, 1, 'rejected', 'lfs', ?, ?, ?, ?)",
        ).bind(`bulk_${i}`, o.orgId, site.resourceId, `org/${o.orgId}/lfs/${site.resourceId}/obj/bulk_${i}`, o.userId, OLD, OLD, OLD),
      );
    }
    for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
    const first = await gc(h, o.orgId);
    expect(first.errors).toEqual([]);
    expect(first.lfsObjectsExpired.length).toBe(100);
    const second = await gc(h, o.orgId);
    expect(second.lfsObjectsExpired.length).toBe(3);
  });
});

describe("GC: row first, bytes second (a leaked key is safe, a row without bytes is not)", () => {
  const cutoff = () => new Date(Date.now() - 7 * 86400_000).toISOString();

  it("an object picked by the select but referenced, touched or accepted before the delete keeps row and key", async () => {
    const { h, o, pid, site } = await world();
    const svc = createServices(env, h.deps);
    const cases: Record<string, () => Promise<unknown>> = {
      referenced: async () => {
        await insertChange(o.orgId, site.resourceId, "chg_late", "applying", new Date().toISOString());
        await env.DB.prepare("INSERT INTO file_change_objects (change_id, staging_id) SELECT 'chg_late', staging_id FROM lfs_objects WHERE path = 'referenced.bin'").run();
      },
      touched: () => env.DB.prepare("UPDATE lfs_objects SET last_used_at = ? WHERE path = 'touched.bin'").bind(new Date().toISOString()).run(),
      accepted: () => env.DB.prepare("UPDATE lfs_objects SET accepted_at = ? WHERE path = 'accepted.bin'").bind(new Date().toISOString()).run(),
    };
    for (const [name, mutate] of Object.entries(cases)) {
      const id = await verified(h, o, pid, `${name}.bin`);
      await ageObject(id);
      const picked = await full(id); // what the select saw
      await mutate(); // what happened before the delete
      const report = emptyReport();
      expect(await expireUnacceptedObject(svc, o.orgId, picked, cutoff(), report), name).toBe(false);
      expect(report.lfsObjectsExpired, name).toEqual([]);
      expect(await row(id), name).not.toBeNull();
      expect(await exists(picked.r2_key), name).toBe(true);
    }
  });

  it("an upload that completed after the select keeps row and key", async () => {
    const { h, o, pid } = await world();
    const svc = createServices(env, h.deps);
    const id = await verified(h, o, pid, "done.bin");
    await env.DB.prepare("UPDATE lfs_objects SET state = 'uploading', source = 'lfs', created_at = ? WHERE staging_id = ?").bind(OLD, id).run();
    const picked = await full(id);
    await env.DB.prepare("UPDATE lfs_objects SET state = 'uploaded' WHERE staging_id = ?").bind(id).run();
    const report = emptyReport();
    expect(await abortUnfinishedUpload(svc, o.orgId, picked, cutoff(), report)).toBe(false);
    expect(await row(id)).not.toBeNull();
    expect(await exists(picked.r2_key)).toBe(true);
  });

  it("a key that cannot be deleted leaks (reported) after its row is gone, and does not hold up the rest of the batch", async () => {
    const { h, o, pid } = await world();
    const bad = await verified(h, o, pid, "bad.bin");
    const good = await verified(h, o, pid, "good.bin");
    await ageObject(bad);
    await ageObject(good);
    const badKey = (await row(bad))!.r2_key;
    const goodKey = (await row(good))!.r2_key;
    const real = env.COMMONFORGE_ASSETS;
    const flaky = new Proxy(real, {
      get: (t, prop) => (prop === "delete" ? async (k: string | string[]) => (k === badKey ? Promise.reject(new Error("r2 down")) : t.delete(k)) : Reflect.get(t, prop).bind?.(t) ?? Reflect.get(t, prop)),
    });
    const svc = createServices({ ...env, COMMONFORGE_ASSETS: flaky } as typeof env, h.deps);
    const r = await runGc(svc, { orgs: [o.orgId] });
    expect([...r.lfsObjectsExpired].sort()).toEqual([bad, good].sort());
    expect(r.errors.some((e) => e.includes("r2 down") && e.includes(bad))).toBe(true);
    expect(await row(bad)).toBeNull();
    expect(await exists(badKey)).toBe(true); // leaked, never a row without bytes
    expect(await exists(goodKey)).toBe(false);
  });

  it("a rejected object that was still uploading gets its multipart upload aborted", async () => {
    const { h, o, pid } = await world();
    const id = await startUpload(h, o, pid, "rej-mp.bin");
    const { r2_key: key, upload_id: uploadId } = (await env.DB.prepare("SELECT r2_key, upload_id FROM lfs_objects WHERE staging_id = ?").bind(id).first<{ r2_key: string; upload_id: string }>())!;
    await env.DB.prepare("UPDATE lfs_objects SET state = 'rejected' WHERE staging_id = ?").bind(id).run();
    await ageObject(id);
    const r = await gc(h, o.orgId);
    expect(r.lfsObjectsExpired).toEqual([id]);
    await expect(env.COMMONFORGE_ASSETS.resumeMultipartUpload(key, uploadId).uploadPart(1, bytes("x"))).rejects.toThrow();
  });
});

describe("GC: file change artifacts", () => {
  const put = async (orgId: string, changeId: string) => {
    const keys = [opsManifestKey(orgId, changeId, 1), opsManifestKey(orgId, changeId, 2), editsKey(orgId, changeId)];
    for (const k of keys) await env.COMMONFORGE_ASSETS.put(k, bytes("{}"));
    return keys;
  };

  it("old terminal changes lose their R2 prefix (rows stay); young, old-open and other changes keep theirs", async () => {
    const { h, o, site } = await world();
    const fresh = new Date().toISOString();
    const cases: Record<string, [string, string]> = {
      chg_added_old: ["added", OLD],
      chg_failed_old: ["failed", OLD],
      chg_failed_young: ["failed", fresh],
      chg_open_old: ["waiting_approval", OLD],
    };
    const keys: Record<string, string[]> = {};
    for (const [id, [state, at]] of Object.entries(cases)) {
      await insertChange(o.orgId, site.resourceId, id, state, at);
      keys[id] = await put(o.orgId, id);
    }
    const r = await gc(h, o.orgId);
    expect(r.errors).toEqual([]);
    expect([...r.fileChangeArtifactsDeleted].sort()).toEqual(["chg_added_old", "chg_failed_old"]);
    for (const id of ["chg_added_old", "chg_failed_old"]) for (const k of keys[id]!) expect(await exists(k)).toBe(false);
    for (const id of ["chg_failed_young", "chg_open_old"]) for (const k of keys[id]!) expect(await exists(k)).toBe(true);
    const kept = await env.DB.prepare("SELECT change_id FROM file_changes WHERE change_id IN (?, ?, ?, ?)").bind(...Object.keys(cases)).all();
    expect(kept.results.length).toBe(4);

    const again = await gc(h, o.orgId);
    expect(again.fileChangeArtifactsDeleted).toEqual([]);
  });

  it("a prefix with no change row goes when its objects are over 24 h old, and not before", async () => {
    const { h, o } = await world();
    // R2 objects carry their real upload time; the GC clock is moved instead
    const keys = await put(o.orgId, "chg_orphan");
    expect((await gc(h, o.orgId)).fileChangeArtifactsDeleted).toEqual([]);
    for (const k of keys) expect(await exists(k)).toBe(true);
    const later = { ...h.deps, now: () => new Date(Date.now() + 25 * 3600_000) };
    const r = await runGc(createServices(env, later), { orgs: [o.orgId] });
    expect(r.fileChangeArtifactsDeleted).toEqual(["chg_orphan"]);
    for (const k of keys) expect(await exists(k)).toBe(false);
  });

  it("deletes every object of a prefix, not only the known ones", async () => {
    const { h, o, site } = await world();
    await insertChange(o.orgId, site.resourceId, "chg_big", "added", OLD);
    const prefix = changePrefix(o.orgId, "chg_big");
    for (let i = 0; i < 12; i++) await env.COMMONFORGE_ASSETS.put(`${prefix}extra-${i}.json`, bytes("{}"));
    const r = await gc(h, o.orgId);
    expect(r.fileChangeArtifactsDeleted).toEqual(["chg_big"]);
    expect((await env.COMMONFORGE_ASSETS.list({ prefix })).objects.length).toBe(0);
  });
});

describe("GC: open file change sweep", () => {
  it("settles open changes idle for over 2 minutes (a stuck apply is enqueued again); not young or finished ones", async () => {
    const { h, o, site } = await world();
    const fresh = new Date().toISOString();
    await insertChange(o.orgId, site.resourceId, "chg_stuck", "applying", OLD);
    await insertChange(o.orgId, site.resourceId, "chg_young", "applying", fresh);
    await insertChange(o.orgId, site.resourceId, "chg_done", "added", OLD);
    h.steps.splice(0);
    const r = await gc(h, o.orgId);
    expect(r.errors).toEqual([]);
    expect(r.fileChangesSettled).toBe(1);
    expect(h.steps).toContainEqual({ type: "files.apply", orgId: o.orgId, changeId: "chg_stuck" });
    expect(h.steps.some((s: any) => s.changeId === "chg_young" || s.changeId === "chg_done")).toBe(false);
  });

  it("rotates: more open changes than one pass handles are all reached over two passes", async () => {
    const { h, o, site } = await world();
    const stmts = [];
    for (let i = 0; i < 55; i++) {
      stmts.push(
        env.DB.prepare(
          "INSERT INTO file_changes (change_id, org_id, project_id, resource_id, mount_name, user_id, title, ops_json, has_edits, state, attempt, job_id, created_at, updated_at) VALUES (?, ?, 'prj', ?, 'site', 'usr', 't', '[]', 0, 'waiting_approval', 1, 'job', ?, ?)",
        ).bind(`rot_${String(i).padStart(3, "0")}`, o.orgId, site.resourceId, OLD, `2020-01-01T00:00:${String(i % 60).padStart(2, "0")}.${String(i).padStart(3, "0")}Z`),
      );
    }
    for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
    const first = await gc(h, o.orgId);
    expect(first.fileChangesSettled).toBe(50);
    const touched = async () => (await env.DB.prepare("SELECT count(*) AS n FROM file_changes WHERE change_id LIKE 'rot_%' AND updated_at > '2021'").first<{ n: number }>())!.n;
    expect(await touched()).toBe(50);
    const second = await gc(h, o.orgId);
    expect(second.fileChangesSettled).toBe(5); // the ones the first pass left; the others were just looked at
    expect(await touched()).toBe(55);
  });

  it("a change that throws while settling is recorded and does not stop the others", async () => {
    const { h, o, site } = await world();
    // an unparsable receipt makes settleFileChange throw for this one
    await insertChange(o.orgId, site.resourceId, "chg_bad", "applying", OLD, { jobId: "job_x" });
    await env.DB.prepare("UPDATE file_changes SET receipt_json = '{not json' WHERE change_id = 'chg_bad'").run();
    await insertChange(o.orgId, site.resourceId, "chg_ok", "applying", "2020-01-02T00:00:00.000Z");
    h.steps.splice(0);
    const r = await gc(h, o.orgId);
    expect(r.fileChangesSettled).toBe(2);
    expect(r.errors.length).toBe(1);
    expect(r.errors[0]).toContain("chg_bad");
    expect(h.steps).toContainEqual({ type: "files.apply", orgId: o.orgId, changeId: "chg_ok" });
  });
});

describe("GC: lost hash steps (M2)", () => {
  it("an upload stuck in `uploaded` for 15 minutes gets lfs.hash again, at most 3 times; then it is rejected and its folder's waiting change fails", async () => {
    const { h, o, pid } = await world();
    const id = await uploadFile(h, o, pid, "stuck.bin", bytes("stuck bytes"), { hash: false });
    expect((await row(id))?.state).toBe("uploaded");
    const r = await h.api("POST", `/api/orgs/${o.orgId}/projects/${pid}/folders/site/changes`, { token: o.token, body: { ops: [{ put: "stuck.bin", stagingId: id }] } });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    // the hash step is lost: nothing in the queue
    h.steps.splice(0);
    const hashSteps = () => (h.steps as Array<{ type: string; stagingId?: string }>).filter((s) => s.type === "lfs.hash" && s.stagingId === id).length;
    const stale = (minutesAgo: number) => env.DB.prepare("UPDATE lfs_objects SET updated_at = ? WHERE staging_id = ?").bind(new Date(Date.now() - minutesAgo * 60_000).toISOString(), id).run();
    const attempts = async () => (await env.DB.prepare("SELECT hash_attempts AS n FROM lfs_objects WHERE staging_id = ?").bind(id).first<{ n: number }>())!.n;

    // younger than 15 minutes: left alone
    await stale(10);
    expect((await gc(h, o.orgId)).lfsHashesRetried).toEqual([]);
    for (let i = 1; i <= 3; i++) {
      await stale(16);
      const g = await gc(h, o.orgId);
      expect(g.errors).toEqual([]);
      expect(g.lfsHashesRetried).toEqual([id]);
      expect(await attempts()).toBe(i);
      expect(hashSteps()).toBe(i);
      // the retry restarted the clock: an immediate second pass does nothing
      expect((await gc(h, o.orgId)).lfsHashesRetried).toEqual([]);
    }
    // the steps stay lost; the fourth time it gives up
    await stale(16);
    h.steps.splice(0);
    const g = await gc(h, o.orgId);
    expect(g.lfsHashesGivenUp).toEqual([id]);
    expect(g.lfsHashesRetried).toEqual([]);
    expect(await row(id)).toMatchObject({ state: "rejected", error: "hash_failed: gave up after 3 retries" });
    // its folder's waiting change was woken and fails with the reason
    expect((h.steps as Array<{ type: string; changeId?: string }>).some((s) => s.type === "files.apply" && s.changeId === r.body.changeId)).toBe(true);
    await h.drainSteps();
    const c = (await h.api("GET", `/api/orgs/${o.orgId}/file-changes/${r.body.changeId}`, { token: o.token })).body;
    expect(c.state).toBe("failed");
    expect(c.error.code).toBe("hash_failed");
  });

  it("a re-enqueued hash step that runs verifies the upload (the retry is the real step)", async () => {
    const { h, o, pid } = await world();
    const id = await uploadFile(h, o, pid, "late.bin", bytes("late bytes"), { hash: false });
    h.steps.splice(0);
    await env.DB.prepare("UPDATE lfs_objects SET updated_at = ? WHERE staging_id = ?").bind(new Date(Date.now() - 20 * 60_000).toISOString(), id).run();
    expect((await gc(h, o.orgId)).lfsHashesRetried).toEqual([id]);
    await h.drainSteps();
    expect((await row(id))?.state).toBe("verified");
  });
});
