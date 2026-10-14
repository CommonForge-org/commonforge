/**
 * Landing a file change (spec 2026-10-07 §7): content-only changes integrate with no checks, code
 * changes with the project's policy checks; the uploader's approval counts when their role is in
 * approvalRoles (else the change waits for one); the change is accepted and its LFS objects are
 * promoted (agent task proposals too); a stale base re-applies uploads up to three attempts and
 * fails edits with file_changed.
 */
import { sha256Hex } from "@commonforge-org/core";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { freezeAndPropose, harness, member, prepareAndIntegrate, provisionedTask, waitUntil, type Harness } from "../helpers.js";
import { LFS_TYPE, batch, parse, uploadFile, world } from "../lfs/lfs-helpers.js";
import { FakeRunner } from "../fakes/runner.js";
import { stagingFixture } from "../staging-helpers.js";
import { failChange, getFileChange, restartAttempt } from "../../src/services/file-changes.js";

type Owner = { token: string; orgId: string };

const MiB = 1_048_576;
const text = (s: string) => new TextEncoder().encode(s);
/** a 2 MiB binary file (NUL bytes), different per seed */
const video = (seed = 0) => new Uint8Array(2 * MiB).map((_, i) => (i % 7 === 0 ? 0 : (i + seed) % 251));

const postChange = (h: Harness, token: string, org: string, pid: string, body: unknown) => h.api("POST", `/api/orgs/${org}/projects/${pid}/folders/site/changes`, { token, body });
const getChange = async (h: Harness, o: Owner, id: string) => (await h.api("GET", `/api/orgs/${o.orgId}/file-changes/${id}`, { token: o.token })).body;
const ENDED = ["added", "failed", "waiting_approval"];

/** Drain steps (the fake runner answers in the background) until the change ended or waits for an approval. */
async function land(h: Harness, o: Owner, changeId: string) {
  for (let i = 0; i < 150; i++) {
    await h.drainSteps();
    const c = await getChange(h, o, changeId);
    if (ENDED.includes(c.state)) return c;
    await new Promise((res) => setTimeout(res, 20));
  }
  const c = await getChange(h, o, changeId);
  const jobs = c.proposalId ? (await env.DB.prepare("SELECT status, result_json FROM runner_jobs WHERE subject = ?").bind(`proposal:${c.proposalId}`).all()).results : [];
  throw new Error(`change ${changeId} did not land: ${JSON.stringify(c)} integrate jobs: ${JSON.stringify(jobs).slice(0, 2000)} steps: ${JSON.stringify(h.steps).slice(0, 500)}`);
}

/** Drain steps until `cond` holds (held runner jobs stay pending). */
async function pumpUntil(h: Harness, cond: () => Promise<boolean>) {
  for (let i = 0; i < 150; i++) {
    await h.drainSteps();
    if (await cond()) return;
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error("condition not reached");
}

const integrateJobs = (h: Harness, proposalId: string) =>
  (h.runnerJobs as Array<{ signedJob: { job: { kind: string; proposalId?: string; checks: Array<{ checkId: string }>; contracts: unknown[] } } }>)
    .filter((m) => m.signedJob.job.kind === "integrate" && m.signedJob.job.proposalId === proposalId)
    .map((m) => m.signedJob.job);

const objectRow = (stagingId: string) => env.DB.prepare("SELECT state, accepted_at FROM lfs_objects WHERE staging_id = ?").bind(stagingId).first<{ state: string; accepted_at: string | null }>();
const head = async (h: Harness, o: Owner, rid: string) => (await h.api("GET", `/api/orgs/${o.orgId}/resources/${rid}`, { token: o.token })).body.head.revisionId as string;
const eventCount = async (action: string, subjectId: string) => (await env.DB.prepare("SELECT count(*) AS n FROM events WHERE action = ? AND subject_id = ?").bind(action, subjectId).first<{ n: number }>())!.n;
const proposalState = async (h: Harness, o: Owner, id: string) => (await h.api("GET", `/api/orgs/${o.orgId}/proposals/${id}`, { token: o.token })).body.state as string;

async function setPolicy(h: Harness, o: Owner, pid: string, policy: { checks?: unknown[]; approvalRoles: string[] }) {
  const r = await h.api("PUT", `/api/orgs/${o.orgId}/projects/${pid}/policy`, { token: o.token, body: { checks: policy.checks ?? [], contracts: [], rules: [], approvalRoles: policy.approvalRoles, publishRoles: ["owner"] } });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

const SITE_TEST = { checkId: "site-test", mountName: "site", command: "npm test", timeoutSeconds: 300, required: true };

async function developerWithWrite(h: Harness, o: Owner, pid: string) {
  const dev = await member(h, o, "developer");
  expect((await h.api("PUT", `/api/orgs/${o.orgId}/projects/${pid}/access`, { token: o.token, body: { userId: dev.userId, level: "write" } })).status).toBe(200);
  return { ...dev, orgId: o.orgId };
}

async function configBlob(h: Harness, o: Owner, pid: string) {
  const f = await h.api("GET", `/api/orgs/${o.orgId}/projects/${pid}/file?mount=site&path=config.json`, { token: o.token });
  expect(f.status).toBe(200);
  return f.headers.get("x-commonforge-blob")!;
}

describe("file changes land on their own", () => {
  it("content-only: integrated with no checks, accepted, the folder moves, the object is accepted and a client can download it", async () => {
    const { h, o, pid, site, base, runner } = await world();
    // a project check exists, but content never runs it
    await setPolicy(h, o, pid, { checks: [SITE_TEST], approvalRoles: ["owner"] });
    const client = await member(h, o, "client");
    expect((await h.api("PUT", `/api/orgs/${o.orgId}/projects/${pid}/access`, { token: o.token, body: { userId: client.userId, level: "read" } })).status).toBe(200);
    const vid = video();
    const oid = await sha256Hex(vid);
    const before = await head(h, o, site.resourceId);
    const a = await uploadFile(h, o, pid, "videos/demo.mp4", vid, { mime: "video/mp4" });
    // not accepted yet: the client gets 404 for the object
    expect(parse(await batch(h, base, client.token, "download", [{ oid, size: vid.length }])).objects[0].error.code).toBe(404);

    const r = await postChange(h, o.token, o.orgId, pid, { ops: [{ put: "videos/demo.mp4", stagingId: a }] });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    const c = await land(h, o, r.body.changeId);
    expect(runner.errors).toEqual([]);
    expect(c.state).toBe("added");
    expect(c).not.toHaveProperty("error");

    const jobs = integrateJobs(h, c.proposalId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.checks).toEqual([]);
    expect(jobs[0]!.contracts).toEqual([]);
    expect(await proposalState(h, o, c.proposalId)).toBe("accepted");
    expect(await head(h, o, site.resourceId)).not.toBe(before);
    const tree = await h.api("GET", `/api/orgs/${o.orgId}/projects/${pid}/tree?mount=site&path=videos`, { token: o.token });
    expect(tree.status).toBe(200);
    expect(tree.body.entries.map((e: { path: string }) => e.path)).toContain("videos/demo.mp4");
    expect((await objectRow(a))!.accepted_at).not.toBeNull();
    expect(await eventCount("files.change_added", r.body.changeId)).toBe(1);

    const d = parse(await batch(h, base, client.token, "download", [{ oid, size: vid.length }]));
    expect(d.objects[0].error).toBeUndefined();
    expect(d.objects[0].actions.download).toBeTruthy();
  });

  it("code: the integrate job carries the policy's checks; checking, then added; a failing check fails the change and the head stays", async () => {
    const { h, o, pid, site, runner } = await world();
    await setPolicy(h, o, pid, { checks: [SITE_TEST], approvalRoles: ["owner"] });
    runner.opts.hold = ["integrate"];
    const r = await postChange(h, o.token, o.orgId, pid, { ops: [{ edit: "config.json", content: '{ "title": "Demo 2" }\n', baseBlob: await configBlob(h, o, pid) }] });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    await pumpUntil(h, async () => (await getChange(h, o, r.body.changeId)).state === "checking");
    const c1 = await getChange(h, o, r.body.changeId);
    expect(integrateJobs(h, c1.proposalId).map((j) => j.checks.map((x) => x.checkId))).toEqual([["site-test"]]);
    runner.opts.hold = [];
    await runner.runPending();
    const c = await land(h, o, r.body.changeId);
    expect(runner.errors).toEqual([]);
    expect(c.state).toBe("added");
    const after = await head(h, o, site.resourceId);

    // the real runner fails a failing check (ok:false, check_failed)
    runner.opts.integrateFailure = { code: "check_failed", detail: "check site-test (npm test) exit 1" };
    runner.opts.failChecks = ["site-test"];
    const f = await postChange(h, o.token, o.orgId, pid, { ops: [{ edit: "config.json", content: "{}\n", baseBlob: await configBlob(h, o, pid) }] });
    const cf = await land(h, o, f.body.changeId);
    expect(cf.state).toBe("failed");
    expect(cf.error.code).toBe("check_failed");
    expect(await head(h, o, site.resourceId)).toBe(after);
    // its proposal is closed: nobody can accept it any more
    expect(await proposalState(h, o, cf.proposalId)).toBe("withdrawn");

    // a successful run whose evidence holds a failed check fails the same way
    runner.opts.integrateFailure = undefined;
    const g = await postChange(h, o.token, o.orgId, pid, { ops: [{ edit: "config.json", content: "{ }\n", baseBlob: await configBlob(h, o, pid) }] });
    const cg = await land(h, o, g.body.changeId);
    expect(cg.state).toBe("failed");
    expect(cg.error.code).toBe("check_failed");
    expect(await head(h, o, site.resourceId)).toBe(after);
  });

  it("a developer not listed in approvalRoles: waiting_approval until an owner approves and accepts", async () => {
    const { h, o, pid, runner } = await world();
    await setPolicy(h, o, pid, { approvalRoles: ["owner"] });
    const dev = await developerWithWrite(h, o, pid);
    const a = await uploadFile(h, dev, pid, "videos/demo.mp4", video());
    const r = await postChange(h, dev.token, o.orgId, pid, { ops: [{ put: "videos/demo.mp4", stagingId: a }] });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    const c = await land(h, o, r.body.changeId);
    expect(runner.errors).toEqual([]);
    expect(c.state).toBe("waiting_approval");
    expect((await objectRow(a))!.accepted_at).toBeNull();
    // no approval was recorded for the developer
    const p = (await h.api("GET", `/api/orgs/${o.orgId}/proposals/${c.proposalId}`, { token: o.token })).body;
    expect(p.approvals).toEqual([]);

    expect((await h.api("POST", `/api/orgs/${o.orgId}/proposals/${c.proposalId}/approvals`, { token: o.token, body: { proposalHash: p.proposalHash } })).status).toBe(201);
    const acc = await h.api("POST", `/api/orgs/${o.orgId}/proposals/${c.proposalId}/accept`, { token: o.token, body: { idempotencyKey: "fc-human-accept" } });
    expect(acc.status, JSON.stringify(acc.body)).toBe(200);
    expect((await getChange(h, o, r.body.changeId)).state).toBe("added");
    expect((await objectRow(a))!.accepted_at).not.toBeNull();
  });

  it("a developer listed in approvalRoles: the upload is added on its own", async () => {
    const { h, o, pid, runner } = await world();
    await setPolicy(h, o, pid, { approvalRoles: ["owner", "developer"] });
    const dev = await developerWithWrite(h, o, pid);
    const a = await uploadFile(h, dev, pid, "videos/demo.mp4", video());
    const r = await postChange(h, dev.token, o.orgId, pid, { ops: [{ put: "videos/demo.mp4", stagingId: a }] });
    const c = await land(h, o, r.body.changeId);
    expect(runner.errors).toEqual([]);
    expect(c.state).toBe("added");
    const approvals = (await h.api("GET", `/api/orgs/${o.orgId}/proposals/${c.proposalId}/approvals`, { token: o.token })).body.approvals;
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ role: "developer", approver: { id: dev.userId } });
    expect(approvals[0].approvalId).toMatch(/^apr-fc-[0-9a-f]{32}$/);
  });

  it("a revoked write grant at accept fails the change with no_write_grant", async () => {
    const { h, o, pid, runner } = await world();
    await setPolicy(h, o, pid, { approvalRoles: ["owner", "developer"] });
    const dev = await developerWithWrite(h, o, pid);
    runner.opts.hold = ["integrate"];
    const a = await uploadFile(h, dev, pid, "videos/demo.mp4", video());
    const r = await postChange(h, dev.token, o.orgId, pid, { ops: [{ put: "videos/demo.mp4", stagingId: a }] });
    await pumpUntil(h, async () => (await getChange(h, o, r.body.changeId)).state === "checking");
    expect((await h.api("PUT", `/api/orgs/${o.orgId}/projects/${pid}/access`, { token: o.token, body: { userId: dev.userId, level: "read" } })).status).toBe(200);
    runner.opts.hold = [];
    await runner.runPending();
    const c = await land(h, o, r.body.changeId);
    expect(c.state).toBe("failed");
    expect(c.error.code).toBe("no_write_grant");
    expect((await objectRow(a))!.accepted_at).toBeNull();
  });
});

describe("file changes: a stale base", () => {
  /** A and B apply on the same base; A's integration runs (and lands) first, then B's. */
  async function race(opsB: (h: Harness, o: Owner, pid: string) => Promise<unknown[]>) {
    const w = await world();
    const { h, o, pid, runner } = w;
    runner.opts.hold = ["integrate"];
    const a = await uploadFile(h, o, pid, "videos/a.mp4", video(1));
    const b = await uploadFile(h, o, pid, "videos/b.mp4", video(2));
    const ra = await postChange(h, o.token, o.orgId, pid, { ops: [{ put: "videos/a.mp4", stagingId: a }] });
    const rb = await postChange(h, o.token, o.orgId, pid, { ops: [{ put: "videos/b.mp4", stagingId: b }, ...(await opsB(h, o, pid))] });
    const A = ra.body.changeId as string;
    const B = rb.body.changeId as string;
    await pumpUntil(h, async () => (await getChange(h, o, A)).state === "checking" && (await getChange(h, o, B)).state === "checking");
    const pa = (await getChange(h, o, A)).proposalId as string;
    const pb = (await getChange(h, o, B)).proposalId as string;
    expect(await runner.runWhere((j) => j.kind === "integrate" && j.proposalId === pa)).toBe(1);
    await pumpUntil(h, async () => (await getChange(h, o, A)).state === "added");
    runner.opts.hold = [];
    await runner.runPending();
    return { ...w, A, B, pb };
  }

  it("uploads re-apply on the new head (attempt 2) and land; both files are in the folder", async () => {
    const { h, o, pid, A, B, pb, runner } = await race(async () => []);
    const cb = await land(h, o, B);
    expect(runner.errors).toEqual([]);
    expect(cb.state).toBe("added");
    expect(cb.attempt).toBe(2);
    expect((await getChange(h, o, A)).attempt).toBe(1);
    // the first attempt's proposal was superseded
    expect(await proposalState(h, o, pb)).toBe("superseded");
    expect(cb.proposalId).not.toBe(pb);
    const tree = await h.api("GET", `/api/orgs/${o.orgId}/projects/${pid}/tree?mount=site&path=videos`, { token: o.token });
    expect(tree.body.entries.map((e: { path: string }) => e.path).sort()).toEqual(["videos/a.mp4", "videos/b.mp4"]);
  });

  it("a change with an edit fails file_changed", async () => {
    const { h, o, B, pb } = await race(async (h, o, pid) => [{ edit: "config.json", content: "{}\n", baseBlob: await configBlob(h, o, pid) }]);
    const cb = await land(h, o, B);
    expect(cb.state).toBe("failed");
    expect(cb.error.code).toBe("file_changed");
    expect(cb.attempt).toBe(1);
    expect(await proposalState(h, o, pb)).toBe("withdrawn");
  });
});

describe("file changes: fix round 1", () => {
  it("R6: with no policy, a developer's upload waits for an approval; an owner's lands", async () => {
    const { h, o, pid, runner } = await world();
    const dev = await developerWithWrite(h, o, pid);
    const d = await postChange(h, dev.token, o.orgId, pid, { ops: [{ put: "videos/dev.mp4", stagingId: await uploadFile(h, dev, pid, "videos/dev.mp4", video(1)) }] });
    const cd = await land(h, o, d.body.changeId);
    expect(cd.state).toBe("waiting_approval");
    expect((await h.api("GET", `/api/orgs/${o.orgId}/proposals/${cd.proposalId}/approvals`, { token: o.token })).body.approvals).toEqual([]);
    const w = await postChange(h, o.token, o.orgId, pid, { ops: [{ put: "videos/own.mp4", stagingId: await uploadFile(h, o, pid, "videos/own.mp4", video(2)) }] });
    expect((await land(h, o, w.body.changeId)).state).toBe("added");
    expect(runner.errors).toEqual([]);
  });

  it("an accept that committed before its landing tail ran is finished by the retry, and by a read", async () => {
    const { h, o, pid, runner } = await world();
    h.envOverrides.COMMONFORGE_CHAOS = "after_file_change_accept_before_landing";
    const a = await uploadFile(h, o, pid, "videos/demo.mp4", video());
    const r = await postChange(h, o.token, o.orgId, pid, { ops: [{ put: "videos/demo.mp4", stagingId: a }] });
    const c = await land(h, o, r.body.changeId);
    expect(runner.errors).toEqual([]);
    expect(c.state).toBe("added");
    expect(await proposalState(h, o, c.proposalId)).toBe("accepted");
    expect((await objectRow(a))!.accepted_at).not.toBeNull();
    expect(await eventCount("files.change_added", r.body.changeId)).toBe(1);
    delete h.envOverrides.COMMONFORGE_CHAOS;

    // the same state found by a read: still checking (or waiting) with an accepted proposal
    await env.DB.prepare("UPDATE file_changes SET state = 'checking' WHERE change_id = ?").bind(r.body.changeId).run();
    await env.DB.prepare("UPDATE lfs_objects SET accepted_at = NULL WHERE staging_id = ?").bind(a).run();
    expect((await getChange(h, o, r.body.changeId)).state).toBe("added");
    expect((await objectRow(a))!.accepted_at).not.toBeNull();
  });

  /** A developer's change waiting for an approval, then an owner's change lands first (the head moves). */
  async function waitingThenMoved(devOps: (h: Harness, dev: Owner, pid: string) => Promise<unknown[]>) {
    const w = await world();
    const { h, o, pid } = w;
    const dev = await developerWithWrite(h, o, pid);
    const d = await postChange(h, dev.token, o.orgId, pid, { ops: await devOps(h, dev, pid) });
    expect(d.status, JSON.stringify(d.body)).toBe(202);
    const cd = await land(h, o, d.body.changeId);
    expect(cd.state).toBe("waiting_approval");
    const own = await postChange(h, o.token, o.orgId, pid, { ops: [{ put: "videos/own.mp4", stagingId: await uploadFile(h, o, pid, "videos/own.mp4", video(2)) }] });
    expect((await land(h, o, own.body.changeId)).state).toBe("added");
    return { ...w, dev, changeId: d.body.changeId as string, proposalId: cd.proposalId as string };
  }
  const row = (id: string) => env.DB.prepare("SELECT state, attempt, error_code FROM file_changes WHERE change_id = ?").bind(id).first<{ state: string; attempt: number; error_code: string | null }>();

  it("a change waiting for an approval whose base moved re-applies when it is read; with an edit it fails file_changed", async () => {
    const up = await waitingThenMoved(async (h, dev, pid) => [{ put: "videos/dev.mp4", stagingId: await uploadFile(h, dev, pid, "videos/dev.mp4", video(1)) }]);
    expect((await row(up.changeId))!.attempt).toBe(1);
    const read = await getChange(up.h, up.o, up.changeId);
    expect(read.attempt).toBe(2);
    expect(await proposalState(up.h, up.o, up.proposalId)).toBe("superseded");
    const again = await land(up.h, up.o, up.changeId);
    expect(again).toMatchObject({ state: "waiting_approval", attempt: 2 });

    const ed = await waitingThenMoved(async (h, dev, pid) => [{ edit: "config.json", content: "{}\n", baseBlob: await configBlob(h, dev, pid) }]);
    const failed = await getChange(ed.h, ed.o, ed.changeId);
    expect(failed.state).toBe("failed");
    expect(failed.error.code).toBe("file_changed");
    expect(await proposalState(ed.h, ed.o, ed.proposalId)).toBe("withdrawn");
  });

  it("a person's accept refused for a moved head (409) re-applies the change", async () => {
    const { h, o, changeId, proposalId } = await waitingThenMoved(async (h, dev, pid) => [{ put: "videos/dev.mp4", stagingId: await uploadFile(h, dev, pid, "videos/dev.mp4", video(1)) }]);
    const p = (await h.api("GET", `/api/orgs/${o.orgId}/proposals/${proposalId}`, { token: o.token })).body;
    expect((await h.api("POST", `/api/orgs/${o.orgId}/proposals/${proposalId}/approvals`, { token: o.token, body: { proposalHash: p.proposalHash } })).status).toBe(201);
    const acc = await h.api("POST", `/api/orgs/${o.orgId}/proposals/${proposalId}/accept`, { token: o.token, body: { idempotencyKey: "fc-stale-accept" } });
    expect([acc.status, acc.body.error.code]).toEqual([409, "expected_head_stale"]);
    // read from the table (a GET would run the read sweep, which does the same)
    expect(await row(changeId)).toMatchObject({ state: "applying", attempt: 2 });
    expect((await land(h, o, changeId)).attempt).toBe(2);
  });
});

describe("file changes: delivery and recovery", () => {
  it("files.accept delivered twice accepts once", async () => {
    const { h, o, pid, runner } = await world();
    runner.opts.hold = ["integrate"];
    const a = await uploadFile(h, o, pid, "videos/demo.mp4", video());
    const r = await postChange(h, o.token, o.orgId, pid, { ops: [{ put: "videos/demo.mp4", stagingId: a }] });
    await pumpUntil(h, async () => (await getChange(h, o, r.body.changeId)).state === "checking");
    runner.opts.hold = [];
    await runner.runPending();
    // the integrate applier enqueued files.accept
    await waitUntil(async () => (h.steps as Array<{ type: string }>).some((s) => s.type === "files.accept"));
    const msg = (h.steps as Array<{ type: string }>).find((s) => s.type === "files.accept")!;
    h.steps.splice(h.steps.indexOf(msg), 1);
    const out = await h.deliver("commonforge-steps", [msg, msg]);
    expect(out.acked).toHaveLength(2);
    await h.deliver("commonforge-steps", [msg]);
    const c = await getChange(h, o, r.body.changeId);
    expect(c.state).toBe("added");
    expect(await eventCount("proposal.accepted", c.proposalId)).toBe(1);
    expect(await eventCount("files.change_added", r.body.changeId)).toBe(1);
    expect((await objectRow(a))!.accepted_at).not.toBeNull();
  });

  it("a change whose step was lost is picked up again when it is read", async () => {
    const { h, o, pid, runner } = await world();
    const backdate = (id: string) => env.DB.prepare("UPDATE file_changes SET updated_at = ? WHERE change_id = ?").bind(new Date(Date.now() - 10 * 60_000).toISOString(), id).run();
    // files.apply lost: applying, no job
    const r1 = await postChange(h, o.token, o.orgId, pid, { ops: [{ delete: "index.html" }] });
    h.steps.splice(0, h.steps.length);
    await backdate(r1.body.changeId);
    expect((await getChange(h, o, r1.body.changeId)).state).toBe("applying");
    expect((h.steps as Array<{ type: string }>).map((s) => s.type)).toEqual(["files.apply"]);
    expect((await land(h, o, r1.body.changeId)).state).toBe("added");

    // files.candidate lost: a receipt with a candidate, no proposal
    runner.opts.hold = ["apply-files"];
    const r2 = await postChange(h, o.token, o.orgId, pid, { ops: [{ delete: "config.json" }] });
    await h.drainSteps();
    runner.opts.hold = [];
    await runner.runPending();
    expect((h.steps as Array<{ type: string }>).map((s) => s.type)).toEqual(["files.candidate"]);
    h.steps.splice(0, h.steps.length);
    await backdate(r2.body.changeId);
    expect((await getChange(h, o, r2.body.changeId)).proposalId).toBeNull();
    expect((h.steps as Array<{ type: string }>).map((s) => s.type)).toEqual(["files.candidate"]);
    expect((await land(h, o, r2.body.changeId)).state).toBe("added");
    expect(runner.errors).toEqual([]);
  });
});

describe("agent task proposals promote their LFS objects", () => {
  it("accepting an agent's proposal accepts its task's verified objects, and one verified after the accept", async () => {
    const h = harness();
    const { o, web, taskId } = await provisionedTask(h);
    const base = `/api/lfs/${o.orgId}/${web.resourceId}/info/lfs`;
    const agent = (await h.api("POST", `/api/tasks/${taskId}/lease`, { token: o.token, body: {} })).body.leaseToken as string;

    // one object verified now, one whose hash step runs only after the accept
    const upload = async (bytes: Uint8Array, hash: boolean) => {
      const oid = await sha256Hex(bytes);
      const b = parse(await batch(h, base, agent, "upload", [{ oid, size: bytes.length }])).objects[0];
      const href = new URL(b.actions.upload.href);
      await env.COMMONFORGE_ASSETS.put(decodeURIComponent(href.pathname.split("/").slice(2).join("/")), bytes);
      const v = await h.api("POST", new URL(b.actions.verify.href).pathname, { headers: { ...b.actions.verify.header, "content-type": LFS_TYPE }, raw: JSON.stringify({ oid, size: bytes.length }) });
      expect(v.status).toBe(200);
      const stagingId = (await env.DB.prepare("SELECT staging_id FROM lfs_objects WHERE org_id = ? AND claimed_oid = ? AND task_id = ?").bind(o.orgId, oid, taskId).first<{ staging_id: string }>())!.staging_id;
      if (hash) await h.drainSteps();
      return stagingId;
    };
    const now = await upload(text("agent asset one"), true);
    const later = await upload(text("agent asset two"), false);
    expect((await objectRow(now))!.state).toBe("verified");
    // hold back the second object's hash step
    const hashStep = (h.steps as Array<{ type: string; stagingId?: string }>).find((s) => s.type === "lfs.hash" && s.stagingId === later)!;
    expect(hashStep).toBeTruthy();
    h.steps.splice(h.steps.indexOf(hashStep), 1);
    expect((await objectRow(later))!.state).toBe("uploaded");

    const { proposal } = await freezeAndPropose(h, o, taskId, { "index.html": "v2" });
    const p = await prepareAndIntegrate(h, o, proposal.proposalId);
    expect((await h.api("POST", `/api/orgs/${o.orgId}/proposals/${p.proposalId}/approvals`, { token: o.token, body: { proposalHash: p.proposalHash } })).status).toBe(201);
    expect((await objectRow(now))!.accepted_at).toBeNull();
    const acc = await h.api("POST", `/api/orgs/${o.orgId}/proposals/${p.proposalId}/accept`, { token: o.token, body: { idempotencyKey: "agent-lfs-accept" } });
    expect(acc.status, JSON.stringify(acc.body)).toBe(200);
    expect((await objectRow(now))!.accepted_at).not.toBeNull();
    expect((await env.DB.prepare("SELECT count(*) AS n FROM lfs_task_promotions WHERE task_id = ? AND resource_id = ?").bind(taskId, web.resourceId).first<{ n: number }>())!.n).toBe(1);

    await h.deliver("commonforge-steps", [hashStep]);
    const row = await objectRow(later);
    expect(row!.state).toBe("verified");
    expect(row!.accepted_at).not.toBeNull();
    // the accepted object is served
    expect(parse(await batch(h, base, o.token, "download", [{ oid: await sha256Hex(text("agent asset two")), size: 15 }])).objects[0].actions.download).toBeTruthy();
  });
});

describe("file changes: final review fixes", () => {
  it("I2: a change putting 200 objects lands and promotes all of them (chunked statements)", async () => {
    const { h, o, site, pid, runner } = await world();
    // 200 verified binary uploads of the owner (as the hash step leaves them; the runner never fetches them)
    const now = new Date().toISOString();
    const ids = Array.from({ length: 200 }, (_, i) => `lfs-${String(i).padStart(24, "0")}`);
    const stmts = ids.map((id, i) =>
      env.DB.prepare("INSERT INTO lfs_objects (staging_id, org_id, resource_id, r2_key, size, sha256, binary, etag, state, source, user_id, created_at, updated_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, 1, 'e', 'verified', 'browser', ?, ?, ?, ?)")
        .bind(id, o.orgId, site.resourceId, `org/${o.orgId}/lfs/${site.resourceId}/obj/${id}`, 2_000_000 + i, i.toString(16).padStart(64, "0"), o.userId, now, now, now),
    );
    for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
    const r = await postChange(h, o.token, o.orgId, pid, { ops: ids.map((stagingId, i) => ({ put: `media/clip-${i}.mov`, stagingId })) });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    const c = await land(h, o, r.body.changeId);
    expect(runner.errors).toEqual([]);
    expect(c.state).toBe("added");
    const accepted = await env.DB.prepare("SELECT count(*) AS n FROM lfs_objects WHERE org_id = ? AND accepted_at IS NOT NULL").bind(o.orgId).first<{ n: number }>();
    expect(accepted!.n).toBe(200);
  });

  it("I3 (R7): replacing a code file with a big binary upload is a code change and runs the policy checks; replacing it again (now LFS) is content", async () => {
    const { h, o, pid, runner } = await world();
    await setPolicy(h, o, pid, { checks: [SITE_TEST], approvalRoles: ["owner"] });
    const a = await uploadFile(h, o, pid, "index.html", video(1));
    const r = await postChange(h, o.token, o.orgId, pid, { ops: [{ put: "index.html", stagingId: a }] });
    const c = await land(h, o, r.body.changeId);
    expect(runner.errors).toEqual([]);
    expect(c.state).toBe("added");
    expect(c.changedPaths.find((p: { path: string }) => p.path === "index.html")).toEqual({ path: "index.html", change: "modified", lfs: true, class: "code" });
    expect(integrateJobs(h, c.proposalId).map((j) => j.checks.map((x) => x.checkId))).toEqual([["site-test"]]);
    // the base is an LFS pointer now: replacing it is content (no checks)
    const b = await uploadFile(h, o, pid, "index.html", video(2));
    const r2 = await postChange(h, o.token, o.orgId, pid, { ops: [{ put: "index.html", stagingId: b }] });
    const c2 = await land(h, o, r2.body.changeId);
    expect(c2.state).toBe("added");
    expect(c2.changedPaths.find((p: { path: string }) => p.path === "index.html")).toEqual({ path: "index.html", change: "modified", lfs: true, class: "content" });
    expect(integrateJobs(h, c2.proposalId).map((j) => j.checks)).toEqual([[]]);
  });

  it("R8: a policy changed before the accept re-applies the change (an edit too) under the new policy and lands", async () => {
    const { h, o, pid, runner } = await world();
    await setPolicy(h, o, pid, { approvalRoles: ["owner"] });
    runner.opts.hold = ["integrate"];
    const a = await uploadFile(h, o, pid, "videos/demo.mp4", video());
    const r = await postChange(h, o.token, o.orgId, pid, { ops: [{ put: "videos/demo.mp4", stagingId: a }, { edit: "config.json", content: "{}\n", baseBlob: await configBlob(h, o, pid) }] });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    await pumpUntil(h, async () => (await getChange(h, o, r.body.changeId)).state === "checking");
    const first = (await getChange(h, o, r.body.changeId)).proposalId as string;
    // the policy changes while the change is being checked (its proposal carries the old revision)
    await setPolicy(h, o, pid, { checks: [SITE_TEST], approvalRoles: ["owner"] });
    runner.opts.hold = [];
    await runner.runPending();
    const c = await land(h, o, r.body.changeId);
    expect(runner.errors).toEqual([]);
    expect(c).toMatchObject({ state: "added", attempt: 2 });
    expect(await proposalState(h, o, first)).toBe("superseded");
    // the second attempt ran under the new policy: its checks
    expect(integrateJobs(h, c.proposalId).map((j) => j.checks.map((x) => x.checkId))).toEqual([["site-test"]]);
    expect((await h.api("GET", `/api/orgs/${o.orgId}/projects/${pid}/file?mount=site&path=config.json`, { token: o.token })).body).toEqual({}); // the edit landed (parsed as JSON)
  });

  it("R8: a person's accept refused policy_revision_stale (409) re-applies a waiting change, an edit too", async () => {
    const { h, o, pid } = await world();
    const dev = await developerWithWrite(h, o, pid);
    const d = await postChange(h, dev.token, o.orgId, pid, { ops: [{ edit: "config.json", content: "{}\n", baseBlob: await configBlob(h, o, pid) }] });
    const cd = await land(h, o, d.body.changeId);
    expect(cd.state).toBe("waiting_approval");
    await setPolicy(h, o, pid, { approvalRoles: ["owner"] });
    const p = (await h.api("GET", `/api/orgs/${o.orgId}/proposals/${cd.proposalId}`, { token: o.token })).body;
    expect((await h.api("POST", `/api/orgs/${o.orgId}/proposals/${cd.proposalId}/approvals`, { token: o.token, body: { proposalHash: p.proposalHash } })).status).toBe(201);
    const acc = await h.api("POST", `/api/orgs/${o.orgId}/proposals/${cd.proposalId}/accept`, { token: o.token, body: { idempotencyKey: "fc-policy-accept" } });
    expect([acc.status, acc.body.error.code]).toEqual([409, "policy_revision_stale"]);
    expect(await env.DB.prepare("SELECT state, attempt FROM file_changes WHERE change_id = ?").bind(d.body.changeId).first()).toEqual({ state: "applying", attempt: 2 });
    expect(await land(h, o, d.body.changeId)).toMatchObject({ state: "waiting_approval", attempt: 2 });
  });
});

describe("file changes in a staging-mode project (M7, ruling R9; through promotion)", { timeout: 60_000 }, () => {
  const landingOfTask = async (orgId: string, taskId: string) =>
    env.DB.prepare("SELECT landing_id, state FROM staging_landings WHERE org_id = ? AND task_id = ? ORDER BY seq DESC LIMIT 1").bind(orgId, taskId).first<{ landing_id: string; state: string }>();
  const taskOf = async (changeId: string) => (await env.DB.prepare("SELECT task_id FROM file_changes WHERE change_id = ?").bind(changeId).first<{ task_id: string }>())!.task_id;

  // staging-mode changes go through promotion (api/file-changes-staged.test.ts); these are the edges
  const staged = async (f: Awaited<ReturnType<typeof stagingFixture>>, content: string) => {
    const r = await f.h.api("POST", `/api/orgs/${f.o.orgId}/projects/${f.pid}/folders/api/changes`, { token: f.o.token, body: { ops: [{ edit: "src/footer.ts", content, baseBlob: "" }] } });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    await f.until(async () => (await getFileChange(f.svc, r.body.changeId))?.state === "staged", 15_000);
    const t = await taskOf(r.body.changeId);
    await f.landingIdOf(t);
    await f.untilLanded(t);
    return { changeId: r.body.changeId as string, t };
  };

  it("an edit is staged like a frozen agent task: its landing is live, no proposal of its own, main unchanged; a staged change never restarts", async () => {
    const f = await stagingFixture();
    const runner = new FakeRunner(f.h);
    const { changeId, t } = await staged(f, "export const footer = 'new';\n");
    expect((await landingOfTask(f.o.orgId, t))!.state).toBe("landed");
    expect(await getChange(f.h, f.o, changeId)).toMatchObject({ state: "staged", proposalId: null, attempt: 1 });
    expect(await f.headSha()).toBe(f.initialHeadSha);
    expect(runner.handled.map((j) => j.job.kind)).toEqual(expect.arrayContaining(["apply-files", "prepare-candidate", "staging-build"]));
    expect(runner.handled.map((j) => j.job.kind)).not.toContain("integrate");
    // a stale base or a changed policy restarts nothing (its promotion rebuilds on a moved main)
    await restartAttempt(f.svc, (await getFileChange(f.svc, changeId))!);
    expect(await getFileChange(f.svc, changeId)).toMatchObject({ state: "staged", attempt: 1, task_id: t });
    expect((await landingOfTask(f.o.orgId, t))!.state).toBe("landed");
    expect(runner.errors).toEqual([]);
  });

  it("P3-6: a staged change that fails takes its landing out of staging; the rollback does not fail it again", async () => {
    const f = await stagingFixture();
    const runner = new FakeRunner(f.h);
    const { changeId, t } = await staged(f, "export const footer = 'x';\n");
    await failChange(f.svc, (await getFileChange(f.svc, changeId))!, "job_expired", "late");
    expect(["rolling_back", "rolled_back"]).toContain((await landingOfTask(f.o.orgId, t))!.state);
    await f.until(async () => (await landingOfTask(f.o.orgId, t))!.state === "rolled_back", 15_000);
    // the rolled-back landing's hook found the change failed already: its first code stays
    expect(await getFileChange(f.svc, changeId)).toMatchObject({ state: "failed", error_code: "job_expired" });
    expect(await eventCount("files.change_failed", changeId)).toBe(1);
    expect(runner.errors).toEqual([]);
  });

  it("P3-6: a change that fails before it ever landed (no task) fails as before, in a staging-mode project", async () => {
    const f = await stagingFixture();
    new FakeRunner(f.h);
    const r = await f.h.api("POST", `/api/orgs/${f.o.orgId}/projects/${f.pid}/folders/api/changes`, { token: f.o.token, body: { ops: [{ edit: "src/footer.ts", content: "x\n", baseBlob: "" }] } });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    const row = (await getFileChange(f.svc, r.body.changeId))!;
    expect(row.task_id).toBeNull();
    await failChange(f.svc, row, "folder_missing", "the folder is no longer part of this project");
    expect((await getFileChange(f.svc, r.body.changeId))).toMatchObject({ state: "failed", error_code: "folder_missing" });
  });
});
