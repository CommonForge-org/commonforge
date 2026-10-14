/**
 * Setting up a new folder (folders phase 4, rulings P4-1 to P4-3, P4-9): `startFolderInit` records
 * the setup and queues `folders.init`; the step issues the runner's `init-folder` job; its receipt
 * is checked against canonical and bound as the folder's genesis head. Retryable failures re-issue
 * up to three attempts; GC re-queues a stale setup; a failed setup can be tried again.
 */
import { artRevisionId } from "@commonforge-org/core";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createServices } from "../../src/context.js";
import { lfsEndpointUrl } from "../../src/lib/lfs-config.js";
import { firstCommitFiles, retryFolderInit, startFolderInit, MAX_FOLDER_INIT_ATTEMPTS } from "../../src/services/folder-init.js";
import { runGc } from "../../src/services/gc.js";
import { FakeRunner, type FakeRunnerOptions } from "../fakes/runner.js";
import { canonicalNs, harness, member, ownerWithOrg, projectWith, type Harness } from "../helpers.js";

const OLD = "2020-01-01T00:00:00.000Z";
type InitRow = { state: string; attempts: number; job_id: string | null; commit_sha: string | null; error: string | null; commit_time: string; requested_by: string; mount_name: string; project_id: string };

const initRow = (orgId: string, rid: string) => env.DB.prepare("SELECT * FROM folder_inits WHERE org_id = ? AND resource_id = ?").bind(orgId, rid).first<InitRow>();
const resourceRow = (orgId: string, rid: string) => env.DB.prepare("SELECT state, error FROM resources WHERE org_id = ? AND resource_id = ?").bind(orgId, rid).first<{ state: string; error: string | null }>();
const initJobs = (h: Harness) => (h.runnerJobs as Array<{ signedJob: { jobId: string; job: any } }>).filter((m) => m.signedJob.job.kind === "init-folder");
const gc = (h: Harness, orgId: string) => runGc(createServices(env, h.deps), { orgs: [orgId] });

/** An empty Artifacts folder `media` attached to a project, and its setup started (not run yet). */
async function newFolder(opts: FakeRunnerOptions = {}) {
  const h = harness();
  const runner = new FakeRunner(h, opts);
  const o = await ownerWithOrg(h);
  const r = await h.api("POST", `/api/orgs/${o.orgId}/resources`, { token: o.token, body: { name: "media", provider: "artifacts" } });
  expect(r.status).toBe(201);
  const rid = r.body.resourceId as string;
  const pid = await projectWith(h, o, [{ mountName: "media", resourceId: rid }]);
  const svc = createServices(env, h.deps);
  await startFolderInit(svc, { orgId: o.orgId, resourceId: rid, projectId: pid, mountName: "media", requestedBy: o.userId });
  return { h, o, rid, pid, runner, svc, repoId: r.body.coords.repoId as string };
}

/** Drain steps and wait for the fake runner until the setup is no longer pending (or nothing moves). */
async function settle(h: Harness, runner: FakeRunner, orgId: string, rid: string): Promise<InitRow> {
  for (let i = 0; i < 30; i++) {
    await h.drainSteps();
    await runner.idle();
    const row = (await initRow(orgId, rid))!;
    if (row.state !== "pending" && h.steps.length === 0) return row;
    if (row.state === "pending" && h.steps.length === 0 && runner.pending.length > 0) return row;
  }
  return (await initRow(orgId, rid))!;
}

const eventsOf = async (h: Harness, o: { token: string; orgId: string }, action: string) =>
  (await h.api("GET", `/api/orgs/${o.orgId}/events`, { token: o.token })).body.events.filter((e: any) => e.action === action);

describe("folder setup: start and job", () => {
  it("startFolderInit records a pending setup with a whole-second commit time and queues folders.init", async () => {
    const { h, o, rid, pid } = await newFolder();
    const row = (await initRow(o.orgId, rid))!;
    expect(row).toMatchObject({ state: "pending", attempts: 0, job_id: null, project_id: pid, mount_name: "media", requested_by: o.userId });
    expect(row.commit_time).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000Z$/);
    expect(h.steps).toContainEqual({ type: "folders.init", orgId: o.orgId, resourceId: rid });
  });

  it("folders.init issues one init-folder job: the three first files, the creator as author, the recorded time", async () => {
    const { h, o, rid, runner } = await newFolder({ hold: ["init-folder"] });
    await h.drainSteps();
    const jobs = initJobs(h);
    expect(jobs).toHaveLength(1);
    const job = jobs[0]!.signedJob.job;
    const row = (await initRow(o.orgId, rid))!;
    const lfsUrl = lfsEndpointUrl(env, o.orgId, rid);
    expect(lfsUrl).toBe(`https://worker.test/api/lfs/${o.orgId}/${rid}/info/lfs`);
    expect(job.files).toEqual(firstCommitFiles("media", lfsUrl));
    expect(job.files.map((f: any) => f.path)).toEqual([".gitattributes", ".lfsconfig", "README.md"]);
    expect(job.files[1].content).toBe(`[lfs]\n\turl = ${lfsUrl}\n`);
    expect(job.files[2].content).toBe("# media\n");
    expect(job.files[0].content).toContain("*.mp4 filter=lfs diff=lfs merge=lfs -text\n");
    const user = await env.DB.prepare("SELECT email, display_name FROM users WHERE user_id = ?").bind(o.userId).first<{ email: string; display_name: string | null }>();
    expect(job.author).toEqual({ name: user!.display_name?.trim() || user!.email, email: user!.email });
    expect(job.commitTime).toBe(row.commit_time);
    expect(job.message).toBe("Create folder media");
    expect(job.resourceId).toBe(rid);
    expect(job.canonical.namespace).toBe(canonicalNs(o.orgId));
    expect(row).toMatchObject({ attempts: 1, job_id: jobs[0]!.signedJob.jobId });
    // a second delivery of the step while the job is open issues nothing
    await h.deliver("commonforge-steps", [{ type: "folders.init", orgId: o.orgId, resourceId: rid }]);
    expect(initJobs(h)).toHaveLength(1);
    expect(runner.pending).toHaveLength(1);
  });

  it("an author name with <, >, newlines or only spaces is cleaned (the job schema refuses them)", async () => {
    const { h, o } = await newFolder({ hold: ["init-folder"] });
    await env.DB.prepare("UPDATE users SET display_name = ? WHERE user_id = ?").bind(" <Ann>\nLee ", o.userId).run();
    await h.drainSteps();
    expect(initJobs(h)[0]!.signedJob.job.author.name).toBe("AnnLee");
    const { h: h2, o: o2 } = await newFolder({ hold: ["init-folder"] });
    await env.DB.prepare("UPDATE users SET display_name = ? WHERE user_id = ?").bind(" <> ", o2.userId).run();
    await h2.drainSteps();
    const user = await env.DB.prepare("SELECT email FROM users WHERE user_id = ?").bind(o2.userId).first<{ email: string }>();
    expect(initJobs(h2)[0]!.signedJob.job.author.name).toBe(user!.email);
  });
});

describe("folder setup: the receipt", () => {
  it("a created receipt is checked against canonical and bound as the genesis head; a second delivery changes nothing", async () => {
    const { h, o, rid, pid, runner, repoId } = await newFolder();
    const row = await settle(h, runner, o.orgId, rid);
    const main = h.artifacts.repo(canonicalNs(o.orgId), rid).refs.get("main")!;
    expect(row).toMatchObject({ state: "done", commit_sha: main, attempts: 1 });
    expect(await resourceRow(o.orgId, rid)).toEqual({ state: "active", error: null });
    const res = await h.api("GET", `/api/orgs/${o.orgId}/resources/${rid}`, { token: o.token });
    expect(res.body.head.revisionId).toBe(artRevisionId(repoId, main));
    const tree = await h.api("GET", `/api/orgs/${o.orgId}/projects/${pid}/tree?mount=media`, { token: o.token });
    expect(tree.status).toBe(200);
    expect(tree.body.entries.map((e: any) => e.path).sort()).toEqual([".gitattributes", ".lfsconfig", "README.md"]);
    const ev = await eventsOf(h, o, "resource.initialized");
    expect(ev.map((e: any) => [e.subject.id, e.detail])).toEqual([[rid, { mountName: "media", commitSha: main }]]);
    // the same result again: a replay; the step again: a no-op
    const signedJob = runner.handled.find((j) => j.job.kind === "init-folder")!;
    const again = await runner.post(signedJob, { jobId: signedJob.jobId, ok: true, receipt: { jobId: signedJob.jobId, resourceId: rid, commitSha: main, status: "created" } });
    expect(again.status).toBe(200);
    await h.deliver("commonforge-steps", [{ type: "folders.init", orgId: o.orgId, resourceId: rid }]);
    expect(initJobs(h)).toHaveLength(1);
    expect(await eventsOf(h, o, "resource.initialized")).toHaveLength(1);
  });

  it("main already holding the folder's first commit (a retried job) answers already and binds it", async () => {
    const { h, o, rid, runner, repoId } = await newFolder({ hold: ["init-folder"] });
    await h.drainSteps();
    const job = initJobs(h)[0]!.signedJob.job;
    const sha = h.artifacts.makeCommit(Object.fromEntries(job.files.map((f: any) => [f.path, f.content])));
    h.artifacts.push(canonicalNs(o.orgId), rid, "main", sha);
    await runner.runPending();
    const row = await settle(h, runner, o.orgId, rid);
    expect(row).toMatchObject({ state: "done", commit_sha: sha });
    const res = await h.api("GET", `/api/orgs/${o.orgId}/resources/${rid}`, { token: o.token });
    expect(res.body.head.revisionId).toBe(artRevisionId(repoId, sha));
  });

  it("a receipt that does not match canonical main fails the setup (init_mismatch) and binds nothing", async () => {
    const { h, o, rid, runner } = await newFolder({ mutateReceipt: { "init-folder": (r: any) => ({ ...r, commitSha: "f".repeat(40) }) } });
    const row = await settle(h, runner, o.orgId, rid);
    expect(row.state).toBe("failed");
    expect(row.error).toMatch(/^init_mismatch/);
    const r = (await resourceRow(o.orgId, rid))!;
    expect(r.state).toBe("failed");
    expect(r.error).toMatch(/^Setting up this folder failed: /);
    expect(initJobs(h)).toHaveLength(1);
    const res = await h.api("GET", `/api/orgs/${o.orgId}/resources/${rid}`, { token: o.token });
    expect(res.body.head).toBeNull();
  });

  it("a commit with a parent on main is a mismatch too", async () => {
    const { h, o, rid, runner } = await newFolder({ hold: ["init-folder"] });
    await h.drainSteps();
    const job = initJobs(h)[0]!.signedJob.job;
    const child = h.artifacts.makeCommit(Object.fromEntries(job.files.map((f: any) => [f.path, f.content])), [h.artifacts.makeCommit({ "x.txt": "x" })]);
    // a runner that reports (and leaves on main) a commit with a parent
    runner.opts.mutateReceipt = {
      "init-folder": (r: any) => {
        h.artifacts.push(canonicalNs(o.orgId), rid, "main", child);
        return { ...r, commitSha: child };
      },
    };
    await runner.runPending();
    const row = await settle(h, runner, o.orgId, rid);
    expect(row.state).toBe("failed");
    expect(row.error).toMatch(/^init_mismatch/);
  });

  it("main holding another commit fails branch_not_empty without a retry", async () => {
    const { h, o, rid, runner } = await newFolder();
    h.artifacts.push(canonicalNs(o.orgId), rid, "main", h.artifacts.makeCommit({ "other.txt": "x" }));
    const row = await settle(h, runner, o.orgId, rid);
    expect(row.state).toBe("failed");
    expect(row.error).toMatch(/^branch_not_empty/);
    expect(initJobs(h)).toHaveLength(1);
    expect((await resourceRow(o.orgId, rid))!.state).toBe("failed");
  });

  it("a retryable failure is tried again; the third failure fails the folder", async () => {
    const { h, o, rid, runner } = await newFolder({ fail: { "init-folder": { code: "provider_unavailable", detail: "busy (test)" } } });
    const row = await settle(h, runner, o.orgId, rid);
    expect(initJobs(h)).toHaveLength(MAX_FOLDER_INIT_ATTEMPTS);
    expect(row).toMatchObject({ state: "failed", attempts: 3 });
    expect(row.error).toMatch(/^provider_unavailable/);
    const r = (await resourceRow(o.orgId, rid))!;
    expect(r).toMatchObject({ state: "failed" });
    expect(r.error).toContain("busy (test)");
    expect(await eventsOf(h, o, "resource.init_failed")).toHaveLength(1);
  });

  it("a retryable failure, then success: the second attempt binds the folder", async () => {
    const { h, o, rid, runner } = await newFolder({ hold: ["init-folder"] });
    await h.drainSteps();
    runner.opts.fail = { "init-folder": { code: "provider_unavailable", detail: "busy (test)" } };
    await runner.runPending();
    runner.opts.fail = undefined;
    await h.drainSteps();
    expect(initJobs(h)).toHaveLength(2);
    await runner.runPending();
    const row = await settle(h, runner, o.orgId, rid);
    expect(row).toMatchObject({ state: "done", attempts: 2 });
    expect((await resourceRow(o.orgId, rid))!.state).toBe("active");
  });
});

describe("folder setup: every attempt makes the same commit (review)", () => {
  const content = (job: any) => ({ files: job.files, author: job.author, commitTime: job.commitTime, message: job.message });

  it("a later attempt reuses the first attempt's files, author and message even if the creator's name changed", async () => {
    const { h, o, rid, runner } = await newFolder({ hold: ["init-folder"] });
    await h.drainSteps();
    const first = content(initJobs(h)[0]!.signedJob.job);
    await env.DB.prepare("UPDATE users SET display_name = ? WHERE user_id = ?").bind("Renamed Person", o.userId).run();
    runner.opts.fail = { "init-folder": { code: "provider_unavailable", detail: "busy (test)" } };
    await runner.runPending();
    runner.opts.fail = undefined;
    await h.drainSteps();
    expect(initJobs(h)).toHaveLength(2);
    expect(content(initJobs(h)[1]!.signedJob.job)).toEqual(first);
    await runner.runPending();
    expect((await settle(h, runner, o.orgId, rid)).state).toBe("done");
  });

  it("Try again reuses them too", async () => {
    const { h, o, rid, runner, svc } = await newFolder({ hold: ["init-folder"] });
    await h.drainSteps();
    const first = content(initJobs(h)[0]!.signedJob.job);
    runner.opts.fail = { "init-folder": { code: "branch_not_empty", detail: "x" } };
    await runner.runPending();
    expect((await settle(h, runner, o.orgId, rid)).state).toBe("failed");
    runner.opts.fail = undefined;
    await env.DB.prepare("UPDATE users SET display_name = ? WHERE user_id = ?").bind("Renamed Person", o.userId).run();
    await retryFolderInit(svc, o.orgId, rid);
    await h.drainSteps();
    expect(initJobs(h)).toHaveLength(2);
    expect(content(initJobs(h)[1]!.signedJob.job)).toEqual(first);
    await runner.runPending();
    expect((await settle(h, runner, o.orgId, rid)).state).toBe("done");
  });

  it("a folder whose head someone else already bound to the same first commit (adopt-head) is done, not failed", async () => {
    const { h, o, rid, pid, runner, repoId } = await newFolder({ hold: ["init-folder"] });
    await h.drainSteps();
    const job = initJobs(h)[0]!.signedJob.job;
    const sha = h.artifacts.makeCommit(Object.fromEntries(job.files.map((f: any) => [f.path, f.content])));
    h.artifacts.push(canonicalNs(o.orgId), rid, "main", sha);
    const dev = await member(h, o, "developer");
    await h.api("PUT", `/api/orgs/${o.orgId}/projects/${pid}/access`, { token: o.token, body: { userId: dev.userId, level: "write" } });
    const adopt = await h.api("POST", `/api/orgs/${o.orgId}/resources/${rid}/adopt-head`, { token: dev.token });
    expect(adopt.status, JSON.stringify(adopt.body)).toBe(200);
    await runner.runPending();
    const row = await settle(h, runner, o.orgId, rid);
    expect(row).toMatchObject({ state: "done", commit_sha: sha });
    expect(await resourceRow(o.orgId, rid)).toEqual({ state: "active", error: null });
    const res = await h.api("GET", `/api/orgs/${o.orgId}/resources/${rid}`, { token: o.token });
    expect(res.body.head.revisionId).toBe(artRevisionId(repoId, sha));
  });

  it("a late result of an earlier attempt's job changes nothing", async () => {
    const { h, o, rid, runner } = await newFolder({ hold: ["init-folder"] });
    await h.drainSteps();
    const old = initJobs(h)[0]!.signedJob;
    // the first job is lost (expired); the step moves on to a second one, held
    await env.DB.prepare("UPDATE runner_jobs SET expires_at = 1 WHERE job_id = ?").bind(old.jobId).run();
    runner.pending.splice(0);
    await h.deliver("commonforge-steps", [{ type: "folders.init", orgId: o.orgId, resourceId: rid }]);
    await h.drainSteps();
    expect(initJobs(h)).toHaveLength(2);
    const before = (await initRow(o.orgId, rid))!;
    expect(before).toMatchObject({ state: "pending", attempts: 2 });
    // the first job answers late with a commit that is not on main: ignored (not this attempt's job)
    await runner.post(old as any, { jobId: old.jobId, ok: true, receipt: { jobId: old.jobId, resourceId: rid, commitSha: "f".repeat(40), status: "created" } });
    expect(await initRow(o.orgId, rid)).toMatchObject({ state: "pending", attempts: 2, job_id: before.job_id });
    expect((await resourceRow(o.orgId, rid))!.state).toBe("empty");
  });
});

describe("folder setup: GC and retry", () => {
  it("GC re-queues a pending setup older than 15 minutes with no running job, once per pass", async () => {
    const { h, o, rid, runner } = await newFolder({ hold: ["init-folder"] });
    await h.drainSteps(); // job issued, held by the runner
    h.steps.splice(0);
    await env.DB.prepare("UPDATE folder_inits SET updated_at = ? WHERE resource_id = ?").bind(OLD, rid).run();
    // the job is still running: nothing to do
    expect((await gc(h, o.orgId)).folderInitRequeued).toBe(0);
    expect(h.steps).toEqual([]);
    // the job expired without a result
    await env.DB.prepare("UPDATE runner_jobs SET expires_at = 1 WHERE kind = 'init-folder' AND org_id = ?").bind(o.orgId).run();
    expect((await gc(h, o.orgId)).folderInitRequeued).toBe(1);
    expect(h.steps).toEqual([{ type: "folders.init", orgId: o.orgId, resourceId: rid }]);
    expect((await gc(h, o.orgId)).folderInitRequeued).toBe(0); // touched: not again this soon
    // the step counts the lost job as a failed attempt and issues the next one
    runner.pending.splice(0);
    runner.opts.hold = [];
    const row = await settle(h, runner, o.orgId, rid);
    expect(row).toMatchObject({ state: "done", attempts: 2 });
  });

  it("GC leaves done and failed setups alone", async () => {
    const { h, o, rid, runner } = await newFolder();
    await settle(h, runner, o.orgId, rid);
    const failed = await newFolder({ fail: { "init-folder": { code: "branch_not_empty", detail: "x" } } });
    await settle(failed.h, failed.runner, failed.o.orgId, failed.rid);
    await env.DB.prepare("UPDATE folder_inits SET updated_at = ? WHERE resource_id IN (?, ?)").bind(OLD, rid, failed.rid).run();
    expect((await gc(h, o.orgId)).folderInitRequeued).toBe(0);
    expect((await gc(failed.h, failed.o.orgId)).folderInitRequeued).toBe(0);
  });

  it("retryFolderInit: only a failed setup; it starts over and can succeed", async () => {
    const { h, o, rid, runner, svc } = await newFolder({ fail: { "init-folder": { code: "branch_not_empty", detail: "x" } } });
    await expect(retryFolderInit(svc, o.orgId, rid)).rejects.toMatchObject({ status: 409, code: "setup_not_failed" });
    expect((await settle(h, runner, o.orgId, rid)).state).toBe("failed");
    runner.opts.fail = undefined;
    await retryFolderInit(svc, o.orgId, rid);
    expect(await initRow(o.orgId, rid)).toMatchObject({ state: "pending", attempts: 0, job_id: null, error: null });
    expect(await resourceRow(o.orgId, rid)).toEqual({ state: "empty", error: null });
    const row = await settle(h, runner, o.orgId, rid);
    expect(row).toMatchObject({ state: "done", attempts: 1 });
    await expect(retryFolderInit(svc, o.orgId, rid)).rejects.toMatchObject({ status: 409, code: "setup_not_failed" });
  });
});

describe("folder setup: afterwards", () => {
  it("a file change and a task work on the new folder", async () => {
    const { h, o, rid, pid, runner } = await newFolder();
    expect((await settle(h, runner, o.orgId, rid)).state).toBe("done");
    const c = await h.api("POST", `/api/orgs/${o.orgId}/projects/${pid}/folders/media/changes`, { token: o.token, body: { ops: [{ delete: "README.md" }] } });
    expect(c.status, JSON.stringify(c.body)).toBe(202);
    let change: any;
    for (let i = 0; i < 100; i++) {
      await h.drainSteps();
      await runner.idle();
      change = (await h.api("GET", `/api/orgs/${o.orgId}/file-changes/${c.body.changeId}`, { token: o.token })).body;
      if (["added", "failed", "waiting_approval"].includes(change.state)) break;
    }
    expect(["added", "waiting_approval"], JSON.stringify(change)).toContain(change.state);
    const t = await h.api("POST", `/api/orgs/${o.orgId}/projects/${pid}/tasks`, { token: o.token, body: { title: "Add a video", request: "add it", writeMounts: ["media"] } });
    expect(t.status, JSON.stringify(t.body)).toBe(201);
  });
});
