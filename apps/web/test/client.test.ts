import { describe, expect, it, vi } from "vitest";
import { ApiError, HttpApi } from "../src/api/client.js";
import { codeMessage } from "../src/ui.js";

/** A stand-in for XMLHttpRequest: records what was sent; the test drives progress, load and abort. */
class FakeXhr {
  static last: FakeXhr | null = null;
  method = "";
  url = "";
  headers: Record<string, string> = {};
  body: unknown = null;
  withCredentials = false;
  status = 0;
  responseText = "";
  aborted = false;
  upload: { onprogress: ((e: { loaded: number; total: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  constructor() {
    FakeXhr.last = this;
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(k: string, v: string) {
    this.headers[k.toLowerCase()] = v;
  }
  send(body: unknown) {
    this.body = body;
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  respond(status: number, body: unknown) {
    this.status = status;
    this.responseText = typeof body === "string" ? body : JSON.stringify(body);
    this.onload?.();
  }
}
const xhrFactory = () => new FakeXhr() as unknown as XMLHttpRequest;

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function recorder(respond: (url: string, init?: RequestInit) => Response) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return respond(url, init);
  };
  return { calls, api: new HttpApi("", fetchImpl) };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("HttpApi", () => {
  it("sends an edited working copy back as a raw same-origin ZIP with mode and deletion intents", async () => {
    const { calls, api } = recorder(() => json({ returnId: "edr-1", state: "queued" }, 202));
    const zip = new Blob(["PK"], { type: "application/zip" });
    await api.sendBack("o-1", "eds-1", zip, { mode: "partial", deletions: ["src/old.ts"] });
    const c = calls[0]!;
    expect(c.url).toBe("/api/orgs/o-1/edition-sessions/eds-1/returns?mode=partial&delete=src%2Fold.ts");
    expect(c.init?.method).toBe("POST");
    expect(c.init?.credentials).toBe("same-origin");
    expect((c.init?.headers as Record<string, string>)["content-type"]).toBe("application/zip");
    expect(c.init?.body).toBe(zip);
  });

  it("member and org admin calls hit the documented routes", async () => {
    const { calls, api } = recorder(() => json({}));
    await api.createOrg("Acme");
    await api.inviteMember("o-1", { email: "a@b.c", role: "client" });
    await api.resendInvite("o-1", "u-2");
    await api.updateMemberRole("o-1", "u-2", "viewer");
    await api.removeMember("o-1", "u-2");
    expect(calls.map((c) => `${c.init?.method} ${c.url}`)).toEqual([
      "POST /api/orgs",
      "POST /api/orgs/o-1/members",
      "POST /api/orgs/o-1/members/u-2/invite",
      "PATCH /api/orgs/o-1/members/u-2",
      "DELETE /api/orgs/o-1/members/u-2",
    ]);
  });

  it("sends the explicit native onboarding mode without changing older callers", async () => {
    const { calls, api } = recorder(() => json({projectId:"p-new", name:"Reference"}));
    await api.createProject("o-1", "Reference", "agent-native");
    await api.createProject("o-1", "Agency", "legacy");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({name:"Reference",mode:"agent-native"});
    expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({name:"Agency",mode:"legacy"});
  });

  it("project and folder admin calls hit the documented routes", async () => {
    const { calls, api } = recorder(() => json({ projectId: "p-9", name: "X", resources: [], folders: [], mountName: "m", resourceId: "r", changed: [] }));
    await api.createProject("o-1", "X");
    await api.listResources("o-1");
    await api.listFolders("o-1", "p-1");
    await api.createFolder("o-1", "p-1", { name: "media" });
    await api.retryFolderSetup("o-1", "p-1", "brand assets");
    await api.attachFolder("o-1", "p-1", { mountName: "site", resourceId: "res-1" });
    await api.detachFolder("o-1", "p-1", "site");
    expect(calls.map((c) => `${c.init?.method} ${c.url}`)).toEqual([
      "POST /api/orgs/o-1/projects",
      "GET /api/orgs/o-1/resources",
      "GET /api/orgs/o-1/projects/p-1/folders",
      "POST /api/orgs/o-1/projects/p-1/folders",
      "POST /api/orgs/o-1/projects/p-1/folders/brand%20assets/setup/retry",
      "POST /api/orgs/o-1/projects/p-1/mounts",
      "DELETE /api/orgs/o-1/projects/p-1/mounts/site",
    ]);
    // a new folder is named only: there is no kind to choose (phase 4)
    expect(JSON.parse(String(calls[3]!.init?.body))).toEqual({ name: "media" });
  });

  it("staging, promotion and client task calls hit the documented routes with their bodies", async () => {
    const { calls, api } = recorder(() => json({ captures: [{ captureId: "cap-1" }], promotions: [{ promotionId: "prm-1" }], tasks: [] }));
    await api.getStaging("o-1", "p-1");
    await api.resetStaging("o-1", "p-1");
    expect(await api.listCaptures("o-1", "p-1")).toEqual([{ captureId: "cap-1" }]);
    await api.rollbackTask("task-1");
    expect(await api.listPromotions("o-1", "p-1")).toEqual([{ promotionId: "prm-1" }]);
    await api.listPromotions("o-1", "p-1", ["pending_approval", "cleared"]);
    await api.getPromotion("o-1", "prm-1");
    await api.previewPromotion("task-1");
    await api.promoteTask("task-1");
    await api.approvePromotion("o-1", "prm-1");
    await api.sendBackPromotion("o-1", "prm-1", "Keep the old column name for now.");
    await api.withdrawPromotion("o-1", "prm-1");
    await api.retryPromotionRelease("o-1", "prm-1");
    await api.createTask("o-1", "p-1", { title: "Add a phone field", request: "On the contact form", writeMounts: ["website", "api"] });
    await api.listTasks("o-1", "p-1");
    expect(calls.map((c) => `${c.init?.method} ${c.url}${c.init?.body ? ` ${String(c.init.body)}` : ""}`)).toEqual([
      "GET /api/orgs/o-1/projects/p-1/staging",
      "POST /api/orgs/o-1/projects/p-1/staging/reset {}",
      "GET /api/orgs/o-1/projects/p-1/staging/sent",
      "POST /api/tasks/task-1/rollback {}",
      "GET /api/orgs/o-1/projects/p-1/promotions",
      "GET /api/orgs/o-1/projects/p-1/promotions?state=pending_approval%2Ccleared",
      "GET /api/orgs/o-1/promotions/prm-1",
      "GET /api/tasks/task-1/promote",
      "POST /api/tasks/task-1/promote {}",
      "POST /api/orgs/o-1/promotions/prm-1/approve {}",
      'POST /api/orgs/o-1/promotions/prm-1/send-back {"note":"Keep the old column name for now."}',
      "POST /api/orgs/o-1/promotions/prm-1/withdraw {}",
      "POST /api/orgs/o-1/promotions/prm-1/retry-release {}",
      'POST /api/orgs/o-1/projects/p-1/tasks {"title":"Add a phone field","request":"On the contact form","writeMounts":["website","api"]}',
      "GET /api/orgs/o-1/projects/p-1/tasks",
    ]);
  });

  it("project access calls hit the documented routes", async () => {
    const { calls, api } = recorder(() => json({ people: [] }));
    await api.getProjectAccess("o-1", "p-1");
    await api.putProjectAccess("o-1", "p-1", { userId: "u-2", level: "read" });
    expect(calls.map((c) => `${c.init?.method} ${c.url}`)).toEqual(["GET /api/orgs/o-1/projects/p-1/access", "PUT /api/orgs/o-1/projects/p-1/access"]);
    expect(JSON.parse(String(calls[1]!.init!.body))).toEqual({ userId: "u-2", level: "read" });
  });

  it("policy calls hit the documented routes, with expectedRevision on save", async () => {
    const { calls, api } = recorder(() => json({ ok: true, issues: [], policyRevision: 2, policy: {} }));
    const policy = { checks: [], contracts: [], rules: [] };
    await api.validatePolicy("o-1", "p-1", policy);
    await api.putPolicy("o-1", "p-1", policy, 1);
    expect(calls.map((c) => `${c.init?.method} ${c.url}`)).toEqual(["POST /api/orgs/o-1/projects/p-1/policy/validate", "PUT /api/orgs/o-1/projects/p-1/policy"]);
    expect(JSON.parse(String(calls[1]!.init!.body))).toEqual({ ...policy, expectedRevision: 1 });
  });

  it("putPolicy without expectedRevision sends exactly the policy", async () => {
    const { calls, api } = recorder(() => json({ policyRevision: 2, policy: {} }));
    const policy = { checks: [], contracts: [], rules: ["r"], approvalRoles: ["owner" as const] };
    await api.putPolicy("o-1", "p-1", policy);
    const body = JSON.parse(String(calls[0]!.init!.body));
    expect(body).toEqual(policy);
    expect(body).not.toHaveProperty("expectedRevision");
  });

  it("sends every request same-origin with the cookie session, never a bearer", async () => {
    const { calls, api } = recorder(() => json({ user: { userId: "u1", email: "a@b.c" }, memberships: [] }));
    await api.me();
    expect(calls[0]!.url).toBe("/api/me");
    expect(calls[0]!.init?.credentials).toBe("same-origin");
    expect(JSON.stringify(calls[0]!.init?.headers)).not.toMatch(/authorization/i);
  });

  it("writes JSON with content-type application/json (CSRF and 415 rules)", async () => {
    const { calls, api } = recorder(() => json({ approvalId: "a1" }, 201));
    await api.approve("o-1", "prop-1", "ab".repeat(32));
    const c = calls[0]!;
    expect(c.url).toBe("/api/orgs/o-1/proposals/prop-1/approvals");
    expect(c.init?.method).toBe("POST");
    expect((c.init?.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(JSON.parse(c.init?.body as string)).toEqual({ proposalHash: "ab".repeat(32) });
  });

  it("sends a web magic-link request and posts the token on verify", async () => {
    const { calls, api } = recorder((url) => (url.endsWith("magic-link") ? json({ ok: true }, 202) : json({ user: { userId: "u", email: "e@x.y" }, expiresAt: "2026-11-05T00:00:00.000Z" })));
    await api.requestMagicLink("e@x.y");
    await api.verify("cfm_abc");
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({ email: "e@x.y", client: "web" });
    expect(calls[1]!.url).toBe("/api/auth/verify");
    expect(JSON.parse(calls[1]!.init?.body as string)).toEqual({ token: "cfm_abc" });
  });

  it("encodes query parameters for tree, file and proposals", async () => {
    const { calls, api } = recorder(() => json({ entries: [], proposals: [] }));
    await api.listTree("o-1", "p-1", { mount: "brand assets", path: "logos/a b" });
    await api.listProposals("o-1", "p-1");
    expect(calls[0]!.url).toBe("/api/orgs/o-1/projects/p-1/tree?mount=brand%20assets&path=logos%2Fa%20b");
    expect(calls[1]!.url).toBe("/api/orgs/o-1/proposals?projectId=p-1");
    expect(api.fileUrl("o-1", "p-1", { mount: "website", path: "src/x.ts", revision: "art:r:abc" })).toBe("/api/orgs/o-1/projects/p-1/file?mount=website&path=src%2Fx.ts&revision=art%3Ar%3Aabc");
  });

  it("maps error bodies to ApiError with the stable code and details", async () => {
    const { api } = recorder(() => json({ error: { code: "expected_head_stale", message: "head moved", details: { resourceId: "res-1" } } }, 409));
    const err = await api.accept("o-1", "prop-1", "accept:key-0001").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code: "expected_head_stale", details: { resourceId: "res-1" } });
  });

  it("keeps a usable error when the body is not JSON", async () => {
    const { api } = recorder(() => new Response("bad gateway", { status: 502, statusText: "Bad Gateway" }));
    const err = (await api.getProject("o", "p").catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe("http_502");
    expect(err.status).toBe(502);
  });

  it("passes the idempotency key on accept and the restore body unchanged", async () => {
    const { calls, api } = recorder(() => json({}));
    await api.accept("o-1", "prop-1", "accept:k-12345678");
    await api.restore("o-1", "res-1", { expectedHead: "art:r:1", targetRevision: "art:r:0", idempotencyKey: "restore:k-1234" });
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({ idempotencyKey: "accept:k-12345678" });
    expect(JSON.parse(calls[1]!.init?.body as string)).toEqual({ expectedHead: "art:r:1", targetRevision: "art:r:0", idempotencyKey: "restore:k-1234" });
  });

  it("upload and file-change calls hit the documented routes with their bodies", async () => {
    const { calls, api } = recorder(() => json({ uploadId: "lfs-1", partSize: 52_428_800, parts: 1, expiresAt: "x", changes: [], stagingId: "lfs-1", size: 3, changeId: "fc-1" }));
    await api.startUpload("o-1", "p-1", "brand assets", { path: "videos/a.mp4", size: 3, mime: "video/mp4" });
    await api.completeUpload("o-1", "lfs-1", [{ n: 1, etag: "e1" }]);
    await api.cancelUpload("o-1", "lfs-1");
    await api.createFileChange("o-1", "p-1", "site", { ops: [{ put: "a.mp4", stagingId: "lfs-1" }, { delete: "old" }], title: "T" });
    await api.getFileChange("o-1", "fc-1");
    await api.listFileChanges("o-1", "p-1", { mount: "site", limit: 5 });
    await api.listFileChanges("o-1", "p-1");
    expect(calls.map((c) => `${c.init?.method} ${c.url}`)).toEqual([
      "POST /api/orgs/o-1/projects/p-1/folders/brand%20assets/uploads",
      "POST /api/orgs/o-1/uploads/lfs-1/complete",
      "DELETE /api/orgs/o-1/uploads/lfs-1",
      "POST /api/orgs/o-1/projects/p-1/folders/site/changes",
      "GET /api/orgs/o-1/file-changes/fc-1",
      "GET /api/orgs/o-1/projects/p-1/file-changes?mount=site&limit=5",
      "GET /api/orgs/o-1/projects/p-1/file-changes",
    ]);
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({ path: "videos/a.mp4", size: 3, mime: "video/mp4" });
    expect(JSON.parse(String(calls[1]!.init!.body))).toEqual({ parts: [{ n: 1, etag: "e1" }] });
    expect(JSON.parse(String(calls[3]!.init!.body))).toEqual({ ops: [{ put: "a.mp4", stagingId: "lfs-1" }, { delete: "old" }], title: "T" });
    for (const c of calls) expect(c.init?.credentials).toBe("same-origin");
  });

  it("listFileChanges unwraps { changes }", async () => {
    const { api } = recorder(() => json({ changes: [{ changeId: "fc-1" }] }));
    expect(await api.listFileChanges("o-1", "p-1")).toEqual([{ changeId: "fc-1" }]);
  });

  it("putUploadPart PUTs the raw part with credentials and reports progress", async () => {
    const api = new HttpApi({ fetchImpl: async () => json({}), xhrFactory });
    const bytes = new Blob(["hello"]);
    const seen: number[] = [];
    const p = api.putUploadPart("o-1", "lfs-1", 2, bytes, { signal: new AbortController().signal, onProgress: (n) => seen.push(n) });
    const x = FakeXhr.last!;
    expect(x.method).toBe("PUT");
    expect(x.url).toBe("/api/orgs/o-1/uploads/lfs-1/parts/2");
    expect(x.withCredentials).toBe(true);
    expect(x.body).toBe(bytes);
    x.upload.onprogress?.({ loaded: 2, total: 5 });
    x.upload.onprogress?.({ loaded: 5, total: 5 });
    x.respond(200, { etag: "etag-2" });
    expect(await p).toEqual({ etag: "etag-2" });
    expect(seen).toEqual([2, 5]);
  });

  it("putUploadPart aborts the request when the signal fires", async () => {
    const api = new HttpApi({ xhrFactory });
    const ctl = new AbortController();
    const p = api.putUploadPart("o-1", "lfs-1", 1, new Blob(["x"]), { signal: ctl.signal });
    const x = FakeXhr.last!;
    ctl.abort();
    expect(x.aborted).toBe(true);
    const err = (await p.catch((e: unknown) => e)) as Error;
    expect(err.name).toBe("AbortError");
  });

  it("putUploadPart refuses at once with an already-aborted signal", async () => {
    const api = new HttpApi({ xhrFactory });
    const ctl = new AbortController();
    ctl.abort();
    FakeXhr.last = null;
    const err = (await api.putUploadPart("o-1", "lfs-1", 1, new Blob(["x"]), { signal: ctl.signal }).catch((e: unknown) => e)) as Error;
    expect(err.name).toBe("AbortError");
    expect(FakeXhr.last).toBeNull();
  });

  it("putUploadPart turns an error body into an ApiError, and a network failure into one too", async () => {
    const api = new HttpApi({ xhrFactory });
    const p = api.putUploadPart("o-1", "lfs-1", 1, new Blob(["x"]), { signal: new AbortController().signal });
    FakeXhr.last!.respond(400, { error: { code: "part_size_mismatch", message: "part 1 must be 5 bytes" } });
    expect(await p.catch((e: unknown) => e)).toMatchObject({ status: 400, code: "part_size_mismatch", message: "part 1 must be 5 bytes" });
    const q = api.putUploadPart("o-1", "lfs-1", 1, new Blob(["x"]), { signal: new AbortController().signal });
    FakeXhr.last!.respond(502, "bad gateway");
    expect(await q.catch((e: unknown) => e)).toMatchObject({ status: 502, code: "http_502" });
    const r = api.putUploadPart("o-1", "lfs-1", 1, new Blob(["x"]), { signal: new AbortController().signal });
    FakeXhr.last!.onerror?.();
    const err = await r.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 0, code: "network_error" });
  });

  it("review 6: cancelUpload outlives the page (keepalive), so leaving still frees the upload", async () => {
    const { calls, api } = recorder(() => json({}));
    await api.cancelUpload("o-1", "lfs-1");
    expect(calls[0]!.init).toMatchObject({ method: "DELETE", keepalive: true, credentials: "same-origin" });
  });

  it("review 9: a part with no progress for 60 s is aborted and fails as a retryable network error", async () => {
    vi.useFakeTimers();
    try {
      const api = new HttpApi({ xhrFactory });
      const p = api.putUploadPart("o-1", "lfs-1", 1, new Blob(["hello"]), { signal: new AbortController().signal });
      const x = FakeXhr.last!;
      vi.advanceTimersByTime(59_000);
      x.upload.onprogress?.({ loaded: 1, total: 5 }); // progress restarts the watch
      vi.advanceTimersByTime(59_000);
      expect(x.aborted).toBe(false);
      vi.advanceTimersByTime(1_000);
      expect(x.aborted).toBe(true);
      const err = await p.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect(err).toMatchObject({ status: 0, code: "stalled" });
      // an answered part leaves no timer behind
      const q = api.putUploadPart("o-1", "lfs-1", 2, new Blob(["x"]), { signal: new AbortController().signal });
      FakeXhr.last!.respond(200, { etag: "e" });
      expect(await q).toEqual({ etag: "e" });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an error body on a file change becomes an ApiError", async () => {
    const { api } = recorder(() => json({ error: { code: "too_many_operations", message: "a change has at most 1000 operations" } }, 413));
    expect(await api.createFileChange("o-1", "p-1", "site", { ops: [{ delete: "a" }] }).catch((e: unknown) => e)).toMatchObject({ status: 413, code: "too_many_operations" });
  });

  const fileRes = (body: BodyInit, headers: Record<string, string>) => new Response(body, { status: 200, headers: { "content-type": "application/octet-stream", "x-commonforge-revision": "art:r:abc", ...headers } });
  const blob = "ab".repeat(20);

  it("readFileForEdit reads the text, the blob id and the revision", async () => {
    const { calls, api } = recorder(() => fileRes("héllo\n", { "x-commonforge-blob": blob }));
    const f = await api.readFileForEdit("o-1", "p-1", { mount: "site", path: "a.txt" });
    expect(calls[0]!.url).toBe("/api/orgs/o-1/projects/p-1/file?mount=site&path=a.txt");
    expect(calls[0]!.init?.credentials).toBe("same-origin");
    expect(f).toEqual({ text: "héllo\n", baseBlob: blob, revisionId: "art:r:abc", size: 7 });
  });

  it("readFileForEdit refuses LFS files, files without a blob id, large files, NUL and non-UTF-8", async () => {
    const refused = async (res: () => Response) => {
      const { api } = recorder(res);
      return api.readFileForEdit("o-1", "p-1", { mount: "site", path: "a" }).catch((e: unknown) => e);
    };
    const notEditable = { status: 409, code: "not_editable" };
    expect(await refused(() => fileRes("x", { "x-commonforge-lfs": "ab".repeat(32) }))).toMatchObject(notEditable);
    expect(await refused(() => fileRes("x", { "x-commonforge-lfs": "missing", "x-commonforge-blob": blob }))).toMatchObject(notEditable);
    expect(await refused(() => fileRes("x", {}))).toMatchObject(notEditable);
    expect(await refused(() => fileRes(new Uint8Array(1024 * 1024).fill(97), { "x-commonforge-blob": blob }))).toMatchObject(notEditable);
    expect(await refused(() => fileRes("a\0b", { "x-commonforge-blob": blob }))).toMatchObject(notEditable);
    expect(await refused(() => fileRes(new Uint8Array([0xff, 0xfe, 0x41]), { "x-commonforge-blob": blob }))).toMatchObject(notEditable);
    const err = await refused(() => fileRes("x", {}));
    expect(err).toBeInstanceOf(ApiError);
  });

  /** A body that counts what was read and whether it was canceled. */
  const tracked = (chunks: Uint8Array[]) => {
    const t = { pulls: 0, canceled: false, body: null as unknown as ReadableStream<Uint8Array> };
    let i = 0;
    t.body = new ReadableStream<Uint8Array>(
      {
        pull(c) {
          t.pulls++;
          if (i < chunks.length) c.enqueue(chunks[i++]!);
          else c.close();
        },
        cancel() {
          t.canceled = true;
        },
      },
      { highWaterMark: 0 },
    );
    return t;
  };

  it("review 10: a content-length of 1 MiB or more is refused without reading the body", async () => {
    const t = tracked([new Uint8Array(10)]);
    const { api } = recorder(() => new Response(t.body, { status: 200, headers: { "x-commonforge-blob": blob, "content-length": String(2 * 1024 * 1024) } }));
    expect(await api.readFileForEdit("o-1", "p-1", { mount: "site", path: "a" }).catch((e: unknown) => e)).toMatchObject({ status: 409, code: "not_editable" });
    expect(t.pulls).toBe(0);
    expect(t.canceled).toBe(true);
  });

  it("review 10: every refusal cancels the body; a body growing past 1 MiB is stopped there", async () => {
    for (const headers of [{ "x-commonforge-lfs": "ab".repeat(32), "x-commonforge-blob": blob }, {}] as Array<Record<string, string>>) {
      const t = tracked([new Uint8Array(10)]);
      const { api } = recorder(() => new Response(t.body, { status: 200, headers }));
      expect(await api.readFileForEdit("o-1", "p-1", { mount: "site", path: "a" }).catch((e: unknown) => e)).toMatchObject({ code: "not_editable" });
      expect(t.pulls).toBe(0);
      expect(t.canceled).toBe(true);
    }
    const chunk = new Uint8Array(512 * 1024).fill(97);
    const t = tracked([chunk, chunk, chunk, chunk, chunk]); // 2.5 MiB, no content-length
    const { api } = recorder(() => new Response(t.body, { status: 200, headers: { "x-commonforge-blob": blob } }));
    expect(await api.readFileForEdit("o-1", "p-1", { mount: "site", path: "a" }).catch((e: unknown) => e)).toMatchObject({ code: "not_editable" });
    expect(t.pulls).toBeLessThanOrEqual(2);
    expect(t.canceled).toBe(true);
  });

  it("readFileForEdit passes the server's own refusal through", async () => {
    const { api } = recorder(() => json({ error: { code: "not_found", message: "file not found" } }, 404));
    expect(await api.readFileForEdit("o-1", "p-1", { mount: "site", path: "a" }).catch((e: unknown) => e)).toMatchObject({ status: 404, code: "not_found" });
  });

  it("the options constructor keeps the default same-origin base", async () => {
    const { calls } = recorder(() => json({}));
    const fetchImpl = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return json({ user: {}, memberships: [] });
    };
    await new HttpApi({ fetchImpl }).me();
    expect(calls[0]!.url).toBe("/api/me");
  });
});

describe("error sentences for uploads and file changes", () => {
  const codes = ["edit_unsupported", "file_changed", "file_missing", "path_exists", "file_too_large", "change_too_large", "too_many_operations", "edit_too_large", "edits_too_large", "invalid_upload", "hash_mismatch", "check_failed", "no_write_grant", "not_editable", "object_missing", "folder_missing", "stale_base", "invalid_path"];
  it.each(codes)("%s has its own sentence", (c) => {
    const m = codeMessage(c, "raw server text");
    expect(m).not.toContain("raw server text");
    expect(m).toMatch(/\.$/);
  });
});
