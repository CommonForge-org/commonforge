/**
 * Staging phase 2, Task 8: a cleared promotion is accepted into `main` with its clearance and
 * released to production (clearance publish approval, migrations first), as the promotion service
 * on behalf of the clearer; landings become `promoted` at accept (R10) and staging drops them; a
 * failed release is retried by an owner or developer, or goes live with any later production
 * release that contains it. A clearance publishes only what promotions cleared (review C1).
 */
import { describe, expect, it } from "vitest";
import { userRef } from "../../src/services/events.js";
import { acceptInputFor } from "../../src/services/proposals.js";
import { getLive, getRelease, validPublishApproval } from "../../src/services/releases.js";
import { FakeRunner } from "../fakes/runner.js";
import { codeResource, prepareAndIntegrate, projectWith } from "../helpers.js";
import { DONE_STATES, RELEASE_STAGING, releaseFixture } from "../promotion-helpers.js";
import { productionFixture, stagingReleasePolicy, type StagingFixture } from "../staging-helpers.js";

const STAGING = RELEASE_STAGING;
const RELEASE_FAILED = "The production update did not go live. Production still runs the previous version.";
const NEEDS_APPROVAL = "Production has other changes waiting for an owner's approval.";

describe("promotions: accept and release", { timeout: 180_000 }, () => {
  it("a client's copy task goes live with clearance:self, run by the promotion service; the client can call no release route", async () => {
    const { f, runner, client, ledger, promote, view, untilState, landTask, landing, mainFiles, approvals, eventRows, stagingSettled, newestBuild } = await releaseFixture();
    const taskId = await landTask(client.token, "Copy", { "public/index.html": "<h1>Welcome</h1>\n" });
    const before = await landing(taskId);
    const candidateId = (await ledger.getProposal(before.proposal_id))!.resourceChanges[0]!.candidateId;
    const r = await promote(client.token, taskId);
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    const p = await untilState(r.body.promotionId, ...DONE_STATES);
    expect(p).toMatchObject({ state: "live", level: "self", clearance_kind: "self", cleared_by: client.userId, reason_code: null });
    expect(p.accepted_version_id).toBeTruthy();
    // main has the task's change (R10: the landing is promoted at accept)
    expect((await mainFiles())["public/index.html"]).toBe("<h1>Welcome</h1>\n");
    expect((await landing(taskId)).state).toBe("promoted");
    expect((await ledger.getProposal(p.proposal_id!))!.state).toBe("accepted");
    expect((await ledger.getProposal(before.proposal_id))!.state).toBe("superseded");
    expect((await ledger.getCandidate(candidateId))!.state).toBe("accepted");
    // the production release: prepared and deployed by the promotion service on behalf of the client
    const rel = (await getRelease(f.svc, f.o.orgId, p.release_id!))!;
    expect(rel).toMatchObject({ channel: "production", state: "live", accepted_version_id: p.accepted_version_id, created_by: client.userId });
    expect(await approvals(rel.release_id)).toEqual([{ role: "clearance:self", approver: client.userId }]);
    expect((await getLive(f.svc, f.o.orgId, f.pid))!.release_id).toBe(rel.release_id);
    const deployed = await eventRows("release.deploy_requested", rel.release_id);
    expect(JSON.parse(deployed[0]!.actor_json)).toEqual({ kind: "service", id: "promotion-service", onBehalfOf: { kind: "user", id: client.userId } });
    // once live, the clearance no longer authorizes a publish of that release
    expect(await validPublishApproval(f.svc, rel)).toBeNull();
    // staging drops the promoted landing: the next build runs on the new main without it
    await stagingSettled();
    const b = await newestBuild();
    expect(b.state).toBe("live");
    expect(JSON.parse(b.landings_json)).not.toContain(before.landing_id);
    // events: clients read codes only; the release events say production
    const accepted = await eventRows("promotion.accepted", p.promotion_id);
    expect(accepted).toHaveLength(1);
    expect(JSON.parse(accepted[0]!.client_detail_json!)).toEqual({ promotionId: p.promotion_id, code: "accepted" });
    const live = await eventRows("promotion.live", p.promotion_id);
    expect(JSON.parse(live[0]!.client_detail_json!)).toEqual({ promotionId: p.promotion_id, code: "live" });
    expect(JSON.parse(live[0]!.detail_json!)).toMatchObject({ channel: "production", releaseId: rel.release_id });
    // the client's view: the state, no release internals
    const v = await view(client.token, p.promotion_id);
    expect(v.body).toMatchObject({ state: "live" });
    expect(v.body.releaseId).toBeUndefined();
    expect((await view(f.o.token, p.promotion_id)).body).toMatchObject({ releaseId: rel.release_id, acceptedVersionId: p.accepted_version_id });
    // the client cannot prepare, approve or deploy a release itself
    expect((await f.h.api("POST", `/api/orgs/${f.o.orgId}/projects/${f.pid}/releases`, { token: client.token, body: {} })).status).toBe(403);
    expect([403, 404]).toContain((await f.h.api("POST", `/api/orgs/${f.o.orgId}/releases/${rel.release_id}/publish-approvals`, { token: client.token, body: { outputDigest: rel.output_digest } })).status);
    expect((await f.h.api("POST", `/api/orgs/${f.o.orgId}/releases/${rel.release_id}/deploy`, { token: client.token, body: { idempotencyKey: "client-deploy-1" } })).status).toBe(403);
    expect((await f.h.api("POST", `/api/orgs/${f.o.orgId}/promotions/${p.promotion_id}/retry-release`, { token: client.token, body: {} })).status).toBe(403);
    expect(runner.errors).toEqual([]);
  });

  it("an API task goes live after a developer's approval, with a clearance:developer publish approval", async () => {
    const { f, client, promote, approve, untilState, landTask, mainFiles, approvals } = await releaseFixture();
    const dev = await f.memberWithAccess("developer");
    const taskId = await landTask(client.token, "API", { "src/contacts.ts": "export const contacts = [];\n" });
    const id = (await promote(client.token, taskId)).body.promotionId as string;
    await untilState(id, "pending_approval");
    expect((await approve(dev.token, id)).status).toBe(200);
    const p = await untilState(id, ...DONE_STATES);
    expect(p).toMatchObject({ state: "live", clearance_kind: "developer", cleared_by: dev.userId });
    expect(await approvals(p.release_id!)).toEqual([{ role: "clearance:developer", approver: dev.userId }]);
    expect((await mainFiles())["src/contacts.ts"]).toBe("export const contacts = [];\n");
  });

  it("a release that fails its health check is release_failed (main keeps the change); a developer retries it to live", async () => {
    const { f, runner, client, promote, view, retry, untilState, landTask, landing, mainFiles } = await releaseFixture();
    const dev = await f.memberWithAccess("developer", "write");
    const taskId = await landTask(client.token, "Copy", { "public/index.html": "<h1>Hi</h1>\n" });
    runner.opts.deployWithoutActivating = true;
    const id = (await promote(client.token, taskId)).body.promotionId as string;
    const p = await untilState(id, ...DONE_STATES);
    expect(p).toMatchObject({ state: "release_failed", reason: RELEASE_FAILED });
    expect(p.detail).toBeTruthy();
    expect((await landing(taskId)).state).toBe("promoted");
    expect((await mainFiles())["public/index.html"]).toBe("<h1>Hi</h1>\n");
    const cv = await view(client.token, id);
    expect(cv.body).toMatchObject({ state: "release_failed", reason: RELEASE_FAILED });
    expect(cv.body.detail).toBeUndefined();
    expect((await getLive(f.svc, f.o.orgId, f.pid))?.release_id).not.toBe(p.release_id);
    // release_failed is not in flight: another promotion could start meanwhile
    expect((await retry(client.token, id)).status).toBe(403);
    // a developer without write on what the release deploys cannot retry it (review I1)
    const reader = await f.memberWithAccess("developer", "read");
    const refused = await retry(reader.token, id);
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("no_write_grant");
    runner.opts.deployWithoutActivating = false;
    const rr = await retry(dev.token, id);
    expect(rr.status, JSON.stringify(rr.body)).toBe(200);
    expect(rr.body.state).toBe("releasing");
    const after = await untilState(id, ...DONE_STATES);
    expect(after).toMatchObject({ state: "live", reason: null });
    expect((await getLive(f.svc, f.o.orgId, f.pid))!.release_id).toBe(after.release_id);
    // retrying a live promotion is refused
    expect((await retry(dev.token, id)).status).toBe(409);
  });

  it("retry-release after a later promotion was accepted prepares the latest version (all cleared); the later failed one goes live with it", async () => {
    const { f, runner, client, promote, retry, untilState, landTask } = await releaseFixture();
    const dev = await f.memberWithAccess("developer", "write");
    const a = await landTask(client.token, "A", { "public/a.html": "a\n" });
    const b = await landTask(client.token, "B", { "public/b.html": "b\n" });
    runner.opts.deployWithoutActivating = true;
    const ida = (await promote(client.token, a)).body.promotionId as string;
    const pa = await untilState(ida, ...DONE_STATES);
    expect(pa.state).toBe("release_failed");
    const idb = (await promote(client.token, b)).body.promotionId as string;
    const pb = await untilState(idb, ...DONE_STATES);
    expect(pb.state).toBe("release_failed");
    expect(pb.accepted_version_id).not.toBe(pa.accepted_version_id);
    runner.opts.deployWithoutActivating = false;
    expect((await retry(dev.token, ida)).status).toBe(200);
    const la = await untilState(ida, ...DONE_STATES);
    expect(la.state).toBe("live");
    // A's pinned version is stale (B was accepted after it): the fresh prepare releases the latest, which has both
    const rel = (await getRelease(f.svc, f.o.orgId, la.release_id!))!;
    expect(rel.accepted_version_id).toBe(pb.accepted_version_id);
    expect(await untilState(idb, "live")).toMatchObject({ release_id: la.release_id, reason_code: null });
  });

  it("a release_failed promotion is live when a later promotion of the project goes live", async () => {
    const { runner, client, promote, untilState, landTask } = await releaseFixture();
    const a = await landTask(client.token, "A", { "public/a.html": "a\n" });
    const b = await landTask(client.token, "B", { "public/b.html": "b\n" });
    runner.opts.deployWithoutActivating = true;
    const ida = (await promote(client.token, a)).body.promotionId as string;
    expect((await untilState(ida, ...DONE_STATES)).state).toBe("release_failed");
    runner.opts.deployWithoutActivating = false;
    const idb = (await promote(client.token, b)).body.promotionId as string;
    expect((await untilState(idb, ...DONE_STATES)).state).toBe("live");
    expect(await untilState(ida, "live", "release_failed")).toMatchObject({ state: "live", reason: null });
  });

  it("main moved before the accept (an owner's direct change): rebuilt before taking production (counted), accepted without a second approval; the uncleared change on main needs an owner's publish (C1), whose release makes the promotion live (M6)", async () => {
    const { f, client, promote, approve, untilState, untilHeld, resume, landTask, mainFiles, eventRows } = await releaseFixture();
    const dev = await f.memberWithAccess("developer");
    const taskId = await landTask(client.token, "API", { "src/contacts.ts": "export const contacts = [];\n" });
    const id = (await promote(client.token, taskId)).body.promotionId as string;
    await untilState(id, "pending_approval");
    expect((await approve(dev.token, id)).status).toBe(200);
    const cleared = await untilHeld(id, (p) => p.state === "cleared");
    await f.acceptOnMain({ "README.md": "moved\n" });
    await resume(id);
    const p = await untilState(id, ...DONE_STATES);
    expect(p).toMatchObject({ state: "release_failed", reason_code: "release_needs_publish_approval", reason: NEEDS_APPROVAL, rebuilds: 1, promotion_rebuilds: 0, clearance_kind: "developer", cleared_by: dev.userId, clearance_key: cleared.clearance_key });
    expect(p.detail).toContain("no promotion cleared");
    expect(p.proposal_id).not.toBe(cleared.proposal_id);
    expect(await eventRows("promotion.pending_approval", id)).toHaveLength(1);
    const files = await mainFiles();
    expect(files["README.md"]).toBe("moved\n");
    expect(files["src/contacts.ts"]).toBe("export const contacts = [];\n");
    // nothing was published under the clearance
    expect(await f.svc.db.prepare("SELECT COUNT(*) AS n FROM release_publish_approvals WHERE org_id = ? AND role LIKE 'clearance:%'").bind(f.o.orgId).first<{ n: number }>()).toEqual({ n: 0 });
    expect(await getLive(f.svc, f.o.orgId, f.pid)).toBeNull();
    // the owner publishes through the release routes; production then contains the promotion
    await ownerPublishes(f);
    expect(await untilState(id, "live")).toMatchObject({ state: "live", reason_code: null });
  });

  it("an owner's direct accept after the promotion's accept: the retry is refused as needing an owner's publish (C1)", async () => {
    const { f, runner, client, promote, retry, untilState, landTask } = await releaseFixture();
    const dev = await f.memberWithAccess("developer", "write");
    const taskId = await landTask(client.token, "Copy", { "public/index.html": "<h1>Hi</h1>\n" });
    runner.opts.deployWithoutActivating = true;
    const id = (await promote(client.token, taskId)).body.promotionId as string;
    expect((await untilState(id, ...DONE_STATES)).state).toBe("release_failed");
    runner.opts.deployWithoutActivating = false;
    await f.acceptOnMain({ "README.md": "direct\n" });
    expect((await retry(dev.token, id)).status).toBe(200);
    const p = await untilState(id, ...DONE_STATES);
    expect(p).toMatchObject({ state: "release_failed", reason_code: "release_needs_publish_approval", reason: NEEDS_APPROVAL });
    expect(await getLive(f.svc, f.o.orgId, f.pid)).toBeNull();
  });

  it("an accept that committed before the step died is not repeated: the next step continues to production", async () => {
    const { f, client, ledger, promote, untilState, untilHeld, resume, landTask, landing, acceptedVersionsOf } = await releaseFixture();
    const taskId = await landTask(client.token, "Copy", { "public/index.html": "<h1>Hi</h1>\n" });
    const id = (await promote(client.token, taskId)).body.promotionId as string;
    const cleared = await untilHeld(id, (p) => p.state === "cleared");
    // the step moved the row to `accepting` and the ledger accepted, then the step died
    await f.svc.db.prepare("UPDATE promotions SET state = 'accepting', machine_since = ? WHERE promotion_id = ?").bind(f.svc.nowIso(), id).run();
    const proposal = (await ledger.getProposal(cleared.proposal_id!))!;
    const d = await ledger.accept(await acceptInputFor(f.svc, proposal, `${f.o.orgId}:promotion-crashed`, userRef(client.userId)));
    expect(d.ok, JSON.stringify(d)).toBe(true);
    await resume(id);
    const p = await untilState(id, ...DONE_STATES);
    expect(p.state).toBe("live");
    expect(p.accepted_version_id).toBe((d as { acceptedVersionId: string }).acceptedVersionId);
    expect(await acceptedVersionsOf(cleared.proposal_id!)).toHaveLength(1);
    expect((await landing(taskId)).state).toBe("promoted");
  });
});

describe("promotions: what a clearance may publish, and what counts as live (review round 2)", { timeout: 180_000 }, () => {
  it("a mount added later whose resource has direct accepts older than production's live version: the next self-cleared release needs an owner (N1)", async () => {
    const { f, client, promote, untilState, landTask } = await releaseFixture();
    // a docs resource accepted directly (another project mounts it) before production first goes live
    const docs = await codeResource(f.h, f.o, "docs", { "README.md": "docs v1\n" });
    await acceptDirect(f, docs.resourceId, { "README.md": "docs v2\n" });
    const a = await landTask(client.token, "A", { "public/a.html": "a\n" });
    const b = await landTask(client.token, "B", { "public/b.html": "b\n" });
    const pa = await untilState((await promote(client.token, a)).body.promotionId, ...DONE_STATES);
    expect(pa.state).toBe("live");
    // the owner mounts docs and builds it into the release
    const m = await f.h.api("POST", `/api/orgs/${f.o.orgId}/projects/${f.pid}/mounts`, { token: f.o.token, body: { mountName: "docs", resourceId: docs.resourceId } });
    expect(m.status, JSON.stringify(m.body)).toBe(201);
    const release = stagingReleasePolicy(f.o.orgId);
    release.recipe.steps.push({ stepId: "docs", mountName: "docs", command: "true" });
    const put = await f.h.api("PUT", `/api/orgs/${f.o.orgId}/projects/${f.pid}/policy`, { token: f.o.token, body: { release, staging: STAGING } });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const pb = await untilState((await promote(client.token, b)).body.promotionId, ...DONE_STATES);
    expect(pb).toMatchObject({ state: "release_failed", reason_code: "release_needs_publish_approval" });
    expect(pb.detail).toContain(docs.resourceId);
    expect((await getLive(f.svc, f.o.orgId, f.pid))!.release_id).toBe(pa.release_id);
  });

  it("a folder mounted after production went live needs one owner publish, even with only its adopted head; then clearances carry it again", async () => {
    const { f, client, promote, untilState, landTask } = await releaseFixture();
    const a = await landTask(client.token, "A", { "public/a.html": "a\n" });
    const b = await landTask(client.token, "B", { "public/b.html": "b\n" });
    const c = await landTask(client.token, "C", { "public/c.html": "c\n" });
    expect((await untilState((await promote(client.token, a)).body.promotionId, ...DONE_STATES)).state).toBe("live");
    // a resource with nothing but its adopted (genesis) head, mounted and built into the release now
    const assets = await codeResource(f.h, f.o, "assets", { "logo.svg": "<svg/>\n" });
    expect((await f.h.api("POST", `/api/orgs/${f.o.orgId}/projects/${f.pid}/mounts`, { token: f.o.token, body: { mountName: "assets", resourceId: assets.resourceId } })).status).toBe(201);
    const release = stagingReleasePolicy(f.o.orgId);
    release.recipe.steps.push({ stepId: "assets", mountName: "assets", command: "true" });
    expect((await f.h.api("PUT", `/api/orgs/${f.o.orgId}/projects/${f.pid}/policy`, { token: f.o.token, body: { release, staging: STAGING } })).status).toBe(200);
    const idb = (await promote(client.token, b)).body.promotionId as string;
    const pb = await untilState(idb, ...DONE_STATES);
    expect(pb).toMatchObject({ state: "release_failed", reason_code: "release_needs_publish_approval" });
    expect(pb.detail).toContain(assets.resourceId);
    // the owner publishes once: B is live with it, and the next promotion's clearance carries the folder
    await ownerPublishes(f);
    expect(await untilState(idb, "live")).toMatchObject({ state: "live" });
    expect((await untilState((await promote(client.token, c)).body.promotionId, ...DONE_STATES)).state).toBe("live");
  });

  it("a restore between a failed promotion's accept and a live release: the promotion is not marked live (M-a)", async () => {
    const { f, runner, client, promote, untilState, landTask } = await releaseFixture();
    const taskId = await landTask(client.token, "Copy", { "public/index.html": "<h1>Hi</h1>\n" });
    runner.opts.deployWithoutActivating = true;
    const id = (await promote(client.token, taskId)).body.promotionId as string;
    expect((await untilState(id, ...DONE_STATES)).state).toBe("release_failed");
    runner.opts.deployWithoutActivating = false;
    const head = (await f.svc.ledger(f.o.orgId).getHead(f.api.resourceId))!;
    const r = await f.h.api("POST", `/api/orgs/${f.o.orgId}/resources/${f.api.resourceId}/restore`, { token: f.o.token, body: { expectedHead: head.revisionId, targetRevision: f.api.revisionId, idempotencyKey: "restore-before-promo" } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    await ownerPublishes(f);
    await f.h.drainSteps();
    expect(await untilState(id, "release_failed", "live")).toMatchObject({ state: "release_failed" });
  });
});

/** Accept `files` into a resource from outside the staging project (an ordinary task, proposal and accept in a second project). */
async function acceptDirect(f: StagingFixture, resourceId: string, files: Record<string, string>): Promise<void> {
  const { h, o } = f;
  const pid = await projectWith(h, o, [{ mountName: "docs", resourceId }]);
  const t = await h.api("POST", `/api/orgs/${o.orgId}/projects/${pid}/tasks`, { token: o.token, body: { title: "Direct", writeMounts: ["docs"] } });
  expect(t.status, JSON.stringify(t.body)).toBe(201);
  const taskId = t.body.taskId as string;
  await f.until(async () => (await h.api("GET", `/api/tasks/${taskId}`, { token: o.token })).body.state === "ready");
  const agent = (await h.api("POST", `/api/tasks/${taskId}/lease`, { token: o.token, body: {} })).body.leaseToken as string;
  const ws = (await h.api("GET", `/api/tasks/${taskId}`, { token: agent })).body.workspaces[0];
  const cred = await h.api("POST", `/api/tasks/${taskId}/credential`, { token: agent, body: { mountName: "docs", access: "write" } });
  const where = h.artifacts.tokenByPlaintext(cred.body.secret)!;
  const base = h.artifacts.repo(where.ns, where.name).refs.get("main")!;
  const sha = h.artifacts.makeCommit({ ...h.artifacts.files.get(base), ...files }, [base]);
  h.artifacts.push(where.ns, where.name, "main", sha);
  expect((await h.api("POST", `/api/tasks/${taskId}/workspaces/${ws.taskWorkspaceId}/freeze`, { token: agent, body: { expectedSha: sha } })).status).toBe(201);
  const proposalId = (await h.api("POST", `/api/orgs/${o.orgId}/proposals`, { token: o.token, body: { taskId } })).body.proposalId as string;
  const p = await prepareAndIntegrate(h, o, proposalId);
  await h.api("POST", `/api/orgs/${o.orgId}/proposals/${proposalId}/approvals`, { token: o.token, body: { proposalHash: p.proposalHash } });
  const acc = await h.api("POST", `/api/orgs/${o.orgId}/proposals/${proposalId}/accept`, { token: o.token, body: { idempotencyKey: `accept-direct-${proposalId}` } });
  expect(acc.status, JSON.stringify(acc.body)).toBe(200);
}

/** The owner prepares the latest release, approves its publish and deploys it (the ordinary release flow). */
async function ownerPublishes(f: StagingFixture): Promise<void> {
  const r = await f.h.api("POST", `/api/orgs/${f.o.orgId}/projects/${f.pid}/releases`, { token: f.o.token, body: {} });
  expect([200, 202], JSON.stringify(r.body)).toContain(r.status);
  await f.until(async () => (await getRelease(f.svc, f.o.orgId, r.body.releaseId))!.build_state !== "building", 20_000);
  const rel = (await getRelease(f.svc, f.o.orgId, r.body.releaseId))!;
  const a = await f.h.api("POST", `/api/orgs/${f.o.orgId}/releases/${rel.release_id}/publish-approvals`, { token: f.o.token, body: { outputDigest: rel.output_digest } });
  expect(a.status, JSON.stringify(a.body)).toBe(201);
  const d = await f.h.api("POST", `/api/orgs/${f.o.orgId}/releases/${rel.release_id}/deploy`, { token: f.o.token, body: { idempotencyKey: `owner-publish-${rel.release_id}` } });
  expect(d.status, JSON.stringify(d.body)).toBe(202);
  await f.until(async () => (await getRelease(f.svc, f.o.orgId, rel.release_id))!.state === "live", 20_000);
}

describe("promotions: landing proposals and clearance publish approvals", { timeout: 180_000 }, () => {
  it("the landing proposals of a rolled-back and of a failed landing are withdrawn", async () => {
    const { f, client, ledger, landTask, landing } = await releaseFixture();
    const a = await landTask(client.token, "A", { "public/a.html": "a\n" });
    const b = await landTask(client.token, "B", { "public/b.html": "b\n" });
    const rb = await f.h.api("POST", `/api/tasks/${a}/rollback`, { token: client.token, body: {} });
    expect(rb.status, JSON.stringify(rb.body)).toBe(202);
    await f.until(async () => (await landing(a)).state === "rolled_back", 20_000);
    expect((await ledger.getProposal((await landing(a)).proposal_id))!.state).toBe("withdrawn");
    // b's change becomes unavailable: staging fails it at the next build
    const lb = await landing(b);
    const rec = (await ledger.getCandidate((await ledger.getProposal(lb.proposal_id))!.resourceChanges[0]!.candidateId))!;
    await ledger.putCandidate(f.o.orgId, { ...rec, state: "superseded", updatedAt: f.svc.nowIso() });
    await f.h.api("POST", `/api/orgs/${f.o.orgId}/projects/${f.pid}/staging/reset`, { token: f.o.token, body: {} });
    await f.until(async () => (await landing(b)).state === "failed", 20_000);
    expect((await ledger.getProposal(lb.proposal_id))!.state).toBe("withdrawn");
  });

  it("a clearance:* publish approval counts only while a promotion is releasing that release", async () => {
    const f = await productionFixture();
    new FakeRunner(f.h);
    const rel = await f.preparedRelease();
    const now = f.svc.nowIso();
    await f.svc.db
      .prepare("INSERT INTO release_publish_approvals (approval_id, org_id, release_id, output_digest, env_digest, approver, role, approved_at) VALUES ('pub-forged', ?, ?, ?, ?, ?, 'clearance:self', ?)")
      .bind(f.o.orgId, rel.release_id, rel.output_digest, rel.env_digest, f.o.userId, now)
      .run();
    expect(await validPublishApproval(f.svc, rel)).toBeNull();
    const d = await f.h.api("POST", `/api/orgs/${f.o.orgId}/releases/${rel.release_id}/deploy`, { token: f.o.token, body: { idempotencyKey: "deploy-forged-1" } });
    expect(d.status).toBe(409);
    expect(d.body.error.code).toBe("publish_approval_required");
    // a promotion naming the release, but not releasing it (or cleared with another kind): still nothing
    const insert = (id: string, state: string, kind: string) =>
      f.svc.db
        .prepare("INSERT INTO promotions (promotion_id, org_id, project_id, target_landing_id, landings_json, state, clearance_kind, cleared_by, release_id, requested_by, created_at, updated_at) VALUES (?, ?, ?, 'lnd-x', '[]', ?, ?, ?, ?, ?, ?, ?)")
        .bind(id, f.o.orgId, f.pid, state, kind, f.o.userId, rel.release_id, f.o.userId, now, now)
        .run();
    await insert("prm-live", "live", "self");
    await insert("prm-dev", "releasing", "developer");
    expect(await validPublishApproval(f.svc, rel)).toBeNull();
    await f.svc.db.prepare("UPDATE promotions SET clearance_kind = 'self' WHERE promotion_id = 'prm-dev'").run();
    expect(await validPublishApproval(f.svc, rel)).toMatchObject({ approval_id: "pub-forged" });
  });
});
