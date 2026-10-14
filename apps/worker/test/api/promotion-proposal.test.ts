/**
 * Staging phase 2, Task 5: the promotion proposal (main heads + the set's candidates, explicit
 * merge bases), its integrate job, per-resource accept heads, and clearance approvals honoured only
 * for a cleared promotion.
 */
import { ProposalRecordSchema, computeProposalHash, parseRevisionId, revisionCommitSha, type ProposalRecord } from "@commonforge-org/core";
import type { IntegrationJob } from "@commonforge-org/runner-protocol";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/lib/http.js";
import { userRef } from "../../src/services/events.js";
import { acceptInputFor, currentApprovals, getProposalIndex } from "../../src/services/proposals.js";
import { buildPromotionProposal, supersedePromotionProposal } from "../../src/services/promotion-proposal.js";
import { issueIntegration } from "../../src/services/integration.js";
import { getProject } from "../../src/services/directory.js";
import { land } from "../../src/services/staging.js";
import { FakeRunner } from "../fakes/runner.js";
import { codeResource, freezeAndPropose, harness, ownerWithOrg, prepareAndIntegrate, projectWith, provisionedTask, waitUntil, type Harness } from "../helpers.js";
import { stagingFixture, type StagingFixture } from "../staging-helpers.js";

/** Two client tasks landed on staging (the second one seeded from the first one's staging build). */
async function twoLandings() {
  const f = await stagingFixture();
  const runner = new FakeRunner(f.h);
  const client = await f.clientWithAccess();
  await f.submitTask(client.token, "First", { "src/a.ts": "export const a = 1;\n" });
  await f.untilLanded(1);
  await f.submitTask(client.token, "Second", { "src/b.ts": "export const b = 2;\n" });
  await f.untilLanded(2);
  const ledger = f.svc.ledger(f.o.orgId);
  const rows = (await f.svc.db.prepare("SELECT proposal_id FROM staging_landings WHERE org_id = ? AND project_id = ? ORDER BY seq").bind(f.o.orgId, f.pid).all<{ proposal_id: string }>()).results;
  const parts = [];
  for (const r of rows) parts.push({ proposalId: r.proposal_id, proposalHash: (await ledger.getProposal(r.proposal_id))!.proposalHash });
  expect(runner.errors).toEqual([]);
  return { f, runner, client, parts, ledger };
}

const build = async (f: StagingFixture, promotionId: string, parts: Array<{ proposalId: string; proposalHash: string }>, requestedBy: string, supersedes?: string) =>
  buildPromotionProposal(f.svc, { project: await f.project(), promotionId, parts, requestedBy, ...(supersedes ? { supersedes } : {}) });

/** Integrate through the route as the owner and wait for the receipt of the current hash. */
async function integrate(f: StagingFixture, proposalId: string) {
  const r = await f.h.api("POST", `/api/orgs/${f.o.orgId}/proposals/${proposalId}/integrate`, { token: f.o.token });
  expect(r.status, JSON.stringify(r.body)).toBe(202);
  await f.until(async () => (await f.h.api("GET", `/api/orgs/${f.o.orgId}/proposals/${proposalId}`, { token: f.o.token })).body.integration?.forCurrentHash === true, 15_000);
  return { jobId: r.body.jobId as string, receipt: (await f.svc.ledger(f.o.orgId).getIntegrationReceipt(proposalId))! };
}

async function clearanceRow(f: StagingFixture, p: ProposalRecord, state: string, kind: string, clearedBy: string) {
  const now = f.svc.nowIso();
  await f.svc.db
    .prepare("INSERT INTO promotions (promotion_id, org_id, project_id, target_landing_id, landings_json, proposal_id, proposal_hash, state, clearance_kind, cleared_by, requested_by, created_at, updated_at) VALUES (?, ?, ?, 'lnd-x', '[]', ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(`prm-row-${crypto.randomUUID().slice(0, 8)}`, f.o.orgId, f.pid, p.proposalId, p.proposalHash, state, kind, clearedBy, clearedBy, now, now)
    .run();
}

describe("promotion proposal", { timeout: 60_000 }, () => {
  it("is built from main heads and every candidate of the set, with each candidate's staging base as its merge base", async () => {
    const { f, client, parts, ledger } = await twoLandings();
    const built = await build(f, "prm-test1", parts, client.userId);
    const head = (await ledger.getHead(f.api.resourceId))!;
    expect(built.proposalId).toMatch(/^prop-pro-[0-9a-f]{32}$/);
    expect(ProposalRecordSchema.parse(built.record)).toEqual(built.record);
    const { proposalHash, ...rest } = built.record;
    expect(await computeProposalHash(rest)).toBe(proposalHash);
    expect(built.record).toMatchObject({ state: "prepared", changeId: "chg-pro-prm-test1", policyRevision: (await f.project()).policy_revision });
    expect(built.record.resourceChanges).toHaveLength(2);
    expect(built.record.resourceChanges.every((c) => c.baseRevision === head.revisionId)).toBe(true);
    expect(built.record.preparedReceipts).toHaveLength(2);
    // read dependencies never pin staging; the changed resource is not one
    expect(built.record.readDependencies.some((d) => d.resourceId === f.api.resourceId)).toBe(false);
    // candidates in part order; each merge base is its own recorded base (the second one: staging)
    const cands = [];
    for (const p of parts) cands.push(...(await ledger.getProposal(p.proposalId))!.resourceChanges.map((c) => c.candidateId));
    expect(built.record.resourceChanges.map((c) => c.candidateId)).toEqual(cands);
    for (const id of cands) expect(built.mergeBases[id]).toBe(revisionCommitSha((await ledger.getCandidate(id))!.candidate.baseRevision));
    expect(built.mergeBases[cands[0]!]).toBe(f.initialHeadSha);
    expect(built.mergeBases[cands[1]!]).not.toBe(f.initialHeadSha);
    // the candidate snapshot points the resource at the last candidate
    expect(built.candidateSnapshot.entries.find((e) => e.resourceId === f.api.resourceId)!.revisionId).toBe(built.record.resourceChanges[1]!.candidateRevision);
    const idx = (await getProposalIndex(f.svc, f.o.orgId, built.proposalId))!;
    expect(idx).toMatchObject({ kind: "promotion", promotion_id: "prm-test1", task_id: null, project_id: f.pid });
    // the listing marks it (and the landing proposals)
    const list = await f.h.api("GET", `/api/orgs/${f.o.orgId}/proposals?projectId=${f.pid}`, { token: f.o.token });
    const kinds = Object.fromEntries((list.body.proposals as Array<{ proposalId: string; kind: string | null }>).map((p) => [p.proposalId, p.kind]));
    expect(kinds[built.proposalId]).toBe("promotion");
    expect(kinds[parts[0]!.proposalId]).toBe("staging");

    // a rebuild with the same promotion and the same main is the same proposal (no throw, no rewrite)
    const again = await build(f, "prm-test1", parts, client.userId);
    expect(again.proposalId).toBe(built.proposalId);
    expect(again.record).toEqual(built.record);
    expect(again.mergeBases).toEqual(built.mergeBases);
  });

  it("refuses a part whose candidate is not prepared", async () => {
    const { f, client, parts, ledger } = await twoLandings();
    const p = (await ledger.getProposal(parts[0]!.proposalId))!;
    const rec = (await ledger.getCandidate(p.resourceChanges[0]!.candidateId))!;
    await ledger.putCandidate(f.o.orgId, { ...rec, state: "superseded", updatedAt: f.svc.nowIso() });
    await expect(build(f, "prm-np", parts, client.userId)).rejects.toMatchObject({ status: 409, code: "promotion_candidate_not_prepared" });
  });

  it("integrates with one target per resource and explicit merge bases; only the set's own edits reach the result", async () => {
    const { f, runner, client, parts, ledger } = await twoLandings();
    const head = (await ledger.getHead(f.api.resourceId))!;
    const built = await build(f, "prm-both", parts, client.userId);
    const { jobId, receipt } = await integrate(f, built.proposalId);
    const job = runner.handled.find((j) => j.jobId === jobId)!.job as Extract<IntegrationJob, { kind: "integrate" }>;
    expect(job.targets).toHaveLength(1);
    expect(job.targets[0]!.expectedHead).toBe(head.revisionId);
    expect(job.candidates.map((c) => c.candidateId)).toEqual(built.record.resourceChanges.map((c) => c.candidateId));
    expect(job.mergeBases).toEqual(built.mergeBases);
    const files = f.h.artifacts.files.get((parseRevisionId(receipt.results[0]!.revisionId) as { sha: string }).sha)!;
    expect(files["src/a.ts"]).toBe("export const a = 1;\n");
    expect(files["src/b.ts"]).toBe("export const b = 2;\n");

    // per-resource accept heads: one expected head, one new head (the integration result)
    const input = await acceptInputFor(f.svc, built.record, "k-both", userRef(f.o.userId));
    expect(input.expectedHeads).toEqual([{ resourceId: f.api.resourceId, revisionId: head.revisionId }]);
    expect(input.newHeads).toHaveLength(1);
    expect(input.newHeads[0]).toMatchObject({ resourceId: f.api.resourceId, revisionId: receipt.results[0]!.revisionId });
    const last = (await ledger.getCandidate(built.record.resourceChanges[1]!.candidateId))!;
    expect(input.newHeads[0]!.preparedReceiptId).toBe(last.preparedReceiptId);

    // promoting only the second landing leaves the first one's edits out (its base is staging)
    const second = await build(f, "prm-second", [parts[1]!], client.userId);
    const only = await integrate(f, second.proposalId);
    const onlyFiles = f.h.artifacts.files.get((parseRevisionId(only.receipt.results[0]!.revisionId) as { sha: string }).sha)!;
    expect(onlyFiles["src/b.ts"]).toBe("export const b = 2;\n");
    expect(onlyFiles["src/a.ts"]).toBeUndefined();
    expect(runner.errors).toEqual([]);
  });

  it("acceptInputFor never fast-forwards a promotion to its candidate: no receipt for the current hash → integration_required", async () => {
    const { f, client, parts } = await twoLandings();
    const built = await build(f, "prm-ff", [parts[0]!], client.userId);
    // one candidate whose resource change names main as its base: the ledger would take it as a fast-forward
    expect(built.record.resourceChanges).toHaveLength(1);
    const err = await acceptInputFor(f.svc, built.record, "k-ff", userRef(f.o.userId)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code: "integration_required" });
  });

  it("accept with a clearance approval succeeds only while a promotion row is cleared for that hash and kind", async () => {
    const { f, client, parts, ledger } = await twoLandings();
    const built = await build(f, "prm-clr", parts, client.userId);
    await integrate(f, built.proposalId);
    const p = (await ledger.getProposal(built.proposalId))!;
    await ledger.putApproval(f.o.orgId, { approvalId: "clr-test-1", proposalId: p.proposalId, proposalHash: p.proposalHash, approver: userRef(client.userId), role: "clearance:self", approvedAt: f.svc.nowIso() });
    // an ordinary approval never counts for a promotion proposal (only clearances do)
    await ledger.putApproval(f.o.orgId, { approvalId: "appr-test-1", proposalId: p.proposalId, proposalHash: p.proposalHash, approver: userRef(f.o.userId), role: "owner", approvedAt: f.svc.nowIso() });
    const accept = async (key: string) => ledger.accept(await acceptInputFor(f.svc, p, `${f.o.orgId}:${key}`, userRef(client.userId)));

    // no promotion row
    expect(await accept("clr-1")).toMatchObject({ ok: false, code: "approval_invalid" });
    // a row for this proposal that is not cleared yet
    await clearanceRow(f, p, "pending_approval", "self", client.userId);
    expect(await accept("clr-2")).toMatchObject({ ok: false, code: "approval_invalid" });
    // cleared, but as another kind
    await f.svc.db.prepare("UPDATE promotions SET state = 'cleared', clearance_kind = 'developer' WHERE proposal_id = ?").bind(p.proposalId).run();
    expect(await accept("clr-3")).toMatchObject({ ok: false, code: "approval_invalid" });
    // cleared for another hash
    await f.svc.db.prepare("UPDATE promotions SET clearance_kind = 'self', proposal_hash = ? WHERE proposal_id = ?").bind(parts[0]!.proposalHash, p.proposalId).run();
    expect(await accept("clr-4")).toMatchObject({ ok: false, code: "approval_invalid" });
    // cleared for this hash and kind
    await f.svc.db.prepare("UPDATE promotions SET proposal_hash = ? WHERE proposal_id = ?").bind(p.proposalHash, p.proposalId).run();
    expect((await currentApprovals(f.svc, f.o.orgId, f.pid, await ledger.listApprovals(p.proposalId), p)).map((a) => a.role)).toEqual(["clearance:self"]);
    const ok = await accept("clr-5");
    expect(ok).toMatchObject({ ok: true });
    expect((await ledger.getHead(f.api.resourceId))!.revisionId).toBe((await ledger.getIntegrationReceipt(p.proposalId))!.results[0]!.revisionId);
  });

  it("main moved: integrate refuses expected_head_stale; a rebuild gets a new id and supersedes the old proposal", async () => {
    const { f, client, parts, ledger } = await twoLandings();
    const first = await build(f, "prm-a", [parts[0]!], client.userId);
    const other = await build(f, "prm-c", [parts[1]!], client.userId);
    // accept the first promotion: main moves
    await integrate(f, first.proposalId);
    await ledger.putApproval(f.o.orgId, { approvalId: "clr-move-1", proposalId: first.proposalId, proposalHash: first.record.proposalHash, approver: userRef(f.o.userId), role: "clearance:developer", approvedAt: f.svc.nowIso() });
    await clearanceRow(f, first.record, "cleared", "developer", f.o.userId);
    expect(await ledger.accept(await acceptInputFor(f.svc, first.record, `${f.o.orgId}:move-1`, userRef(f.o.userId)))).toMatchObject({ ok: true });

    const stale = await f.h.api("POST", `/api/orgs/${f.o.orgId}/proposals/${other.proposalId}/integrate`, { token: f.o.token });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("expected_head_stale");

    const rebuilt = await build(f, "prm-c", [parts[1]!], client.userId, other.proposalId);
    expect(rebuilt.proposalId).not.toBe(other.proposalId);
    expect((await ledger.getProposal(other.proposalId))!.state).toBe("superseded");
    expect(rebuilt.record.resourceChanges[0]!.baseRevision).toBe((await ledger.getHead(f.api.resourceId))!.revisionId);
    // the rebuilt promotion integrates on the new main
    const { receipt } = await integrate(f, rebuilt.proposalId);
    const files = f.h.artifacts.files.get((parseRevisionId(receipt.results[0]!.revisionId) as { sha: string }).sha)!;
    expect(files["src/a.ts"]).toBe("export const a = 1;\n");
    expect(files["src/b.ts"]).toBe("export const b = 2;\n");
  });

  it("the accept, approvals and integrate routes refuse staging proposals; accept and approvals refuse promotion proposals", async () => {
    const { f, client, parts } = await twoLandings();
    const built = await build(f, "prm-routes", parts, client.userId);
    const stg = parts[0]!;
    const post = (id: string, what: string, body: unknown = {}) => f.h.api("POST", `/api/orgs/${f.o.orgId}/proposals/${id}/${what}`, { token: f.o.token, body });

    const accStg = await post(stg.proposalId, "accept", { idempotencyKey: "accept-stg-1" });
    expect(accStg.status).toBe(409);
    expect(accStg.body.error).toMatchObject({ code: "staging_proposal", message: "Promote this task from staging instead" });
    const accPro = await post(built.proposalId, "accept", { idempotencyKey: "accept-pro-1" });
    expect(accPro.status).toBe(409);
    expect(accPro.body.error.code).toBe("promotion_proposal");

    const apprStg = await post(stg.proposalId, "approvals", { proposalHash: stg.proposalHash });
    expect(apprStg.status).toBe(409);
    expect(apprStg.body.error).toMatchObject({ code: "staging_proposal", message: "Promote this task from staging instead" });
    const apprPro = await post(built.proposalId, "approvals", { proposalHash: built.record.proposalHash });
    expect(apprPro.status).toBe(409);
    expect(apprPro.body.error.code).toBe("promotion_proposal");
    // the client cannot approve either
    const apprClient = await f.h.api("POST", `/api/orgs/${f.o.orgId}/proposals/${built.proposalId}/approvals`, { token: client.token, body: { proposalHash: built.record.proposalHash } });
    expect(apprClient.status).toBe(409);
    expect((await f.svc.ledger(f.o.orgId).listApprovals(built.proposalId))).toEqual([]);

    const intStg = await post(stg.proposalId, "integrate");
    expect(intStg.status).toBe(409);
    expect(intStg.body.error).toMatchObject({ code: "staging_proposal", message: "Promote this task from staging instead" });
  });
});

describe("promotion proposal (review fix round 1)", { timeout: 60_000 }, () => {
  it("land repairs a landing whose part 1 or index row is missing (a step that died half way)", async () => {
    const f = await stagingFixture();
    new FakeRunner(f.h);
    const client = await f.clientWithAccess();
    const taskId = await f.submitTask(client.token, "First", { "src/a.ts": "1\n" });
    const landingId = await f.landingIdOf(taskId);
    await f.untilLanded(1);
    const proposalId = (await f.svc.db.prepare("SELECT proposal_id FROM staging_landings WHERE landing_id = ?").bind(landingId).first<{ proposal_id: string }>())!.proposal_id;
    const part = () => f.svc.db.prepare("SELECT * FROM staging_landing_parts WHERE landing_id = ?").bind(landingId).all<{ part: number; task_id: string; proposal_id: string }>();
    expect((await part()).results).toEqual([expect.objectContaining({ part: 1, task_id: taskId, proposal_id: proposalId })]);
    const hashBefore = (await f.svc.ledger(f.o.orgId).getProposal(proposalId))!.proposalHash;
    await f.svc.db.prepare("DELETE FROM staging_landing_parts WHERE landing_id = ?").bind(landingId).run();
    await f.svc.db.prepare("DELETE FROM proposals_index WHERE proposal_id = ?").bind(proposalId).run();
    expect(await land(f.svc, f.o.orgId, taskId)).toEqual({ done: true });
    expect((await part()).results).toEqual([expect.objectContaining({ part: 1, task_id: taskId, proposal_id: proposalId })]);
    expect(await getProposalIndex(f.svc, f.o.orgId, proposalId)).toMatchObject({ kind: "staging", task_id: taskId });
    expect((await f.svc.ledger(f.o.orgId).getProposal(proposalId))!.proposalHash).toBe(hashBefore);
  });

  it("issueIntegration rejoins a job by key only for the same proposal id and hash", async () => {
    const { f, runner, client, parts } = await twoLandings();
    const built = await build(f, "prm-key", parts, client.userId);
    const idx = (await getProposalIndex(f.svc, f.o.orgId, built.proposalId))!;
    runner.opts.hold = ["integrate"];
    const key = `promotion:prm-key:${built.record.proposalHash}`;
    const a = await issueIntegration(f.svc, userRef(f.o.userId), built.record, idx, { jobKey: key });
    const b = await issueIntegration(f.svc, userRef(f.o.userId), built.record, idx, { jobKey: key });
    expect(a.reused).toBe(false);
    expect(b).toEqual({ jobId: a.jobId, reused: true });
    // same id, rewritten content (another hash): never the old job
    const rewritten = { ...built.record, proposalHash: parts[0]!.proposalHash } as ProposalRecord;
    const c = await issueIntegration(f.svc, userRef(f.o.userId), rewritten, idx, { jobKey: key });
    expect(c.reused).toBe(false);
    expect(c.jobId).not.toBe(a.jobId);
  });

  it("a rebuild never reuses a closed proposal: a superseded one on the same base gets a fresh id", async () => {
    const { f, client, parts, ledger } = await twoLandings();
    const first = await build(f, "prm-closed", parts, client.userId);
    expect(await supersedePromotionProposal(f.svc, f.o.orgId, first.proposalId)).toBe(true);
    const again = await build(f, "prm-closed", parts, client.userId);
    expect(again.proposalId).not.toBe(first.proposalId);
    expect(again.record.state).toBe("prepared");
    expect((await ledger.getProposal(first.proposalId))!.state).toBe("superseded");
    // and stays stable from there on
    expect((await build(f, "prm-closed", parts, client.userId)).proposalId).toBe(again.proposalId);
  });

  it("a rewrite of the same id (other parts, same base) keeps createdAt and advances updatedAt", async () => {
    const { f, client, parts } = await twoLandings();
    const one = await build(f, "prm-rw", [parts[0]!], client.userId);
    const both = await build(f, "prm-rw", parts, client.userId);
    expect(both.proposalId).toBe(one.proposalId);
    expect(both.record.proposalHash).not.toBe(one.record.proposalHash);
    expect(both.record.createdAt).toBe(one.record.createdAt);
    expect(both.record.updatedAt > one.record.updatedAt).toBe(true);
    expect(JSON.parse((await getProposalIndex(f.svc, f.o.orgId, both.proposalId))!.candidate_snapshot_json).snapshotId).toBe(both.record.candidateSnapshotId);
  });

  it("a clearance is not honoured for another clearer, a removed member, or a client who lost project access", async () => {
    const { f, client, parts, ledger } = await twoLandings();
    const built = await build(f, "prm-who", parts, client.userId);
    await integrate(f, built.proposalId);
    const p = built.record;
    await ledger.putApproval(f.o.orgId, { approvalId: "clr-who-1", proposalId: p.proposalId, proposalHash: p.proposalHash, approver: userRef(client.userId), role: "clearance:self", approvedAt: f.svc.nowIso() });
    const kept = async () => (await currentApprovals(f.svc, f.o.orgId, f.pid, await ledger.listApprovals(p.proposalId), p)).map((a) => a.approvalId);
    // cleared by somebody else
    await clearanceRow(f, p, "cleared", "self", f.o.userId);
    expect(await kept()).toEqual([]);
    await f.svc.db.prepare("UPDATE promotions SET cleared_by = ? WHERE proposal_id = ?").bind(client.userId, p.proposalId).run();
    expect(await kept()).toEqual(["clr-who-1"]);
    // the client loses project access
    const off = await f.h.api("PUT", `/api/orgs/${f.o.orgId}/projects/${f.pid}/access`, { token: f.o.token, body: { userId: client.userId, level: "none" } });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect(await kept()).toEqual([]);
    const on = await f.h.api("PUT", `/api/orgs/${f.o.orgId}/projects/${f.pid}/access`, { token: f.o.token, body: { userId: client.userId, level: "read" } });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    expect(await kept()).toEqual(["clr-who-1"]);
    // the client is removed from the org
    const gone = await f.h.api("DELETE", `/api/orgs/${f.o.orgId}/members/${client.userId}`, { token: f.o.token });
    expect(gone.status, JSON.stringify(gone.body)).toBeLessThan(300);
    expect(await kept()).toEqual([]);
  });

  it("a promotion over two resources: one target per resource, one expected and one new head per resource", async () => {
    const h = harness();
    const runner = new FakeRunner(h);
    const o = await ownerWithOrg(h);
    const web = await codeResource(h, o, "website", { "index.html": "v1" });
    const api = await codeResource(h, o, "api", { "src/index.ts": "api v1" });
    const pid = await projectWith(h, o, [
      { mountName: "website", resourceId: web.resourceId },
      { mountName: "api", resourceId: api.resourceId },
    ]);
    const svc = h.services();
    const parts = [];
    for (const [mount, files] of [["website", { "index.html": "v2" }], ["api", { "src/extra.ts": "x" }]] as const) parts.push(await ordinaryProposal(h, o, pid, mount, files));
    const project = (await getProject(svc.db, o.orgId, pid))!;
    const built = await buildPromotionProposal(svc, { project, promotionId: "prm-two", parts, requestedBy: o.userId });
    expect(built.record.resourceChanges.map((c) => c.resourceId)).toEqual([web.resourceId, api.resourceId]);
    const r = await h.api("POST", `/api/orgs/${o.orgId}/proposals/${built.proposalId}/integrate`, { token: o.token });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    await waitUntil(async () => !!(await svc.ledger(o.orgId).getIntegrationReceipt(built.proposalId)), 10_000);
    const job = runner.handled.find((j) => j.jobId === r.body.jobId)!.job as Extract<IntegrationJob, { kind: "integrate" }>;
    expect(job.targets.map((t) => t.resourceId)).toEqual([web.resourceId, api.resourceId]);
    const input = await acceptInputFor(svc, built.record, `${o.orgId}:two-1`, userRef(o.userId));
    expect(input.expectedHeads).toEqual([{ resourceId: web.resourceId, revisionId: web.revisionId }, { resourceId: api.resourceId, revisionId: api.revisionId }]);
    expect(input.newHeads.map((n) => n.resourceId)).toEqual([web.resourceId, api.resourceId]);
    const ledger = svc.ledger(o.orgId);
    await ledger.putApproval(o.orgId, { approvalId: "clr-two-1", proposalId: built.proposalId, proposalHash: built.record.proposalHash, approver: userRef(o.userId), role: "clearance:developer", approvedAt: svc.nowIso() });
    const now = svc.nowIso();
    await svc.db
      .prepare("INSERT INTO promotions (promotion_id, org_id, project_id, target_landing_id, landings_json, proposal_id, proposal_hash, state, clearance_kind, cleared_by, requested_by, created_at, updated_at) VALUES ('prm-two', ?, ?, 'lnd-x', '[]', ?, ?, 'cleared', 'developer', ?, ?, ?, ?)")
      .bind(o.orgId, pid, built.proposalId, built.record.proposalHash, o.userId, o.userId, now, now)
      .run();
    expect(await ledger.accept(await acceptInputFor(svc, built.record, `${o.orgId}:two-2`, userRef(o.userId)))).toMatchObject({ ok: true });
    const files = (rid: string) => h.artifacts.files.get(revisionCommitSha(input.newHeads.find((n) => n.resourceId === rid)!.revisionId)!)!;
    expect(files(web.resourceId)["index.html"]).toBe("v2");
    expect(files(api.resourceId)["src/extra.ts"]).toBe("x");
    expect(runner.errors).toEqual([]);
  });
});

/** An ordinary proposal of a task writing `mount` (frozen, proposed, prepared). */
async function ordinaryProposal(h: Harness, o: { token: string; orgId: string }, pid: string, mount: string, files: Record<string, string>) {
  const t = await h.api("POST", `/api/orgs/${o.orgId}/projects/${pid}/tasks`, { token: o.token, body: { title: `Change ${mount}`, writeMounts: [mount] } });
  expect(t.status, JSON.stringify(t.body)).toBe(201);
  const taskId = t.body.taskId as string;
  await h.drainSteps();
  const lease = await h.api("POST", `/api/tasks/${taskId}/lease`, { token: o.token, body: {} });
  expect(lease.status, JSON.stringify(lease.body)).toBe(200);
  const agent = lease.body.leaseToken as string;
  const task = (await h.api("GET", `/api/tasks/${taskId}`, { token: agent })).body;
  const ws = task.workspaces.find((w: { mountName: string }) => w.mountName === mount);
  const cred = await h.api("POST", `/api/tasks/${taskId}/credential`, { token: agent, body: { mountName: mount, access: "write" } });
  const where = h.artifacts.tokenByPlaintext(cred.body.secret)!;
  const base = h.artifacts.repo(where.ns, where.name).refs.get("main")!;
  const sha = h.artifacts.makeCommit({ ...h.artifacts.files.get(base), ...files }, [base]);
  h.artifacts.push(where.ns, where.name, "main", sha);
  const fr = await h.api("POST", `/api/tasks/${taskId}/workspaces/${ws.taskWorkspaceId}/freeze`, { token: agent, body: { expectedSha: sha } });
  expect(fr.status, JSON.stringify(fr.body)).toBe(201);
  const p = await h.api("POST", `/api/orgs/${o.orgId}/proposals`, { token: o.token, body: { taskId } });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  await h.drainSteps();
  const rec = (await h.services().ledger(o.orgId).getProposal(p.body.proposalId))!;
  expect(rec.state).toBe("prepared");
  return { proposalId: rec.proposalId, proposalHash: rec.proposalHash };
}

describe("clearance approvals on ordinary proposals", { timeout: 30_000 }, () => {
  it("the approvals route records the caller's role (never a clearance); clearance:* approvals never count", async () => {
    const h = harness();
    const { o, taskId } = await provisionedTask(h);
    const { proposal } = await freezeAndPropose(h, o, taskId, { "index.html": "v2" });
    const p = await prepareAndIntegrate(h, o, proposal.proposalId);
    const a = await h.api("POST", `/api/orgs/${o.orgId}/proposals/${p.proposalId}/approvals`, { token: o.token, body: { proposalHash: p.proposalHash, role: "clearance:self" } });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(a.body.role).toBe("owner");
    const svc = h.services();
    const ledger = svc.ledger(o.orgId);
    const rec = (await ledger.getProposal(p.proposalId))!;
    await ledger.putApproval(o.orgId, { approvalId: "clr-ord-1", proposalId: rec.proposalId, proposalHash: rec.proposalHash, approver: userRef(o.userId), role: "clearance:developer", approvedAt: svc.nowIso() });
    // even with a matching promotions row: the proposal is not a promotion proposal
    const now = svc.nowIso();
    await svc.db
      .prepare("INSERT INTO promotions (promotion_id, org_id, project_id, target_landing_id, landings_json, proposal_id, proposal_hash, state, clearance_kind, cleared_by, requested_by, created_at, updated_at) VALUES ('prm-ord', ?, ?, 'lnd-x', '[]', ?, ?, 'cleared', 'developer', ?, ?, ?, ?)")
      .bind(o.orgId, rec.projectId, rec.proposalId, rec.proposalHash, o.userId, o.userId, now, now)
      .run();
    const kept = await currentApprovals(svc, o.orgId, rec.projectId, await ledger.listApprovals(rec.proposalId), rec);
    expect(kept.map((x) => x.role)).toEqual(["owner"]);
    const input = await acceptInputFor(svc, rec, `${o.orgId}:ord-1`, userRef(o.userId));
    expect(input.approvals.map((x) => x.role)).toEqual(["owner"]);
  });
});
