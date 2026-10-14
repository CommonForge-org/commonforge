/**
 * File changes in a staging-mode project (decision "Staging promotion and LFS": through promotion).
 * A git folder's change lands in staging and stops there (`staged`): no proposal of its own, no
 * integrate job, `main` unchanged. A promotion that accepts its landing adds it (its LFS objects
 * accepted, `files.change_added` once); its landing failing or rolled back fails it; a withdrawn
 * promotion leaves it staged. Agent tasks promoted through promotions accept their LFS objects too.
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getFileChange, settleFileChange } from "../../src/services/file-changes.js";
import { runGc } from "../../src/services/gc.js";
import { REASONS, rollbackTask, setLanding, type LandingRow } from "../../src/services/staging.js";
import { userRef } from "../../src/services/events.js";
import { acceptInputFor } from "../../src/services/proposals.js";
import { DONE_STATES, releaseFixture } from "../promotion-helpers.js";
import { uploadFile } from "../lfs/lfs-helpers.js";

type Fixture = Awaited<ReturnType<typeof releaseFixture>>;

const MiB = 1_048_576;
/** a 2 MiB binary file (NUL bytes): an LFS object */
const video = (seed = 0) => new Uint8Array(2 * MiB).map((_, i) => (i % 7 === 0 ? 0 : (i + seed) % 251));

const objectRow = (stagingId: string) => env.DB.prepare("SELECT state, accepted_at FROM lfs_objects WHERE staging_id = ?").bind(stagingId).first<{ state: string; accepted_at: string | null }>();
const eventCount = async (action: string, subjectId: string) => (await env.DB.prepare("SELECT count(*) AS n FROM events WHERE action = ? AND subject_id = ?").bind(action, subjectId).first<{ n: number }>())!.n;

/** Upload a video to `api/public/<name>` as the owner and post the change; wait until it is staged and its landing is live on staging. */
async function stagedUpload(x: Fixture, name = "video.mp4", seed = 0) {
  const { f } = x;
  const stagingId = await uploadFile(f.h, f.o, f.pid, `public/${name}`, video(seed), { mount: "api" });
  const r = await f.h.api("POST", `/api/orgs/${f.o.orgId}/projects/${f.pid}/folders/api/changes`, { token: f.o.token, body: { ops: [{ put: `public/${name}`, stagingId }] } });
  expect(r.status, JSON.stringify(r.body)).toBe(202);
  const changeId = r.body.changeId as string;
  await f.until(async () => (await getFileChange(f.svc, changeId))?.state === "staged", 20_000);
  const taskId = (await getFileChange(f.svc, changeId))!.task_id!;
  await f.landingIdOf(taskId);
  await f.untilLanded(taskId);
  return { changeId, taskId, stagingId, path: `public/${name}` };
}

const read = async (x: Fixture, changeId: string) => (await x.f.h.api("GET", `/api/orgs/${x.f.o.orgId}/file-changes/${changeId}`, { token: x.f.o.token })).body;
const landingRow = async (x: Fixture, taskId: string) => (await x.f.svc.db.prepare("SELECT * FROM staging_landings WHERE org_id = ? AND task_id = ? ORDER BY seq DESC LIMIT 1").bind(x.f.o.orgId, taskId).first<LandingRow>())!;

describe("file changes in a staging-mode project go through promotion", { timeout: 120_000 }, () => {
  it("an upload is staged: its landing is live on staging, it has no proposal of its own, nothing is integrated and main is unchanged", async () => {
    const x = await releaseFixture();
    const { f, runner } = x;
    const { changeId, taskId, stagingId, path } = await stagedUpload(x);
    await f.h.drainSteps();
    const c = await read(x, changeId);
    expect(c).toMatchObject({ state: "staged", proposalId: null });
    expect(c.error).toBeUndefined();
    expect(c.changedPaths).toEqual(expect.arrayContaining([expect.objectContaining({ path })]));
    expect((await landingRow(x, taskId)).state).toBe("landed");
    expect(await f.headSha()).toBe(f.initialHeadSha);
    expect(runner.handled.map((j) => j.job.kind)).not.toContain("integrate");
    expect((await objectRow(stagingId))!.accepted_at).toBeNull();
    expect(await eventCount("files.change_staged", changeId)).toBe(1);
    // listed as open (however old), and settling a read changes nothing
    const list = (await f.h.api("GET", `/api/orgs/${f.o.orgId}/projects/${f.pid}/file-changes`, { token: f.o.token })).body.changes;
    expect(list).toMatchObject([{ changeId, state: "staged" }]);
    await env.DB.prepare("UPDATE file_changes SET updated_at = ? WHERE change_id = ?").bind(new Date(Date.now() - 10 * 60_000).toISOString(), changeId).run();
    expect((await settleFileChange(f.svc, (await getFileChange(f.svc, changeId))!)).state).toBe("staged");
    expect(runner.errors).toEqual([]);
  });

  it("promoted: main has the file, the change is added once, its LFS object is accepted; a lost tail is repaired when the change is read", async () => {
    const x = await releaseFixture();
    const { f, runner, promote, untilState, mainFiles, landingState } = x;
    const { changeId, taskId, stagingId, path } = await stagedUpload(x);
    const r = await promote(f.o.token, taskId);
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    const p = await untilState(r.body.promotionId, ...DONE_STATES);
    expect(p.state, p.detail ?? "").toBe("live");
    expect(await landingState(taskId)).toBe("promoted");
    expect((await mainFiles())[path]).toContain("oid sha256:");
    expect(await read(x, changeId)).toMatchObject({ state: "added", proposalId: null });
    expect((await objectRow(stagingId))!.accepted_at).not.toBeNull();
    expect(await eventCount("files.change_added", changeId)).toBe(1);
    const ev = (await env.DB.prepare("SELECT detail_json FROM events WHERE action = 'files.change_added' AND subject_id = ?").bind(changeId).first<{ detail_json: string }>())!;
    expect(JSON.parse(ev.detail_json)).toMatchObject({ taskId, promotionId: p.promotion_id, acceptedVersionId: p.accepted_version_id, objects: 1 });

    // as if the accept tail had died before the change was added: a read finishes it
    await env.DB.prepare("UPDATE file_changes SET state = 'staged' WHERE change_id = ?").bind(changeId).run();
    await env.DB.prepare("UPDATE lfs_objects SET accepted_at = NULL WHERE staging_id = ?").bind(stagingId).run();
    expect(await read(x, changeId)).toMatchObject({ state: "added" });
    expect((await objectRow(stagingId))!.accepted_at).not.toBeNull();
    expect(runner.errors).toEqual([]);
  });

  it("a withdrawn promotion leaves the change staged and its landing in staging", async () => {
    const x = await releaseFixture();
    const { f, runner, promote, untilState, landingState } = x;
    const { changeId, taskId } = await stagedUpload(x);
    runner.opts.hold = ["integrate"];
    const id = (await promote(f.o.token, taskId)).body.promotionId as string;
    await untilState(id, "building");
    expect((await f.h.api("POST", `/api/orgs/${f.o.orgId}/promotions/${id}/withdraw`, { token: f.o.token, body: {} })).status).toBe(200);
    runner.opts.hold = [];
    await runner.runPending();
    await f.h.drainSteps();
    expect(await landingState(taskId)).toBe("landed");
    expect(await read(x, changeId)).toMatchObject({ state: "staged" });
    expect(await f.headSha()).toBe(f.initialHeadSha);
  });

  it("its landing fails: the change fails staging_failed with the platform's text; nothing rolls back twice", async () => {
    const x = await releaseFixture();
    const { f } = x;
    const { changeId, taskId } = await stagedUpload(x);
    const l = await landingRow(x, taskId);
    const builds = async () => (await env.DB.prepare("SELECT count(*) AS n FROM staging_builds WHERE org_id = ? AND project_id = ?").bind(f.o.orgId, f.pid).first<{ n: number }>())!.n;
    const before = await builds();
    expect(await setLanding(f.svc, l, ["landed"], "failed", { code: "conflicts_with_production", text: REASONS.conflictsWithProduction })).toBe(true);
    const c = await read(x, changeId);
    expect(c).toMatchObject({ state: "failed", error: { code: "staging_failed" } });
    expect(c.error.message).toContain(REASONS.conflictsWithProduction);
    expect((await landingRow(x, taskId)).state).toBe("failed");
    // the failed change's own rollback (P3-6) found its landing out of staging: no build requested
    expect(await builds()).toBe(before);
    expect(await eventCount("files.change_failed", changeId)).toBe(1);
  });

  it("its landing is rolled back: the change fails staging_rolled_back", async () => {
    const x = await releaseFixture();
    const { f } = x;
    const { changeId, taskId } = await stagedUpload(x);
    await rollbackTask(f.svc, f.o.orgId, taskId, f.o.userId);
    await f.until(async () => (await landingRow(x, taskId)).state === "rolled_back", 20_000);
    expect(await read(x, changeId)).toMatchObject({ state: "failed", error: { code: "staging_rolled_back" } });
    expect(await f.headSha()).toBe(f.initialHeadSha);
  });

  it("a staged change's uploads never expire while it waits", async () => {
    const x = await releaseFixture();
    const { f } = x;
    const { changeId, stagingId } = await stagedUpload(x);
    // unused far past the staging TTL: GC keeps the object of an unfinished (staged) change
    await env.DB.prepare("UPDATE lfs_objects SET last_used_at = ? WHERE staging_id = ?").bind(new Date(0).toISOString(), stagingId).run();
    const report = await runGc(f.svc);
    expect(report.lfsObjectsExpired).not.toContain(stagingId);
    expect(await objectRow(stagingId)).not.toBeNull();
    expect((await getFileChange(f.svc, changeId))!.state).toBe("staged");
  });

  it("an agent task promoted through a promotion accepts its task's verified LFS objects", async () => {
    const x = await releaseFixture();
    const { f, client, promote, untilState, landTask } = x;
    const taskId = await landTask(client.token, "Copy", { "public/index.html": "<h1>Hi</h1>\n" });
    const resourceId = f.api.resourceId;
    const now = new Date(Date.parse(f.svc.nowIso()) - 60_000).toISOString();
    const ins = (id: string, rid: string) =>
      env.DB.prepare("INSERT INTO lfs_objects (staging_id, org_id, resource_id, r2_key, size, sha256, binary, etag, state, source, user_id, task_id, created_at, updated_at, last_used_at) VALUES (?, ?, ?, ?, 5, ?, 1, 'e', 'verified', 'lfs', ?, ?, ?, ?, ?)")
        .bind(id, f.o.orgId, rid, `org/${f.o.orgId}/lfs/${rid}/obj/${id}`, id.padEnd(64, "0"), client.userId, taskId, now, now, now)
        .run();
    await ins("lfs-agent-1", resourceId);
    // an object of the same task in a resource the promotion does not change stays unaccepted
    await ins("lfs-agent-2", "res-not-changed");
    const id = (await promote(client.token, taskId)).body.promotionId as string;
    expect((await untilState(id, ...DONE_STATES)).state).toBe("live");
    expect((await objectRow("lfs-agent-1"))!.accepted_at).not.toBeNull();
    expect((await objectRow("lfs-agent-2"))!.accepted_at).toBeNull();
    expect((await env.DB.prepare("SELECT count(*) AS n FROM lfs_task_promotions WHERE task_id = ? AND resource_id = ?").bind(taskId, resourceId).first<{ n: number }>())!.n).toBe(1);
  });

  it("a change already on its own proposal when staging mode applies finishes on the old path", async () => {
    const x = await releaseFixture();
    const { f, runner } = x;
    // staging mode off without a policy revision (a test seam): the change opens its own proposal
    const policy = (await env.DB.prepare("SELECT policy_json FROM projects WHERE org_id = ? AND project_id = ?").bind(f.o.orgId, f.pid).first<{ policy_json: string }>())!.policy_json;
    const without = JSON.parse(policy);
    delete without.staging;
    await env.DB.prepare("UPDATE projects SET policy_json = ? WHERE org_id = ? AND project_id = ?").bind(JSON.stringify(without), f.o.orgId, f.pid).run();
    runner.opts.hold = ["integrate"];
    const stagingId = await uploadFile(f.h, f.o, f.pid, "public/old.mp4", video(3), { mount: "api" });
    const r = await f.h.api("POST", `/api/orgs/${f.o.orgId}/projects/${f.pid}/folders/api/changes`, { token: f.o.token, body: { ops: [{ put: "public/old.mp4", stagingId }] } });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    await f.until(async () => (await getFileChange(f.svc, r.body.changeId))?.state === "checking", 20_000);
    // staging mode is on again while it integrates
    await env.DB.prepare("UPDATE projects SET policy_json = ? WHERE org_id = ? AND project_id = ?").bind(policy, f.o.orgId, f.pid).run();
    runner.opts.hold = [];
    await runner.runPending();
    await f.until(async () => (await getFileChange(f.svc, r.body.changeId))?.state === "added", 20_000);
    expect((await getFileChange(f.svc, r.body.changeId))!.proposal_id).toMatch(/^prop-fc-/);
    expect(await f.headSha()).not.toBe(f.initialHeadSha);
    expect((await objectRow(stagingId))!.accepted_at).not.toBeNull();
  });

  it("ruling 3 / review I1: staging drops the landing after its promotion's accept committed; GC keeps the uploads while the landing is claimed, and the accept adds the change", async () => {
    const x = await releaseFixture();
    const { f, promote, untilHeld, untilState, resume, ledger, landingState } = x;
    const { changeId, taskId, stagingId, path } = await stagedUpload(x);
    const id = (await promote(f.o.token, taskId)).body.promotionId as string;
    const cleared = await untilHeld(id, (p) => p.state === "cleared");
    // it took production and the ledger accepted (past the set guard), then staging failed the
    // promoting landing before the accept tail ran
    await f.svc.db.prepare("UPDATE promotions SET state = 'accepting', claimed_at = ? WHERE promotion_id = ?").bind(f.svc.nowIso(), id).run();
    const proposal = (await ledger.getProposal(cleared.proposal_id!))!;
    expect((await ledger.accept(await acceptInputFor(f.svc, proposal, `${f.o.orgId}:promotion-i1`, userRef(f.o.userId)))).ok).toBe(true);
    expect(await setLanding(f.svc, await landingRow(x, taskId), ["promoting"], "failed", { code: "conflicts_with_production", text: REASONS.conflictsWithProduction })).toBe(true);
    expect(await getFileChange(f.svc, changeId)).toMatchObject({ state: "failed", error_code: "staging_failed" });
    // unused far past the staging TTL, the change no longer open: the claim keeps the bytes
    await env.DB.prepare("UPDATE lfs_objects SET last_used_at = ? WHERE staging_id = ?").bind(new Date(0).toISOString(), stagingId).run();
    const report = await runGc(f.svc);
    expect(report.lfsObjectsExpired).not.toContain(stagingId);
    expect(await objectRow(stagingId)).toMatchObject({ state: "verified", accepted_at: null });
    // the accept tail goes on: the change is added after all, its object accepted
    await resume(id);
    expect((await untilState(id, ...DONE_STATES)).state).toBe("live");
    expect(await landingState(taskId)).toBe("promoted");
    expect(await read(x, changeId)).toMatchObject({ state: "added" });
    expect((await objectRow(stagingId))!.accepted_at).not.toBeNull();
    expect((await x.mainFiles())[path]).toContain("oid sha256:");
    expect(await eventCount("files.change_objects_missing", changeId)).toBe(0);
  });

  it("review I1: without a claim (the promotion ended), a staging_failed change's uploads expire as usual", async () => {
    const x = await releaseFixture();
    const { f } = x;
    const { changeId, taskId, stagingId } = await stagedUpload(x);
    await setLanding(f.svc, await landingRow(x, taskId), ["landed"], "failed", { code: "conflicts_with_production", text: REASONS.conflictsWithProduction });
    expect((await getFileChange(f.svc, changeId))!.error_code).toBe("staging_failed");
    await env.DB.prepare("UPDATE lfs_objects SET last_used_at = ? WHERE staging_id = ?").bind(new Date(0).toISOString(), stagingId).run();
    expect((await runGc(f.svc)).lfsObjectsExpired).toContain(stagingId);
  });

  it("review I1: a promotion accept whose change's object is gone records it loudly", async () => {
    const x = await releaseFixture();
    const { f, promote, untilHeld, untilState, resume } = x;
    const { changeId, taskId, stagingId } = await stagedUpload(x);
    const id = (await promote(f.o.token, taskId)).body.promotionId as string;
    await untilHeld(id, (p) => p.state === "cleared");
    await env.DB.prepare("DELETE FROM lfs_objects WHERE staging_id = ?").bind(stagingId).run();
    await resume(id);
    expect((await untilState(id, ...DONE_STATES)).state).toBe("live");
    expect(await read(x, changeId)).toMatchObject({ state: "added" });
    expect(await eventCount("files.change_objects_missing", changeId)).toBe(1);
  });

  it("ruling 4: a staged change whose task has no landing gets staging.land again when idle, and fails staging_land_failed after 6 hours", async () => {
    const x = await releaseFixture();
    const { f } = x;
    const { changeId, taskId } = await stagedUpload(x);
    // as if staging never took it
    await env.DB.prepare("DELETE FROM staging_landing_parts WHERE task_id = ?").bind(taskId).run();
    await env.DB.prepare("DELETE FROM staging_landings WHERE task_id = ?").bind(taskId).run();
    const old = new Date(Date.now() - 10 * 60_000).toISOString();
    await env.DB.prepare("UPDATE file_changes SET updated_at = ? WHERE change_id = ?").bind(old, changeId).run();
    f.h.steps.splice(0, f.h.steps.length);
    expect((await settleFileChange(f.svc, (await getFileChange(f.svc, changeId))!)).state).toBe("staged");
    expect(f.h.steps).toContainEqual({ type: "staging.land", orgId: f.o.orgId, taskId });
    // the read touched it: an immediate second read sends nothing
    f.h.steps.splice(0, f.h.steps.length);
    await settleFileChange(f.svc, (await getFileChange(f.svc, changeId))!);
    expect(f.h.steps).toEqual([]);
    await env.DB.prepare("UPDATE task_candidates SET created_at = ? WHERE task_id = ?").bind(new Date(Date.now() - 7 * 3600_000).toISOString(), taskId).run();
    expect(await settleFileChange(f.svc, (await getFileChange(f.svc, changeId))!)).toMatchObject({ state: "failed", error_code: "staging_land_failed" });
  });

  it("ruling 5 / review M2: a staged change whose candidate cannot be prepared fails prepare_failed at once and its landing leaves staging", async () => {
    const x = await releaseFixture();
    const { f, runner } = x;
    runner.opts.fail = { "prepare-candidate": { code: "scope_violation", detail: "prepare refused (test)" } };
    const stagingId = await uploadFile(f.h, f.o, f.pid, "public/p.mp4", video(5), { mount: "api" });
    const r = await f.h.api("POST", `/api/orgs/${f.o.orgId}/projects/${f.pid}/folders/api/changes`, { token: f.o.token, body: { ops: [{ put: "public/p.mp4", stagingId }] } });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    await f.until(async () => (await getFileChange(f.svc, r.body.changeId))?.state === "failed", 20_000);
    const fc = (await getFileChange(f.svc, r.body.changeId))!;
    expect(fc.error_code).toBe("prepare_failed");
    expect(await eventCount("files.change_staged", r.body.changeId)).toBe(1);
    expect(["rolling_back", "rolled_back"]).toContain((await landingRow(x, fc.task_id!)).state);
  });

  it("review M6: the GC sweep repairs a staged change whose promotion tail was lost, and leaves healthy staged changes untouched", async () => {
    const x = await releaseFixture();
    const { f, promote, untilState } = x;
    const a = await stagedUpload(x, "a.mp4", 1);
    const b = await stagedUpload(x, "b.mp4", 2);
    expect((await untilState((await promote(f.o.token, a.taskId)).body.promotionId, ...DONE_STATES)).state).toBe("live");
    // a's tail lost: staged again, object unaccepted
    await env.DB.prepare("UPDATE file_changes SET state = 'staged' WHERE change_id = ?").bind(a.changeId).run();
    await env.DB.prepare("UPDATE lfs_objects SET accepted_at = NULL WHERE staging_id = ?").bind(a.stagingId).run();
    const old = new Date(Date.now() - 3600_000).toISOString();
    await env.DB.prepare("UPDATE file_changes SET updated_at = ? WHERE change_id IN (?, ?)").bind(old, a.changeId, b.changeId).run();
    await runGc(f.svc);
    expect(await getFileChange(f.svc, a.changeId)).toMatchObject({ state: "added" });
    expect((await objectRow(a.stagingId))!.accepted_at).not.toBeNull();
    // b is healthy (landed): not rewritten
    expect(await getFileChange(f.svc, b.changeId)).toMatchObject({ state: "staged", updated_at: old });
  });

  it("review M5: the change names its task", async () => {
    const x = await releaseFixture();
    const { changeId, taskId } = await stagedUpload(x);
    expect(await read(x, changeId)).toMatchObject({ state: "staged", taskId });
  });
});
