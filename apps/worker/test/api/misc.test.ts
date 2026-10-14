import { sha256HexSync } from "@commonforge-org/core";
import { describe, expect, it } from "vitest";
import { FakeRunner, jobHeader } from "../fakes/runner.js";
import { codeResource, harness, member, ownerWithOrg, projectWith, provisionedTask } from "../helpers.js";

const waitUntil = async (cond: () => Promise<boolean>, ms = 3000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("export, events, audit and stubs", () => {
  it("exports the accepted snapshot through a runner job and serves the items", async () => {
    const h = harness();
    const { o, pid, runner } = await provisionedTask(h);
    const e = await h.api("POST", `/api/orgs/${o.orgId}/projects/${pid}/exports`, { token: o.token });
    expect(e.status).toBe(202);
    await waitUntil(async () => (await h.api("GET", `/api/orgs/${o.orgId}/exports/${e.body.exportId}`, { token: o.token })).body.state === "succeeded");
    expect(runner.errors).toEqual([]);
    const got = await h.api("GET", `/api/orgs/${o.orgId}/exports/${e.body.exportId}`, { token: o.token });
    expect(got.body.receipt.items).toHaveLength(2);
    const dl = await h.api("GET", got.body.downloads[0], { token: o.token });
    expect(dl.status).toBe(200);
    expect(String(dl.body)).toMatch(/^bundle of [0-9a-f]{40}$/);
    // export jobs read canonical only
    const exportJob = runner.handled.find((j) => j.job.kind === "export")!;
    expect(runner.credentials.filter((c) => c.jobId === exportJob.jobId).every((c) => c.access === "read")).toBe(true);
    const outside = await h.api("PUT", `/api/runner/blobs/${encodeURIComponent(`org/${o.orgId}/res/x/obj/${"a".repeat(64)}`)}`, { raw: "x", headers: jobHeader(exportJob) });
    expect(outside.status).toBe(409); // job finished (and the key is outside the sink anyway)
  });

  it("developers see activity and the ledger audit; clients see only client-visible events", async () => {
    const h = harness();
    const { o, pid, web } = await provisionedTask(h);
    const dev = await h.api("GET", `/api/orgs/${o.orgId}/events`, { token: o.token });
    expect(dev.body.events.map((e: any) => e.action)).toEqual(expect.arrayContaining(["org.created", "resource.created", "task.created", "workspace.provisioned"]));
    const audit = await h.api("GET", `/api/orgs/${o.orgId}/audit`, { token: o.token });
    expect(audit.body.audit.map((a: any) => a.action)).toContain("resource.bound");
    const client = await member(h, o, "client");
    await h.api("PUT", `/api/orgs/${o.orgId}/grants`, { token: o.token, body: { userId: client.userId, scope: { kind: "project", id: pid }, operations: ["read"] } });
    await h.api("PUT", `/api/orgs/${o.orgId}/grants`, { token: o.token, body: { userId: client.userId, scope: { kind: "resource", id: web.resourceId }, operations: ["read"] } });
    const ce = await h.api("GET", `/api/orgs/${o.orgId}/events`, { token: client.token });
    expect(ce.body.events.map((e: any) => e.action)).toEqual(["project.created"]);
    expect((await h.api("GET", `/api/orgs/${o.orgId}/audit`, { token: client.token })).status).toBe(403);
  });

  it("editions, previews and releases are 404 to strangers", async () => {
    const h = harness();
    const o = await ownerWithOrg(h);
    // previews and releases are implemented by Task 22 (test/api/previews.test.ts, releases.test.ts); nothing answers 501 any more
    for (const path of [] as string[]) {
      const r = await h.api("POST", `/api/orgs/${o.orgId}/${path}`, { token: o.token, body: {} });
      expect(r.status).toBe(501);
      expect(r.body.error.code).toBe("not_implemented");
    }
    const stranger = await h.signIn("stranger-x@example.test");
    expect((await h.api("GET", `/api/orgs/${o.orgId}/editions`, { token: stranger })).status).toBe(404);
  });
});

describe("assets in a change", () => {
  it("stages, verifies and commits an asset manifest; a code+asset change is accepted together", async () => {
    const h = harness();
    const runner = new FakeRunner(h);
    const o = await ownerWithOrg(h);
    const web = await codeResource(h, o, "website", { "index.html": "v1" });
    const brand = await h.api("POST", `/api/orgs/${o.orgId}/resources`, { token: o.token, body: { name: "brand", provider: "r2-assets" } });
    const pid = await projectWith(h, o, [
      { mountName: "website", resourceId: web.resourceId },
      { mountName: "brand", resourceId: brand.body.resourceId },
    ]);
    const t = await h.api("POST", `/api/orgs/${o.orgId}/projects/${pid}/tasks`, { token: o.token, body: { title: "new logo", writeMounts: ["website", "brand"] } });
    await h.drainSteps();
    const lease = await h.api("POST", `/api/tasks/${t.body.taskId}/lease`, { token: o.token, body: {} });
    const agent = lease.body.leaseToken;

    const logo = new TextEncoder().encode("PNG-bytes-of-the-new-logo");
    const stage = await h.api("POST", `/api/tasks/${t.body.taskId}/assets/stage`, { token: agent, body: { mountName: "brand", path: "logo.png", size: logo.length, mime: "image/png" } });
    expect(stage.status).toBe(200);
    const up = await h.api("PUT", stage.body.uploadUrl, { token: agent, raw: logo, headers: { "content-length": String(logo.length) } });
    expect(up.status).toBe(201);
    const wrongSha = await h.api("POST", `/api/tasks/${t.body.taskId}/assets/commit`, { token: agent, body: { mountName: "brand", changes: [{ path: "logo.png", stagingKey: stage.body.stagingKey, sha256: "0".repeat(64), mime: "image/png" }] } });
    expect(wrongSha.status).toBe(400);
    const commit = await h.api("POST", `/api/tasks/${t.body.taskId}/assets/commit`, { token: agent, body: { mountName: "brand", changes: [{ path: "logo.png", stagingKey: stage.body.stagingKey, sha256: sha256HexSync(logo), mime: "image/png" }] } });
    expect(commit.status).toBe(200);
    const task = (await h.api("GET", `/api/tasks/${t.body.taskId}`, { token: agent })).body;
    const brandWs = task.workspaces.find((w: any) => w.mountName === "brand");
    const webWs = task.workspaces.find((w: any) => w.mountName === "website");
    expect((await h.api("POST", `/api/tasks/${t.body.taskId}/workspaces/${brandWs.taskWorkspaceId}/freeze`, { token: agent, body: {} })).status).toBe(200);

    const cred = await h.api("POST", `/api/tasks/${t.body.taskId}/credential`, { token: agent, body: { mountName: "website", access: "write" } });
    const where = h.artifacts.tokenByPlaintext(cred.body.secret)!;
    const base = h.artifacts.repo(where.ns, where.name).refs.get("main")!;
    const sha = h.artifacts.makeCommit({ "index.html": "<img src=logo.png>" }, [base]);
    h.artifacts.push(where.ns, where.name, "main", sha);
    expect((await h.api("POST", `/api/tasks/${t.body.taskId}/workspaces/${webWs.taskWorkspaceId}/freeze`, { token: agent, body: { expectedSha: sha } })).status).toBe(201);

    const p = await h.api("POST", `/api/orgs/${o.orgId}/proposals`, { token: o.token, body: { taskId: t.body.taskId } });
    expect(p.status).toBe(201);
    expect(p.body.assetManifestChanges).toEqual([expect.objectContaining({ resourceId: brand.body.resourceId, newManifestId: commit.body.manifestId })]);
    await h.drainSteps();
    expect((await h.api("POST", `/api/orgs/${o.orgId}/proposals/${p.body.proposalId}/integrate`, { token: o.token })).status).toBe(202);
    await waitUntil(async () => (await h.api("GET", `/api/orgs/${o.orgId}/proposals/${p.body.proposalId}`, { token: o.token })).body.integration?.forCurrentHash === true);
    await h.api("POST", `/api/orgs/${o.orgId}/proposals/${p.body.proposalId}/approvals`, { token: o.token, body: { proposalHash: p.body.proposalHash } });
    const acc = await h.api("POST", `/api/orgs/${o.orgId}/proposals/${p.body.proposalId}/accept`, { token: o.token, body: { idempotencyKey: "accept-mixed" } });
    expect(acc.status).toBe(200);
    expect(runner.errors).toEqual([]);
    const brandHead = (await h.api("GET", `/api/orgs/${o.orgId}/resources/${brand.body.resourceId}`, { token: o.token })).body.head;
    expect(brandHead.revisionId).toBe(`r2m:${commit.body.manifestId}`);
    const file = await h.api("GET", `/api/orgs/${o.orgId}/projects/${pid}/file?mount=brand&path=logo.png`, { token: o.token });
    expect(file.body).toBe("PNG-bytes-of-the-new-logo");
  });
});
