/**
 * Assets-only proposals (follow-up Task 23): a change whose only content is an R2 asset manifest (a
 * logo replacement) is integrated like any other — an `integrate` job with no git targets runs the
 * policy checks against the snapshot's git mounts (all references) and signs evidence with an empty
 * merge outcome — and accept uses that evidence. Negatives: a failing required check, no
 * integration at all, and a base that moved.
 */
import { sha256HexSync } from "@commonforge-org/core";
import { describe, expect, it } from "vitest";
import { FakeRunner } from "../fakes/runner.js";
import { codeResource, harness, ownerWithOrg, projectWith, waitUntil, type Harness } from "../helpers.js";

type Owner = { token: string; orgId: string; userId: string };

async function newTask(h: Harness, o: Owner, pid: string, body: Record<string, unknown>): Promise<{ taskId: string; agent: string }> {
  const t = await h.api("POST", `/api/orgs/${o.orgId}/projects/${pid}/tasks`, { token: o.token, body: { title: "replace the logo", ...body } });
  expect(t.status).toBe(201);
  await h.drainSteps();
  const l = await h.api("POST", `/api/tasks/${t.body.taskId}/lease`, { token: o.token, body: {} });
  expect(l.status).toBe(200);
  return { taskId: t.body.taskId as string, agent: l.body.leaseToken as string };
}

/** Stage, upload, commit and freeze `files` in the task's `mount`; returns the frozen manifest id. */
async function commitAndFreeze(h: Harness, taskId: string, agent: string, mount: string, files: Record<string, string>): Promise<string> {
  const changes = [];
  for (const [path, text] of Object.entries(files)) {
    const bytes = new TextEncoder().encode(text);
    const stage = await h.api("POST", `/api/tasks/${taskId}/assets/stage`, { token: agent, body: { mountName: mount, path, size: bytes.length, mime: "image/svg+xml" } });
    expect(stage.status).toBe(200);
    expect((await h.api("PUT", stage.body.uploadUrl, { token: agent, raw: bytes, headers: { "content-length": String(bytes.length) } })).status).toBe(201);
    changes.push({ path, stagingKey: stage.body.stagingKey, sha256: sha256HexSync(bytes), mime: "image/svg+xml" });
  }
  const commit = await h.api("POST", `/api/tasks/${taskId}/assets/commit`, { token: agent, body: { mountName: mount, changes } });
  expect(commit.status).toBe(200);
  const ws = (await h.api("GET", `/api/tasks/${taskId}`, { token: agent })).body.workspaces.find((w: any) => w.mountName === mount);
  expect((await h.api("POST", `/api/tasks/${taskId}/workspaces/${ws.taskWorkspaceId}/freeze`, { token: agent, body: {} })).status).toBe(200);
  return commit.body.manifestId as string;
}

/** A project with `website` (git) and `brand` (R2, genesis = empty manifest) and a required website check. */
async function world(runnerOpts: ConstructorParameters<typeof FakeRunner>[1] = {}) {
  const h = harness();
  const runner = new FakeRunner(h, runnerOpts);
  const o = await ownerWithOrg(h);
  const web = await codeResource(h, o, "website", { "index.html": '<img src="logo.svg">' });
  const brand = await h.api("POST", `/api/orgs/${o.orgId}/resources`, { token: o.token, body: { name: "brand", provider: "r2-assets" } });
  expect(brand.status).toBe(201);
  const pid = await projectWith(h, o, [
    { mountName: "website", resourceId: web.resourceId },
    { mountName: "brand", resourceId: brand.body.resourceId },
  ]);
  const policy = await h.api("PUT", `/api/orgs/${o.orgId}/projects/${pid}/policy`, { token: o.token, body: { checks: [{ checkId: "site-test", mountName: "website", command: "npm test" }] } });
  expect(policy.status).toBe(200);
  return { h, runner, o, pid, web, brandId: brand.body.resourceId as string };
}

/** A logo-only proposal, prepared (the Worker prepares asset changes itself). */
async function logoProposal(w: Awaited<ReturnType<typeof world>>, svg: string) {
  const { h, o, pid } = w;
  const { taskId, agent } = await newTask(h, o, pid, { writeMounts: ["brand"], readMounts: ["website"] });
  const manifestId = await commitAndFreeze(h, taskId, agent, "brand", { "logo.svg": svg });
  const p = await h.api("POST", `/api/orgs/${o.orgId}/proposals`, { token: o.token, body: { taskId } });
  expect(p.status).toBe(201);
  await h.drainSteps();
  const view = await h.api("GET", `/api/orgs/${o.orgId}/proposals/${p.body.proposalId}`, { token: o.token });
  expect(view.body.state).toBe("prepared");
  expect(view.body.resourceChanges).toEqual([]);
  expect(view.body.assetManifestChanges).toMatchObject([{ resourceId: w.brandId, newManifestId: manifestId }]);
  return { proposalId: p.body.proposalId as string, proposalHash: p.body.proposalHash as string, manifestId };
}

const path = (o: Owner, id: string, rest = "") => `/api/orgs/${o.orgId}/proposals/${id}${rest}`;

describe("assets-only proposals: integrate → approve → accept", () => {
  it("a logo-only proposal is validated by an integrate job with no git targets and accepted as a new version with the new manifest", async () => {
    const w = await world();
    const { h, runner, o, web, brandId } = w;
    const genesis = (await h.api("GET", `/api/orgs/${o.orgId}/resources/${brandId}`, { token: o.token })).body.head.revisionId as string;
    const p = await logoProposal(w, "<svg>teal logo v2</svg>");

    // accept before validation: no evidence for this hash
    expect((await h.api("POST", path(o, p.proposalId, "/approvals"), { token: o.token, body: { proposalHash: p.proposalHash } })).status).toBe(201);
    const early = await h.api("POST", path(o, p.proposalId, "/accept"), { token: o.token, body: { idempotencyKey: "logo-early" } });
    expect([early.status, early.body.error.code]).toEqual([409, "evidence_missing"]);

    const integrate = await h.api("POST", path(o, p.proposalId, "/integrate"), { token: o.token });
    expect(integrate.status).toBe(202);
    await waitUntil(async () => (await h.api("GET", path(o, p.proposalId), { token: o.token })).body.integration?.forCurrentHash === true);
    expect(runner.errors).toEqual([]);

    // the job: no candidates or targets, the asset change, every git mount a read-only reference
    const handled = runner.handled.find((j) => j.job.kind === "integrate")!;
    const job = handled.job as any;
    expect(job.candidates).toEqual([]);
    expect(job.targets).toEqual([]);
    expect(job.assetChanges).toEqual([{ resourceId: brandId, baseManifestId: genesis.slice(4), newManifestId: p.manifestId }]);
    expect(job.references.map((r: any) => r.resourceId)).toEqual([web.resourceId]);
    expect(job.checks.map((c: any) => c.checkId)).toEqual(["site-test"]);
    // read access to the reference only: no canonical write for an assets-only job
    expect(runner.credentials.filter((c) => c.jobId === handled.jobId).map((c) => [c.access, c.status])).toEqual([["read", 200]]);

    const view = (await h.api("GET", path(o, p.proposalId), { token: o.token })).body;
    expect(view.integration).toMatchObject({ forCurrentHash: true, checks: [{ checkId: "site-test", result: "pass" }], mergeOutcome: [] });
    expect(view.lastAttempt).toMatchObject({ state: "succeeded", code: null, mergeOutcome: [], signedEvidence: true });
    const events = (await h.api("GET", `/api/orgs/${o.orgId}/events?subjectId=${p.proposalId}`, { token: o.token })).body;
    expect(JSON.stringify(events)).toContain("proposal.integrated");

    // the approval given before integration still counts (the hash did not change)
    const accepted = await h.api("POST", path(o, p.proposalId, "/accept"), { token: o.token, body: { idempotencyKey: "logo-accept" } });
    expect(accepted.status).toBe(200);
    expect(accepted.body.replayed).toBe(false);
    const head = (await h.api("GET", `/api/orgs/${o.orgId}/resources/${brandId}`, { token: o.token })).body.head;
    expect(head.revisionId).toBe(`r2m:${p.manifestId}`);
    expect(head.acceptedVersionId).toBe(accepted.body.acceptedVersionId);
    const versions = (await h.api("GET", `/api/orgs/${o.orgId}/resources/${brandId}/versions`, { token: o.token })).body.versions;
    expect(versions.map((v: any) => v.kind)).toEqual(["accept", "bind"]);
    expect(versions[0].acceptedVersionId).toBe(accepted.body.acceptedVersionId);
    // the website did not move
    expect((await h.api("GET", `/api/orgs/${o.orgId}/resources/${web.resourceId}`, { token: o.token })).body.head.revisionId).toBe(web.revisionId);
    expect((await h.api("GET", path(o, p.proposalId), { token: o.token })).body.state).toBe("accepted");
  });

  it("a failing required check refuses: check_failed at integrate, evidence_missing at accept", async () => {
    const w = await world({ integrateFailure: { code: "check_failed", detail: "check site-test (npm test) exit 1" }, failChecks: ["site-test"] });
    const { h, o, brandId } = w;
    const p = await logoProposal(w, "<svg>broken</svg>");
    expect((await h.api("POST", path(o, p.proposalId, "/integrate"), { token: o.token })).status).toBe(202);
    await waitUntil(async () => (await h.api("GET", path(o, p.proposalId), { token: o.token })).body.lastAttempt?.state === "failed");
    const view = (await h.api("GET", path(o, p.proposalId), { token: o.token })).body;
    expect(view.lastAttempt).toMatchObject({ code: "check_failed", checks: [{ checkId: "site-test", result: "fail" }], mergeOutcome: [], signedEvidence: true });
    expect(view.integration).toBeNull();
    await h.api("POST", path(o, p.proposalId, "/approvals"), { token: o.token, body: { proposalHash: p.proposalHash } });
    const r = await h.api("POST", path(o, p.proposalId, "/accept"), { token: o.token, body: { idempotencyKey: "logo-fail" } });
    expect([r.status, r.body.error.code]).toEqual([409, "evidence_missing"]);
    expect((await h.api("GET", `/api/orgs/${o.orgId}/resources/${brandId}`, { token: o.token })).body.head.revisionId).not.toBe(`r2m:${p.manifestId}`);
  });

  it("a successful run whose evidence reports a failed required check is refused by the ledger at accept", async () => {
    // defence in depth: even a receipt with a failing required check never accepts
    const w = await world({ failChecks: ["site-test"] });
    const { h, o } = w;
    const p = await logoProposal(w, "<svg>v3</svg>");
    expect((await h.api("POST", path(o, p.proposalId, "/integrate"), { token: o.token })).status).toBe(202);
    await waitUntil(async () => (await h.api("GET", path(o, p.proposalId), { token: o.token })).body.integration?.forCurrentHash === true);
    await h.api("POST", path(o, p.proposalId, "/approvals"), { token: o.token, body: { proposalHash: p.proposalHash } });
    const r = await h.api("POST", path(o, p.proposalId, "/accept"), { token: o.token, body: { idempotencyKey: "logo-failed-check" } });
    expect([r.status, r.body.error.code]).toEqual([409, "evidence_missing"]);
  });

  it("accept refuses the second of two validated, approved logo proposals on the same base; the head stays the first (review m-4)", async () => {
    const w = await world();
    const { h, o, brandId } = w;
    const a = await logoProposal(w, "<svg>A</svg>");
    const b = await logoProposal(w, "<svg>B</svg>");
    for (const p of [a, b]) {
      expect((await h.api("POST", path(o, p.proposalId, "/integrate"), { token: o.token })).status).toBe(202);
      await waitUntil(async () => (await h.api("GET", path(o, p.proposalId), { token: o.token })).body.integration?.forCurrentHash === true);
      expect((await h.api("POST", path(o, p.proposalId, "/approvals"), { token: o.token, body: { proposalHash: p.proposalHash } })).status).toBe(201);
    }
    expect((await h.api("POST", path(o, a.proposalId, "/accept"), { token: o.token, body: { idempotencyKey: "logo-accept-first" } })).status).toBe(200);
    const r = await h.api("POST", path(o, b.proposalId, "/accept"), { token: o.token, body: { idempotencyKey: "logo-accept-second" } });
    expect([r.status, r.body.error.code, r.body.error.details?.resourceId]).toEqual([409, "expected_head_stale", brandId]);
    expect((await h.api("GET", `/api/orgs/${o.orgId}/resources/${brandId}`, { token: o.token })).body.head.revisionId).toBe(`r2m:${a.manifestId}`);
  });

  it("a mixed proposal (git + assets) gets a job with targets and no assetChanges, as before (review M-1)", async () => {
    const w = await world();
    const { h, runner, o, pid } = w;
    const { taskId, agent } = await newTask(h, o, pid, { writeMounts: ["website", "brand"], readMounts: [] });
    const manifestId = await commitAndFreeze(h, taskId, agent, "brand", { "logo.svg": "<svg>mixed</svg>" });
    const cred = await h.api("POST", `/api/tasks/${taskId}/credential`, { token: agent, body: { mountName: "website", access: "write" } });
    const where = h.artifacts.tokenByPlaintext(cred.body.secret)!;
    const base = h.artifacts.repo(where.ns, where.name).refs.get("main")!;
    const sha = h.artifacts.makeCommit({ "index.html": '<img src="logo.svg?v=2">' }, [base]);
    h.artifacts.push(where.ns, where.name, "main", sha);
    const webWs = (await h.api("GET", `/api/tasks/${taskId}`, { token: agent })).body.workspaces.find((x: any) => x.mountName === "website");
    expect((await h.api("POST", `/api/tasks/${taskId}/workspaces/${webWs.taskWorkspaceId}/freeze`, { token: agent, body: { expectedSha: sha } })).status).toBe(201);
    const p = await h.api("POST", `/api/orgs/${o.orgId}/proposals`, { token: o.token, body: { taskId } });
    expect(p.status).toBe(201);
    await h.drainSteps();
    expect((await h.api("POST", path(o, p.body.proposalId, "/integrate"), { token: o.token })).status).toBe(202);
    await waitUntil(async () => (await h.api("GET", path(o, p.body.proposalId), { token: o.token })).body.integration?.forCurrentHash === true);
    const job = runner.handled.find((j) => j.job.kind === "integrate")!.job as any;
    expect(job.targets.map((t: any) => t.resourceId)).toEqual([w.web.resourceId]);
    expect(job).not.toHaveProperty("assetChanges");
    await h.api("POST", path(o, p.body.proposalId, "/approvals"), { token: o.token, body: { proposalHash: p.body.proposalHash } });
    expect((await h.api("POST", path(o, p.body.proposalId, "/accept"), { token: o.token, body: { idempotencyKey: "mixed-accept" } })).status).toBe(200);
    expect((await h.api("GET", `/api/orgs/${o.orgId}/resources/${w.brandId}`, { token: o.token })).body.head.revisionId).toBe(`r2m:${manifestId}`);
  });

  it("integrate refuses an assets-only proposal whose base manifest is no longer the head; previews are refused", async () => {
    const w = await world();
    const { h, o } = w;
    const a = await logoProposal(w, "<svg>A</svg>");
    const b = await logoProposal(w, "<svg>B</svg>");
    expect((await h.api("POST", path(o, a.proposalId, "/integrate"), { token: o.token })).status).toBe(202);
    await waitUntil(async () => (await h.api("GET", path(o, a.proposalId), { token: o.token })).body.integration?.forCurrentHash === true);
    await h.api("POST", path(o, a.proposalId, "/approvals"), { token: o.token, body: { proposalHash: a.proposalHash } });
    const acc = await h.api("POST", path(o, a.proposalId, "/accept"), { token: o.token, body: { idempotencyKey: "logo-accept-a" } });
    expect(acc.status, JSON.stringify(acc.body)).toBe(200);
    const stale = await h.api("POST", path(o, b.proposalId, "/integrate"), { token: o.token });
    expect([stale.status, stale.body.error.code, stale.body.error.details?.resourceId]).toEqual([409, "expected_head_stale", w.brandId]);
    // there is no code to preview in an assets-only proposal
    const pv = await h.api("POST", path(o, b.proposalId, "/previews"), { token: o.token });
    expect([pv.status, pv.body.error.code]).toEqual([409, "nothing_to_preview"]);
  });
});
