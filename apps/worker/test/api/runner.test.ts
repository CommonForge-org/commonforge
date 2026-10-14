import { env } from "cloudflare:workers";
import { signJob, type SignedJob } from "@commonforge-org/runner-protocol";
import { describe, expect, it } from "vitest";
import { createServices } from "../../src/context.js";
import { issueJob } from "../../src/services/runner-jobs.js";
import { canonicalNs, codeResource, harness, ownerWithOrg, type Harness } from "../helpers.js";
import { jobHeader } from "../fakes/runner.js";

const tasksNs = (orgId: string) => `commonforge-dev-${orgId}-tasks`;

async function seedJobFixture(h: Harness) {
  const o = await ownerWithOrg(h);
  const web = await codeResource(h, o, "website", { "index.html": "v1" });
  const canonical = h.artifacts.repo(canonicalNs(o.orgId), web.resourceId).info;
  const task = h.artifacts.addRepo(tasksNs(o.orgId), "ws-tw-test1").info;
  const coords = (ns: string, i: { id: string; name: string; remote: string }) => ({ kind: "artifacts" as const, namespace: ns, repoName: i.name, repoId: i.id, remoteUrl: i.remote });
  const job = {
    kind: "seed-workspace" as const,
    taskWorkspaceId: "tw-test1",
    resourceId: web.resourceId,
    canonical: coords(canonicalNs(o.orgId), canonical),
    baseSha: web.sha,
    taskFork: coords(tasksNs(o.orgId), task),
    ref: "refs/heads/main",
  };
  const svc = createServices(env, h.deps);
  const signed = await issueJob(svc, job, { orgId: o.orgId });
  return { o, web, job, signed, svc };
}

describe("runner endpoints: credential broker and results", () => {
  it("mints only what the job names, bounded by the job; revokes on result; refuses afterwards", async () => {
    const h = harness();
    const { o, job, signed, web } = await seedJobFixture(h);
    expect(h.runnerJobs).toHaveLength(1);

    const read = await h.api("POST", "/api/runner/credential", { body: { signedJob: signed, repo: job.canonical, access: "read" } });
    expect(read.status).toBe(200);
    expect(read.body.remoteUrl).toBe(job.canonical.remoteUrl);
    expect(Date.parse(read.body.expiresAt)).toBeLessThanOrEqual(Date.parse(signed.expiresAt) + 1000);
    expect(read.body.token).toMatch(/^art_v2_/);

    // AT-17: a seed job never gets canonical write
    const write = await h.api("POST", "/api/runner/credential", { body: { signedJob: signed, repo: job.canonical, access: "write" } });
    expect(write.status).toBe(403);
    expect(write.body.error.code).toBe("access_exceeds_job");

    const fork = await h.api("POST", "/api/runner/credential", { body: { signedJob: signed, repo: job.taskFork, access: "write" } });
    expect(fork.status).toBe(200);

    const other = { ...job.taskFork, repoName: "ws-other", repoId: "id-other", remoteUrl: job.taskFork.remoteUrl.replace("ws-tw-test1", "ws-other") };
    const notInJob = await h.api("POST", "/api/runner/credential", { body: { signedJob: signed, repo: other, access: "read" } });
    expect(notInJob.status).toBe(403);
    expect(notInJob.body.error.code).toBe("repo_not_in_job");

    const partial = await h.api("POST", "/api/runner/credential", { body: { signedJob: signed, repo: { ...job.canonical, remoteUrl: "https://evil.example/c.git" }, access: "read" } });
    expect(partial.status).toBe(403);
    expect(partial.body.error.code).toBe("identity_mismatch");

    h.artifacts.push(job.taskFork.namespace, job.taskFork.repoName, "main", web.sha);
    const result = { jobId: signed.jobId, ok: true, receipt: { jobId: signed.jobId, taskWorkspaceId: job.taskWorkspaceId, resourceId: job.resourceId, ref: job.ref, sha: job.baseSha, seededAt: new Date().toISOString() } };
    const posted = await h.api("POST", "/api/runner/results", { body: { signedJob: signed, result } });
    expect(posted.status).toBe(201);
    // tokens minted for the job are revoked once its result is in
    expect(h.artifacts.activeTokens(canonicalNs(o.orgId), web.resourceId)).toHaveLength(0);
    expect(h.artifacts.activeTokens(job.taskFork.namespace, job.taskFork.repoName)).toHaveLength(0);
    const after = await h.api("POST", "/api/runner/credential", { body: { signedJob: signed, repo: job.canonical, access: "read" } });
    expect(after.status).toBe(409);
    expect(after.body.error.code).toBe("job_finished");

    // results apply once per jobId
    const again = await h.api("POST", "/api/runner/results", { body: { signedJob: signed, result } });
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
    const different = await h.api("POST", "/api/runner/results", { body: { signedJob: signed, result: { jobId: signed.jobId, ok: false, code: "provider_unavailable", detail: "x" } } });
    expect(different.status).toBe(409);
    expect(different.body.error.code).toBe("result_conflict");
  });

  it("refuses tampered, foreign, unknown-key and expired jobs", async () => {
    const h = harness();
    const { job, signed, svc } = await seedJobFixture(h);
    const tampered: SignedJob = { ...signed, job: { ...signed.job, baseSha: "f".repeat(40) } as SignedJob["job"] };
    const t = await h.api("POST", "/api/runner/credential", { body: { signedJob: tampered, repo: job.canonical, access: "read" } });
    expect(t.status).toBe(403);
    expect(t.body.error.code).toBe("job_invalid");

    // correctly signed but never issued (recorded) by this Worker
    const forged = await signJob({ job, jobId: "job-forged", issuedAt: signed.issuedAt, expiresAt: signed.expiresAt, credentialBroker: signed.credentialBroker }, svc.jobKey());
    const f = await h.api("POST", "/api/runner/credential", { body: { signedJob: forged, repo: job.canonical, access: "read" } });
    expect(f.status).toBe(403);
    expect(f.body.error.code).toBe("job_unknown");

    const otherKey = await signJob({ job, jobId: signed.jobId, issuedAt: signed.issuedAt, expiresAt: signed.expiresAt, credentialBroker: signed.credentialBroker }, { kid: "k1", secret: "another-key-another-key-another-key-0000" });
    expect((await h.api("POST", "/api/runner/credential", { body: { signedJob: otherKey, repo: job.canonical, access: "read" } })).status).toBe(403);

    const later = harness({ now: () => new Date(Date.parse(signed.expiresAt) + 60_000) });
    // the D1 row is shared (same database), so the second harness sees the same job
    const e = await later.api("POST", "/api/runner/credential", { body: { signedJob: signed, repo: job.canonical, access: "read" } });
    expect(e.status).toBe(410);
    expect(e.body.error.code).toBe("job_expired");

    const ek = await h.api("POST", "/api/runner/evidence-key", { body: { signedJob: signed } });
    expect(ek.status).toBe(403);
  });

  it("refuses a repo that was recreated under the same name (repo id changed)", async () => {
    const h = harness();
    const { job, signed } = await seedJobFixture(h);
    h.artifacts.repos.delete(`${job.taskFork.namespace}/${job.taskFork.repoName}`);
    h.artifacts.addRepo(job.taskFork.namespace, job.taskFork.repoName);
    const r = await h.api("POST", "/api/runner/credential", { body: { signedJob: signed, repo: job.taskFork, access: "write" } });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("identity_mismatch");
  });

  it("Task 14 contract: revoke, heads, pull-mode polling and blob scoping", async () => {
    const h = harness();
    const { o, job, signed, web } = await seedJobFixture(h);
    const cred = await h.api("POST", "/api/runner/credential", { body: { signedJob: signed, repo: job.canonical, access: "read" } });
    // revoke at <credentialBroker>/revoke, only for this job's tokens
    expect(signed.credentialBroker).toBe("https://worker.test/api/runner/credential");
    expect((await h.api("POST", "/api/runner/credential/revoke", { body: { signedJob: signed, tokenId: "tok-other" } })).status).toBe(404);
    expect((await h.api("POST", "/api/runner/credential/revoke", { body: { signedJob: signed, tokenId: cred.body.tokenId } })).status).toBe(200);
    expect(h.artifacts.activeTokens(canonicalNs(o.orgId), web.resourceId)).toHaveLength(0);

    const heads = await h.api("POST", "/api/runner/heads", { body: { signedJob: signed } });
    expect(heads.body).toEqual({ heads: { [web.resourceId]: web.revisionId } });

    // pull mode: bearer required; claims each open job once (re-claim only after the claim timeout)
    expect((await h.api("POST", "/api/runner/jobs/next", { body: { runnerId: "r1" } })).status).toBe(401);
    const bearer = "test-runner-bearer-0123456789abcdef";
    // (D1 is shared by this file's tests: drain every open job, ours must come out exactly once)
    const claimed: string[] = [];
    for (let i = 0; i < 50; i++) {
      const next = await h.api("POST", "/api/runner/jobs/next", { token: bearer, body: { runnerId: "r1" } });
      if (next.status === 204) break;
      expect(next.status).toBe(200);
      claimed.push(next.body.signedJob.jobId);
      if (next.body.signedJob.jobId === signed.jobId) expect(next.body).toEqual({ signedJob: signed });
    }
    expect(claimed.filter((id) => id === signed.jobId)).toHaveLength(1);
    expect(new Set(claimed).size).toBe(claimed.length);
    expect((await h.api("POST", "/api/runner/jobs/next", { token: bearer, body: { runnerId: "r2" } })).status).toBe(204);

    // blobs: a seed job names no object
    const blob = await h.api("GET", `/api/runner/blobs/${encodeURIComponent(`org/${o.orgId}/intake/x/upload.zip`)}`, { headers: jobHeader(signed) });
    expect(blob.status).toBe(403);
    expect((await h.api("GET", `/api/runner/blobs/${encodeURIComponent("org/x/y")}`, {})).status).toBe(403);
  });

  it("apply-files reads its ops manifest and only its change's small text uploads, under the folder's staging prefix, and writes nothing", async () => {
    const h = harness();
    const o = await ownerWithOrg(h);
    const web = await codeResource(h, o, "website", { "index.html": "v1" });
    const canonical = h.artifacts.repo(canonicalNs(o.orgId), web.resourceId).info;
    const task = h.artifacts.addRepo(tasksNs(o.orgId), "ws-tw-af1").info;
    const coords = (ns: string, i: { id: string; name: string; remote: string }) => ({ kind: "artifacts" as const, namespace: ns, repoName: i.name, repoId: i.id, remoteUrl: i.remote });
    const prefix = `org/${o.orgId}/lfs/${web.resourceId}/obj/`;
    const manifestKey = `org/${o.orgId}/file-changes/fc-1/ops-1.json`;
    const job = (changeId: string, r2Key: string) => ({
      kind: "apply-files" as const,
      changeId,
      target: { resourceId: web.resourceId, canonical: coords(canonicalNs(o.orgId), canonical), expectedHead: web.revisionId },
      candidateFork: { taskWorkspaceId: "tw-af1", coords: coords(tasksNs(o.orgId), task) },
      opsManifest: { r2Key, sha256: "a".repeat(64), count: 3 },
      author: { name: "Owner", email: "owner@example.test" },
      title: "Uploaded files",
      lfsThresholdBytes: 1_048_576,
    });
    const svc = createServices(env, h.deps);
    const signed = await issueJob(svc, job("fc-1", manifestKey), { orgId: o.orgId, lifetimeSeconds: 3600 });
    // the change this job was issued for: puts lfs-a (small text) and lfs-c (binary); lfs-d is another upload
    const now = new Date().toISOString();
    const obj = (id: string, size: number, binary: number) =>
      env.DB.prepare("INSERT INTO lfs_objects (staging_id, org_id, resource_id, r2_key, size, sha256, binary, state, source, user_id, created_at, updated_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'verified', 'browser', ?, ?, ?, ?)")
        .bind(id, o.orgId, web.resourceId, `${prefix}${id}`, size, "a".repeat(64), binary, o.userId, now, now, now);
    await env.DB.batch([
      obj("lfs-a", 6, 0),
      obj("lfs-c", 6, 1),
      obj("lfs-d", 6, 0),
      env.DB.prepare("INSERT INTO file_changes (change_id, org_id, project_id, resource_id, mount_name, user_id, title, ops_json, has_edits, state, attempt, job_id, created_at, updated_at) VALUES ('fc-1', ?, 'p-x', ?, 'website', ?, 't', '[]', 0, 'applying', 1, ?, ?, ?)")
        .bind(o.orgId, web.resourceId, o.userId, signed.jobId, now, now),
      env.DB.prepare("INSERT INTO file_change_objects (change_id, staging_id) VALUES ('fc-1', 'lfs-a'), ('fc-1', 'lfs-c')"),
    ]);
    const outside = `org/${o.orgId}/intake/lfs-a`;
    const otherManifest = `org/${o.orgId}/file-changes/fc-2/ops-1.json`;
    for (const k of [manifestKey, otherManifest, outside, `${prefix}lfs-a`, `${prefix}lfs-c`, `${prefix}lfs-d`]) await env.COMMONFORGE_ASSETS.put(k, "hello\n");
    // the hash step's etag (what it verified) on each staged object
    for (const id of ["lfs-a", "lfs-c", "lfs-d"]) await env.DB.prepare("UPDATE lfs_objects SET etag = ? WHERE staging_id = ?").bind((await env.COMMONFORGE_ASSETS.head(`${prefix}${id}`))!.etag, id).run();
    const get = (k: string, sj: SignedJob = signed) => h.api("GET", `/api/runner/blobs/${encodeURIComponent(k)}`, { headers: jobHeader(sj) });
    expect((await get(manifestKey)).status).toBe(200);
    expect((await get(`${prefix}lfs-a`)).status).toBe(200);
    expect((await get(otherManifest)).status).toBe(403); // another change's manifest
    expect((await get(outside)).status).toBe(403); // outside the folder's staging prefix
    expect((await get(`${prefix}lfs-c`)).status).toBe(403); // an LFS object: never fetched by the runner
    expect((await get(`${prefix}lfs-d`)).status).toBe(403); // under the prefix, not one of the change's puts
    const listed = `${prefix}lfs-a`;
    // a job whose manifest is not under its own change's prefix reads nothing of it
    const stray = await issueJob(svc, job("fc-1", otherManifest), { orgId: o.orgId, lifetimeSeconds: 3600 });
    expect((await get(otherManifest, stray)).status).toBe(403);
    // and a job no change was issued with reads none of the change's uploads
    expect((await get(listed, stray)).status).toBe(403);
    const write = await h.api("PUT", `/api/runner/blobs/${encodeURIComponent(listed)}`, { raw: "x", headers: jobHeader(signed) });
    expect(write.status).toBe(403);
    expect(write.body.error.code).toBe("scope_violation");
    expect((await h.api("POST", "/api/runner/heads", { body: { signedJob: signed } })).body).toEqual({ heads: { [web.resourceId]: web.revisionId } });

    // a staged upload written again after the hash step verified it is never handed out: 404, rejected
    await env.COMMONFORGE_ASSETS.put(listed, "changed\n");
    expect((await get(listed)).status).toBe(404);
    expect(await env.DB.prepare("SELECT state, error FROM lfs_objects WHERE staging_id = 'lfs-a'").first()).toEqual({ state: "rejected", error: "object_changed" });
    expect((await get(listed)).status).toBe(403); // no longer a verified upload of the change
    expect((await get(manifestKey)).status).toBe(200); // the manifest is not an upload: not pinned
  });
});
