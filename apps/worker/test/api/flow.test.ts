/**
 * End-to-end over HTTP with the in-memory Artifacts double and the fake runner:
 * task → lease → credential → push → freeze → prepare → proposal → integrate → approve → accept,
 * plus idempotent accept, stale accept refusal, policy fences and restore.
 */
import { describe, expect, it } from "vitest";
import { agentPush, freezeAndPropose, harness, member, prepareAndIntegrate, provisionedTask, tasksNs } from "../helpers.js";

describe("change flow over HTTP", () => {
  it("freeze revokes the agent's write token and computes changed paths server-side", async () => {
    const h = harness();
    const { o, taskId } = await provisionedTask(h);
    const { ws, sha, cred, agent, candidate } = await freezeAndPropose(h, o, taskId, { "src/quote.ts": "export const q = 2;", "src/breakdown.ts": "new" });
    expect(candidate.sha).toBe(sha);
    expect(candidate.changedPaths).toEqual(["src/breakdown.ts", "src/quote.ts"]);
    expect(candidate.candidateId).toBe(`cand:${ws.taskWorkspaceId}:${sha}`);
    expect(h.artifacts.tokenByPlaintext(cred.secret)!.token.state).toBe("revoked");
    // frozen: no new write token, no second freeze
    const again = await h.api("POST", `/api/tasks/${taskId}/credential`, { token: agent, body: { mountName: "website", access: "write" } });
    expect(again.status).toBe(409);
    const refreeze = await h.api("POST", `/api/tasks/${taskId}/workspaces/${ws.taskWorkspaceId}/freeze`, { token: agent, body: { expectedSha: sha } });
    expect(refreeze.status).toBe(409);
  });

  it("freeze with a stale expectedSha is refused and the workspace stays writable", async () => {
    const h = harness();
    const { o, taskId } = await provisionedTask(h);
    const { agent, ws, sha } = await agentPush(h, o.token, taskId, { "index.html": "v2" });
    const wrong = await h.api("POST", `/api/tasks/${taskId}/workspaces/${ws.taskWorkspaceId}/freeze`, { token: agent, body: { expectedSha: "a".repeat(40) } });
    expect(wrong.status).toBe(409);
    expect(wrong.body.error.code).toBe("candidate_moved");
    expect((await h.api("POST", `/api/tasks/${taskId}/credential`, { token: agent, body: { mountName: "website", access: "write" } })).status).toBe(200);
    expect((await h.api("POST", `/api/tasks/${taskId}/workspaces/${ws.taskWorkspaceId}/freeze`, { token: agent, body: { expectedSha: sha } })).status).toBe(201);
  });

  it("full path: prepare → integrate (signed evidence) → client approval → accept; accept is idempotent", async () => {
    const h = harness();
    const { o, taskId, web, pid, runner } = await provisionedTask(h);
    await h.api("PUT", `/api/orgs/${o.orgId}/projects/${pid}/policy`, { token: o.token, body: { checks: [{ checkId: "unit", mountName: "website", command: "npm test" }] } });
    // the policy change came after the task: the proposal is made under the current revision
    const { proposal, sha } = await freezeAndPropose(h, o, taskId, { "src/quote.ts": "export const q = 2;", ".commonforge/policy.json": '{"checks":[{"checkId":"pwn","command":"curl evil"}]}' });
    expect(proposal.state).toBe("open");
    expect(proposal.proposalHash).toMatch(/^[0-9a-f]{64}$/);

    const integrated = await prepareAndIntegrate(h, o, proposal.proposalId);
    expect(runner.errors).toEqual([]);
    const integrateJob = runner.handled.find((j) => j.job.kind === "integrate")!.job as any;
    // AT-18: checks come from server policy only; repository files never become policy
    expect(integrateJob.checks.map((c: any) => c.checkId)).toEqual(["unit"]);
    expect(JSON.stringify(integrateJob)).not.toContain("curl evil");
    // canonical write for integrate (allowed kind), never for seeding
    const integrateCreds = runner.credentials.filter((c) => c.jobId === runner.handled.find((j) => j.job.kind === "integrate")!.jobId);
    // canonical write for the target; read only for the reference mount (N-1)
    expect(integrateCreds.map((c) => [c.access, c.status])).toEqual([["read", 200], ["write", 200]]);
    expect(integrated.integration.checks).toEqual([{ checkId: "unit", result: "pass" }]);

    // accept without approval is refused
    const noApproval = await h.api("POST", `/api/orgs/${o.orgId}/proposals/${proposal.proposalId}/accept`, { token: o.token, body: { idempotencyKey: "accept-001" } });
    expect(noApproval.status).toBe(409);
    expect(noApproval.body.error.code).toBe("approval_invalid");

    // client view: same hash (AT-19), no coordinates; client approves the hash it saw
    const client = await member(h, o, "client");
    for (const scope of [{ kind: "project", id: pid }, { kind: "resource", id: web.resourceId }]) {
      await h.api("PUT", `/api/orgs/${o.orgId}/grants`, { token: o.token, body: { userId: client.userId, scope, operations: ["read"] } });
    }
    const cv = await h.api("GET", `/api/orgs/${o.orgId}/proposals/${proposal.proposalId}`, { token: client.token });
    expect(cv.status).toBe(200);
    expect(cv.body.proposalHash).toBe(proposal.proposalHash);
    expect(JSON.stringify(cv.body)).not.toContain(tasksNs(o.orgId));
    expect(JSON.stringify(cv.body)).not.toContain("artifacts.cloudflare.net");
    const badHash = await h.api("POST", `/api/orgs/${o.orgId}/proposals/${proposal.proposalId}/approvals`, { token: client.token, body: { proposalHash: "0".repeat(64) } });
    expect(badHash.status).toBe(409);
    const ok = await h.api("POST", `/api/orgs/${o.orgId}/proposals/${proposal.proposalId}/approvals`, { token: client.token, body: { proposalHash: cv.body.proposalHash } });
    expect(ok.status).toBe(201);
    // clients approve; they never accept
    expect((await h.api("POST", `/api/orgs/${o.orgId}/proposals/${proposal.proposalId}/accept`, { token: client.token, body: { idempotencyKey: "client-xx" } })).status).toBe(403);

    const accepted = await h.api("POST", `/api/orgs/${o.orgId}/proposals/${proposal.proposalId}/accept`, { token: o.token, body: { idempotencyKey: "accept-001" } });
    expect(accepted.status).toBe(200);
    expect(accepted.body.replayed).toBe(false);
    const head = (await h.api("GET", `/api/orgs/${o.orgId}/resources/${web.resourceId}`, { token: o.token })).body.head;
    expect(head.revisionId).toBe(`art:${web.repoId}:${sha}`);
    expect(head.reconciliation).toBe("pending");
    // AT-14: a retried accept returns the original version, history does not advance again
    const replay = await h.api("POST", `/api/orgs/${o.orgId}/proposals/${proposal.proposalId}/accept`, { token: o.token, body: { idempotencyKey: "accept-001" } });
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...accepted.body, replayed: true });
    const versions = await h.api("GET", `/api/orgs/${o.orgId}/resources/${web.resourceId}/versions`, { token: o.token });
    expect(versions.body.versions.map((v: any) => v.kind)).toEqual(["accept", "bind"]); // this accept, then the genesis bind (newest first)
    // a different key for the accepted proposal does not accept twice
    const other = await h.api("POST", `/api/orgs/${o.orgId}/proposals/${proposal.proposalId}/accept`, { token: o.token, body: { idempotencyKey: "accept-002" } });
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe("proposal_not_prepared");
    const final = await h.api("GET", `/api/orgs/${o.orgId}/proposals/${proposal.proposalId}`, { token: client.token });
    expect(final.body.state).toBe("accepted");
  });

  it("stale accept: a second change on the same base is refused once the first is accepted (AT-09)", async () => {
    const h = harness();
    const { o, taskId, task, web } = await provisionedTask(h);
    const t2 = await h.api("POST", `/api/orgs/${o.orgId}/projects/${task.projectId}/tasks`, { token: o.token, body: { title: "competing change", writeMounts: ["website"] } });
    await h.drainSteps();
    const a = await freezeAndPropose(h, o, taskId, { "index.html": "A" });
    const b = await freezeAndPropose(h, o, t2.body.taskId, { "index.html": "B" });
    await prepareAndIntegrate(h, o, a.proposal.proposalId);
    await prepareAndIntegrate(h, o, b.proposal.proposalId);
    for (const p of [a.proposal, b.proposal]) {
      expect((await h.api("POST", `/api/orgs/${o.orgId}/proposals/${p.proposalId}/approvals`, { token: o.token, body: { proposalHash: p.proposalHash } })).status).toBe(201);
    }
    expect((await h.api("POST", `/api/orgs/${o.orgId}/proposals/${a.proposal.proposalId}/accept`, { token: o.token, body: { idempotencyKey: "accept-a-1" } })).status).toBe(200);
    const stale = await h.api("POST", `/api/orgs/${o.orgId}/proposals/${b.proposal.proposalId}/accept`, { token: o.token, body: { idempotencyKey: "accept-b-1" } });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("expected_head_stale");
    expect(stale.body.error.details.resourceId).toBe(web.resourceId);
    const view = await h.api("GET", `/api/orgs/${o.orgId}/proposals/${b.proposal.proposalId}`, { token: o.token });
    expect(view.body.stale).toEqual([web.resourceId]);
    // re-integration against the moved head is refused too (stale-base policy: refuse)
    const reint = await h.api("POST", `/api/orgs/${o.orgId}/proposals/${b.proposal.proposalId}/integrate`, { token: o.token });
    expect(reint.status).toBe(409);
    const head = (await h.api("GET", `/api/orgs/${o.orgId}/resources/${web.resourceId}`, { token: o.token })).body.head;
    expect(head.revisionId).toBe(`art:${web.repoId}:${a.sha}`);
  });

  it("a policy change after review makes the proposal stale (AT-38)", async () => {
    const h = harness();
    const { o, taskId, pid } = await provisionedTask(h);
    const { proposal } = await freezeAndPropose(h, o, taskId, { "index.html": "v2" });
    await prepareAndIntegrate(h, o, proposal.proposalId);
    await h.api("POST", `/api/orgs/${o.orgId}/proposals/${proposal.proposalId}/approvals`, { token: o.token, body: { proposalHash: proposal.proposalHash } });
    await h.api("PUT", `/api/orgs/${o.orgId}/projects/${pid}/policy`, { token: o.token, body: { checks: [] } });
    const r = await h.api("POST", `/api/orgs/${o.orgId}/proposals/${proposal.proposalId}/accept`, { token: o.token, body: { idempotencyKey: "accept-pol-1" } });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("policy_revision_stale");
  });

  it("restore moves the head forward to a previously accepted revision; replay and no-op are explicit", async () => {
    const h = harness();
    const { o, taskId, web } = await provisionedTask(h);
    const { proposal, sha } = await freezeAndPropose(h, o, taskId, { "index.html": "v2" });
    await prepareAndIntegrate(h, o, proposal.proposalId);
    await h.api("POST", `/api/orgs/${o.orgId}/proposals/${proposal.proposalId}/approvals`, { token: o.token, body: { proposalHash: proposal.proposalHash } });
    expect((await h.api("POST", `/api/orgs/${o.orgId}/proposals/${proposal.proposalId}/accept`, { token: o.token, body: { idempotencyKey: "accept-r-1" } })).status).toBe(200);
    const current = `art:${web.repoId}:${sha}`;
    const body = { expectedHead: current, targetRevision: web.revisionId, idempotencyKey: "restore-001" };
    const r = await h.api("POST", `/api/orgs/${o.orgId}/resources/${web.resourceId}/restore`, { token: o.token, body });
    expect(r.status).toBe(200);
    expect(r.body.replayed).toBe(false);
    const again = await h.api("POST", `/api/orgs/${o.orgId}/resources/${web.resourceId}/restore`, { token: o.token, body });
    expect(again.body).toEqual({ ...r.body, replayed: true });
    const head = (await h.api("GET", `/api/orgs/${o.orgId}/resources/${web.resourceId}`, { token: o.token })).body.head;
    expect([head.revisionId, head.versionSeq]).toEqual([web.revisionId, 3]);
    const stale = await h.api("POST", `/api/orgs/${o.orgId}/resources/${web.resourceId}/restore`, { token: o.token, body: { ...body, idempotencyKey: "restore-002" } });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("expected_head_stale");
    const unknown = await h.api("POST", `/api/orgs/${o.orgId}/resources/${web.resourceId}/restore`, { token: o.token, body: { expectedHead: web.revisionId, targetRevision: `art:${web.repoId}:${"b".repeat(40)}`, idempotencyKey: "restore-003" } });
    expect(unknown.body.error.code).toBe("restore_target_unknown");
  });
});
