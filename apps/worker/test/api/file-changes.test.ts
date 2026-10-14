import { sha256Hex } from "@commonforge-org/core";
import { gitattributesLfsEntry, lfsPointer, parseLfsPointer } from "@commonforge-org/runner-protocol";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { codeResource, fileCollection, member, waitUntil, type Harness } from "../helpers.js";
import type { FakeRunner } from "../fakes/runner.js";
import { CONFIG_JSON, uploadFile, world } from "../lfs/lfs-helpers.js";

type Owner = { token: string; orgId: string };

const MiB = 1_048_576;
const text = (s: string) => new TextEncoder().encode(s);
/** a 2 MiB binary file (NUL bytes) */
const video = () => new Uint8Array(2 * MiB).map((_, i) => (i % 7 === 0 ? 0 : i % 251));

const postChange = (h: Harness, token: string, org: string, pid: string, body: unknown, mount = "site") => h.api("POST", `/api/orgs/${org}/projects/${pid}/folders/${mount}/changes`, { token, body });
const getChange = (h: Harness, token: string, org: string, id: string) => h.api("GET", `/api/orgs/${org}/file-changes/${id}`, { token });

/** Drain steps and wait for the fake runner until the change has a proposal or ended. */
async function settle(h: Harness, o: Owner, changeId: string) {
  for (let i = 0; i < 50; i++) {
    await h.drainSteps();
    const r = await getChange(h, o.token, o.orgId, changeId);
    if (r.body.proposalId || r.body.state === "added" || r.body.state === "failed") {
      await h.drainSteps(); // candidate.prepare
      return (await getChange(h, o.token, o.orgId, changeId)).body;
    }
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error("change did not settle");
}

/** Drain steps until the change landed (added), failed, or waits for an approval. */
async function land(h: Harness, o: Owner, changeId: string) {
  for (let i = 0; i < 150; i++) {
    await h.drainSteps();
    const r = await getChange(h, o.token, o.orgId, changeId);
    if (["added", "failed", "waiting_approval"].includes(r.body.state)) return r.body;
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error("change did not land");
}

/** The task repo's `main` (where apply-files pushed the change) as a file map. */
function taskTree(h: Harness, runner: FakeRunner, changeId: string): Record<string, string> {
  const jobs = runner.handled.filter((j) => j.job.kind === "apply-files" && (j.job as { changeId: string }).changeId === changeId);
  const job = jobs[jobs.length - 1]!.job as { candidateFork: { coords: { namespace: string; repoName: string } } };
  const sha = h.artifacts.repo(job.candidateFork.coords.namespace, job.candidateFork.coords.repoName).refs.get("main")!;
  return h.artifacts.files.get(sha)!;
}

const applyJobs = (h: Harness, changeId: string) => (h.runnerJobs as Array<{ signedJob: { job: { kind: string; changeId?: string } } }>).filter((m) => m.signedJob.job.kind === "apply-files" && m.signedJob.job.changeId === changeId);

/** The resolved operations of an apply-files job, read from its R2 manifest (checked against the job's sha256). */
async function manifestOps(job: { opsManifest: { r2Key: string; sha256: string } }): Promise<any[]> {
  const bytes = new Uint8Array(await (await env.COMMONFORGE_ASSETS.get(job.opsManifest.r2Key))!.arrayBuffer());
  expect(await sha256Hex(bytes)).toBe(job.opsManifest.sha256);
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** Size of the enqueued runner message, as the queue would carry it. */
const messageBytes = (m: unknown) => new TextEncoder().encode(JSON.stringify(m)).length;

async function gitBlobSha1Of(s: string) {
  const bytes = text(s);
  const header = text(`blob ${bytes.length}\0`);
  const all = new Uint8Array(header.length + bytes.length);
  all.set(header);
  all.set(bytes, header.length);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-1", all))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("file changes: upload, apply, proposal", () => {
  it("two uploads become one change: a pointer for the binary file, text for the small one, an open proposal", async () => {
    const { h, o, pid, runner } = await world();
    const vid = video();
    const a = await uploadFile(h, o, pid, "videos/demo.mp4", vid, { mime: "video/mp4" });
    const b = await uploadFile(h, o, pid, "notes.txt", text("hello notes\n"), { mime: "text/plain" });
    const r = await postChange(h, o.token, o.orgId, pid, { ops: [{ put: "videos/demo.mp4", stagingId: a }, { put: "notes.txt", stagingId: b }] });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(r.body).toMatchObject({ proposalId: null, state: "applying" });
    const changeId = r.body.changeId as string;

    const c = await settle(h, o, changeId);
    expect(runner.errors).toEqual([]);
    expect(c.proposalId).toMatch(/^prop-fc-[0-9a-f]{32}$/);
    expect(c.attempt).toBe(1);
    expect(c).not.toHaveProperty("error");

    const tree = taskTree(h, runner, changeId);
    const sha = await sha256Hex(vid);
    expect(tree["videos/demo.mp4"]).toBe(lfsPointer(sha, vid.length));
    expect(parseLfsPointer(tree["videos/demo.mp4"]!)).toEqual({ sha256: sha, size: vid.length });
    expect(tree["notes.txt"]).toBe("hello notes\n");
    expect(tree[".gitattributes"]).toBe(`${gitattributesLfsEntry("videos/demo.mp4")}\n`);
    // untouched files stay
    expect(tree["index.html"]).toBe("v1");

    const byPath = Object.fromEntries((c.changedPaths as Array<{ path: string; class: string; lfs: boolean; change: string }>).map((p) => [p.path, p]));
    expect(byPath["videos/demo.mp4"]).toMatchObject({ class: "content", lfs: true, change: "added" });
    expect(byPath["notes.txt"]).toMatchObject({ class: "code", lfs: false, change: "added" });

    // the proposal is an ordinary one, prepared by the existing step (and then landing on its own: file-changes-land.test.ts)
    const p = await h.api("GET", `/api/orgs/${o.orgId}/proposals/${c.proposalId}`, { token: o.token });
    expect(p.status).toBe(200);
    expect(["prepared", "accepted"]).toContain(p.body.state);

    // the job: author is the uploader, the small text file carries its key, the LFS one does not
    const job = applyJobs(h, changeId)[0]!.signedJob.job as any;
    expect(job.author.email).toMatch(/@example\.test$/);
    // the operations travel as an R2 manifest named (and bound) by the job
    expect(job).not.toHaveProperty("ops");
    expect(job.opsManifest.r2Key).toBe(`org/${o.orgId}/file-changes/${changeId}/ops-1.json`);
    const ops = await manifestOps(job);
    expect(job.opsManifest.count).toBe(2);
    expect(ops[0]).not.toHaveProperty("r2Key");
    expect(ops[0]).toMatchObject({ binary: true, size: vid.length, sha256: sha });
    expect(ops[1].r2Key).toMatch(new RegExp(`/obj/${b}$`));
  });

  it("an empty upload lands as a plain empty file in git (no LFS)", async () => {
    const { h, o, pid, runner } = await world();
    const a = await uploadFile(h, o, pid, "pkg/__init__.py", new Uint8Array(0), { mime: "text/x-python" });
    const r = await postChange(h, o.token, o.orgId, pid, { ops: [{ put: "pkg/__init__.py", stagingId: a }, { put: "assets/.gitkeep", stagingId: a }] });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    const c = await land(h, o, r.body.changeId);
    expect(runner.errors).toEqual([]);
    expect(c.state, JSON.stringify(c)).toBe("added");
    const tree = taskTree(h, runner, r.body.changeId);
    expect(tree["pkg/__init__.py"]).toBe("");
    expect(tree["assets/.gitkeep"]).toBe("");
    expect(tree).not.toHaveProperty(".gitattributes");
    const ops = await manifestOps(applyJobs(h, r.body.changeId)[0]!.signedJob.job as any);
    expect(ops[0]).toMatchObject({ size: 0, binary: false, sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" });
    expect(ops[0].r2Key).toMatch(new RegExp(`/obj/${a}$`));
    expect(c.changedPaths).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "pkg/__init__.py", change: "added", lfs: false }), expect.objectContaining({ path: "assets/.gitkeep", change: "added", lfs: false })]),
    );
  });

  it("a change waits for its uploads to be hashed, then applies", async () => {
    const { h, o, pid } = await world();
    const a = await uploadFile(h, o, pid, "notes.txt", text("later\n"), { hash: false });
    const r = await postChange(h, o.token, o.orgId, pid, { ops: [{ put: "notes.txt", stagingId: a }] });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    // deliver only files.apply (the hash step has not run yet)
    const apply = (h.steps as Array<{ type: string }>).filter((s) => s.type === "files.apply");
    expect(apply).toHaveLength(1);
    h.steps.splice(h.steps.indexOf(apply[0]!), 1);
    await h.deliver("commonforge-steps", apply);
    expect(applyJobs(h, r.body.changeId)).toHaveLength(0);
    expect((await getChange(h, o.token, o.orgId, r.body.changeId)).body.state).toBe("applying");
    // the hash step verifies the object and wakes the change
    const c = await settle(h, o, r.body.changeId);
    expect(applyJobs(h, r.body.changeId)).toHaveLength(1);
    expect(c.proposalId).toBeTruthy();
  });

  it("M4: a referenced upload rejected by the hash step fails the change with the row's actual reason", async () => {
    const cases: Array<[string, string, RegExp]> = [
      ["hash_mismatch", "hash_mismatch", /does not match what was uploaded: its bytes do not hash/],
      ["size_mismatch", "size_mismatch", /does not match what was uploaded: its stored size differs/],
      ["missing", "upload_missing", /does not match what was uploaded: its bytes are missing/],
      ["object_changed", "object_changed", /written again after they were verified/],
      ["hash_failed: provider_unavailable: R2 down", "hash_failed", /could not be verified \(hash_failed: provider_unavailable: R2 down\)/],
    ];
    for (const [error, code, message] of cases) {
      const { h, o, pid } = await world();
      const a = await uploadFile(h, o, pid, "notes.txt", text("bad\n"), { hash: false });
      const r = await postChange(h, o.token, o.orgId, pid, { ops: [{ put: "notes.txt", stagingId: a }] });
      expect(r.status).toBe(202);
      await env.DB.prepare("UPDATE lfs_objects SET state = 'rejected', error = ? WHERE staging_id = ?").bind(error, a).run();
      h.steps.splice(0, h.steps.length, ...(h.steps as Array<{ type: string }>).filter((s) => s.type === "files.apply"));
      const c = await settle(h, o, r.body.changeId);
      expect(c.state).toBe("failed");
      expect(c.error.code, error).toBe(code);
      expect(c.error.message, error).toMatch(message);
      expect(c.error.message).toContain(a);
      expect(applyJobs(h, r.body.changeId)).toHaveLength(0);
    }
  });

  it("an edit with the blob from GET …/file applies; a stale blob fails with file_changed", async () => {
    const { h, o, pid, runner } = await world();
    const f = await h.api("GET", `/api/orgs/${o.orgId}/projects/${pid}/file?mount=site&path=config.json`, { token: o.token });
    expect(f.status).toBe(200);
    const blob = f.headers.get("x-commonforge-blob")!;
    expect(blob).toBe(await gitBlobSha1Of(CONFIG_JSON));
    const next = '{ "title": "Demo 2" }\n';
    const r = await postChange(h, o.token, o.orgId, pid, { ops: [{ edit: "config.json", content: next, baseBlob: blob }] });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    const c = await settle(h, o, r.body.changeId);
    expect(c.proposalId).toBeTruthy();
    expect(taskTree(h, runner, r.body.changeId)["config.json"]).toBe(next);
    expect(c.changedPaths).toEqual([{ path: "config.json", change: "modified", lfs: false, class: "code" }]);
    expect(runner.errors).toEqual([]);

    const stale = await postChange(h, o.token, o.orgId, pid, { ops: [{ edit: "config.json", content: "x\n", baseBlob: "0".repeat(40) }] });
    expect(stale.status).toBe(202);
    const s = await settle(h, o, stale.body.changeId);
    expect(s.state).toBe("failed");
    expect(s.error.code).toBe("file_changed");
    expect(s.proposalId).toBeNull();
  });

  it("deleting a missing file changes nothing: added, no_changes, no proposal", async () => {
    const { h, o, pid } = await world();
    const r = await postChange(h, o.token, o.orgId, pid, { ops: [{ delete: "nope.txt" }] });
    expect(r.status).toBe(202);
    const c = await settle(h, o, r.body.changeId);
    expect(c.state).toBe("added");
    expect(c.note).toBe("no_changes");
    expect(c.proposalId).toBeNull();
    expect(c).not.toHaveProperty("error");
    const row = await env.DB.prepare("SELECT error_code, task_id FROM file_changes WHERE change_id = ?").bind(r.body.changeId).first<{ error_code: string; task_id: string }>();
    expect(row!.error_code).toBe("no_changes");
    // the runner's result is applied in the background: the task ends just after the change does
    await waitUntil(async () => (await h.api("GET", `/api/tasks/${row!.task_id}`, { token: o.token })).body.state === "canceled");
  });

  it("a stale base re-applies uploads up to three attempts; a change with an edit fails file_changed at once", async () => {
    const { h, o, pid, runner } = await world();
    runner.opts.fail = { "apply-files": { code: "stale_base", detail: "head moved (test)" } };
    const a = await uploadFile(h, o, pid, "notes.txt", text("n\n"));
    const r = await postChange(h, o.token, o.orgId, pid, { ops: [{ put: "notes.txt", stagingId: a }] });
    const c = await settle(h, o, r.body.changeId);
    expect(c.state).toBe("failed");
    expect(c.error.code).toBe("stale_base");
    expect(c.attempt).toBe(3);
    expect(applyJobs(h, r.body.changeId)).toHaveLength(3);
    expect(runner.errors).toEqual([]);
    // every attempt had its own task, abandoned when the next one started
    const taskStates = async () =>
      (
        await env.DB.prepare("SELECT t.state FROM tasks t JOIN task_workspaces w ON w.task_id = t.task_id WHERE w.task_workspace_id IN (SELECT json_extract(signed_json, '$.job.candidateFork.taskWorkspaceId') FROM runner_jobs WHERE subject = ?)")
          .bind(`file-change:${r.body.changeId}`)
          .all<{ state: string }>()
      ).results
        .map((t) => t.state)
        .sort()
        .join(",");
    await waitUntil(async () => (await taskStates()) === "canceled,canceled,failed");

    const f = await h.api("GET", `/api/orgs/${o.orgId}/projects/${pid}/file?mount=site&path=config.json`, { token: o.token });
    const e = await postChange(h, o.token, o.orgId, pid, { ops: [{ put: "notes.txt", stagingId: await uploadFile(h, o, pid, "notes.txt", text("m\n")) }, { edit: "config.json", content: "{}\n", baseBlob: f.headers.get("x-commonforge-blob") }] });
    const ce = await settle(h, o, e.body.changeId);
    expect(ce.state).toBe("failed");
    expect(ce.error.code).toBe("file_changed");
    expect(ce.attempt).toBe(1);
  });
});

describe("file changes: the ops manifest (R5)", () => {
  it("the signed job of a 1,000-put change, and of a change with a 1 MiB edit, stays under 100 KB", async () => {
    const { h, o, site, pid, runner } = await world();
    runner.opts.manual = true;
    // 1,000 verified binary uploads of the owner (as the hash step leaves them)
    const now = new Date().toISOString();
    const ids = Array.from({ length: 1000 }, (_, i) => `lfs-${String(i).padStart(24, "0")}`);
    const stmts = ids.map((id, i) =>
      env.DB.prepare("INSERT INTO lfs_objects (staging_id, org_id, resource_id, r2_key, size, sha256, binary, state, source, user_id, created_at, updated_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, 1, 'verified', 'browser', ?, ?, ?, ?)")
        .bind(id, o.orgId, site.resourceId, `org/${o.orgId}/lfs/${site.resourceId}/obj/${id}`, 2_000_000 + i, i.toString(16).padStart(64, "0"), o.userId, now, now, now),
    );
    for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
    const puts = await postChange(h, o.token, o.orgId, pid, { ops: ids.map((stagingId, i) => ({ put: `media/clip-${String(i).padStart(4, "0")}-with-a-fairly-long-descriptive-name.mov`, stagingId })) });
    expect(puts.status, JSON.stringify(puts.body)).toBe(202);
    const edit = await postChange(h, o.token, o.orgId, pid, { ops: [{ edit: "big.txt", content: "x".repeat(MiB), baseBlob: "" }] });
    expect(edit.status, JSON.stringify(edit.body)).toBe(202);
    await h.drainSteps();
    for (const [id, count] of [
      [puts.body.changeId, 1000],
      [edit.body.changeId, 1],
    ] as const) {
      const [msg] = applyJobs(h, id);
      expect(msg, id).toBeTruthy();
      expect(messageBytes(msg)).toBeLessThan(100_000);
      expect((msg!.signedJob.job as any).opsManifest.count).toBe(count);
      expect(await manifestOps(msg!.signedJob.job as any)).toHaveLength(count);
    }
    // and the jobs run: 1,000 pointers in one commit
    runner.opts.manual = false;
    await runner.runPending();
    const c = await settle(h, o, puts.body.changeId);
    expect(runner.errors).toEqual([]);
    expect(c.proposalId).toBeTruthy();
    expect(c.changedPaths.filter((p: { lfs: boolean }) => p.lfs)).toHaveLength(1000);
    const e = await settle(h, o, edit.body.changeId);
    expect(taskTree(h, runner, edit.body.changeId)["big.txt"]).toHaveLength(MiB);
    expect(e.proposalId).toBeTruthy();
  });

  it("a tampered manifest fails the job (scope_violation); nothing is proposed", async () => {
    const { h, o, pid, runner } = await world();
    runner.opts.manual = true;
    const r = await postChange(h, o.token, o.orgId, pid, { ops: [{ delete: "config.json" }] });
    await h.drainSteps();
    const [msg] = applyJobs(h, r.body.changeId);
    await env.COMMONFORGE_ASSETS.put((msg!.signedJob.job as any).opsManifest.r2Key, JSON.stringify([{ delete: "index.html" }]));
    await runner.runPending();
    const c = await settle(h, o, r.body.changeId);
    expect(c.state).toBe("failed");
    expect(c.error.code).toBe("scope_violation");
    expect(c.proposalId).toBeNull();
  });

  it("a receipt naming an object that is not one of the change's uploads is refused (receipt_mismatch)", async () => {
    const { h, o, pid, runner } = await world();
    const a = await uploadFile(h, o, pid, "videos/demo.mp4", video());
    runner.opts.mutateReceipt = { "apply-files": (rc: any) => ({ ...rc, lfsObjects: [...rc.lfsObjects, { stagingId: "lfs-not-in-this-change", sha256: "b".repeat(64), size: 10 }] }) };
    const r = await postChange(h, o.token, o.orgId, pid, { ops: [{ put: "videos/demo.mp4", stagingId: a }] });
    const c = await settle(h, o, r.body.changeId);
    expect(c.state).toBe("failed");
    expect(c.error.code).toBe("receipt_mismatch");
    expect(c.proposalId).toBeNull();
    // a recorded put with another hash or size is refused too
    runner.opts.mutateReceipt = { "apply-files": (rc: any) => ({ ...rc, lfsObjects: rc.lfsObjects.map((x: any) => ({ ...x, size: x.size + 1 })) }) };
    const b = await uploadFile(h, o, pid, "videos/demo2.mp4", video());
    const r2 = await postChange(h, o.token, o.orgId, pid, { ops: [{ put: "videos/demo2.mp4", stagingId: b }] });
    expect((await settle(h, o, r2.body.changeId)).error.code).toBe("receipt_mismatch");
    // a small text upload the runner wrote as a plain file is not an LFS object of the change
    const bytes = text("small text\n");
    const small = await uploadFile(h, o, pid, "notes.txt", bytes, { mime: "text/plain" });
    const sha = await sha256Hex(bytes);
    runner.opts.mutateReceipt = { "apply-files": (rc: any) => ({ ...rc, lfsObjects: [...rc.lfsObjects, { stagingId: small, sha256: sha, size: bytes.length }] }) };
    const r3 = await postChange(h, o.token, o.orgId, pid, { ops: [{ put: "notes.txt", stagingId: small }] });
    const c3 = await settle(h, o, r3.body.changeId);
    expect(c3.error.code).toBe("receipt_mismatch");
    // one that an LFS pattern stores in LFS is (the receipt reports its path as LFS)
    runner.opts.mutateReceipt = undefined;
    const attrs = await postChange(h, o.token, o.orgId, pid, { ops: [{ edit: ".gitattributes", content: "*.svg filter=lfs diff=lfs merge=lfs -text\n", baseBlob: "" }] });
    expect(attrs.status, JSON.stringify(attrs.body)).toBe(202);
    expect((await land(h, o, attrs.body.changeId)).state).toBe("added");
    const svgBytes = text("<svg/>\n");
    const svg = await uploadFile(h, o, pid, "logo.svg", svgBytes, { mime: "image/svg+xml" });
    const r4 = await postChange(h, o.token, o.orgId, pid, { ops: [{ put: "logo.svg", stagingId: svg }] });
    const c4 = await land(h, o, r4.body.changeId);
    expect(runner.errors).toEqual([]);
    expect(c4.state).toBe("added");
    expect(c4.changedPaths).toEqual([{ path: "logo.svg", change: "added", lfs: true, class: "content" }]);
    expect((await env.DB.prepare("SELECT accepted_at FROM lfs_objects WHERE staging_id = ?").bind(svg).first<{ accepted_at: string | null }>())!.accepted_at).not.toBeNull();
  });
});

describe("file changes: expired jobs", () => {
  it("a change whose job the GC closed (expired without a result) reads as failed job_expired", async () => {
    const { h, o, pid, runner } = await world();
    runner.opts.manual = true;
    const r = await postChange(h, o.token, o.orgId, pid, { ops: [{ delete: "index.html" }] });
    await h.drainSteps();
    expect(applyJobs(h, r.body.changeId)).toHaveLength(1);
    expect((await getChange(h, o.token, o.orgId, r.body.changeId)).body.state).toBe("applying");
    // what gc.ts expireRunnerJobs writes
    await env.DB.prepare("UPDATE runner_jobs SET status = 'failed', result_json = ? WHERE subject = ?")
      .bind(JSON.stringify({ ok: false, code: "job_expired", detail: "the job expired without a result (closed by GC)" }), `file-change:${r.body.changeId}`)
      .run();
    const c = (await getChange(h, o.token, o.orgId, r.body.changeId)).body;
    expect(c.state).toBe("failed");
    expect(c.error.code).toBe("job_expired");
  });
});

describe("file changes: limits and permissions", () => {
  it("limits: operations, edit size, foreign uploads", async () => {
    const { h, o, pid } = await world();
    const many = Array.from({ length: 1001 }, (_, i) => ({ delete: `f${i}.txt` }));
    const tooMany = await postChange(h, o.token, o.orgId, pid, { ops: many });
    expect(tooMany.status).toBe(413);
    expect(tooMany.body.error.code).toBe("too_many_operations");

    const big = await postChange(h, o.token, o.orgId, pid, { ops: [{ edit: "big.txt", content: "a".repeat(MiB + 1), baseBlob: "" }] });
    expect(big.status).toBe(413);
    expect(big.body.error.code).toBe("edit_too_large");
    // 16 MiB of edits together at most
    const seventeen = Array.from({ length: 17 }, (_, i) => ({ edit: `e${i}.txt`, content: "a".repeat(MiB), baseBlob: "" }));
    const many16 = await postChange(h, o.token, o.orgId, pid, { ops: seventeen });
    expect(many16.status).toBe(413);
    expect(many16.body.error.code).toBe("edits_too_large");
    expect((await postChange(h, o.token, o.orgId, pid, { ops: seventeen.slice(0, 16) })).status).toBe(202);
    const nul = await postChange(h, o.token, o.orgId, pid, { ops: [{ edit: "nul.txt", content: "a\0b", baseBlob: "" }] });
    expect(nul.status).toBe(413);
    expect(nul.body.error.code).toBe("edit_too_large");

    const badBlob = await postChange(h, o.token, o.orgId, pid, { ops: [{ edit: "a.txt", content: "a", baseBlob: "xyz" }] });
    expect(badBlob.status).toBe(400);
    expect(badBlob.body.error.code).toBe("invalid_request");
    const badPath = await postChange(h, o.token, o.orgId, pid, { ops: [{ delete: ".git/config" }] });
    expect(badPath.status).toBe(400);
    expect(badPath.body.error.code).toBe("invalid_path");

    // an upload by someone else
    const dev = await member(h, o, "developer");
    expect((await h.api("PUT", `/api/orgs/${o.orgId}/projects/${pid}/access`, { token: o.token, body: { userId: dev.userId, level: "write" } })).status).toBe(200);
    const theirs = await uploadFile(h, { token: dev.token, orgId: o.orgId }, pid, "theirs.txt", text("theirs\n"));
    const foreign = await postChange(h, o.token, o.orgId, pid, { ops: [{ put: "theirs.txt", stagingId: theirs }] });
    expect(foreign.status).toBe(400);
    expect(foreign.body.error.code).toBe("invalid_upload");

    // an upload to another folder
    const docs = await h.api("POST", `/api/orgs/${o.orgId}/resources`, { token: o.token, body: { name: "docs", provider: "artifacts" } });
    expect(docs.status).toBe(201);
    const sha = h.artifacts.makeCommit({ "README.md": "docs" });
    h.artifacts.push(`commonforge-dev-${o.orgId}-canonical`, docs.body.resourceId, "main", sha);
    expect((await h.api("POST", `/api/orgs/${o.orgId}/resources/${docs.body.resourceId}/adopt-head`, { token: o.token })).status).toBe(200);
    expect((await h.api("POST", `/api/orgs/${o.orgId}/projects/${pid}/mounts`, { token: o.token, body: { mountName: "docs", resourceId: docs.body.resourceId } })).status).toBe(201);
    const other = await uploadFile(h, o, pid, "x.txt", text("x\n"), { mount: "docs" });
    const wrongFolder = await postChange(h, o.token, o.orgId, pid, { ops: [{ put: "x.txt", stagingId: other }] });
    expect(wrongFolder.status).toBe(400);
    expect(wrongFolder.body.error.code).toBe("invalid_upload");
    // the same upload works in its own folder
    expect((await postChange(h, o.token, o.orgId, pid, { ops: [{ put: "x.txt", stagingId: other }] }, "docs")).status).toBe(202);
    const unknown = await postChange(h, o.token, o.orgId, pid, { ops: [{ put: "x.txt", stagingId: "lfs-000000000000000000000000" }] });
    expect(unknown.body.error.code).toBe("invalid_upload");
  });

  it("the 20 GB of a change counts every put, also one upload put at several paths", async () => {
    const { h, o, site, pid } = await world();
    const now = new Date().toISOString();
    const id = "lfs-big000000000000000000000";
    await env.DB.prepare("INSERT INTO lfs_objects (staging_id, org_id, resource_id, r2_key, size, sha256, binary, state, source, user_id, created_at, updated_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, 1, 'verified', 'browser', ?, ?, ?, ?)")
      .bind(id, o.orgId, site.resourceId, `org/${o.orgId}/lfs/${site.resourceId}/obj/${id}`, 4_500_000_000, "e".repeat(64), o.userId, now, now, now)
      .run();
    const five = Array.from({ length: 5 }, (_, i) => ({ put: `media/copy-${i}.mov`, stagingId: id }));
    const r = await postChange(h, o.token, o.orgId, pid, { ops: five });
    expect(r.status).toBe(413);
    expect(r.body.error.code).toBe("change_too_large");
    expect((await postChange(h, o.token, o.orgId, pid, { ops: five.slice(0, 4) })).status).toBe(202);
  });

  it("clients and developers without write are refused; a file collection refuses edits", async () => {
    const { h, o, pid } = await world();
    const client = await member(h, o, "client");
    expect((await postChange(h, client.token, o.orgId, pid, { ops: [{ delete: "index.html" }] })).status).toBe(403);
    const dev = await member(h, o, "developer");
    expect((await h.api("PUT", `/api/orgs/${o.orgId}/projects/${pid}/access`, { token: o.token, body: { userId: dev.userId, level: "read" } })).status).toBe(200);
    expect([403, 404]).toContain((await postChange(h, dev.token, o.orgId, pid, { ops: [{ delete: "index.html" }] })).status);
    await fileCollection(h, o, pid, "brand");
    expect((await postChange(h, o.token, o.orgId, pid, { ops: [{ delete: "a.png" }] }, "brand")).status).toBe(202);
    const edit = await postChange(h, o.token, o.orgId, pid, { ops: [{ edit: "a.txt", content: "x\n", baseBlob: "" }] }, "brand");
    expect([edit.status, edit.body.error.code]).toEqual([400, "edit_unsupported"]);
  });

  it("GET /file-changes/:id: the uploader and owners see it; a developer who cannot read the folder gets 404", async () => {
    const { h, o, pid, site } = await world();
    const dev = await member(h, o, "developer");
    expect((await h.api("PUT", `/api/orgs/${o.orgId}/projects/${pid}/access`, { token: o.token, body: { userId: dev.userId, level: "write" } })).status).toBe(200);
    const r = await postChange(h, dev.token, o.orgId, pid, { ops: [{ delete: "nope.txt" }] });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect((await getChange(h, dev.token, o.orgId, r.body.changeId)).status).toBe(200);
    expect((await getChange(h, o.token, o.orgId, r.body.changeId)).status).toBe(200);
    const other = await member(h, o, "developer");
    expect((await h.api("PUT", `/api/orgs/${o.orgId}/projects/${pid}/access`, { token: o.token, body: { userId: other.userId, level: "write", folders: { [site.resourceId]: "none" } } })).status).toBe(200);
    expect((await getChange(h, other.token, o.orgId, r.body.changeId)).status).toBe(404);
    const client = await member(h, o, "client");
    expect((await getChange(h, client.token, o.orgId, r.body.changeId)).status).toBe(404);
    expect((await getChange(h, o.token, o.orgId, "fc-000000000000000000000000")).status).toBe(404);
  });

  it("GET …/file of a git folder carries the git blob id of the content", async () => {
    const { h, o, pid } = await world();
    const f = await h.api("GET", `/api/orgs/${o.orgId}/projects/${pid}/file?mount=site&path=index.html`, { token: o.token });
    expect(f.status).toBe(200);
    // git hash-object of "v1": sha1("blob 2\0v1")
    expect(f.headers.get("x-commonforge-blob")).toBe(await gitBlobSha1Of("v1"));
    expect(f.headers.get("x-commonforge-blob")).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("file changes: idempotency keys (final review 3)", () => {
  const rows = async (org: string) => (await env.DB.prepare("SELECT COUNT(*) AS n FROM file_changes WHERE org_id = ?").bind(org).first<{ n: number }>())!.n;
  const applySteps = (h: Harness) => (h.steps as Array<{ type: string }>).filter((s) => s.type === "files.apply").length;

  it("a repeat with the same key answers the same change (202, same body), once it landed too; nothing new is created", async () => {
    const { h, o, pid } = await world();
    const a = await uploadFile(h, o, pid, "notes.txt", text("hello\n"), { mime: "text/plain" });
    const body = { ops: [{ put: "notes.txt", stagingId: a }], idempotencyKey: "batch-1_A" };
    const first = await postChange(h, o.token, o.orgId, pid, body);
    expect(first.status, JSON.stringify(first.body)).toBe(202);
    const again = await postChange(h, o.token, o.orgId, pid, body);
    expect(again.status).toBe(202);
    expect(again.body).toEqual(first.body);
    expect(await rows(o.orgId)).toBe(1);
    expect(applySteps(h)).toBe(1);
    // a different title is the same request (the key names the operations)
    expect((await postChange(h, o.token, o.orgId, pid, { ...body, title: "Another title" })).body.changeId).toBe(first.body.changeId);
    // landed: the upload is added (it could not be put again), the repeat still answers the change
    const c = await land(h, o, first.body.changeId);
    expect(c.state).toBe("added");
    const late = await postChange(h, o.token, o.orgId, pid, body);
    expect(late.status).toBe(202);
    expect(late.body).toMatchObject({ changeId: first.body.changeId, state: "added" });
    expect(await rows(o.orgId)).toBe(1);
  });

  it("the same key with other operations or another folder is 409 idempotency_key_reused; another user's key is theirs", async () => {
    const { h, o, pid } = await world();
    await fileCollection(h, o, pid, "brand");
    const first = await postChange(h, o.token, o.orgId, pid, { ops: [{ delete: "a.txt" }], idempotencyKey: "k1" });
    expect(first.status).toBe(202);
    const otherOps = await postChange(h, o.token, o.orgId, pid, { ops: [{ delete: "b.txt" }], idempotencyKey: "k1" });
    expect([otherOps.status, otherOps.body.error?.code]).toEqual([409, "idempotency_key_reused"]);
    const otherMount = await postChange(h, o.token, o.orgId, pid, { ops: [{ delete: "a.txt" }], idempotencyKey: "k1" }, "brand");
    expect([otherMount.status, otherMount.body.error?.code]).toEqual([409, "idempotency_key_reused"]);
    const dev = await member(h, o, "developer");
    expect((await h.api("PUT", `/api/orgs/${o.orgId}/projects/${pid}/access`, { token: o.token, body: { userId: dev.userId, level: "write" } })).status).toBe(200);
    const theirs = await postChange(h, dev.token, o.orgId, pid, { ops: [{ delete: "a.txt" }], idempotencyKey: "k1" });
    expect(theirs.status).toBe(202);
    expect(theirs.body.changeId).not.toBe(first.body.changeId);
    // without a key, every request is a new change
    expect((await postChange(h, o.token, o.orgId, pid, { ops: [{ delete: "a.txt" }] })).body.changeId).not.toBe(first.body.changeId);
    expect(await rows(o.orgId)).toBe(3);
  });

  it("two requests with the same key at once make one change", async () => {
    const { h, o, pid } = await world();
    const body = { ops: [{ edit: "x.txt", content: "x\n", baseBlob: "" }], idempotencyKey: "race" };
    const [a, b] = await Promise.all([postChange(h, o.token, o.orgId, pid, body), postChange(h, o.token, o.orgId, pid, body)]);
    expect([a.status, b.status]).toEqual([202, 202]);
    expect(a.body.changeId).toBe(b.body.changeId);
    expect(await rows(o.orgId)).toBe(1);
  });

  it("a request whose insert loses to the same key's (it checked before that one committed) answers the winner's change", async () => {
    const { h, o, pid, site } = await world();
    const body = { ops: [{ edit: "x.txt", content: "x\n", baseBlob: "" }], idempotencyKey: "late" };
    const db = env.DB;
    let raced = false;
    // the other request commits right after this one's lookup missed
    (h.envOverrides as Record<string, unknown>).DB = new Proxy(db, {
      get(t, k) {
        if (k === "prepare")
          return (sql: string) => {
            const st = db.prepare(sql);
            if (raced || !/idempotency_key = \?/.test(sql) || !sql.startsWith("SELECT")) return st;
            return new Proxy(st, {
              get(t2, k2) {
                if (k2 === "bind")
                  return (...args: unknown[]) => {
                    const bound = st.bind(...args);
                    return new Proxy(bound, {
                      get(t3, k3) {
                        if (k3 === "first")
                          return async () => {
                            const got = await bound.first();
                            raced = true;
                            const now = new Date().toISOString();
                            const ops = JSON.stringify([{ edit: "x.txt", contentSha256: await sha256Hex(text("x\n")), baseBlob: "" }]);
                            await db
                              .prepare("INSERT INTO file_changes (change_id, org_id, project_id, resource_id, mount_name, user_id, title, ops_json, has_edits, state, attempt, created_at, updated_at, idempotency_key) VALUES ('fc-winner', ?, ?, ?, 'site', ?, 'Edited x.txt', ?, 1, 'applying', 1, ?, ?, 'late')")
                              .bind(o.orgId, pid, site.resourceId, o.userId, ops, now, now)
                              .run();
                            return got;
                          };
                        const v = (t3 as unknown as Record<string | symbol, unknown>)[k3];
                        return typeof v === "function" ? v.bind(t3) : v;
                      },
                    });
                  };
                const v = (t2 as unknown as Record<string | symbol, unknown>)[k2];
                return typeof v === "function" ? v.bind(t2) : v;
              },
            });
          };
        const v = (t as unknown as Record<string | symbol, unknown>)[k];
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const r = await postChange(h, o.token, o.orgId, pid, body);
    expect(raced).toBe(true);
    expect([r.status, r.body.changeId]).toEqual([202, "fc-winner"]);
    expect(await rows(o.orgId)).toBe(1);
    // the loser's edits object is not left behind
    const listed = await env.COMMONFORGE_ASSETS.list({ prefix: `org/${o.orgId}/file-changes/` });
    expect(listed.objects.filter((x) => !x.key.includes("fc-winner"))).toEqual([]);
  });

  it("a key is 1 to 128 characters of letters, digits, _ and -", async () => {
    const { h, o, pid } = await world();
    for (const k of ["", "a".repeat(129), "has space", "slash/", 7]) {
      const r = await postChange(h, o.token, o.orgId, pid, { ops: [{ delete: "a.txt" }], idempotencyKey: k });
      expect([r.status, r.body.error?.code], String(k)).toEqual([400, "invalid_request"]);
    }
    expect((await postChange(h, o.token, o.orgId, pid, { ops: [{ delete: "a.txt" }], idempotencyKey: "a".repeat(128) })).status).toBe(202);
  });
});

describe("GET /projects/:pid/file-changes (the Files tab's list)", () => {
  const listChanges = (h: Harness, token: string, org: string, pid: string, query = "") => h.api("GET", `/api/orgs/${org}/projects/${pid}/file-changes${query}`, { token });
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  const HOUR = 3_600_000;
  let seq = 0;
  /** A change row as the routes would leave it (no job, so a read settles nothing). */
  async function row(o: Owner, pid: string, rid: string, mount: string, userId: string, state: string, createdAgo: number, updatedAgo = 0) {
    const id = `fc-list${String(++seq).padStart(19, "0")}`;
    await env.DB.prepare(
      "INSERT INTO file_changes (change_id, org_id, project_id, resource_id, mount_name, user_id, title, ops_json, has_edits, state, attempt, error_code, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, '[]', 0, ?, 1, ?, ?, ?, ?)",
    )
      .bind(id, o.orgId, pid, rid, mount, userId, `change ${seq}`, state, state === "failed" ? "check_failed" : null, state === "failed" ? "check site-test failed" : null, ago(createdAgo), ago(updatedAgo))
      .run();
    return id;
  }
  async function twoFolders() {
    const w = await world();
    const docs = await codeResource(w.h, w.o, "docs", { "README.md": "docs" });
    const m = await w.h.api("POST", `/api/orgs/${w.o.orgId}/projects/${w.pid}/mounts`, { token: w.o.token, body: { mountName: "docs", resourceId: docs.resourceId } });
    expect(m.status, JSON.stringify(m.body)).toBe(201);
    return { ...w, docs, ownerId: w.o.userId };
  }

  it("newest first, presented like GET /file-changes/:id, filtered by mount, limited (default 20, at most 50; open changes always listed)", async () => {
    const { h, o, pid, site, docs, ownerId } = await twoFolders();
    const ids: string[] = [];
    for (let i = 0; i < 25; i++) ids.push(await row(o, pid, site.resourceId, "site", ownerId, i % 2 ? "applying" : "added", (30 - i) * 60_000));
    const d = await row(o, pid, docs.resourceId, "docs", ownerId, "failed", 1000);
    const all = await listChanges(h, o.token, o.orgId, pid);
    expect(all.status, JSON.stringify(all.body)).toBe(200);
    // every open change (the odd ones), terminal ones up to the limit: d and the 7 newest added
    const newest = ids.map((id, i) => ({ id, i })).reverse();
    expect(all.body.changes.map((c: { changeId: string }) => c.changeId)).toEqual([d, ...newest.filter(({ i }) => i % 2 === 1 || i >= 12).map(({ id }) => id)]);
    expect(all.body.changes[0]).toEqual({ ...(await getChange(h, o.token, o.orgId, d)).body });
    expect(all.body.changes[0].error).toEqual({ code: "check_failed", message: "check site-test failed" });
    const site5 = await listChanges(h, o.token, o.orgId, pid, "?mount=site&limit=5");
    // the 12 open changes are all listed, whatever the limit
    expect(site5.body.changes.map((c: { changeId: string }) => c.changeId)).toEqual(newest.filter(({ i }) => i % 2 === 1).map(({ id }) => id));
    expect((await listChanges(h, o.token, o.orgId, pid, "?mount=site&limit=15")).body.changes.map((c: { changeId: string }) => c.changeId)).toEqual(newest.filter(({ i }) => i % 2 === 1 || i >= 20).map(({ id }) => id));
    expect((await listChanges(h, o.token, o.orgId, pid, "?limit=50")).body.changes).toHaveLength(26);
    for (const bad of ["?limit=0", "?limit=51", "?limit=x"]) expect((await listChanges(h, o.token, o.orgId, pid, bad)).status).toBe(400);
    expect((await listChanges(h, o.token, o.orgId, pid, "?mount=nope")).status).toBe(404);
  });

  it("a developer sees only folders they can read, and only their own terminal changes; terminal changes older than 24 hours drop off", async () => {
    const { h, o, pid, site, docs, ownerId } = await twoFolders();
    const dev = await member(h, o, "developer");
    expect((await h.api("PUT", `/api/orgs/${o.orgId}/projects/${pid}/access`, { token: o.token, body: { userId: dev.userId, level: "write", folders: { [docs.resourceId]: "none" } } })).status).toBe(200);
    const ownersOpen = await row(o, pid, site.resourceId, "site", ownerId, "waiting_approval", 10 * HOUR);
    const ownersDone = await row(o, pid, site.resourceId, "site", ownerId, "added", 2 * HOUR, HOUR);
    const devsDone = await row(o, pid, site.resourceId, "site", dev.userId, "failed", 3 * HOUR, HOUR);
    const devsOld = await row(o, pid, site.resourceId, "site", dev.userId, "added", 30 * HOUR, 25 * HOUR);
    const ownersOld = await row(o, pid, site.resourceId, "site", ownerId, "failed", 30 * HOUR, 25 * HOUR);
    const docsOpen = await row(o, pid, docs.resourceId, "docs", ownerId, "applying", HOUR / 2);
    const oldOpen = await row(o, pid, site.resourceId, "site", dev.userId, "checking", 40 * HOUR, 0);

    const ids = (r: { body: { changes: Array<{ changeId: string }> } }) => r.body.changes.map((c) => c.changeId);
    const forOwner = await listChanges(h, o.token, o.orgId, pid);
    expect(forOwner.status).toBe(200);
    expect(ids(forOwner)).toEqual([docsOpen, ownersDone, devsDone, ownersOpen, oldOpen]);
    const forDev = await listChanges(h, dev.token, o.orgId, pid);
    expect(forDev.status, JSON.stringify(forDev.body)).toBe(200);
    expect(ids(forDev)).toEqual([devsDone, ownersOpen, oldOpen]);
    expect(ids(forDev)).not.toContain(devsOld);
    expect(ids(forOwner)).not.toContain(ownersOld);
    expect((await listChanges(h, dev.token, o.orgId, pid, "?mount=docs")).status).toBe(404);
  });

  it("open changes are always listed, however old: terminal changes fill the rest of the limit", async () => {
    const { h, o, pid, site, ownerId } = await twoFolders();
    const open = await row(o, pid, site.resourceId, "site", ownerId, "waiting_approval", 10 * HOUR);
    const done: string[] = [];
    for (let i = 0; i < 25; i++) done.push(await row(o, pid, site.resourceId, "site", ownerId, "added", (30 - i) * 60_000));
    const r = await listChanges(h, o.token, o.orgId, pid);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.changes.map((c: { changeId: string }) => c.changeId)).toEqual([...done.slice().reverse().slice(0, 19), open]);
  });

  it("changes in more folders than D1 has bind parameters (100) are listed", async () => {
    const { h, o, pid } = await world();
    const ids: string[] = [];
    // 150 folders, each changed once (the owner reads every folder)
    for (let i = 0; i < 150; i++) ids.push(await row(o, pid, `res-many${String(i).padStart(4, "0")}`, `m${i}`, o.userId, "added", (200 - i) * 1000));
    const r = await listChanges(h, o.token, o.orgId, pid, "?limit=50");
    expect(r.status, JSON.stringify(r.body).slice(0, 500)).toBe(200);
    expect(r.body.changes.map((c: { changeId: string }) => c.changeId)).toEqual(ids.slice().reverse().slice(0, 50));
  });

  it("clients and viewers get 403; a developer who cannot read the project gets 404", async () => {
    const { h, o, pid } = await world();
    for (const role of ["client", "viewer"]) {
      const m = await member(h, o, role);
      expect((await h.api("PUT", `/api/orgs/${o.orgId}/projects/${pid}/access`, { token: o.token, body: { userId: m.userId, level: "read" } })).status).toBe(200);
      expect((await listChanges(h, m.token, o.orgId, pid)).status).toBe(403);
    }
    const dev = await member(h, o, "developer");
    expect((await listChanges(h, dev.token, o.orgId, pid)).status).toBe(404);
  });
});
