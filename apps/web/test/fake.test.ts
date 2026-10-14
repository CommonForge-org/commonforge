import { describe, expect, it } from "vitest";
import { ApiError } from "../src/api/client.js";
import { FakeApi, FIXTURE_ORG as ORG, FIXTURE_PROJECT as PID, FIXTURE_PROPOSALS as P, FIXTURE_RESOURCES as R, FIXTURE_STAGING_TASKS } from "../src/api/fake.js";
import type { Role } from "../src/api/types.js";
import { acceptBlockers } from "../src/lib/model.js";

function clock(start = Date.parse("2026-10-06T12:00:00.000Z")) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

async function acceptRepaired(api: FakeApi) {
  const role = api.role;
  const p = await api.getProposal(ORG, P.quoteRepaired);
  api.role = "client";
  await api.approve(ORG, P.quoteRepaired, p.proposalHash);
  api.role = "owner";
  await api.accept(ORG, P.quoteRepaired, "accept:fixture-0001");
  api.role = role;
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof ApiError ? e.code : String(e);
  }
}

describe("FakeApi fixture (the demo story)", () => {
  it("shows a project of separate resources: Artifacts repos, an R2 collection and a pinned reference", async () => {
    const api = new FakeApi();
    const project = await api.getProject(ORG, PID);
    expect(project.mounts.map((m) => `${m.mountName}:${m.provider}:${m.mode}`)).toEqual([
      "website:artifacts:must-match-accepted",
      "api:artifacts:must-match-accepted",
      "brand-assets:r2-assets:must-match-accepted",
      "requirements:artifacts:must-match-accepted",
      "quote-builder-concept:artifacts:pinned-reference",
    ]);
    const snap = await api.getSnapshot(ORG, PID);
    expect(snap.entries).toHaveLength(5);
    const tree = await api.listTree(ORG, PID, { mount: "brand-assets", path: "videos" });
    expect(tree.entries[0]).toMatchObject({ path: "videos/launch-film.mp4", size: 52_428_800 });
  });

  it("gives clients the same proposal identity but no coordinates, tasks or revision browsing", async () => {
    const api = new FakeApi();
    const devView = await api.getProposal(ORG, P.quoteRepaired);
    api.role = "client";
    const clientView = await api.getProposal(ORG, P.quoteRepaired);
    expect(clientView.proposalHash).toBe(devView.proposalHash);
    expect(clientView.integration?.results).toBeUndefined();
    expect((await api.getResource(ORG, R.website)).coords).toBeUndefined();
    expect(await code(api.listTasks(ORG, PID))).toBe("insufficient_role");
    expect(await code(api.readFile(ORG, PID, { mount: "website", path: "src/quote.ts", revision: devView.resourceChanges[0]!.baseRevision }))).toBe("revision_not_allowed");
  });

  it("binds approvals to the current hash", async () => {
    const api = new FakeApi({ role: "client" });
    expect(await code(api.approve(ORG, P.quoteRepaired, "0".repeat(64)))).toBe("proposal_hash_mismatch");
    api.role = "viewer";
    const p = await api.getProposal(ORG, P.quoteRepaired);
    expect(await code(api.approve(ORG, P.quoteRepaired, p.proposalHash))).toBe("approval_role_not_allowed");
  });

  it("keeps approve and accept separate, records a version, replays the same key, and makes overlapping proposals stale", async () => {
    const api = new FakeApi();
    const before = await api.getProposal(ORG, P.quoteRepaired);
    expect(acceptBlockers(before)).toEqual(["No approval for this identity yet"]);
    expect(await code(api.accept(ORG, P.quoteRepaired, "accept:key-0001"))).toBe("approval_invalid");

    api.role = "client";
    await api.approve(ORG, P.quoteRepaired, before.proposalHash);
    expect(await code(api.accept(ORG, P.quoteRepaired, "accept:key-0001"))).toBe("insufficient_role");

    api.role = "owner";
    const first = await api.accept(ORG, P.quoteRepaired, "accept:key-0002");
    const again = await api.accept(ORG, P.quoteRepaired, "accept:key-0002");
    expect(again).toEqual({ ...first, replayed: true });
    expect((await api.getProposal(ORG, P.quoteRepaired)).state).toBe("accepted");

    const versions = await api.listVersions(ORG, R.api);
    expect(versions[0]).toMatchObject({ acceptedVersionId: first.acceptedVersionId, proposalId: P.quoteRepaired, kind: "accept" });
    // the brand refresh also changes requirements from the old head: it is now stale (refuse policy)
    const brand = await api.getProposal(ORG, P.brandRefresh);
    expect(brand.stale).toContain(R.requirements);
    expect(await code(api.integrate(ORG, P.brandRefresh))).toBe("expected_head_stale");
  });

  it("runs an integration that finishes after a while and records evidence for the current hash", async () => {
    const c = clock();
    const api = new FakeApi({ now: c.now, integrationMs: 1000 });
    expect((await api.getProposal(ORG, P.brandRefresh)).integration).toBeNull();
    const job = await api.integrate(ORG, P.brandRefresh);
    expect((await api.getProposal(ORG, P.brandRefresh)).integration).toBeNull();
    c.advance(1500);
    const p = await api.getProposal(ORG, P.brandRefresh);
    expect(p.integration).toMatchObject({ jobId: job.jobId, forCurrentHash: true });
    const events = (await api.listEvents(ORG, { projectId: PID })).events.map((e) => e.action);
    expect(events.slice(-2)).toEqual(["proposal.integration_requested", "proposal.integrated"]);
  });

  it("restores an earlier version as a new version, with the API's refusals", async () => {
    const api = new FakeApi();
    await acceptRepaired(api);
    const res = await api.getResource(ORG, R.website);
    const versions = await api.listVersions(ORG, R.website);
    // the genesis bind is a real version (like the ledger's planBindHead), with no proposal
    expect(versions[versions.length - 1]).toMatchObject({ kind: "accept", proposalId: null });
    const older = versions[versions.length - 1]!.head!.revisionId;
    const head = res.head!.revisionId;
    expect(await code(api.restore(ORG, R.website, { expectedHead: head, targetRevision: head, idempotencyKey: "restore:k-0001" }))).toBe("restore_noop");
    expect(await code(api.restore(ORG, R.website, { expectedHead: older, targetRevision: older, idempotencyKey: "restore:k-0002" }))).toBe("expected_head_stale");
    expect(older).not.toBe(head);
    const r = await api.restore(ORG, R.website, { expectedHead: head, targetRevision: older, idempotencyKey: "restore:k-0003" });
    expect(r.headRevisionId).toBe(older);
    expect((await api.listVersions(ORG, R.website))[0]).toMatchObject({ kind: "restore", acceptedVersionId: r.acceptedVersionId });
    expect(await code(api.restore(ORG, R.website, { expectedHead: older, targetRevision: head, idempotencyKey: "restore:k-0003" }))).toBe("idempotency_key_conflict");
  });

  it("C-1: like the server, a failed run leaves integration null and is reported as the last attempt", async () => {
    const api = new FakeApi();
    const dev = await api.getProposal(ORG, P.quoteFailed);
    expect(dev.state).toBe("prepared"); // the server never marks older proposals superseded
    expect(dev.integration).toBeNull();
    expect(dev.lastAttempt).toMatchObject({ state: "failed", code: "contract_failed", contractChecks: [{ contractId: "quote-schema", result: "fail" }] });
    expect(dev.lastAttempt?.detail).toContain("breakdown");
    api.role = "client";
    const client = await api.getProposal(ORG, P.quoteFailed);
    expect(client.lastAttempt?.detail).toBeUndefined();
    expect(client.lastAttempt?.jobId).toBeUndefined();
    const failed = (await api.listEvents(ORG, { projectId: PID })).events.find((e) => e.action === "proposal.integration_failed");
    expect(failed?.detail).toEqual({ code: "contract_failed", conflictPaths: [] });
    expect((await api.listEvents(ORG, { projectId: PID })).events.some((e) => e.action.startsWith("task."))).toBe(false);
  });

  it("C-1: an integrate request shows as a queued attempt until the run finishes", async () => {
    const c = clock();
    const api = new FakeApi({ now: c.now, integrationMs: 1000 });
    await api.integrate(ORG, P.brandRefresh);
    expect((await api.getProposal(ORG, P.brandRefresh)).lastAttempt).toMatchObject({ state: "queued" });
    c.advance(1200);
    expect((await api.getProposal(ORG, P.brandRefresh)).lastAttempt).toMatchObject({ state: "succeeded", forCurrentHash: true });
  });

  it("produces export downloads once the export job finishes", async () => {
    const c = clock();
    const api = new FakeApi({ now: c.now });
    const started = await api.startExport(ORG, PID);
    expect((await api.getExport(ORG, started.exportId)).downloads).toEqual([]);
    c.advance(2000);
    const done = await api.getExport(ORG, started.exportId);
    expect(done.downloads).toHaveLength(5);
  });

  it("records three overlapping sessions: two agent tasks and a client edition session (as in the rehearsal)", async () => {
    const api = new FakeApi();
    const events = (await api.listEvents(ORG, { projectId: PID })).events;
    expect(events.filter((e) => e.action === "task.started")).toHaveLength(2);
    expect(events.filter((e) => e.action === "edition.session_started")).toHaveLength(1);
    expect(events.find((e) => e.action === "edition.returned")?.detail).toMatchObject({ sessionId: "eds-0b5e00000000b100", tool: "claude" });
    expect((await api.listTasks(ORG, PID)).map((t) => t.state)).toEqual(["submitted", "running", "submitted"]);
    api.completeRunningTasks();
    expect((await api.listTasks(ORG, PID)).every((t) => t.state === "submitted")).toBe(true);
  });
});

// ------------------------------------------------------------------- uploads and file changes

const signal = () => new AbortController().signal;
const MiB = 1024 * 1024;

/** Upload `content` (text) or `{ size }` bytes (a stand-in Blob: the fake reads only `size` of non-text uploads). */
async function upload(api: FakeApi, mount: string, path: string, content: string | { size: number }, mime = typeof content === "string" ? "text/plain" : "video/mp4") {
  const size = typeof content === "string" ? new TextEncoder().encode(content).length : content.size;
  const s = await api.startUpload(ORG, PID, mount, { path, size, mime });
  const parts: Array<{ n: number; etag: string }> = [];
  for (let n = 1; n <= s.parts; n++) {
    const len = n < s.parts ? s.partSize : size - (s.parts - 1) * s.partSize;
    const blob = typeof content === "string" ? new Blob([content]) : ({ size: len } as Blob);
    parts.push({ n, etag: (await api.putUploadPart(ORG, s.uploadId, n, blob, { signal: signal() })).etag });
  }
  return (await api.completeUpload(ORG, s.uploadId, parts)).stagingId;
}

/** Poll until the change stops moving (terminal, waiting for approval, or on staging). */
async function settle(api: FakeApi, changeId: string) {
  for (let i = 0; i < 10; i++) {
    const c = await api.getFileChange(ORG, changeId);
    if (c.state === "added" || c.state === "failed" || c.state === "waiting_approval" || c.state === "staged") return c;
  }
  throw new Error("the change never settled");
}

describe("FakeApi uploads and file changes (mirroring the Worker)", () => {
  it("says canWrite per mount: owners always, developers with write on the folder, never clients", async () => {
    const api = new FakeApi();
    expect((await api.getProject(ORG, PID)).mounts.every((m) => m.canWrite === true)).toBe(true);
    await api.putProjectAccess(ORG, PID, { userId: "u-developer", level: "write", folders: { [R.website]: "read" } });
    api.role = "developer";
    const dev = (await api.getProject(ORG, PID)).mounts;
    expect(dev.find((m) => m.mountName === "website")!.canWrite).toBe(false);
    expect(dev.find((m) => m.mountName === "api")!.canWrite).toBe(true);
    expect(await code(api.startUpload(ORG, PID, "website", { path: "a.txt", size: 1, mime: "text/plain" }))).toBe("no_write_grant");
    expect(await code(api.createFileChange(ORG, PID, "website", { ops: [{ delete: "README.md" }] }))).toBe("no_write_grant");
    api.role = "client";
    expect((await api.getProject(ORG, PID)).mounts.some((m) => m.canWrite)).toBe(false);
    expect(await code(api.startUpload(ORG, PID, "api", { path: "a.txt", size: 1, mime: "text/plain" }))).toBe("insufficient_role");
    expect(await code(api.createFileChange(ORG, PID, "api", { ops: [{ delete: "README.md" }] }))).toBe("insufficient_role");
    expect(await code(api.listFileChanges(ORG, PID))).toBe("insufficient_role");
  });

  it("checks upload paths and sizes, and splits into 50 MiB parts", async () => {
    const api = new FakeApi();
    const start = (path: string, size: number) => api.startUpload(ORG, PID, "website", { path, size, mime: "video/mp4" });
    for (const bad of ["/abs.txt", "a/../b.txt", ".git/config", "docs/.GIT/x", "a//b", "re\u0301sume\u0301.txt"]) expect(await code(start(bad, 1))).toBe("invalid_path");
    expect(await start("r\u00e9sum\u00e9.txt", 1)).toMatchObject({ parts: 1 }); // the NFC spelling is the one taken
    expect(await code(start("big.mp4", 5_000_000_001))).toBe("file_too_large");
    expect(await code(start("half.txt", 1.5))).toBe("invalid_size");
    expect(await code(start("minus.txt", -1))).toBe("invalid_size");
    const s = await start("videos/film.mp4", 120 * MiB);
    expect(s).toMatchObject({ partSize: 50 * MiB, parts: 3 });
    expect(typeof s.expiresAt).toBe("string");
  });

  it("takes parts of the right size, reports progress in one step, and completes to a stagingId", async () => {
    const api = new FakeApi();
    const s = await api.startUpload(ORG, PID, "website", { path: "notes.txt", size: 5, mime: "text/plain" });
    expect(await code(api.putUploadPart(ORG, s.uploadId, 1, new Blob(["toolong"]), { signal: signal() }))).toBe("part_size_mismatch");
    expect(await code(api.putUploadPart(ORG, s.uploadId, 2, new Blob(["hello"]), { signal: signal() }))).toBe("invalid_part");
    const ctl = new AbortController();
    ctl.abort();
    expect(await code(api.putUploadPart(ORG, s.uploadId, 1, new Blob(["hello"]), { signal: ctl.signal }))).toContain("AbortError");
    const seen: number[] = [];
    const { etag } = await api.putUploadPart(ORG, s.uploadId, 1, new Blob(["hello"]), { signal: signal(), onProgress: (n) => seen.push(n) });
    expect(seen).toEqual([5]);
    expect(await code(api.completeUpload(ORG, s.uploadId, []))).toBe("parts_mismatch");
    const done = await api.completeUpload(ORG, s.uploadId, [{ n: 1, etag }]);
    expect(done).toEqual({ stagingId: s.uploadId, size: 5 });
    // another person's upload is not found
    api.role = "developer";
    expect(await code(api.completeUpload(ORG, s.uploadId, [{ n: 1, etag }]))).toBe("not_found");
  });

  it("an empty file is an upload of no parts, completed with parts: [], and lands as an empty file", async () => {
    const api = new FakeApi();
    const s = await api.startUpload(ORG, PID, "website", { path: "media/.gitkeep", size: 0, mime: "application/octet-stream" });
    expect(s.parts).toBe(0);
    expect(await code(api.putUploadPart(ORG, s.uploadId, 1, new Blob([]), { signal: signal() }))).toBe("invalid_part");
    const done = await api.completeUpload(ORG, s.uploadId, []);
    expect(done).toEqual({ stagingId: s.uploadId, size: 0 });
    const c = await api.createFileChange(ORG, PID, "website", { ops: [{ put: "media/.gitkeep", stagingId: done.stagingId }] });
    expect((await settle(api, c.changeId)).state).toBe("added");
    expect((await api.listTree(ORG, PID, { mount: "website", path: "media" })).entries).toContainEqual({ path: "media/.gitkeep", type: "file", size: 0 });
  });

  it("cancels an unfinished upload; a change can't name it", async () => {
    const api = new FakeApi();
    const s = await api.startUpload(ORG, PID, "website", { path: "x.txt", size: 1, mime: "text/plain" });
    await api.cancelUpload(ORG, s.uploadId);
    expect(await code(api.createFileChange(ORG, PID, "website", { ops: [{ put: "x.txt", stagingId: s.uploadId }] }))).toBe("invalid_upload");
  });

  it("an owner's upload lands one step per poll: applying (verifying), applying, checking, added; the tree shows the file", async () => {
    const api = new FakeApi();
    const text = await upload(api, "website", "docs/guide.md", "# Guide\n");
    const film = await upload(api, "website", "media/film.mp4", { size: 120 * MiB });
    const created = await api.createFileChange(ORG, PID, "website", { ops: [{ put: "docs/guide.md", stagingId: text }, { put: "media/film.mp4", stagingId: film }] });
    expect(created).toMatchObject({ state: "applying", attempt: 1, proposalId: null, mountName: "website", projectId: PID });
    // like the Worker's default: the puts' common folder, or the mount at the root
    expect(created.title).toBe("Uploaded 2 files to website");
    const states = [];
    for (let i = 0; i < 3; i++) states.push((await api.getFileChange(ORG, created.changeId)).state);
    expect(states).toEqual(["applying", "checking", "added"]);
    const done = await api.getFileChange(ORG, created.changeId);
    expect(done.proposalId).toMatch(/^prop-/);
    expect(done.changedPaths).toEqual([
      { path: "docs/guide.md", change: "added", lfs: false, class: "content" },
      { path: "media/film.mp4", change: "added", lfs: true, class: "content" },
    ]);
    expect((await api.listTree(ORG, PID, { mount: "website", path: "media" })).entries).toEqual([{ path: "media/film.mp4", type: "file", size: 120 * MiB, lfs: true }]);
    expect((await api.listTree(ORG, PID, { mount: "website", path: "docs" })).entries).toEqual([{ path: "docs/guide.md", type: "file", size: 8 }]);
    expect(await (await api.readFile(ORG, PID, { mount: "website", path: "docs/guide.md" })).text()).toBe("# Guide\n");
    expect((await api.getProposal(ORG, done.proposalId!)).state).toBe("accepted");
    // the same upload can't be put again
    expect(await code(api.createFileChange(ORG, PID, "website", { ops: [{ put: "again.md", stagingId: text }] }))).toBe("invalid_upload");
  });

  it("titles a pure upload by its common folder, like the Worker", async () => {
    const api = new FakeApi();
    const a = await upload(api, "website", "videos/2026/a.mp4", { size: 10 });
    const b = await upload(api, "website", "videos/2026/b/c.mp4", { size: 10 });
    expect((await api.createFileChange(ORG, PID, "website", { ops: [{ put: "videos/2026/a.mp4", stagingId: a }, { put: "videos/2026/b/c.mp4", stagingId: b }] })).title).toBe("Uploaded 2 files to videos/2026");
    const c = await upload(api, "website", "top.txt", "x");
    expect((await api.createFileChange(ORG, PID, "website", { ops: [{ put: "top.txt", stagingId: c }], title: "Mine" })).title).toBe("Mine");
  });

  it("refuses a title over 200 characters (after trimming), like the Worker", async () => {
    const api = new FakeApi();
    expect(await code(api.createFileChange(ORG, PID, "website", { ops: [{ delete: "README.md" }], title: "x".repeat(201) }))).toBe("invalid_request");
    expect(await code(api.createFileChange(ORG, PID, "website", { ops: [{ delete: "README.md" }], title: "   " }))).toBe("invalid_request");
    expect((await api.createFileChange(ORG, PID, "website", { ops: [{ delete: "README.md" }], title: ` ${"x".repeat(200)} ` })).title).toBe("x".repeat(200));
  });

  it("R6: a developer's change waits for approval; approve and accept move it to added", async () => {
    const api = new FakeApi({ role: "developer" });
    const id = await upload(api, "api", "assets/logo.png", { size: 2048 }, "image/png");
    const c = await api.createFileChange(ORG, PID, "api", { ops: [{ put: "assets/logo.png", stagingId: id }] });
    const waiting = await settle(api, c.changeId);
    expect(waiting.state).toBe("waiting_approval");
    const p = await api.getProposal(ORG, waiting.proposalId!);
    api.role = "client";
    await api.approve(ORG, p.proposalId, p.proposalHash);
    api.role = "owner";
    await api.accept(ORG, p.proposalId, "accept:fc-0001");
    api.role = "developer";
    expect((await api.getFileChange(ORG, c.changeId)).state).toBe("added");
    expect((await api.listTree(ORG, PID, { mount: "api", path: "assets" })).entries[0]).toMatchObject({ path: "assets/logo.png", lfs: true, size: 2048 });
  });

  it("R6: a developer's change lands by itself when the policy lists developers", async () => {
    const api = new FakeApi();
    const p = await api.getProject(ORG, PID);
    await api.putPolicy(ORG, PID, { ...p.policy!, approvalRoles: ["owner", "developer"] });
    api.role = "developer";
    const c = await api.createFileChange(ORG, PID, "api", { ops: [{ delete: "wrangler.jsonc" }] });
    const done = await settle(api, c.changeId);
    expect(done.state).toBe("added");
    expect(done.changedPaths).toEqual([{ path: "wrangler.jsonc", change: "deleted", lfs: false, class: "code" }]);
  });

  it("staging mode (as the Worker): a git folder's change stops at staging with no proposal and the folder unchanged", async () => {
    const api = new FakeApi();
    const p = await api.getProject(ORG, PID);
    await api.putPolicy(ORG, PID, { ...p.policy!, release: { targets: [] }, staging: { environment: {} } });
    const before = await api.listTree(ORG, PID, { mount: "api", path: "" });
    const c = await api.createFileChange(ORG, PID, "api", { ops: [{ delete: "wrangler.jsonc" }] });
    const staged = await settle(api, c.changeId);
    expect(staged).toMatchObject({ state: "staged", proposalId: null, changedPaths: [{ path: "wrangler.jsonc", change: "deleted" }] });
    expect(await api.listTree(ORG, PID, { mount: "api", path: "" })).toEqual(before);
    expect((await api.listFileChanges(ORG, PID, {})).map((x) => [x.changeId, x.state])).toContainEqual([c.changeId, "staged"]);
  });

  it("enforces the change limits", async () => {
    const api = new FakeApi();
    const ops = Array.from({ length: 1001 }, (_, i) => ({ delete: `f${i}` }));
    expect(await code(api.createFileChange(ORG, PID, "website", { ops }))).toBe("too_many_operations");
    expect(await code(api.createFileChange(ORG, PID, "website", { ops: [] }))).toBe("invalid_request");
    expect(await code(api.createFileChange(ORG, PID, "website", { ops: [{ edit: "big.txt", content: "x".repeat(MiB + 1), baseBlob: "" }] }))).toBe("edit_too_large");
    expect(await code(api.createFileChange(ORG, PID, "website", { ops: [{ edit: "nul.txt", content: "a\0b", baseBlob: "" }] }))).toBe("edit_too_large");
    const many = Array.from({ length: 17 }, (_, i) => ({ edit: `e${i}.txt`, content: "x".repeat(MiB), baseBlob: "" }));
    expect(await code(api.createFileChange(ORG, PID, "website", { ops: many }))).toBe("edits_too_large");
    expect(await code(api.createFileChange(ORG, PID, "website", { ops: [{ edit: "a.txt", content: "x", baseBlob: "nope" }] }))).toBe("invalid_request");
    expect(await code(api.createFileChange(ORG, PID, "website", { ops: [{ delete: "../x" }] }))).toBe("invalid_path");
    const huge = await upload(api, "website", "huge.bin", { size: 5_000_000_000 }, "application/octet-stream");
    const puts = Array.from({ length: 5 }, (_, i) => ({ put: `copy-${i}.bin`, stagingId: huge }));
    expect(await code(api.createFileChange(ORG, PID, "website", { ops: puts }))).toBe("change_too_large");
  });

  it("edits in place with the file's blob id; a stale blob or a new file over an existing one fails file_changed", async () => {
    const api = new FakeApi();
    const f = await api.readFileForEdit(ORG, PID, { mount: "website", path: "README.md" });
    expect(f.text).toContain("# Website");
    expect(f.baseBlob).toMatch(/^[0-9a-f]{40}$/);
    expect(f.revisionId).toBe((await api.getResource(ORG, R.website)).head!.revisionId);
    const ok = await api.createFileChange(ORG, PID, "website", { ops: [{ edit: "README.md", content: "# Website v2\n", baseBlob: f.baseBlob }] });
    expect(ok.title).toBe("Edited README.md");
    expect((await settle(api, ok.changeId)).state).toBe("added");
    expect(await (await api.readFile(ORG, PID, { mount: "website", path: "README.md" })).text()).toBe("# Website v2\n");
    expect((await api.readFileForEdit(ORG, PID, { mount: "website", path: "README.md" })).baseBlob).not.toBe(f.baseBlob);

    const stale = await api.createFileChange(ORG, PID, "website", { ops: [{ edit: "README.md", content: "again", baseBlob: f.baseBlob }] });
    expect(await settle(api, stale.changeId)).toMatchObject({ state: "failed", error: { code: "file_changed" } });
    const over = await api.createFileChange(ORG, PID, "website", { ops: [{ edit: "README.md", content: "new", baseBlob: "" }] });
    expect(await settle(api, over.changeId)).toMatchObject({ state: "failed", error: { code: "file_changed" } });
    const created = await api.createFileChange(ORG, PID, "website", { ops: [{ edit: "docs/new.md", content: "hi", baseBlob: "" }] });
    expect(await settle(api, created.changeId)).toMatchObject({ state: "added" });
  });

  it("refuses to open LFS files, file-collection files and large files for editing", async () => {
    const api = new FakeApi();
    expect(await code(api.readFileForEdit(ORG, PID, { mount: "brand-assets", path: "logos/logo.svg" }))).toBe("not_editable");
    const film = await upload(api, "website", "film.mp4", { size: 10 });
    const big = await upload(api, "website", "big.txt", { size: 2 * MiB }, "text/plain");
    const c = await api.createFileChange(ORG, PID, "website", { ops: [{ put: "film.mp4", stagingId: film }, { put: "big.txt", stagingId: big }] });
    await settle(api, c.changeId);
    expect(await code(api.readFileForEdit(ORG, PID, { mount: "website", path: "film.mp4" }))).toBe("not_editable");
    expect(await code(api.readFileForEdit(ORG, PID, { mount: "website", path: "big.txt" }))).toBe("not_editable");
    api.role = "client";
    expect(await code(api.readFileForEdit(ORG, PID, { mount: "website", path: "README.md", revision: "art:x:y" }))).toBe("revision_not_allowed");
  });

  it("deletes and moves files and folders", async () => {
    const api = new FakeApi();
    const c = await api.createFileChange(ORG, PID, "website", { ops: [{ move: "src", to: "app" }, { delete: "tests" }, { move: "README.md", to: "docs/README.md" }, { delete: "not-there" }] });
    const done = await settle(api, c.changeId);
    expect(done.state).toBe("added");
    const root = (await api.listTree(ORG, PID, { mount: "website", path: "" })).entries.map((e) => e.path);
    expect(root).toEqual(["app", "docs", "package.json"]);
    expect((await api.listTree(ORG, PID, { mount: "website", path: "app" })).entries.map((e) => e.path)).toEqual(["app/api.ts", "app/index.html", "app/quote.ts"]);
    const clash = await api.createFileChange(ORG, PID, "website", { ops: [{ move: "package.json", to: "docs/README.md" }] });
    expect(await settle(api, clash.changeId)).toMatchObject({ state: "failed", error: { code: "path_conflict" } });
    const nothing = await api.createFileChange(ORG, PID, "website", { ops: [{ delete: "not-there" }] });
    expect(await settle(api, nothing.changeId)).toMatchObject({ state: "added", note: "no_changes", proposalId: null });
  });

  it("file collections take uploads, deletes and moves, but refuse edits", async () => {
    const api = new FakeApi();
    expect(await code(api.createFileChange(ORG, PID, "brand-assets", { ops: [{ edit: "logos/logo.svg", content: "<svg/>", baseBlob: "" }] }))).toBe("edit_unsupported");
    const id = await upload(api, "brand-assets", "photos/team.jpg", { size: 4 * MiB }, "image/jpeg");
    const c = await api.createFileChange(ORG, PID, "brand-assets", { ops: [{ put: "photos/team.jpg", stagingId: id }, { move: "logos", to: "brand" }] });
    const done = await settle(api, c.changeId);
    expect(done.state).toBe("added");
    expect(done.changedPaths!.every((p) => p.class === "content" && !p.lfs)).toBe(true);
    expect((await api.listTree(ORG, PID, { mount: "brand-assets", path: "photos" })).entries).toEqual([{ path: "photos/team.jpg", type: "file", size: 4 * MiB }]);
    expect((await api.getResource(ORG, R.brand)).head!.revisionId).toMatch(/^r2m:/);
    const missing = await api.createFileChange(ORG, PID, "brand-assets", { ops: [{ delete: "nope.png" }] });
    expect(await settle(api, missing.changeId)).toMatchObject({ state: "failed", error: { code: "file_missing" } });
    const exists = await api.createFileChange(ORG, PID, "brand-assets", { ops: [{ move: "brand/logo.svg", to: "brand/logo-dark.svg" }] });
    expect(await settle(api, exists.changeId)).toMatchObject({ state: "failed", error: { code: "path_exists" } });
  });

  it("re-applies a change whose base moved (attempt + 1); a change with an edit fails file_changed instead", async () => {
    const api = new FakeApi({ role: "developer" });
    const first = await api.createFileChange(ORG, PID, "api", { ops: [{ delete: "README.md" }] });
    expect((await settle(api, first.changeId)).state).toBe("waiting_approval");
    const f = await api.readFileForEdit(ORG, PID, { mount: "api", path: "src/pricing.ts" });
    const edit = await api.createFileChange(ORG, PID, "api", { ops: [{ edit: "src/pricing.ts", content: "// x\n", baseBlob: f.baseBlob }] });
    expect((await settle(api, edit.changeId)).state).toBe("waiting_approval");
    api.role = "owner";
    const second = await api.createFileChange(ORG, PID, "api", { ops: [{ delete: "wrangler.jsonc" }] });
    expect((await settle(api, second.changeId)).state).toBe("added");
    api.role = "developer";
    const again = await settle(api, first.changeId);
    expect(again).toMatchObject({ state: "waiting_approval", attempt: 2 });
    expect(await settle(api, edit.changeId)).toMatchObject({ state: "failed", error: { code: "file_changed" } });
  });

  it("lists a project's changes newest first, with the mount filter, and hides others' terminal changes from developers", async () => {
    const c = clock();
    const api = new FakeApi({ now: c.now });
    const a = await api.createFileChange(ORG, PID, "website", { ops: [{ delete: "tests" }] });
    c.advance(1000);
    const b = await api.createFileChange(ORG, PID, "api", { ops: [{ delete: "wrangler.jsonc" }] });
    expect((await api.listFileChanges(ORG, PID)).map((x) => x.changeId)).toEqual([b.changeId, a.changeId]);
    expect((await api.listFileChanges(ORG, PID, { mount: "api" })).map((x) => x.changeId)).toEqual([b.changeId]);
    expect(await api.listFileChanges(ORG, PID, { limit: 1 })).toHaveLength(1);
    for (let i = 0; i < 3; i++) await api.listFileChanges(ORG, PID);
    expect((await api.listFileChanges(ORG, PID)).every((x) => x.state === "added")).toBe(true);
    api.role = "developer";
    expect(await api.listFileChanges(ORG, PID)).toEqual([]);
    expect(await code(api.getFileChange(ORG, a.changeId))).toBe("ok");
    api.role = "client";
    expect(await code(api.getFileChange(ORG, a.changeId))).toBe("not_found");
    api.role = "owner";
    c.advance(25 * 3600_000);
    expect(await api.listFileChanges(ORG, PID)).toEqual([]);
  });

  it("final review 3: an idempotency key answers the change it made (also once added); other ops or another folder are 409; keys are per user", async () => {
    const api = new FakeApi();
    const id = await upload(api, "website", "docs/a.md", "a", "text/markdown");
    const body = { ops: [{ put: "docs/a.md", stagingId: id }], idempotencyKey: "fc-1" };
    const first = await api.createFileChange(ORG, PID, "website", body);
    expect(await api.createFileChange(ORG, PID, "website", body)).toEqual(first);
    expect((await api.createFileChange(ORG, PID, "website", { ...body, title: "Other" })).changeId).toBe(first.changeId);
    expect((await settle(api, first.changeId)).state).toBe("added");
    // the upload is added now: still the same change, not invalid_upload
    expect(await api.createFileChange(ORG, PID, "website", body)).toMatchObject({ changeId: first.changeId, state: "added" });
    expect(await code(api.createFileChange(ORG, PID, "website", { ops: [{ delete: "README.md" }], idempotencyKey: "fc-1" }))).toBe("idempotency_key_reused");
    expect(await code(api.createFileChange(ORG, PID, "api", body))).toBe("idempotency_key_reused");
    for (const k of ["", "a".repeat(129), "has:colon"]) expect(await code(api.createFileChange(ORG, PID, "website", { ops: [{ delete: "README.md" }], idempotencyKey: k }))).toBe("invalid_request");
    await api.putProjectAccess(ORG, PID, { userId: "u-developer", level: "write" });
    api.role = "developer";
    const theirs = await api.createFileChange(ORG, PID, "website", { ops: [{ delete: "README.md" }], idempotencyKey: "fc-1" });
    expect(theirs.changeId).not.toBe(first.changeId);
  });

  it("final review 4: every open change is listed (up to 100) whatever the limit; terminal ones fill the rest; a bad limit is 400", async () => {
    const c = clock();
    const api = new FakeApi({ now: c.now });
    const added: string[] = [];
    for (const path of ["tests", "src"]) {
      const x = await api.createFileChange(ORG, PID, "website", { ops: [{ delete: path }] });
      expect((await settle(api, x.changeId)).state).toBe("added");
      added.unshift(x.changeId);
      c.advance(1000);
    }
    api.role = "developer";
    const waiting: string[] = [];
    for (const path of ["README.md", "wrangler.jsonc", "src/pricing.ts"]) {
      const x = await api.createFileChange(ORG, PID, "api", { ops: [{ delete: path }] });
      expect((await settle(api, x.changeId)).state).toBe("waiting_approval");
      waiting.unshift(x.changeId);
      c.advance(1000);
    }
    api.role = "owner";
    expect((await api.listFileChanges(ORG, PID, { limit: 1 })).map((x) => x.changeId)).toEqual(waiting);
    expect((await api.listFileChanges(ORG, PID, { limit: 4 })).map((x) => x.changeId)).toEqual([...waiting, added[0]]);
    expect((await api.listFileChanges(ORG, PID, { limit: 50 })).map((x) => x.changeId)).toEqual([...waiting, ...added]);
    for (const limit of [0, 51, 1.5, Number.NaN]) expect(await code(api.listFileChanges(ORG, PID, { limit }))).toBe("invalid_request");
  });

  it("returns copies: mutating a returned mount, snapshot entry, tree entry or change does not change the fake", async () => {
    const api = new FakeApi();
    const p = await api.getProject(ORG, PID);
    p.mounts[0]!.operations.push("read");
    p.mounts.pop();
    const again = await api.getProject(ORG, PID);
    expect(again.mounts).toHaveLength(5);
    expect(again.mounts[0]!.operations).toEqual(["read", "write"]);
    const snap = await api.getSnapshot(ORG, PID);
    snap.entries[0]!.operations.length = 0;
    expect((await api.getSnapshot(ORG, PID)).entries[0]!.operations).toEqual(["read", "write"]);
    const prop = await api.getProposal(ORG, P.brandRefresh);
    prop.resourceChanges.length = 0;
    expect((await api.getProposal(ORG, P.brandRefresh)).resourceChanges).toHaveLength(1);
    const ch = await api.createFileChange(ORG, PID, "website", { ops: [{ delete: "tests" }] });
    ch.title = "mutated";
    ch.state = "failed";
    // (the poll moves it one step on: no uploads to verify, so it is applied)
    expect(await api.getFileChange(ORG, ch.changeId)).toMatchObject({ title: "Changed 1 file", state: "checking" });
  });
});

// ------------------------------------------------------------------------- staging mode (phase 3)

describe("FakeApi staging mode (staging phase 3: the Customer Portal demo)", () => {
  const T = FIXTURE_STAGING_TASKS;
  const STEP = 1000;
  function staging(role: Role = "client") {
    const c = clock();
    const api = new FakeApi({ role, staging: true, now: c.now, integrationMs: STEP, promotionStepMs: STEP });
    return { api, c };
  }
  const as = async <X>(api: FakeApi, role: Role, f: () => Promise<X>): Promise<X> => {
    const before = api.role;
    api.role = role;
    try {
      return await f();
    } finally {
      api.role = before;
    }
  };
  /** Poll (one step per poll) until the promotion waits for a person or ends; returns every state seen. */
  async function drive(api: FakeApi, c: ReturnType<typeof clock>, id: string) {
    const seen: string[] = [];
    for (let i = 0; i < 30; i++) {
      const v = await api.getPromotion(ORG, id);
      if (seen[seen.length - 1] !== v.state) seen.push(v.state);
      if (["pending_approval", "live", "failed", "release_failed", "sent_back", "withdrawn", "superseded"].includes(v.state)) return { v, seen };
      c.advance(STEP);
    }
    throw new Error(`the promotion never settled: ${seen.join(" → ")}`);
  }
  const landing = async (api: FakeApi, taskId: string) => (await api.getStaging(ORG, PID)).landings.find((l) => l.taskId === taskId);

  it("is off by default: no staging, no captures, existing data unchanged", async () => {
    const api = new FakeApi({ role: "client" });
    expect(await api.getStaging(ORG, PID)).toEqual({ enabled: false, url: null, current: null, building: false, landings: [] });
    expect(await api.listCaptures(ORG, PID)).toEqual([]);
    expect(await code(api.listTasks(ORG, PID))).toBe("insufficient_role");
    api.role = "owner";
    expect((await api.listTasks(ORG, PID)).map((t) => t.title)).toEqual(["Add a quote breakdown (website + API)", "Client update: Friendlier quote form copy", "Refresh the brand logo and requirements"]);
    expect((await api.listProposals(ORG, PID)).every((p) => p.kind === null)).toBe(true);
  });

  it("seeds the demo: a staging link, the last change, three tasks live on staging, one working, two captures", async () => {
    const { api } = staging();
    const s = await api.getStaging(ORG, PID);
    if (!s.enabled) throw new Error("staging should be on");
    expect(s).toMatchObject({ state: "active", stateText: null, building: false });
    expect(s.url).toMatch(/^https:\/\//);
    expect(s.current?.since).toBeTruthy();
    expect(s.baseline).toEqual({ since: expect.any(String) }); // no releaseId for a client
    expect(s.landings.map((l) => [l.title, l.state, l.promotion])).toEqual([
      ["Rename the contact name column", "landed", null],
      ["Add a phone field to the contact form", "landed", null],
      ["Update the home page copy, banner and footer", "landed", null],
    ]);
    expect(s.landings[0]).toMatchObject({ createdBy: "u-client", parts: [{ part: 1, taskId: T.rename }] });
    expect(s.landings[0]!.detail).toBeUndefined();
    expect(s.landings[0]!.travelsWith).toBeUndefined();
    const tasks = await api.listTasks(ORG, PID);
    expect(tasks.map((t) => [t.taskId, t.state])).toEqual([
      [T.working, "running"],
      [T.rename, "submitted"],
      [T.phone, "submitted"],
      [T.copy, "submitted"],
    ]);
    const captures = await api.listCaptures(ORG, PID);
    expect(captures).toHaveLength(2);
    expect(captures[0]!.receivedAt > captures[1]!.receivedAt).toBe(true);
    expect(captures[0]).toMatchObject({ method: "POST", truncated: false });
    expect(Object.keys(captures[0]!.headers).some((h) => /authorization|cookie|token|secret/i.test(h))).toBe(false);
    // owners and developers see the baseline release and the landing extras
    const dev = await as(api, "developer", () => api.getStaging(ORG, PID));
    if (!dev.enabled) throw new Error("staging should be on");
    expect(dev.baseline?.releaseId).toMatch(/^rel-/);
    expect(dev.landings[0]).toMatchObject({ detail: null, travelsWith: [] });
    // the project's policy says so (staging mode as the Worker reads it)
    const policy = (await as(api, "owner", () => api.getProject(ORG, PID))).policy!;
    expect(policy.staging).toBeDefined();
    expect(policy.release).toBeDefined();
  });

  it("the home page copy (self): the client promotes it and it goes live step by step; the client view never has the gate", async () => {
    const { api, c } = staging();
    const preview = await api.previewPromotion(T.copy);
    expect(preview).toEqual({ landings: [{ landingId: expect.any(String), taskId: T.copy, title: "Update the home page copy, banner and footer" }], mode: "closure", goingWithout: [] });
    expect(await api.listPromotions(ORG, PID)).toEqual([]); // the dry run wrote nothing
    const r = await api.promoteTask(T.copy);
    expect(r).toMatchObject({ landings: [{ landingId: preview.landings[0]!.landingId, taskId: T.copy }], mode: "closure", goingWithout: [] });
    expect(await landing(api, T.copy)).toMatchObject({ state: "promoting", promotion: { promotionId: r.promotionId, state: "requested" } });
    const { v, seen } = await drive(api, c, r.promotionId);
    expect(seen).toEqual(["requested", "building", "gating", "cleared", "accepting", "releasing", "live"]);
    expect(v).toMatchObject({ state: "live", level: "self", reasonCode: null, reason: null, waitingForProduction: false });
    for (const k of ["gate", "clearance", "proposalId", "proposalHash", "detail", "requestedBy", "resources", "checks", "targetLandingId"]) expect(v).not.toHaveProperty(k);
    expect(v.landings[0]).not.toHaveProperty("request");
    expect(await landing(api, T.copy)).toMatchObject({ state: "promoted", promotion: { promotionId: r.promotionId, state: "live" } });
    // the change is in production: a new accepted version, released live
    const dev = await as(api, "developer", () => api.getPromotion(ORG, r.promotionId));
    expect(dev.clearance).toMatchObject({ kind: "self", clearedBy: "u-client" });
    expect(dev.gate).toMatchObject({ pathLevel: "self", reasonCode: "self", veto: { kind: "none" }, classifier: { asked: false, cleared: false, reason: "not_needed" } });
    expect(dev.acceptedVersionId).toBeTruthy();
    const releases = await as(api, "owner", () => api.listReleases(ORG, PID));
    expect(releases.live?.acceptedVersionId).toBe(dev.acceptedVersionId);
    expect(await code(api.promoteTask(T.copy))).toBe("not_in_staging");
  });

  it("the phone field by default: the real Jev's answers (risk medium) decline it → classifier_declined, a developer approves → Live; the client never sees the evidence", async () => {
    const { api, c } = staging();
    const r = await api.promoteTask(T.phone);
    const { v } = await drive(api, c, r.promotionId);
    expect(v).toMatchObject({ state: "pending_approval", level: "developer", reasonCode: "classifier_declined", reason: "The automatic review could not confirm this change is low risk." });
    expect(v.gate).toBeUndefined();
    expect(JSON.stringify(v)).not.toContain("jev");
    const dev = await as(api, "developer", () => api.getPromotion(ORG, r.promotionId));
    expect(dev.gate?.veto.kind).toBe("additive");
    expect(dev.gate?.classifier).toMatchObject({ asked: true, cleared: false, reason: "declined" });
    const ev = dev.gate!.classifier.evidence!;
    expect(ev).toMatchObject({ provider: "jev", model: "jev-1.13.0", threshold: 0.9, cleared: false, failed: "risk", error: null });
    expect(ev.safeProbability).toEqual({ risk: 0.4, migration: 1, apiChange: 0.4, authOrPayments: 1, addressedToReviewer: 0.97 });
    expect(Object.fromEntries(Object.entries(ev.answers!).map(([q, a]) => [q, a.choice]))).toEqual({ risk: "medium", migration: "additive", apiChange: "breaking", authOrPayments: "no", addressedToReviewer: "no" });
    expect(await as(api, "developer", () => api.approvePromotion(ORG, r.promotionId))).toMatchObject({ state: "cleared", clearance: { kind: "developer", clearedBy: "u-developer" } });
    expect((await drive(api, c, r.promotionId)).v.state).toBe("live");
  });

  it("the phone field (classify, additive migration): a clearing classifier clears it with evidence developers can read", async () => {
    const { api, c } = staging();
    api.classifierOutcome = "clear";
    const r = await api.promoteTask(T.phone);
    const { v } = await drive(api, c, r.promotionId);
    expect(v).toMatchObject({ state: "live", level: "classify" });
    expect(v.gate).toBeUndefined();
    const dev = await as(api, "developer", () => api.getPromotion(ORG, r.promotionId));
    expect(dev.clearance).toMatchObject({ kind: "classifier", clearedBy: "u-client" });
    expect(dev.gate?.reasonCode).toBe("classifier");
    expect(dev.gate?.veto.kind).toBe("additive");
    expect(dev.gate?.perPath).toContainEqual({ path: "api/migrations/0002_phone.sql", level: "classify", rule: 1 });
    const ev = dev.gate?.classifier.evidence;
    expect(dev.gate?.classifier).toMatchObject({ asked: true, cleared: true, reason: "cleared" });
    expect(ev).toMatchObject({ provider: "jev", threshold: 0.9, cleared: true, failed: null, truncated: false });
    expect(Object.keys(ev!.answers!)).toEqual(["risk", "migration", "apiChange", "authOrPayments", "addressedToReviewer"]);
    for (const p of Object.values(ev!.safeProbability!)) expect(p).toBeGreaterThanOrEqual(0.9);
    expect(ev!.inputDigest).toMatch(/^[0-9a-f]{64}$/);
    // the review screen's inputs: requests, parts, per-resource main head and result, checks
    expect(dev.landings[0]).toMatchObject({ request: expect.stringContaining("phone"), parts: [{ part: 1, taskId: T.phone, title: "Add a phone field to the contact form" }] });
    expect(dev.resources!.map((x) => x.mountName).sort()).toEqual(["api", "website"]);
    const api0 = dev.resources!.find((x) => x.mountName === "api")!;
    expect(api0.head).not.toBe(api0.result);
    const sql = await as(api, "developer", () => api.readFile(ORG, PID, { mount: "api", path: "migrations/0002_phone.sql", revision: api0.result }));
    expect(await sql.text()).toContain("ADD COLUMN phone");
    expect(dev.checks).toMatchObject({ checks: expect.any(Array), contractChecks: expect.any(Array), mergeOutcome: expect.any(Array) });
    // its proposal is listed as a promotion and is not approved or accepted directly
    await as(api, "owner", async () => {
      const kinds = (await api.listProposals(ORG, PID)).filter((p) => p.proposalId === dev.proposalId);
      expect(kinds).toEqual([expect.objectContaining({ kind: "promotion", state: "accepted" })]);
      expect(await code(api.accept(ORG, dev.proposalId!, "k-1"))).toBe("promotion_proposal");
    });
  });

  it("the column rename (destructive migration): waits for a developer; the client cannot approve; a developer approves and it goes live", async () => {
    const { api, c } = staging();
    const r = await api.promoteTask(T.rename);
    const { v } = await drive(api, c, r.promotionId);
    expect(v).toMatchObject({ state: "pending_approval", level: "developer", reasonCode: "migration_destructive", reason: "Changes the database structure in a way that needs a developer." });
    expect(v.gate).toBeUndefined();
    expect(await landing(api, T.rename)).toMatchObject({ state: "promoting", promotion: { state: "pending_approval" } });
    expect(await code(api.approvePromotion(ORG, r.promotionId))).toBe("insufficient_role");
    const dev = await as(api, "developer", () => api.getPromotion(ORG, r.promotionId));
    expect(dev.gate?.veto).toEqual({ kind: "destructive", offending: [{ file: "api/migrations/0003_rename_contact_name.sql", statement: "ALTER TABLE contacts RENAME COLUMN name TO full_name" }] });
    expect(dev.gate?.classifier).toEqual({ asked: false, cleared: false, reason: "not_needed" });
    expect(dev.clearance).toBeNull();
    const approved = await as(api, "developer", () => api.approvePromotion(ORG, r.promotionId));
    expect(approved).toMatchObject({ state: "cleared", clearance: { kind: "developer", clearedBy: "u-developer" } });
    expect(await as(api, "developer", () => code(api.approvePromotion(ORG, r.promotionId)))).toBe("promotion_not_pending");
    expect((await drive(api, c, r.promotionId)).v.state).toBe("live");
  });

  it("send back: the developer's note is the client's reason and the task is back in staging", async () => {
    const { api, c } = staging();
    const r = await api.promoteTask(T.rename);
    await drive(api, c, r.promotionId);
    expect(await code(api.sendBackPromotion(ORG, r.promotionId, "Keep the old name"))).toBe("insufficient_role");
    expect(await as(api, "developer", () => code(api.sendBackPromotion(ORG, r.promotionId, "  ")))).toBe("invalid_request");
    const back = await as(api, "developer", () => api.sendBackPromotion(ORG, r.promotionId, "Keep the old column name; add a new one instead."));
    expect(back).toMatchObject({ state: "sent_back", reasonCode: "sent_back", reason: "Keep the old column name; add a new one instead.", clearance: null });
    expect(await api.getPromotion(ORG, r.promotionId)).toMatchObject({ state: "sent_back", reason: "Keep the old column name; add a new one instead." });
    expect(await landing(api, T.rename)).toMatchObject({ state: "landed", promotion: { promotionId: r.promotionId, state: "sent_back" } });
    expect(await as(api, "developer", () => code(api.sendBackPromotion(ORG, r.promotionId, "again")))).toBe("promotion_not_pending");
    // promote again: a new promotion
    const again = await api.promoteTask(T.rename);
    expect(again.promotionId).not.toBe(r.promotionId);
  });

  it("withdraw: the requester before the accept; viewers cannot; an accepted promotion is not withdrawn", async () => {
    const { api, c } = staging();
    const r = await api.promoteTask(T.rename);
    await drive(api, c, r.promotionId);
    expect(await as(api, "viewer", () => code(api.withdrawPromotion(ORG, r.promotionId)))).toBe("not_promotion_requester");
    expect(await api.withdrawPromotion(ORG, r.promotionId)).toMatchObject({ state: "withdrawn", reasonCode: "withdrawn", reason: "Withdrawn" });
    expect(await landing(api, T.rename)).toMatchObject({ state: "landed" });
    expect(await code(api.withdrawPromotion(ORG, r.promotionId))).toBe("promotion_not_in_flight");
    const live = await api.promoteTask(T.copy);
    await drive(api, c, live.promotionId);
    expect(await code(api.withdrawPromotion(ORG, live.promotionId))).toBe("promotion_accepted");
  });

  it("role rules: viewers cannot promote, a client cannot promote or see another person's task, a busy task is refused", async () => {
    const { api, c } = staging();
    expect(await as(api, "viewer", () => code(api.promoteTask(T.copy)))).toBe("not_found");
    expect(await as(api, "viewer", () => code(api.previewPromotion(T.copy)))).toBe("not_found");
    expect(await as(api, "viewer", () => code(api.listPromotions(ORG, PID)))).toBe("insufficient_role");
    expect(await code(api.promoteTask("task-unknown"))).toBe("not_found");
    // a developer's own task, landed on staging
    const t = await as(api, "developer", () => api.createTask(ORG, PID, { title: "Tidy the footer links", writeMounts: ["website"] }));
    api.completeRunningTasks();
    c.advance(STEP);
    // a client sees every landing, but reasons and parts only of their own
    const theirs = await landing(api, t.taskId);
    expect(theirs).toMatchObject({ state: "landed", reasonCode: null, reason: null, createdBy: "u-developer" });
    expect(theirs).not.toHaveProperty("parts");
    expect((await api.listTasks(ORG, PID)).some((x) => x.taskId === t.taskId)).toBe(false);
    expect(await code(api.promoteTask(t.taskId))).toBe("not_found");
    expect(await code(api.rollbackTask(t.taskId))).toBe("not_found");
    // promoting twice
    const r = await api.promoteTask(T.copy);
    const busy = await api.promoteTask(T.copy).catch((e: ApiError) => e);
    expect(busy).toMatchObject({ code: "promotion_in_progress", details: { promotionId: r.promotionId } });
  });

  it("lists promotions newest first: developers all (developer view), clients theirs (client view), filtered by state", async () => {
    const { api, c } = staging();
    const a = await api.promoteTask(T.copy);
    c.advance(STEP);
    const b = await api.promoteTask(T.rename);
    await drive(api, c, b.promotionId);
    const mine = await api.listPromotions(ORG, PID);
    expect(mine.map((p) => p.promotionId)).toEqual([b.promotionId, a.promotionId]);
    expect(mine.every((p) => p.gate === undefined)).toBe(true);
    const pending = await as(api, "developer", () => api.listPromotions(ORG, PID, ["pending_approval"]));
    expect(pending.map((p) => p.promotionId)).toEqual([b.promotionId]);
    expect(pending[0]!.gate?.reasonCode).toBe("migration_destructive");
    // a developer's promotion is not listed for the client
    const t = await as(api, "developer", () => api.createTask(ORG, PID, { title: "Tidy the footer links", writeMounts: ["website"] }));
    api.completeRunningTasks();
    c.advance(STEP);
    const d = await as(api, "developer", () => api.promoteTask(t.taskId));
    expect((await api.listPromotions(ORG, PID)).some((p) => p.promotionId === d.promotionId)).toBe(false);
    expect(await as(api, "developer", async () => (await api.listPromotions(ORG, PID)).length)).toBe(3);
    // a client reading another person's promotion gets no reason
    expect(await api.getPromotion(ORG, d.promotionId)).toMatchObject({ reasonCode: null, reason: null });
  });

  it("a client's list includes promotions they requested, even without a landing they created (as the Worker)", async () => {
    const { api, c } = staging();
    const t = await as(api, "developer", () => api.createTask(ORG, PID, { title: "Tidy the footer links", writeMounts: ["website"] }));
    api.completeRunningTasks();
    c.advance(STEP);
    const d = await as(api, "developer", () => api.promoteTask(t.taskId));
    expect((await api.listPromotions(ORG, PID)).some((p) => p.promotionId === d.promotionId)).toBe(false);
    // the client asked for it (e.g. it travelled with their own landing that later left the set)
    const row = (api as unknown as { promotions: Array<{ promotionId: string; requestedBy: string }> }).promotions.find((p) => p.promotionId === d.promotionId)!;
    row.requestedBy = "u-client";
    const listed = (await api.listPromotions(ORG, PID)).find((p) => p.promotionId === d.promotionId);
    expect(listed).toBeDefined();
    expect(listed!.gate).toBeUndefined();
  });

  it.each([
    ["risk", "The automatic review could not confirm this change is low risk."],
    ["migration", "Changes the database structure in a way that needs a developer."],
    ["apiChange", "May change how the API works for existing callers."],
    ["authOrPayments", "Touches sign-in or payments."],
    ["addressedToReviewer", "Needs a developer's review."],
  ] as const)("P3-5: a declined %s answer sends the phone field to a developer with its own text", async (failed, text) => {
    const { api, c } = staging();
    api.classifierOutcome = failed;
    const r = await api.promoteTask(T.phone);
    const { v } = await drive(api, c, r.promotionId);
    expect(v).toMatchObject({ state: "pending_approval", level: "developer", reasonCode: "classifier_declined", reason: text });
    const dev = await as(api, "developer", () => api.getPromotion(ORG, r.promotionId));
    expect(dev.gate?.classifier).toMatchObject({ asked: true, cleared: false, reason: "declined", evidence: { cleared: false, failed } });
  });

  it("P3-5: an unavailable classifier is classifier_unavailable with the unchanged text", async () => {
    const { api, c } = staging();
    api.classifierOutcome = "unavailable";
    const r = await api.promoteTask(T.phone);
    const { v } = await drive(api, c, r.promotionId);
    expect(v).toMatchObject({ state: "pending_approval", reasonCode: "classifier_unavailable", reason: "Needs a developer's review." });
    const dev = await as(api, "developer", () => api.getPromotion(ORG, r.promotionId));
    expect(dev.gate?.classifier).toMatchObject({ asked: true, cleared: false, reason: "error", evidence: { error: "timeout", answers: null } });
  });

  it("an owner's own request clears as a developer clearance", async () => {
    const { api, c } = staging("owner");
    const r = await api.promoteTask(T.rename);
    const { v } = await drive(api, c, r.promotionId);
    expect(v).toMatchObject({ state: "live", clearance: { kind: "developer", clearedBy: "u-owner" } });
  });

  it("a failed production release is retried by a developer, not a client", async () => {
    const { api, c } = staging();
    api.failNextPromotionRelease = true;
    const r = await api.promoteTask(T.copy);
    const { v } = await drive(api, c, r.promotionId);
    expect(v).toMatchObject({ state: "release_failed", reasonCode: "deploy_failed", reason: "The production update did not go live. Production still runs the previous version." });
    expect(await code(api.retryPromotionRelease(ORG, r.promotionId))).toBe("insufficient_role");
    expect(await as(api, "developer", () => api.retryPromotionRelease(ORG, r.promotionId))).toMatchObject({ state: "releasing" });
    expect((await drive(api, c, r.promotionId)).v.state).toBe("live");
    expect(await as(api, "developer", () => code(api.retryPromotionRelease(ORG, r.promotionId)))).toBe("promotion_not_release_failed");
  });

  it("New task follows the Worker's rules, starts Working, and lands on staging when the agent finishes", async () => {
    const { api, c } = staging();
    const ok = { title: "Add opening hours", request: "Show them on the contact page", writeMounts: ["website"] };
    expect(await code(api.createTask(ORG, PID, { ...ok, title: "   " }))).toBe("invalid_request");
    expect(await code(api.createTask(ORG, PID, { ...ok, title: "x".repeat(201) }))).toBe("invalid_request");
    expect(await code(api.createTask(ORG, PID, { ...ok, request: "x".repeat(16_001) }))).toBe("invalid_request");
    expect(await code(api.createTask(ORG, PID, { ...ok, writeMounts: [] }))).toBe("invalid_request");
    expect(await code(api.createTask(ORG, PID, { ...ok, writeMounts: ["nope"] }))).toBe("not_found");
    expect(await code(api.createTask(ORG, PID, { ...ok, writeMounts: ["quote-builder-concept"] }))).toBe("mount_read_only");
    expect(await code(api.createTask(ORG, PID, { ...ok, writeMounts: ["brand-assets"] }))).toBe("no_write_grant");
    expect(await as(api, "viewer", () => code(api.createTask(ORG, PID, ok)))).toBe("insufficient_role");
    const t = await api.createTask(ORG, PID, ok);
    expect(t).toMatchObject({ title: "Add opening hours", request: "Show them on the contact page", state: "provisioning", projectId: PID, orgId: ORG });
    expect(t.workspaces.filter((w) => w.access === "write").map((w) => w.mountName)).toEqual(["website"]);
    expect(t.workspaces.some((w) => w.access === "read")).toBe(true);
    expect((await api.listTasks(ORG, PID))[0]).toMatchObject({ taskId: t.taskId, state: "provisioning" });
    c.advance(STEP);
    expect((await api.listTasks(ORG, PID))[0]).toMatchObject({ taskId: t.taskId, state: "ready" });
    expect(await landing(api, t.taskId)).toBeUndefined();
    api.completeRunningTasks();
    expect((await api.listTasks(ORG, PID)).find((x) => x.taskId === t.taskId)?.state).toBe("submitted");
    expect(await landing(api, t.taskId)).toMatchObject({ state: "checking", createdBy: "u-client" });
    expect((await api.getStaging(ORG, PID)).building).toBe(true);
    c.advance(STEP);
    expect(await landing(api, t.taskId)).toMatchObject({ state: "landed" });
    // the seeded working task landed too
    expect(await landing(api, T.working)).toMatchObject({ state: "landed" });
    // a client in a project without staging cannot create tasks
    const off = new FakeApi({ role: "client" });
    expect(await code(off.createTask(ORG, PID, ok))).toBe("insufficient_role");
  });

  it("roll back takes a task out of staging; a task being promoted is refused", async () => {
    const { api, c } = staging();
    expect(await api.rollbackTask(T.copy)).toEqual({ buildId: expect.any(String) });
    expect(await landing(api, T.copy)).toMatchObject({ state: "rolling_back" });
    c.advance(STEP);
    expect(await landing(api, T.copy)).toMatchObject({ state: "rolled_back" });
    expect(await code(api.rollbackTask(T.copy))).toBe("not_in_staging");
    await api.promoteTask(T.phone);
    expect(await code(api.rollbackTask(T.phone))).toBe("promotion_in_progress");
    expect(await code(api.rollbackTask(T.working))).toBe("not_in_staging");
  });

  it("reset demo data rebuilds staging (newer last change, a Demo data was reset event); viewers cannot", async () => {
    const { api, c } = staging();
    const before = await api.getStaging(ORG, PID);
    expect(await as(api, "viewer", () => code(api.resetStaging(ORG, PID)))).toBe("insufficient_role");
    c.advance(60_000);
    const r = await api.resetStaging(ORG, PID);
    expect(r.buildId).toBeTruthy();
    expect((await api.getStaging(ORG, PID)).building).toBe(true);
    c.advance(STEP);
    const after = await api.getStaging(ORG, PID);
    expect(after.building).toBe(false);
    expect(after.current!.buildId).toBe(r.buildId);
    expect(after.current!.since > before.current!.since).toBe(true);
    const events = (await api.listEvents(ORG, { projectId: PID })).events;
    expect(events.find((e) => e.action === "staging.reset")).toMatchObject({ detail: { note: "Demo data was reset" } });
    const devEvents = (await as(api, "developer", () => api.listEvents(ORG, { projectId: PID }))).events;
    expect(devEvents.find((e) => e.action === "staging.reset")).toMatchObject({ detail: { buildId: r.buildId, note: "Demo data was reset" } });
  });

  // core `RiskEvidenceSchema` (packages/core/src/risk.ts): every key, nullable where the schema says so
  const EVIDENCE_KEYS = ["answers", "cleared", "error", "failed", "inputBytes", "inputDigest", "latencyMs", "model", "omittedFiles", "provider", "safeProbability", "threshold", "truncated"];

  it("classifier evidence has core RiskEvidenceSchema's shape: error null when answered, a null-heavy timeout when unavailable", async () => {
    const { api, c } = staging();
    api.classifierOutcome = "clear";
    const r = await api.promoteTask(T.phone);
    await drive(api, c, r.promotionId);
    const ev = (await as(api, "developer", () => api.getPromotion(ORG, r.promotionId))).gate!.classifier.evidence!;
    expect(Object.keys(ev).sort()).toEqual(EVIDENCE_KEYS);
    expect(ev).toMatchObject({ provider: "jev", model: expect.any(String), error: null, failed: null, omittedFiles: 0, truncated: false, cleared: true });
    expect(ev.inputBytes).toBeGreaterThan(0);
    expect(typeof ev.latencyMs).toBe("number");

    const u = staging();
    u.api.classifierOutcome = "unavailable";
    const r2 = await u.api.promoteTask(T.phone);
    await drive(u.api, u.c, r2.promotionId);
    const ev2 = (await as(u.api, "developer", () => u.api.getPromotion(ORG, r2.promotionId))).gate!.classifier.evidence!;
    expect(Object.keys(ev2).sort()).toEqual(EVIDENCE_KEYS);
    expect(ev2).toMatchObject({ error: "timeout", answers: null, safeProbability: null, failed: null, cleared: false, omittedFiles: 0 });
    expect(ev2.inputDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("list rows carry no resources or checks; getPromotion does", async () => {
    const { api, c } = staging();
    api.classifierOutcome = "clear";
    const r = await api.promoteTask(T.phone);
    await drive(api, c, r.promotionId);
    const row = (await as(api, "developer", () => api.listPromotions(ORG, PID))).find((p) => p.promotionId === r.promotionId)!;
    expect(row.gate?.reasonCode).toBe("classifier");
    expect(row).not.toHaveProperty("resources");
    expect(row).not.toHaveProperty("checks");
    const one = await as(api, "developer", () => api.getPromotion(ORG, r.promotionId));
    expect(one.resources!.length).toBeGreaterThan(0);
    expect(one.checks).not.toBeNull();
  });

  it("a developer without read on a folder the promotion changes gets the client view (get and list)", async () => {
    const { api, c } = staging();
    api.classifierOutcome = "clear";
    const r = await api.promoteTask(T.phone);
    await drive(api, c, r.promotionId);
    const apiFolder = (await as(api, "owner", () => api.getProject(ORG, PID))).mounts.find((m) => m.mountName === "api")!.resourceId;
    await as(api, "owner", () => api.putProjectAccess(ORG, PID, { userId: "u-developer", level: "write", folders: { [apiFolder]: "none" } }));
    const v = await as(api, "developer", () => api.getPromotion(ORG, r.promotionId));
    expect(v.state).toBe("live");
    for (const k of ["gate", "resources", "checks", "detail", "requestedBy", "proposalId"]) expect(v).not.toHaveProperty(k);
    expect(v.landings[0]).not.toHaveProperty("request");
    const row = (await as(api, "developer", () => api.listPromotions(ORG, PID))).find((p) => p.promotionId === r.promotionId)!;
    expect(row).not.toHaveProperty("gate");
    // the owner still reads everything
    expect((await as(api, "owner", () => api.getPromotion(ORG, r.promotionId))).gate?.reasonCode).toBe("classifier");
  });

  it("P3-11: an incomplete input is never sent: input_incomplete with its reasons, classifier_unavailable, and the developer's detail names it", async () => {
    const { api, c } = staging();
    api.classifierOutcome = "incomplete";
    const r = await api.promoteTask(T.phone);
    const { v } = await drive(api, c, r.promotionId);
    expect(v).toMatchObject({ state: "pending_approval", reasonCode: "classifier_unavailable", reason: "Needs a developer's review." });
    expect(v).not.toHaveProperty("detail");
    const dev = await as(api, "developer", () => api.getPromotion(ORG, r.promotionId));
    expect(dev.detail).toBe("classifier: input_incomplete (file_not_read)");
    expect(dev.gate?.classifier).toMatchObject({ asked: true, cleared: false, reason: "error", evidence: { error: "input_incomplete", incomplete: ["file_not_read"], answers: null, latencyMs: null } });
    // a timeout names its error too
    const u = staging();
    u.api.classifierOutcome = "unavailable";
    const r2 = await u.api.promoteTask(T.phone);
    await drive(u.api, u.c, r2.promotionId);
    expect((await as(u.api, "developer", () => u.api.getPromotion(ORG, r2.promotionId))).detail).toBe("classifier: timeout");
  });

  it("a rebuild carries a classifier clearance with its evidence (reasonCode classifier, not asked again)", async () => {
    const { api, c } = staging();
    api.classifierOutcome = "clear";
    const a = await api.promoteTask(T.copy);
    const b = await api.promoteTask(T.phone);
    await drive(api, c, a.promotionId);
    const { v } = await drive(api, c, b.promotionId);
    expect(v.state).toBe("live");
    const dev = await as(api, "developer", () => api.getPromotion(ORG, b.promotionId));
    expect(dev.gate?.reasonCode).toBe("classifier");
    expect(dev.gate?.classifier).toMatchObject({ asked: false, cleared: true, reason: "carried", evidence: { cleared: true, error: null } });
    expect(dev.clearance?.kind).toBe("classifier");
  });

  it("a rebuild carries a developer clearance over a classify level (reasonCode carried)", async () => {
    const { api, c } = staging();
    api.classifierOutcome = "risk";
    const b = await api.promoteTask(T.phone);
    await drive(api, c, b.promotionId);
    const a = await api.promoteTask(T.copy);
    // the copy holds production (accepting) when the developer approves: the phone field waits, then rebuilds on the new main
    c.advance(STEP * 4);
    expect((await api.getPromotion(ORG, a.promotionId)).state).toBe("accepting");
    await as(api, "developer", () => api.approvePromotion(ORG, b.promotionId));
    await drive(api, c, a.promotionId);
    const { v } = await drive(api, c, b.promotionId);
    expect(v.state).toBe("live");
    const dev = await as(api, "developer", () => api.getPromotion(ORG, b.promotionId));
    expect(dev.gate?.reasonCode).toBe("carried");
    expect(dev.gate?.classifier).toEqual({ asked: false, cleared: false, reason: "carried" });
    expect(dev).toMatchObject({ level: "classify", clearance: { kind: "developer" } });
  });

  it("promotion sets are core's: a website-only task whose closure is larger goes alone (gatesAlone), the rest Going without", async () => {
    const { api, c } = staging("developer");
    // the staging policy has a required website check that gates alone-first
    expect((await api.getProject(ORG, PID)).policy!.checks).toContainEqual(expect.objectContaining({ mountName: "website", required: true, gatesAlone: true }));
    const first = await api.createTask(ORG, PID, { title: "Tidy the footer links", writeMounts: ["website"] });
    api.completeRunningTasks();
    c.advance(STEP);
    const second = await api.createTask(ORG, PID, { title: "Fix the banner typo", writeMounts: ["website"] });
    api.completeRunningTasks();
    c.advance(STEP);
    // both wrote website/CHANGES.md: the second's closure holds the first, but its alone set is covered
    const preview = await api.previewPromotion(second.taskId);
    expect(preview.mode).toBe("alone");
    expect(preview.landings.map((l) => l.taskId)).toEqual([second.taskId]);
    expect(preview.goingWithout).toEqual([{ landingId: expect.any(String), taskId: first.taskId, title: "Tidy the footer links", text: "Going to production without 'Tidy the footer links' (still in staging)" }]);
    const r = await api.promoteTask(second.taskId);
    expect(r).toMatchObject({ mode: "alone", landings: [{ taskId: second.taskId }], goingWithout: [{ taskId: first.taskId }] });
    expect(await landing(api, first.taskId)).toMatchObject({ state: "landed" });
    expect(await api.getPromotion(ORG, r.promotionId)).toMatchObject({ mode: "alone", goingWithout: [{ taskId: first.taskId }] });
    // the first is promoted on its own meanwhile: the text says so
    await api.promoteTask(first.taskId);
    expect((await api.getPromotion(ORG, r.promotionId)).goingWithout[0]!.text).toBe("Going to production without 'Tidy the footer links' (being promoted separately)");
  });

  it("a closure that changes a resource no gatesAlone check covers is promoted together", async () => {
    const { api, c } = staging("developer");
    const first = await api.createTask(ORG, PID, { title: "Log quote requests", writeMounts: ["api"] });
    api.completeRunningTasks();
    c.advance(STEP);
    const second = await api.createTask(ORG, PID, { title: "Count quote requests", writeMounts: ["api"] });
    api.completeRunningTasks();
    c.advance(STEP);
    const preview = await api.previewPromotion(second.taskId);
    expect(preview).toMatchObject({ mode: "closure", goingWithout: [] });
    expect(preview.landings.map((l) => l.taskId)).toEqual([first.taskId, second.taskId]);
    // a later landing is no predecessor: the second's set is unchanged while it checks
    const third = await api.createTask(ORG, PID, { title: "Name the quote log", writeMounts: ["api"] });
    api.completeRunningTasks();
    expect((await api.previewPromotion(second.taskId)).landings).toHaveLength(2);
    expect(await code(api.previewPromotion(third.taskId))).toBe("not_landed");
    c.advance(STEP);
    expect((await api.previewPromotion(third.taskId)).landings.map((l) => l.taskId)).toEqual([first.taskId, second.taskId, third.taskId]);
  });

  it("before the owner's first production publish, promote and reset are staging_awaiting_baseline", async () => {
    const { api } = staging();
    (api as unknown as { liveRelease: string | null }).liveRelease = null;
    const s = await api.getStaging(ORG, PID);
    expect(s).toMatchObject({ enabled: true, state: "awaiting_baseline" });
    expect(await code(api.previewPromotion(T.copy))).toBe("staging_awaiting_baseline");
    expect(await code(api.promoteTask(T.copy))).toBe("staging_awaiting_baseline");
    expect(await code(api.resetStaging(ORG, PID))).toBe("staging_awaiting_baseline");
  });

  it("a developer's task outside staging still completes with Finish running agent", async () => {
    const c = clock();
    const api = new FakeApi({ role: "developer", now: c.now, promotionStepMs: STEP });
    const t = await api.createTask(ORG, PID, { title: "Tidy the footer links", writeMounts: ["website"] });
    api.completeRunningTasks();
    expect((await api.listTasks(ORG, PID)).find((x) => x.taskId === t.taskId)?.state).toBe("submitted");
  });

  it("retrying a failed release needs write on the folders the release deploys from", async () => {
    const { api, c } = staging();
    api.failNextPromotionRelease = true;
    const r = await api.promoteTask(T.copy);
    await drive(api, c, r.promotionId);
    await as(api, "owner", () => api.putProjectAccess(ORG, PID, { userId: "u-developer", level: "write", folders: { [R.api]: "read" } }));
    expect(await as(api, "developer", () => code(api.retryPromotionRelease(ORG, r.promotionId)))).toBe("no_write_grant");
    expect(await as(api, "owner", () => api.retryPromotionRelease(ORG, r.promotionId))).toMatchObject({ state: "releasing" });
  });

  it("mounts carry canStartTask like the Worker: clients in staging for git folders opened for writing", async () => {
    const { api } = staging();
    const starts = async (role: Role, a: FakeApi = api) => Object.fromEntries((await as(a, role, () => a.getProject(ORG, PID))).mounts.map((m) => [m.mountName, m.canStartTask]));
    expect(await starts("client")).toEqual({ website: true, api: true, "brand-assets": false, requirements: true, "quote-builder-concept": false });
    expect(await starts("owner")).toEqual({ website: true, api: true, "brand-assets": true, requirements: true, "quote-builder-concept": false });
    expect(Object.values(await starts("viewer")).every((v) => v === false)).toBe(true);
    const off = new FakeApi({ role: "client" });
    expect(Object.values(await starts("client", off)).every((v) => v === false)).toBe(true);
  });
});
