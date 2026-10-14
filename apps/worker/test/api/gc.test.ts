/**
 * Scheduled GC (Task 17): single-flight lock, task repo sweep (frozen+prepared, abandoned
 * reference copies, expired leases), ghost names after failed creates, stale tokens and jobs, and
 * asset reachability from the ledger. Every sweep is run twice to prove it idempotent.
 */
import { sha256Hex, type TaskWorkspaceId } from "@commonforge-org/core";
import { createScheduledController, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createServices } from "../../src/context.js";
import { runGc, type GcOptions } from "../../src/services/gc.js";
import { agentPush, canonicalNs, freezeAndPropose, harness, ownerWithOrg, provisionedTask, tasksNs, type Harness } from "../helpers.js";

const OLD = "2020-01-01T00:00:00.000Z";
const ledgerOf = (orgId: string) => env.ORG_LEDGER.get(env.ORG_LEDGER.idFromName(`org:${orgId}`));
const gc = (h: Harness, orgId: string, opts: GcOptions = {}) => runGc(createServices(env, h.deps), { orgs: [orgId], ...opts });
const age = (taskId: string) => env.DB.prepare("UPDATE task_workspaces SET updated_at = ? WHERE task_id = ?").bind(OLD, taskId).run();
const wsRow = (id: string) => env.DB.prepare("SELECT state, swept_at FROM task_workspaces WHERE task_workspace_id = ?").bind(id).first<{ state: string; swept_at: string | null }>();
const repoName = (id: string) => `ws-${id}`;

describe("GC: single flight", () => {
  it("a run that finds the lock held is skipped; the cron handler runs one pass", async () => {
    const h = harness();
    const o = await ownerWithOrg(h);
    const svc = createServices(env, h.deps);
    const held = await svc.gate.withLock("gc", "sweep", 60_000, () => gc(h, o.orgId));
    expect(held.locked).toBe(false);
    expect(held.locked === false && held.value.skipped).toBe("locked");
    const free = await gc(h, o.orgId);
    expect(free.skipped).toBeUndefined();
    expect(free.errors).toEqual([]);

    const ctx = createExecutionContext();
    await h.worker.scheduled(createScheduledController({ scheduledTime: Date.now(), cron: "*/10 * * * *" }), env, ctx);
    await waitOnExecutionContext(ctx);
  });
});

describe("GC: run budget and reconcile backoff", () => {
  it("M-3: a run past its budget starts no further org pass", async () => {
    const h = harness();
    const o = await ownerWithOrg(h);
    const r = await gc(h, o.orgId, { runBudgetMs: -1 });
    expect(r.errors.some((e) => e.startsWith("deadline:"))).toBe(true);
  });

  it("M-5: diverged heads are re-requested with exponential backoff, pending heads every run", async () => {
    const h = harness();
    const t = await provisionedTask(h);
    const ledger = ledgerOf(t.o.orgId);
    const head = (await ledger.getHead(t.web.resourceId))!;
    expect(head.acceptedVersionId).toBeTruthy();
    await ledger.recordReconciliation(t.o.orgId, { resourceId: head.resourceId, revisionId: head.revisionId, state: "diverged", observedSha: null });
    // N-2: counted from when the divergence was observed, not from acceptance
    const observedAt = (await ledger.getRefState(head.resourceId))!.observedAt;
    const at = (runs: number) => runGc(createServices(env, { ...h.deps, now: () => new Date(Date.parse(observedAt) + runs * 600_000 + 1000) }), { orgs: [t.o.orgId], reconcileStaleSeconds: 0 });
    const counts: number[] = [];
    for (const runs of [1, 2, 3, 4, 5, 6, 7, 8]) {
      counts.push((await at(runs)).reconcileRequests);
    }
    expect(counts).toEqual([1, 1, 0, 1, 0, 0, 0, 1]);
    h.outbox.splice(0);
  });
});

describe("GC: task repo sweep", () => {
  it("frozen workspaces are collected only once their candidate is prepared and the grace has passed; idempotent", async () => {
    const h = harness();
    const t = await provisionedTask(h);
    const ws = t.task.workspaces.find((w: any) => w.mountName === "website");
    const ref = t.task.workspaces.find((w: any) => w.mountName === "api");
    t.runner.opts.manual = true;
    await freezeAndPropose(h, t.o, t.taskId, { "index.html": "v2" });
    h.deps.runnerWait = { pollMs: 5, timeoutMs: 20 };
    await h.drainSteps(1); // candidate.prepare waits on the runner
    // submitted: the reference copy was collected right away
    expect((await wsRow(ref.taskWorkspaceId))?.state).toBe("collected");
    expect(h.artifacts.findRepo(tasksNs(t.o.orgId), repoName(ref.taskWorkspaceId))).toBeUndefined();

    // young and still unprepared: kept
    let r = await gc(h, t.o.orgId);
    expect(r.errors).toEqual([]);
    expect(r.collectedWorkspaces).toEqual([]);
    expect((await wsRow(ref.taskWorkspaceId))?.swept_at).toBeTruthy(); // confirmed gone
    // old but the candidate still waits for prepare-candidate: the fork is still needed
    await age(t.taskId);
    r = await gc(h, t.o.orgId);
    expect(r.collectedWorkspaces).toEqual([]);
    expect(h.artifacts.findRepo(tasksNs(t.o.orgId), repoName(ws.taskWorkspaceId))).toBeTruthy();

    // prepared → retained in canonical → the task repo goes
    t.runner.opts.manual = false;
    await t.runner.runPending();
    h.deps.runnerWait = { pollMs: 5, timeoutMs: 3000 };
    await h.drainSteps();
    r = await gc(h, t.o.orgId);
    expect(r.errors).toEqual([]);
    expect(r.collectedWorkspaces).toEqual([ws.taskWorkspaceId]);
    expect(h.artifacts.findRepo(tasksNs(t.o.orgId), repoName(ws.taskWorkspaceId))).toBeUndefined();
    expect((await ledgerOf(t.o.orgId).getWorkspace(ws.taskWorkspaceId))?.state).toBe("collected");
    expect(await wsRow(ws.taskWorkspaceId)).toMatchObject({ state: "collected", swept_at: expect.any(String) });
    // canonical is untouched
    expect(h.artifacts.findRepo(canonicalNs(t.o.orgId), t.web.resourceId)).toBeTruthy();

    // idempotent
    const deletes = h.artifacts.calls.filter((c) => c.op === "deleteRepo").length;
    r = await gc(h, t.o.orgId);
    expect(r.errors).toEqual([]);
    expect([r.collectedWorkspaces, r.sweptGhosts, r.abandonedWorkspaces]).toEqual([[], [], []]);
    expect(h.artifacts.calls.filter((c) => c.op === "deleteRepo").length).toBe(deletes);
  });

  it("a task left running with an expired lease is canceled; its repos and read-only copies are abandoned, then collected after the grace (N-4)", async () => {
    const h = harness();
    const t = await provisionedTask(h);
    const lease = await h.api("POST", `/api/tasks/${t.taskId}/lease`, { token: t.o.token, body: {} });
    const agent = lease.body.leaseToken as string;
    const cred = await h.api("POST", `/api/tasks/${t.taskId}/credential`, { token: agent, body: { mountName: "api", access: "read" } });
    expect(cred.status).toBe(200);
    const ids = t.task.workspaces.map((w: any) => w.taskWorkspaceId as string).sort();

    // live lease: untouched even with a tiny abandon window
    let r = await gc(h, t.o.orgId, { abandonAfterSeconds: 0 });
    expect(r.canceledTasks).toEqual([]);
    // the lease expired long ago
    await env.DB.prepare("UPDATE tasks SET lease_expires_at = ?, updated_at = ? WHERE task_id = ?").bind(Date.parse(OLD), OLD, t.taskId).run();
    r = await gc(h, t.o.orgId);
    expect(r.errors).toEqual([]);
    expect(r.canceledTasks).toEqual([t.taskId]);
    expect([...r.abandonedWorkspaces].sort()).toEqual(ids);
    expect(r.collectedWorkspaces).toEqual([]); // young abandonment: grace first
    expect(h.artifacts.tokenByPlaintext(cred.body.secret)!.token.state).toBe("revoked");
    expect((await h.api("GET", `/api/tasks/${t.taskId}`, { token: agent })).status).toBe(401);
    for (const id of ids) expect((await ledgerOf(t.o.orgId).getWorkspace(id))?.state).toBe("abandoned");

    await age(t.taskId);
    r = await gc(h, t.o.orgId);
    expect(r.errors).toEqual([]);
    expect([...r.collectedWorkspaces].sort()).toEqual(ids);
    for (const id of ids) {
      expect(h.artifacts.findRepo(tasksNs(t.o.orgId), repoName(id))).toBeUndefined();
      expect((await ledgerOf(t.o.orgId).getWorkspace(id))?.state).toBe("collected");
    }
    r = await gc(h, t.o.orgId);
    expect([r.canceledTasks, r.abandonedWorkspaces, r.collectedWorkspaces, r.errors]).toEqual([[], [], [], []]);
  });

  it("review I-2: `ready` tasks are never canceled; a released lease cancels only after 7 days idle; pushed-but-unfrozen work outlives the 1 h grace", async () => {
    const h = harness();
    const ready = await provisionedTask(h);
    await env.DB.prepare("UPDATE tasks SET updated_at = ? WHERE task_id = ?").bind(OLD, ready.taskId).run();
    let r = await gc(h, ready.o.orgId);
    expect(r.canceledTasks).toEqual([]);
    expect((await h.api("GET", `/api/tasks/${ready.taskId}`, { token: ready.o.token })).body.state).toBe("ready");

    const t = await provisionedTask(h);
    const { ws } = await agentPush(h, t.o.token, t.taskId, { "index.html": "work in progress" });
    expect((await h.api("DELETE", `/api/tasks/${t.taskId}/lease`, { token: t.o.token })).status).toBe(200);
    const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
    await env.DB.prepare("UPDATE tasks SET updated_at = ? WHERE task_id = ?").bind(daysAgo(2), t.taskId).run();
    r = await gc(h, t.o.orgId);
    expect(r.canceledTasks).toEqual([]);
    await env.DB.prepare("UPDATE tasks SET updated_at = ? WHERE task_id = ?").bind(daysAgo(8), t.taskId).run();
    r = await gc(h, t.o.orgId);
    expect(r.canceledTasks).toEqual([t.taskId]);
    const ref = t.task.workspaces.find((w: any) => w.mountName === "api").taskWorkspaceId as string;

    // abandoned 2 h ago: the empty reference copy goes, the repo with unfrozen commits stays
    await env.DB.prepare("UPDATE task_workspaces SET updated_at = ? WHERE task_id = ?").bind(new Date(Date.now() - 2 * 3_600_000).toISOString(), t.taskId).run();
    r = await gc(h, t.o.orgId);
    expect(r.errors).toEqual([]);
    expect(r.collectedWorkspaces).toEqual([ref]);
    expect(h.artifacts.findRepo(tasksNs(t.o.orgId), repoName(ws.taskWorkspaceId))).toBeTruthy();
    // after the unfrozen-work grace it goes too
    await env.DB.prepare("UPDATE task_workspaces SET updated_at = ? WHERE task_id = ?").bind(daysAgo(8), t.taskId).run();
    r = await gc(h, t.o.orgId);
    expect(r.collectedWorkspaces).toEqual([ws.taskWorkspaceId]);
    expect(h.artifacts.findRepo(tasksNs(t.o.orgId), repoName(ws.taskWorkspaceId))).toBeUndefined();
  });

  it("crash after the repo create, before the ledger record: the stuck workspace fails and the sweep deletes the repo; ghost names are re-checked until the window ends (G.5, A9)", async () => {
    const h = harness();
    const t0 = await provisionedTask(h);
    const o = t0.o;
    const created = await h.api("POST", `/api/orgs/${o.orgId}/projects/${t0.pid}/tasks`, { token: o.token, body: { title: "crashes", writeMounts: ["website"] } });
    expect(created.status).toBe(201);
    h.steps.splice(0); // the provisioning steps are lost
    const [a, b] = created.body.workspaces.map((w: any) => w.taskWorkspaceId as string);
    // a: the create landed, then the Worker died (no ledger handle); b: a ghost name (500 on create)
    h.artifacts.addRepo(tasksNs(o.orgId), repoName(a));
    await env.DB.prepare("UPDATE task_workspaces SET updated_at = ? WHERE task_id = ?").bind(OLD, created.body.taskId).run();

    let r = await gc(h, o.orgId, { stuckProvisioningSeconds: 60 });
    expect(r.errors).toEqual([]);
    expect((await wsRow(a))?.state).toBe("failed");
    expect((await h.api("GET", `/api/tasks/${created.body.taskId}`, { token: o.token })).body.state).toBe("failed");
    r = await gc(h, o.orgId);
    expect(r.sweptGhosts).toEqual([a]);
    expect(h.artifacts.findRepo(tasksNs(o.orgId), repoName(a))).toBeUndefined();
    expect((await wsRow(a))?.swept_at).toBeTruthy();
    // b failed recently (inside the ghost window): nothing to delete yet, keep looking
    expect((await wsRow(b))?.swept_at).toBeNull();
    // the ghost materializes later: the next run deletes it
    h.artifacts.addRepo(tasksNs(o.orgId), repoName(b));
    r = await gc(h, o.orgId);
    expect(r.sweptGhosts).toEqual([b]);
    expect(h.artifacts.findRepo(tasksNs(o.orgId), repoName(b))).toBeUndefined();
    r = await gc(h, o.orgId);
    expect([r.sweptGhosts, r.collectedWorkspaces, r.errors]).toEqual([[], [], []]);
    // the first task's live workspaces were never touched
    for (const w of t0.task.workspaces) expect(h.artifacts.findRepo(tasksNs(o.orgId), repoName(w.taskWorkspaceId))).toBeTruthy();
  });

  it("a failed workspace whose name never materializes is marked swept once the ghost window ends", async () => {
    const h = harness();
    const t0 = await provisionedTask(h);
    const created = await h.api("POST", `/api/orgs/${t0.o.orgId}/projects/${t0.pid}/tasks`, { token: t0.o.token, body: { title: "ghost", writeMounts: ["website"] } });
    h.steps.splice(0);
    const ids = created.body.workspaces.map((w: any) => w.taskWorkspaceId as string);
    await env.DB.prepare("UPDATE task_workspaces SET state = 'failed', updated_at = ? WHERE task_id = ?").bind(OLD, created.body.taskId).run();
    const r = await gc(h, t0.o.orgId);
    expect([...r.sweptGhosts].sort()).toEqual([...ids].sort());
    for (const id of ids) expect((await wsRow(id))?.swept_at).toBeTruthy();
  });
});

describe("GC: tokens and runner jobs", () => {
  it("revokes stale canonical write tokens and closes expired runner jobs (revoking their tokens)", async () => {
    const h = harness();
    const t = await provisionedTask(h);
    const ns = canonicalNs(t.o.orgId);
    const stale = await h.artifacts.createToken(ns, t.web.resourceId, "write", 86_400);
    h.artifacts.repo(ns, t.web.resourceId).tokens.find((x) => x.id === stale.id)!.createdAt = OLD;
    const fresh = await h.artifacts.createToken(ns, t.web.resourceId, "write", 600);
    const read = await h.artifacts.createToken(ns, t.web.resourceId, "read", 86_400);
    h.artifacts.repo(ns, t.web.resourceId).tokens.find((x) => x.id === read.id)!.createdAt = OLD;

    // an open job that never got a result
    t.runner.opts.manual = true;
    await freezeAndPropose(h, t.o, t.taskId, { "index.html": "v2" });
    h.deps.runnerWait = { pollMs: 5, timeoutMs: 20 };
    await h.drainSteps(1);
    const job = t.runner.pending[0]!;
    await t.runner.credential(job, (job.job as any).canonical, "write");
    const minted = h.artifacts.activeTokens(ns, t.web.resourceId).filter((x) => ![stale.id, fresh.id, read.id].includes(x.id));
    expect(minted).toHaveLength(1);
    await env.DB.prepare("UPDATE runner_jobs SET expires_at = 1 WHERE job_id = ?").bind(job.jobId).run();

    const r = await gc(h, t.o.orgId);
    expect(r.errors).toEqual([]);
    expect(r.expiredJobs).toBeGreaterThanOrEqual(1);
    const row = await env.DB.prepare("SELECT status, result_json FROM runner_jobs WHERE job_id = ?").bind(job.jobId).first<{ status: string; result_json: string }>();
    expect(row?.status).toBe("failed");
    expect(JSON.parse(row!.result_json)).toMatchObject({ ok: false, code: "job_expired" });
    const state = (id: string) => h.artifacts.repo(ns, t.web.resourceId).tokens.find((x) => x.id === id)!.state;
    expect(state(stale.id)).toBe("revoked");
    expect(state(minted[0]!.id)).toBe("revoked");
    expect(state(fresh.id)).toBe("active");
    expect(state(read.id)).toBe("active");
    // a late result for the closed job is refused
    const late = await t.runner.post(job, { jobId: job.jobId, ok: false, code: "provider_unavailable", detail: "late" });
    expect(late.status).toBe(409);
  });
});

describe("GC: assets", () => {
  async function promote(h: Harness, orgId: string, resourceId: string, text: string) {
    const assets = await createServices(env, h.deps).assets(orgId);
    const bytes = new TextEncoder().encode(text);
    const { stagingKey } = await assets.stageUpload({ organizationId: orgId, taskWorkspaceId: "tw-gc-test" as TaskWorkspaceId, path: `${text}.bin`, size: bytes.length, mime: "application/octet-stream" });
    await assets.putStaged(stagingKey, bytes);
    return assets.promoteStaged({ stagingKey, expectedSha256: await sha256Hex(bytes), resourceId: resourceId as never });
  }

  it("never deletes reachable or young objects; unreachable ones go after the grace", async () => {
    const h = harness();
    const o = await ownerWithOrg(h);
    const res = await h.api("POST", `/api/orgs/${o.orgId}/resources`, { token: o.token, body: { name: "brand", provider: "r2-assets" } });
    expect(res.status).toBe(201);
    const rid = res.body.resourceId as string;
    const m0 = res.body.coords.manifestId as string; // genesis: an accepted version
    const assets = await createServices(env, h.deps).assets(o.orgId);
    const o1 = await promote(h, o.orgId, rid, "orphan-1");
    const m1 = await assets.writeManifest({ resourceId: rid as never, parentManifestId: null, entries: [{ path: "a.bin", sha256: o1.sha256, size: o1.size, mime: "x/y", objectKey: o1.objectKey }] });
    const o2 = await promote(h, o.orgId, rid, "in-a-running-task");
    const m2 = await assets.writeManifest({ resourceId: rid as never, parentManifestId: m0 as never, entries: [{ path: "b.bin", sha256: o2.sha256, size: o2.size, mime: "x/y", objectKey: o2.objectKey }] });
    const o3 = await promote(h, o.orgId, rid, "orphan-object");
    // a running task whose asset workspace produced m2
    const now = new Date().toISOString();
    const pid = (await h.api("POST", `/api/orgs/${o.orgId}/projects`, { token: o.token, body: { name: "P" } })).body.projectId;
    await env.DB.prepare(
      "INSERT INTO tasks (task_id, org_id, project_id, change_id, title, request, state, snapshot_json, created_by, created_at, updated_at) VALUES ('task-gc-assets', ?, ?, 'chg-x', 't', '', 'running', '{}', ?, ?, ?)",
    )
      .bind(o.orgId, pid, o.userId, now, now)
      .run();
    await env.DB.prepare(
      "INSERT INTO task_workspaces (task_workspace_id, task_id, org_id, resource_id, mount_name, provider, access, base_revision, state, asset_manifest_id, created_at, updated_at) VALUES ('tw-gc-assets', 'task-gc-assets', ?, ?, 'brand', 'r2-assets', 'write', ?, 'writable', ?, ?, ?)",
    )
      .bind(o.orgId, rid, `r2m:${m0}`, m2.manifestId, now, now)
      .run();
    const keys = (prefix: string) => env.COMMONFORGE_ASSETS.list({ prefix }).then((l) => l.objects.map((x) => x.key));
    const manifestKey = (id: string) => `org/${o.orgId}/res/${rid}/manifest/${id}.json`;

    // young: nothing is deleted
    let r = await gc(h, o.orgId);
    expect(r.errors).toEqual([]);
    expect(r.deletedAssets).toEqual([]);

    // past the grace: only the unreachable
    r = await gc(h, o.orgId, { graceSeconds: 0 });
    expect(r.errors).toEqual([]);
    expect(new Set(r.deletedAssets)).toEqual(new Set([o1.objectKey, manifestKey(m1.manifestId), `org/${o.orgId}/manifest-index/${m1.manifestId}`, o3.objectKey]));
    const left = await keys(`org/${o.orgId}/res/`);
    for (const k of [manifestKey(m0), manifestKey(m2.manifestId), o2.objectKey]) expect(left).toContain(k);
    r = await gc(h, o.orgId, { graceSeconds: 0 });
    expect(r.deletedAssets).toEqual([]); // idempotent

    // the task fails: its manifest is no longer reachable
    await env.DB.prepare("UPDATE tasks SET state = 'failed' WHERE task_id = 'task-gc-assets'").run();
    r = await gc(h, o.orgId, { graceSeconds: 0 });
    expect(new Set(r.deletedAssets)).toEqual(new Set([o2.objectKey, manifestKey(m2.manifestId), `org/${o.orgId}/manifest-index/${m2.manifestId}`]));
    expect(await keys(`org/${o.orgId}/res/`)).toEqual([manifestKey(m0)]);
    expect(await assets.readManifest(m0)).not.toBeNull();
  });
});
