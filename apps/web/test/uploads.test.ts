import { describe, expect, it } from "vitest";
import { ApiError } from "../src/api/client.js";
import type { FileChange, FileChangeOp, UploadStart } from "../src/api/types.js";
import { UploadQueue, type UploadBatch, type UploadItem, type UploadQueueDeps } from "../src/lib/uploads.js";

/** Lets every settled promise run its continuations (no timers stay behind). */
const flush = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};

interface PendingPart {
  uploadId: string;
  n: number;
  bytes: Blob;
  signal: AbortSignal;
  onProgress?: (sent: number) => void;
  resolve: (v: { etag: string }) => void;
  reject: (e: unknown) => void;
}

/**
 * A scripted API: parts wait in `pending` until the test settles them, so concurrency can be
 * observed; `failPart` decides which attempts fail.
 */
function scripted(opts: { partSize?: number; failPart?: (path: string, n: number, attempt: number) => unknown; failStart?: (path: string) => unknown; failChange?: (attempt: number) => unknown } = {}) {
  const partSize = opts.partSize ?? 4;
  const calls: string[] = [];
  const pending: PendingPart[] = [];
  const paths = new Map<string, string>();
  const attempts = new Map<string, number>();
  const changes: Array<{ mount: string; ops: FileChangeOp[]; title?: string }> = [];
  const canceled: string[] = [];
  /** the idempotency key of every createFileChange call, failed ones too */
  const keys: Array<string | undefined> = [];
  const open = new Set<string>(); // started and neither completed nor canceled
  let maxParts = 0;
  let maxFiles = 0;
  let seq = 0;
  let changeAttempts = 0;
  const api: UploadQueueDeps["api"] = {
    async startUpload(_org, _pid, _mount, body): Promise<UploadStart> {
      calls.push(`start ${body.path} ${body.size} ${body.mime}`);
      const err = opts.failStart?.(body.path);
      if (err) throw err;
      const uploadId = `up-${++seq}`;
      paths.set(uploadId, body.path);
      open.add(uploadId);
      maxFiles = Math.max(maxFiles, open.size);
      return { uploadId, partSize, parts: Math.ceil(body.size / partSize), expiresAt: "2026-10-08T00:00:00.000Z" };
    },
    putUploadPart(_org, uploadId, n, bytes, o) {
      const path = paths.get(uploadId)!;
      const key = `${path}#${n}`;
      const attempt = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, attempt);
      calls.push(`put ${path} ${n} ${bytes.size}`);
      return new Promise((resolve, reject) => {
        if (o.signal.aborted) return reject(new DOMException("the upload was canceled", "AbortError"));
        const p: PendingPart = { uploadId, n, bytes, signal: o.signal, onProgress: o.onProgress, resolve, reject };
        const fail = opts.failPart?.(path, n, attempt);
        if (fail) {
          reject(fail);
          return;
        }
        pending.push(p);
        maxParts = Math.max(maxParts, pending.length);
        o.signal.addEventListener("abort", () => {
          const i = pending.indexOf(p);
          if (i >= 0) pending.splice(i, 1);
          reject(new DOMException("the upload was canceled", "AbortError"));
        });
      });
    },
    async completeUpload(_org, uploadId, parts) {
      calls.push(`complete ${paths.get(uploadId)} ${parts.map((p) => `${p.n}:${p.etag}`).join(",")}`);
      open.delete(uploadId);
      return { stagingId: `stg-${uploadId}`, size: 0 };
    },
    async cancelUpload(_org, uploadId) {
      calls.push(`cancel ${paths.get(uploadId)}`);
      canceled.push(uploadId);
      open.delete(uploadId);
    },
    async createFileChange(_org, _pid, mount, { idempotencyKey, ...body }): Promise<FileChange> {
      calls.push(`change ${mount} ${body.title}`);
      keys.push(idempotencyKey);
      changeAttempts++;
      const err = opts.failChange?.(changeAttempts);
      if (err) throw err;
      changes.push({ mount, ...body });
      return { changeId: `fc-${changes.length}`, projectId: "p-1", mountName: mount, title: body.title ?? "", state: "applying", attempt: 1, proposalId: null, createdAt: "", updatedAt: "" };
    },
  };
  /** settles every waiting part (each one's etag names it), then lets the queue move on */
  const settleAll = async () => {
    for (let guard = 0; guard < 1000; guard++) {
      await flush();
      const p = pending.shift();
      if (!p) return;
      p.onProgress?.(p.bytes.size);
      p.resolve({ etag: `e-${paths.get(p.uploadId)}-${p.n}` });
    }
  };
  return { api, calls, pending, changes, canceled, keys, settleAll, get maxParts() { return maxParts; }, get maxFiles() { return maxFiles; } };
}

function setup(opts: Parameters<typeof scripted>[0] = {}) {
  const s = scripted(opts);
  const sleeps: number[] = [];
  const q = new UploadQueue({ api: s.api, org: "acme", pid: "p-1", sleep: async (ms) => void sleeps.push(ms) });
  let state: { items: UploadItem[]; batches: UploadBatch[] } = { items: [], batches: [] };
  q.subscribe((st) => (state = st));
  return Object.assign(s, { q, sleeps, state: () => state });
}

const blob = (n: number, fill = "x") => new Blob([fill.repeat(n)]);

describe("UploadQueue: parts", () => {
  it("slices each file into partSize parts in order, completes it with every etag, and sends one change", async () => {
    const t = setup({ partSize: 4 });
    const batchId = t.q.add("site", "media", [{ file: new Blob(["abcdefghij"]), relPath: "a.bin", mime: "application/octet-stream" }]);
    await t.settleAll();
    await flush();
    expect(t.calls).toEqual([
      "start media/a.bin 10 application/octet-stream",
      "put media/a.bin 1 4",
      "put media/a.bin 2 4",
      "put media/a.bin 3 2",
      "complete media/a.bin 1:e-media/a.bin-1,2:e-media/a.bin-2,3:e-media/a.bin-3",
      "change site Uploaded 1 file to media",
    ]);
    expect(t.changes).toEqual([{ mount: "site", ops: [{ put: "media/a.bin", stagingId: "stg-up-1" }], title: "Uploaded 1 file to media" }]);
    const item = t.state().items[0]!;
    expect(item).toMatchObject({ batchId, path: "media/a.bin", size: 10, sent: 10, state: "done", stagingId: "stg-up-1" });
    expect(t.state().batches[0]).toMatchObject({ id: batchId, changeId: "fc-1", change: { changeId: "fc-1" } });
    expect(t.q.busy).toBe(false);
  });

  it("sends the slices' bytes", async () => {
    const t = setup({ partSize: 4 });
    t.q.add("site", "", [{ file: new Blob(["abcdefghij"]), relPath: "a.txt" }]);
    await flush();
    const texts = await Promise.all(t.pending.map((p) => p.bytes.text()));
    expect(texts).toEqual(["abcd", "efgh", "ij"]);
    await t.settleAll();
  });

  it("uses the blob's type, or application/octet-stream, when no mime is given", async () => {
    const t = setup();
    t.q.add("site", "", [{ file: new Blob(["hi"], { type: "text/plain" }), relPath: "a.txt" }, { file: new Blob(["hi"]), relPath: "b" }]);
    await t.settleAll();
    expect(t.calls.filter((c) => c.startsWith("start"))).toEqual(["start a.txt 2 text/plain", "start b 2 application/octet-stream"]);
  });

  it("reports progress across parts", async () => {
    const t = setup({ partSize: 4 });
    t.q.add("site", "", [{ file: blob(10), relPath: "a" }]);
    await flush();
    t.pending[0]!.onProgress?.(3);
    t.pending[1]!.onProgress?.(1);
    expect(t.state().items[0]).toMatchObject({ state: "uploading", sent: 4 });
    t.pending[0]!.onProgress?.(4);
    t.pending.shift()!.resolve({ etag: "e1" });
    await flush();
    expect(t.state().items[0]!.sent).toBe(5);
    expect(t.q.busy).toBe(true);
    await t.settleAll();
  });
});

describe("UploadQueue: concurrency", () => {
  it("never has more than 2 files or 4 parts in flight", async () => {
    const t = setup({ partSize: 1 });
    const files = Array.from({ length: 6 }, (_, i) => ({ file: blob(5), relPath: `f${i}` }));
    t.q.add("site", "", files);
    await flush();
    expect(t.pending.length).toBe(4);
    expect(t.state().items.filter((i) => i.state === "uploading")).toHaveLength(2);
    await t.settleAll();
    await flush();
    expect(t.maxParts).toBe(4);
    expect(t.maxFiles).toBe(2);
    expect(t.state().items.every((i) => i.state === "done")).toBe(true);
    expect(t.changes).toHaveLength(1);
    expect(t.changes[0]!.ops).toHaveLength(6);
  });

  it("shares the caps across batches", async () => {
    const t = setup({ partSize: 1 });
    t.q.add("site", "", [{ file: blob(3), relPath: "a" }, { file: blob(3), relPath: "b" }]);
    t.q.add("site", "docs", [{ file: blob(3), relPath: "c" }]);
    await flush();
    expect(t.state().items.filter((i) => i.state === "uploading").map((i) => i.path)).toEqual(["a", "b"]);
    await t.settleAll();
    await flush();
    expect(t.maxFiles).toBe(2);
    expect(t.maxParts).toBe(4);
    expect(t.changes.map((c) => c.title)).toEqual(["Uploaded 2 files to /", "Uploaded 1 file to docs"]);
  });
});

describe("UploadQueue: retries", () => {
  it("retries a failed part after 1 s, 4 s and 10 s", async () => {
    const t = setup({ partSize: 4, failPart: (_p, n, attempt) => (n === 2 && attempt <= 3 ? new ApiError(0, "network_error", "the connection failed") : undefined) });
    t.q.add("site", "", [{ file: blob(8), relPath: "a" }]);
    await t.settleAll();
    await flush();
    expect(t.sleeps).toEqual([1000, 4000, 10000]);
    expect(t.calls.filter((c) => c === "put a 2 4")).toHaveLength(4);
    expect(t.state().items[0]!.state).toBe("done");
    expect(t.changes).toHaveLength(1);
  });

  it("marks the item failed after three retries, cancels its upload, and holds the batch", async () => {
    const t = setup({ partSize: 4, failPart: (p) => (p === "bad" ? new ApiError(503, "unavailable", "try again later") : undefined) });
    t.q.add("site", "", [{ file: blob(4), relPath: "ok" }, { file: blob(4), relPath: "bad" }]);
    await t.settleAll();
    await flush();
    expect(t.sleeps).toEqual([1000, 4000, 10000]);
    expect(t.calls.filter((c) => c === "put bad 1 4")).toHaveLength(4);
    const bad = t.state().items.find((i) => i.path === "bad")!;
    expect(bad).toMatchObject({ state: "failed", error: "try again later" });
    expect(t.calls).toContain("cancel bad");
    expect(t.changes).toHaveLength(0); // the batch waits for Retry or Remove
    expect(t.q.busy).toBe(true); // review 5: "ok" is uploaded but not sent yet, so leaving the page warns
  });

  it("review 5: a batch held only by failed items is busy; once removed and sent, it is not", async () => {
    const t = setup({ partSize: 4, failPart: (p) => (p === "bad" ? new ApiError(400, "nope", "refused") : undefined) });
    t.q.add("site", "", [{ file: blob(4), relPath: "ok" }, { file: blob(4), relPath: "bad" }]);
    await t.settleAll();
    await flush();
    expect(t.q.busy).toBe(true);
    t.q.remove(t.state().items.find((i) => i.path === "bad")!.id);
    await flush();
    expect(t.changes).toHaveLength(1);
    expect(t.q.busy).toBe(false);
    // a batch of only failed items holds nothing uploaded: not busy
    const u = setup({ partSize: 4, failPart: () => new ApiError(400, "nope", "refused") });
    u.q.add("site", "", [{ file: blob(4), relPath: "bad" }]);
    await u.settleAll();
    expect(u.q.busy).toBe(false);
  });

  it("review 8: the wait before a retry ends at once when the item is canceled", async () => {
    const s = scripted({ partSize: 4, failPart: (p) => (p !== "c" ? new ApiError(0, "network_error", "offline") : undefined) });
    const q = new UploadQueue({ api: s.api, org: "acme", pid: "p-1", sleep: () => new Promise<void>(() => undefined) }); // a wait that never ends
    let state: { items: UploadItem[]; batches: UploadBatch[] } = { items: [], batches: [] };
    q.subscribe((st) => (state = st));
    q.add("site", "", [{ file: blob(4), relPath: "a" }, { file: blob(4), relPath: "b" }, { file: blob(4), relPath: "c" }]);
    await flush();
    expect(s.calls.some((c) => c.startsWith("start c"))).toBe(false); // a and b hold both file slots, waiting to retry
    q.cancel(state.items[0]!.id);
    await flush();
    expect(s.calls.some((c) => c.startsWith("start c"))).toBe(true); // a's slot was freed
  });

  it("a part that fails for good stops the item's other parts", async () => {
    const t = setup({ partSize: 1, failPart: (_p, n) => (n === 2 ? new ApiError(400, "part_size_mismatch", "part 2 is wrong") : undefined) });
    t.q.add("site", "", [{ file: blob(6), relPath: "a" }]);
    await flush();
    expect(t.pending).toHaveLength(0); // parts 1, 3 and 4 were aborted
    expect(t.state().items[0]).toMatchObject({ state: "failed", error: "part 2 is wrong" });
    expect(t.calls.filter((c) => c.startsWith("put"))).toEqual(["put a 1 1", "put a 2 1", "put a 3 1", "put a 4 1"]);
    expect(t.calls).toContain("cancel a");
  });

  it("does not retry what the server refused outright", async () => {
    const t = setup({ partSize: 4, failPart: () => new ApiError(400, "part_size_mismatch", "part 1 must be 4 bytes") });
    t.q.add("site", "", [{ file: blob(4), relPath: "a" }]);
    await t.settleAll();
    expect(t.sleeps).toEqual([]);
    expect(t.state().items[0]).toMatchObject({ state: "failed", error: "part 1 must be 4 bytes" });
  });

  it("a refused start fails the item without retrying", async () => {
    const t = setup({ failStart: () => new ApiError(403, "no_write_grant", "no write grant on this folder") });
    t.q.add("site", "", [{ file: blob(4), relPath: "a" }]);
    await t.settleAll();
    expect(t.state().items[0]).toMatchObject({ state: "failed", error: "no write grant on this folder" });
    expect(t.calls).toEqual(["start a 4 application/octet-stream"]);
  });

  it("retry restarts a failed item from a new upload, and the batch then sends its one change", async () => {
    let broken = true;
    const t = setup({ partSize: 4, failPart: (p) => (p === "bad" && broken ? new ApiError(0, "network_error", "offline") : undefined) });
    t.q.add("site", "", [{ file: blob(4), relPath: "ok" }, { file: blob(4), relPath: "bad" }]);
    await t.settleAll();
    const bad = t.state().items.find((i) => i.path === "bad")!;
    expect(bad.state).toBe("failed");
    broken = false;
    t.q.retry(bad.id);
    expect(t.state().items.find((i) => i.id === bad.id)).toMatchObject({ state: "uploading", sent: 0 }); // queued, and started at once (a slot is free)
    expect(t.state().items.find((i) => i.id === bad.id)!.error).toBeUndefined();
    await t.settleAll();
    await flush();
    expect(t.calls.filter((c) => c === "start bad 4 application/octet-stream")).toHaveLength(2);
    expect(t.state().items.every((i) => i.state === "done")).toBe(true);
    expect(t.changes).toHaveLength(1);
    expect(t.changes[0]!.ops).toEqual([
      { put: "ok", stagingId: "stg-up-1" },
      { put: "bad", stagingId: "stg-up-3" },
    ]);
  });

  it("removing the failed item sends the change with the rest", async () => {
    const t = setup({ partSize: 4, failPart: (p) => (p === "bad" ? new ApiError(0, "network_error", "offline") : undefined) });
    const batchId = t.q.add("site", "", [{ file: blob(4), relPath: "ok" }, { file: blob(4), relPath: "bad" }]);
    await t.settleAll();
    const bad = t.state().items.find((i) => i.path === "bad")!;
    t.q.remove(bad.id);
    await flush();
    expect(t.state().items.map((i) => i.path)).toEqual(["ok"]);
    expect(t.state().batches[0]!.itemIds).toHaveLength(1);
    expect(t.changes).toEqual([{ mount: "site", ops: [{ put: "ok", stagingId: "stg-up-1" }], title: "Uploaded 1 file to /" }]);
    expect(t.state().batches.find((b) => b.id === batchId)!.changeId).toBe("fc-1");
  });
});

describe("UploadQueue: sending the change (review 2)", () => {
  it("a change that fails to send for a retryable reason is tried again after 1 s, 4 s and 10 s", async () => {
    const t = setup({ partSize: 4, failChange: (n) => (n <= 2 ? new ApiError(503, "unavailable", "try later") : undefined) });
    const id = t.q.add("site", "", [{ file: blob(4), relPath: "a" }]);
    await t.settleAll();
    await flush();
    expect(t.sleeps).toEqual([1000, 4000]);
    expect(t.calls.filter((c) => c.startsWith("change"))).toHaveLength(3);
    expect(t.state().batches.find((b) => b.id === id)).toMatchObject({ changeId: "fc-1" });
    expect(t.state().batches[0]!.error).toBeUndefined();
    expect(t.q.busy).toBe(false);
  });

  it("still failing, the batch keeps its uploads and offers Send again, which sends the same ops", async () => {
    let down = true;
    const t = setup({ partSize: 4, failChange: () => (down ? new ApiError(0, "network_error", "offline") : undefined) });
    const id = t.q.add("site", "", [{ file: blob(4), relPath: "a" }]);
    await t.settleAll();
    await flush();
    expect(t.calls.filter((c) => c.startsWith("change"))).toHaveLength(4);
    const b = t.state().batches.find((x) => x.id === id)!;
    expect(b).toMatchObject({ sendError: "offline" });
    expect(b.error).toBeUndefined();
    expect(b.changeId).toBeUndefined();
    expect(t.state().items[0]).toMatchObject({ state: "done", stagingId: "stg-up-1" });
    expect(t.q.busy).toBe(true); // uploaded but not sent: leaving warns
    down = false;
    t.q.resend(id);
    await flush();
    expect(t.changes).toEqual([{ mount: "site", ops: [{ put: "a", stagingId: "stg-up-1" }], title: "Uploaded 1 file to /" }]);
    expect(t.state().batches[0]).toMatchObject({ changeId: "fc-1" });
    expect(t.state().batches[0]!.sendError).toBeUndefined();
    expect(t.q.busy).toBe(false);
  });

  it("a refusal (4xx) is final: no retry, the batch shows the error", async () => {
    const t = setup({ partSize: 4, failChange: () => new ApiError(400, "invalid_request", "title: 1 to 200 characters") });
    t.q.add("site", "", [{ file: blob(4), relPath: "a" }]);
    await t.settleAll();
    await flush();
    expect(t.sleeps).toEqual([]);
    expect(t.state().batches[0]).toMatchObject({ error: "title: 1 to 200 characters" });
    expect(t.state().batches[0]!.sendError).toBeUndefined();
    expect(t.q.busy).toBe(false);
    t.q.resend(t.state().batches[0]!.id); // nothing to send again
    await flush();
    expect(t.calls.filter((c) => c.startsWith("change"))).toHaveLength(1);
  });
});

describe("UploadQueue: idempotency keys (final review 3)", () => {
  it("one key per batch, the same on every retry and on Send again; another batch gets another", async () => {
    let down = true;
    const t = setup({ partSize: 4, failChange: () => (down ? new ApiError(503, "unavailable", "later") : undefined) });
    const first = t.q.add("site", "", [{ file: blob(4), relPath: "a" }]);
    await t.settleAll();
    await flush();
    expect(t.keys).toHaveLength(4);
    expect(new Set(t.keys).size).toBe(1);
    expect(t.keys[0]).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
    down = false;
    t.q.resend(first);
    await flush();
    expect(t.keys).toHaveLength(5);
    expect(t.keys[4]).toBe(t.keys[0]);
    t.q.add("site", "", [{ file: blob(4), relPath: "b" }]);
    await t.settleAll();
    await flush();
    expect(t.keys).toHaveLength(6);
    expect(t.keys[5]).not.toBe(t.keys[0]);
  });

  it("a send whose reply was lost (the change was made) is answered with that change on the retry (FakeApi)", async () => {
    const { FakeApi, FIXTURE_ORG, FIXTURE_PROJECT } = await import("../src/api/fake.js");
    const api = new FakeApi();
    let lose = true;
    const lossy: UploadQueueDeps["api"] = {
      startUpload: (...a) => api.startUpload(...a),
      putUploadPart: (...a) => api.putUploadPart(...a),
      completeUpload: (...a) => api.completeUpload(...a),
      cancelUpload: (...a) => api.cancelUpload(...a),
      async createFileChange(...a) {
        const c = await api.createFileChange(...a);
        if (lose) {
          lose = false;
          throw new ApiError(0, "network_error", "the reply was lost");
        }
        return c;
      },
    };
    const q = new UploadQueue({ api: lossy, org: FIXTURE_ORG, pid: FIXTURE_PROJECT, sleep: async () => {} });
    let state: { items: UploadItem[]; batches: UploadBatch[] } = { items: [], batches: [] };
    q.subscribe((st) => (state = st));
    q.add("website", "docs", [{ file: new Blob(["hello"]), relPath: "hello.md", mime: "text/markdown" }]);
    for (let i = 0; i < 20 && !state.batches[0]?.changeId; i++) await flush();
    const listed = await api.listFileChanges(FIXTURE_ORG, FIXTURE_PROJECT, { limit: 50 });
    expect(listed.filter((c) => c.title === "Uploaded 1 file to docs")).toHaveLength(1);
    expect(state.batches[0]!.changeId).toBe(listed.find((c) => c.title === "Uploaded 1 file to docs")!.changeId);
  });
});

describe("UploadQueue: cancel", () => {
  it("review 3: cancelAll with some files done and others running sends no change", async () => {
    const t = setup({ partSize: 4 });
    t.q.add("site", "", [{ file: blob(4), relPath: "done" }, { file: blob(8), relPath: "running" }]);
    await flush();
    t.pending.find((p) => p.n === 1 && p.bytes.size === 4 && t.calls.includes("put done 1 4"))!.resolve({ etag: "e" });
    await flush();
    expect(t.state().items.map((i) => i.state)).toEqual(["done", "uploading"]);
    t.q.cancelAll();
    await t.settleAll();
    await flush();
    expect(t.state().items.map((i) => i.state)).toEqual(["done", "canceled"]);
    expect(t.changes).toHaveLength(0);
    expect(t.calls.some((c) => c.startsWith("change"))).toBe(false);
  });

  it("review 3: cancelAll stops a change waiting for its next try; Send again (a user action) sends it", async () => {
    const waits: Array<() => void> = [];
    let down = true;
    const s = scripted({ partSize: 4, failChange: () => (down ? new ApiError(503, "unavailable", "later") : undefined) });
    const q = new UploadQueue({ api: s.api, org: "acme", pid: "p-1", sleep: () => new Promise<void>((ok) => waits.push(ok)) });
    let state: { items: UploadItem[]; batches: UploadBatch[] } = { items: [], batches: [] };
    q.subscribe((st) => (state = st));
    const id = q.add("site", "", [{ file: blob(4), relPath: "a" }]);
    await s.settleAll();
    await flush();
    expect(s.calls.filter((c) => c.startsWith("change"))).toHaveLength(1);
    expect(waits).toHaveLength(1); // waiting for the next try
    q.cancelAll();
    waits.shift()!();
    await flush();
    expect(s.calls.filter((c) => c.startsWith("change"))).toHaveLength(1);
    expect(state.batches.find((b) => b.id === id)).toMatchObject({ sendError: "later" });
    down = false;
    q.resend(id);
    await flush();
    expect(s.changes).toHaveLength(1);
    expect(state.batches.find((b) => b.id === id)).toMatchObject({ changeId: "fc-1" });
  });

  it("final review 2: after cancelAll (pagehide, then a bfcache restore), retrying a failed file sends the batch's change", async () => {
    let broken = true;
    const t = setup({ partSize: 4, failPart: (p) => (p === "bad" && broken ? new ApiError(0, "network_error", "offline") : undefined) });
    t.q.add("site", "", [{ file: blob(4), relPath: "ok" }, { file: blob(4), relPath: "bad" }]);
    await t.settleAll();
    const bad = t.state().items.find((i) => i.path === "bad")!;
    expect(bad.state).toBe("failed");
    t.q.cancelAll();
    broken = false;
    t.q.retry(bad.id);
    await t.settleAll();
    await flush();
    expect(t.state().items.every((i) => i.state === "done")).toBe(true);
    expect(t.changes).toHaveLength(1);
  });

  it("final review 2: reopen (pageshow from the bfcache) lets a batch go again: removing its failed file then sends the rest", async () => {
    const t = setup({ partSize: 4, failPart: (p) => (p === "bad" ? new ApiError(0, "network_error", "offline") : undefined) });
    t.q.add("site", "", [{ file: blob(4), relPath: "ok" }, { file: blob(4), relPath: "bad" }]);
    await t.settleAll();
    const bad = t.state().items.find((i) => i.path === "bad")!;
    t.q.cancelAll(); // pagehide
    await flush();
    expect(t.changes).toHaveLength(0);
    t.q.reopen(); // pageshow, persisted
    await flush();
    expect(t.changes).toHaveLength(0); // reopening sends nothing by itself
    t.q.remove(bad.id);
    await flush();
    expect(t.changes).toEqual([{ mount: "site", ops: [{ put: "ok", stagingId: "stg-up-1" }], title: "Uploaded 1 file to /" }]);
  });

  it("review 7: a superseded start's upload is canceled and never taken for the new run's", async () => {
    const t = setup({ partSize: 4 });
    const starts: Array<() => void> = [];
    const realStart = t.api.startUpload.bind(t.api);
    t.api.startUpload = (...args) => new Promise((ok) => starts.push(() => ok(realStart(...args))));
    t.q.add("site", "", [{ file: blob(4), relPath: "a" }]);
    await flush();
    const id = t.state().items[0]!.id;
    t.q.cancel(id);
    t.q.retry(id); // a new run starts while the first start is still out
    await flush();
    expect(starts).toHaveLength(2);
    starts[1]!(); // the new run's start answers first: up-1
    await flush();
    starts[0]!(); // then the old one: up-2, which nobody wants
    await flush();
    expect(t.calls).toContain("cancel a");
    expect(t.canceled).toEqual(["up-2"]);
    await t.settleAll();
    await flush();
    expect(t.state().items[0]).toMatchObject({ state: "done", stagingId: "stg-up-1" });
    expect(t.changes).toHaveLength(1);
  });

  it("aborts the item's parts in flight and cancels its upload; canceled is not failed", async () => {
    const t = setup({ partSize: 1 });
    t.q.add("site", "", [{ file: blob(5), relPath: "a" }]);
    await flush();
    const signals = t.pending.map((p) => p.signal);
    expect(signals).toHaveLength(4);
    const id = t.state().items[0]!.id;
    t.q.cancel(id);
    await flush();
    expect(signals.every((s) => s.aborted)).toBe(true);
    expect(t.pending).toHaveLength(0);
    expect(t.calls).toContain("cancel a");
    expect(t.state().items[0]).toMatchObject({ state: "canceled" });
    expect(t.state().items[0]!.error).toBeUndefined();
    expect(t.sleeps).toEqual([]);
    await t.settleAll();
    expect(t.calls.filter((c) => c.startsWith("put a")).length).toBe(4); // no part after the cancel
    expect(t.changes).toHaveLength(0);
    expect(t.q.busy).toBe(false);
  });

  it("canceling while the upload is starting cancels it once the server answers", async () => {
    const t = setup({ partSize: 4 });
    const real = t.api.startUpload.bind(t.api);
    let release!: () => void;
    const gate = new Promise<void>((ok) => (release = ok));
    t.api.startUpload = async (...a) => {
      await gate;
      return real(...a);
    };
    t.q.add("site", "", [{ file: blob(4), relPath: "a" }]);
    await flush();
    t.q.cancel(t.state().items[0]!.id);
    release();
    await t.settleAll();
    await flush();
    expect(t.calls).toEqual(["start a 4 application/octet-stream", "cancel a"]);
    expect(t.state().items[0]!.state).toBe("canceled");
  });

  it("canceling a queued item never starts it", async () => {
    const t = setup({ partSize: 4 });
    t.q.add("site", "", [{ file: blob(4), relPath: "a" }, { file: blob(4), relPath: "b" }, { file: blob(4), relPath: "c" }]);
    const c = t.state().items.find((i) => i.path === "c")!;
    expect(c.state).toBe("queued");
    t.q.cancel(c.id);
    await t.settleAll();
    await flush();
    expect(t.calls.some((x) => x.startsWith("start c"))).toBe(false);
    expect(t.calls.some((x) => x === "cancel c")).toBe(false);
    expect(t.changes).toHaveLength(1);
    expect(t.changes[0]).toMatchObject({ title: "Uploaded 2 files to /", ops: [{ put: "a" }, { put: "b" }] });
  });

  it("canceling the last unfinished file sends the change with the rest", async () => {
    const t = setup({ partSize: 4 });
    t.q.add("site", "", [{ file: blob(4), relPath: "a" }, { file: blob(8), relPath: "b" }]);
    await flush();
    // settle a's part only
    const pa = t.pending.find((p) => p.uploadId === "up-1")!;
    t.pending.splice(t.pending.indexOf(pa), 1);
    pa.resolve({ etag: "ea" });
    await flush();
    expect(t.changes).toHaveLength(0);
    t.q.cancel(t.state().items.find((i) => i.path === "b")!.id);
    await flush();
    expect(t.changes).toEqual([{ mount: "site", ops: [{ put: "a", stagingId: "stg-up-1" }], title: "Uploaded 1 file to /" }]);
  });

  it("canceling a failed item lets the batch go", async () => {
    const t = setup({ partSize: 4, failPart: (p) => (p === "bad" ? new ApiError(400, "nope", "nope") : undefined) });
    t.q.add("site", "", [{ file: blob(4), relPath: "ok" }, { file: blob(4), relPath: "bad" }]);
    await t.settleAll();
    t.q.cancel(t.state().items.find((i) => i.path === "bad")!.id);
    await flush();
    expect(t.changes).toHaveLength(1);
  });

  it("a batch whose files were all canceled sends nothing", async () => {
    const t = setup({ partSize: 4 });
    t.q.add("site", "", [{ file: blob(4), relPath: "a" }, { file: blob(4), relPath: "b" }]);
    await flush();
    for (const i of t.state().items) t.q.cancel(i.id);
    await t.settleAll();
    await flush();
    expect(t.changes).toHaveLength(0);
    expect(t.state().items.map((i) => i.state)).toEqual(["canceled", "canceled"]);
    expect(t.q.busy).toBe(false);
  });

  it("cancelAll stops everything", async () => {
    const t = setup({ partSize: 1 });
    t.q.add("site", "", [{ file: blob(3), relPath: "a" }, { file: blob(3), relPath: "b" }, { file: blob(3), relPath: "c" }]);
    await flush();
    expect(t.q.busy).toBe(true);
    t.q.cancelAll();
    await t.settleAll();
    await flush();
    expect(t.state().items.map((i) => i.state)).toEqual(["canceled", "canceled", "canceled"]);
    expect(t.canceled.sort()).toEqual(["up-1", "up-2"]);
    expect(t.changes).toHaveLength(0);
    expect(t.q.busy).toBe(false);
  });
});

describe("UploadQueue: batches", () => {
  it("sends exactly one change, after the last item completes", async () => {
    const t = setup({ partSize: 4 });
    t.q.add("site", "videos/2026", [{ file: blob(4), relPath: "a.mp4" }, { file: blob(4), relPath: "raw/b.mp4" }, { file: blob(4), relPath: "c.mp4" }]);
    await flush();
    t.pending.shift()!.resolve({ etag: "1" });
    await flush();
    t.pending.shift()!.resolve({ etag: "2" });
    await flush();
    expect(t.changes).toHaveLength(0);
    await t.settleAll();
    await flush();
    expect(t.changes).toHaveLength(1);
    expect(t.changes[0]).toEqual({
      mount: "site",
      title: "Uploaded 3 files to videos/2026",
      ops: [
        { put: "videos/2026/a.mp4", stagingId: "stg-up-1" },
        { put: "videos/2026/raw/b.mp4", stagingId: "stg-up-2" },
        { put: "videos/2026/c.mp4", stagingId: "stg-up-3" },
      ],
    });
    expect(t.calls.filter((c) => c.startsWith("change"))).toHaveLength(1);
  });

  it("an explicit title replaces the generated one", async () => {
    const t = setup();
    t.q.add("site", "", [{ file: blob(2), relPath: "a" }], { title: "New photos" });
    await t.settleAll();
    await flush();
    expect(t.changes[0]!.title).toBe("New photos");
  });

  it("a replace batch has one item at the replaced path and the title Replaced <path>", async () => {
    const t = setup();
    const id = t.q.add("site", "docs", [{ file: blob(2), relPath: "whatever.pdf" }], { replace: "docs/guide.pdf" });
    expect(t.state().batches.find((b) => b.id === id)!.title).toBe("Replaced docs/guide.pdf");
    await t.settleAll();
    await flush();
    expect(t.changes).toEqual([{ mount: "site", title: "Replaced docs/guide.pdf", ops: [{ put: "docs/guide.pdf", stagingId: "stg-up-1" }] }]);
  });

  it("a replace batch takes exactly one file", () => {
    const t = setup();
    const id = t.q.add("site", "", [{ file: blob(2), relPath: "a" }, { file: blob(2), relPath: "b" }], { replace: "a" });
    expect(t.state().batches.find((b) => b.id === id)).toMatchObject({ itemIds: [], error: expect.any(String) });
  });

  it("a refused batch is created with its error and starts nothing", async () => {
    const t = setup();
    const big = { size: 5_000_000_001, slice: () => new Blob([]), type: "" } as unknown as Blob;
    const id = t.q.add("site", "", [{ file: big, relPath: "huge.mov" }, { file: blob(1), relPath: "a" }]);
    const b = t.state().batches.find((x) => x.id === id)!;
    expect(b.itemIds).toEqual([]);
    expect(b.error).toMatch(/5,000,000,000|5 GB/);
    expect(t.state().items).toEqual([]);
    await flush();
    expect(t.calls).toEqual([]);
  });

  it("a batch with a bad path is refused", () => {
    const t = setup();
    const id = t.q.add("site", "", [{ file: blob(1), relPath: ".git/config" }]);
    expect(t.state().batches.find((x) => x.id === id)!.error).toMatch(/\.git\/config/);
    expect(t.state().items).toEqual([]);
  });

  it("an empty batch is refused", () => {
    const t = setup();
    const id = t.q.add("site", "", []);
    expect(t.state().batches.find((x) => x.id === id)!.error).toBeTruthy();
  });

  it("a refused change is kept on the batch", async () => {
    const t = setup();
    t.api.createFileChange = async () => {
      throw new ApiError(413, "change_too_large", "changes are limited to 20 GB");
    };
    t.q.add("site", "", [{ file: blob(2), relPath: "a" }]);
    await t.settleAll();
    await flush();
    expect(t.state().batches[0]).toMatchObject({ error: "changes are limited to 20 GB" });
    expect(t.state().batches[0]!.changeId).toBeUndefined();
    expect(t.q.busy).toBe(false);
  });

  it("ids are deterministic and subscribers get copies; unsubscribe stops updates", async () => {
    const t = setup();
    const seen: number[] = [];
    const off = t.q.subscribe((s) => seen.push(s.items.length));
    expect(seen).toEqual([0]); // the current state at once
    const b1 = t.q.add("site", "", [{ file: blob(1), relPath: "a" }]);
    off();
    const n = seen.length;
    t.q.add("site", "", [{ file: blob(1), relPath: "b" }]);
    expect(seen.length).toBe(n);
    expect(b1).toBe("batch-1");
    const snap = t.state();
    expect(snap.items.map((i) => i.id)).toEqual(["item-1", "item-2"]);
    snap.items[0]!.state = "failed";
    snap.batches[0]!.itemIds.push("x");
    let fresh: { items: UploadItem[]; batches: UploadBatch[] } | undefined;
    t.q.subscribe((s) => (fresh = s))();
    expect(fresh!.items[0]!.state).not.toBe("failed");
    expect(fresh!.batches[0]!.itemIds).toEqual(["item-1"]);
    await t.settleAll();
  });
});

describe("UploadQueue: empty files", () => {
  it("an empty file starts an upload of no parts, sends none, and completes with parts: []", async () => {
    const t = setup({ partSize: 4 });
    t.q.add("site", "", [{ file: new Blob([]), relPath: ".gitkeep", mime: "application/octet-stream" }]);
    await t.settleAll();
    await flush();
    expect(t.calls).toEqual(["start .gitkeep 0 application/octet-stream", "complete .gitkeep ", "change site Uploaded 1 file to /"]);
    expect(t.state().items[0]).toMatchObject({ state: "done", sent: 0, size: 0, stagingId: "stg-up-1" });
    expect(t.changes[0]!.ops).toEqual([{ put: ".gitkeep", stagingId: "stg-up-1" }]);
  });

  it("a dropped folder holding an empty .gitkeep lands as one change (FakeApi)", async () => {
    const { FakeApi, FIXTURE_ORG, FIXTURE_PROJECT } = await import("../src/api/fake.js");
    const { filesFromDrop } = await import("../src/lib/file-ops.js");
    const api = new FakeApi();
    const file = (name: string, body: string) => ({ isFile: true, isDirectory: false, name, file: (ok: (f: File) => void) => ok(new File([body], name, { type: "text/plain" })) });
    const dir = {
      isFile: false,
      isDirectory: true,
      name: "assets",
      createReader: () => {
        let done = false;
        return { readEntries: (ok: (es: unknown[]) => void) => ok(done ? [] : ((done = true), [file(".gitkeep", ""), file("notes.txt", "hello")])) };
      },
    };
    const items = Object.assign([{ kind: "file", webkitGetAsEntry: () => dir, getAsFile: () => null }], {}) as unknown as DataTransferItemList;
    const picked = await filesFromDrop(items);
    expect(picked.map((p) => [p.relPath, p.file.size])).toEqual([
      ["assets/.gitkeep", 0],
      ["assets/notes.txt", 5],
    ]);
    const q = new UploadQueue({ api, org: FIXTURE_ORG, pid: FIXTURE_PROJECT, sleep: async () => undefined });
    let state: { items: UploadItem[]; batches: UploadBatch[] } = { items: [], batches: [] };
    q.subscribe((s) => (state = s));
    q.add("website", "", picked);
    for (let i = 0; i < 20 && q.busy; i++) await flush();
    expect(q.busy).toBe(false);
    expect(state.items.map((i) => i.state)).toEqual(["done", "done"]);
    expect(state.batches).toHaveLength(1);
    const changeId = state.batches[0]!.changeId!;
    expect(changeId).toBeTruthy();
    expect(api.calls.filter((c) => c.method === "createFileChange")).toHaveLength(1);
    let change = await api.getFileChange(FIXTURE_ORG, changeId);
    for (let i = 0; i < 10 && change.state !== "added"; i++) change = await api.getFileChange(FIXTURE_ORG, changeId);
    expect(change.state).toBe("added");
    const tree = await api.listTree(FIXTURE_ORG, FIXTURE_PROJECT, { mount: "website", path: "assets" });
    expect(tree.entries).toEqual([
      { path: "assets/.gitkeep", type: "file", size: 0 },
      { path: "assets/notes.txt", type: "file", size: 5 },
    ]);
  });
});

describe("UploadQueue: long paths (review 1)", () => {
  it("a generated title stays within 200 characters, so the FakeApi (like the Worker) takes the change", async () => {
    const { FakeApi, FIXTURE_ORG, FIXTURE_PROJECT } = await import("../src/api/fake.js");
    const api = new FakeApi();
    const q = new UploadQueue({ api, org: FIXTURE_ORG, pid: FIXTURE_PROJECT, sleep: async () => undefined });
    let state: { items: UploadItem[]; batches: UploadBatch[] } = { items: [], batches: [] };
    q.subscribe((s) => (state = s));
    const deep = "very-long-folder-name/".repeat(12); // 264 characters
    q.add("website", deep, [{ file: blob(3), relPath: "a.txt", mime: "text/plain" }]);
    q.add("website", "", [{ file: blob(3), relPath: "x.txt", mime: "text/plain" }], { replace: `${deep}a.txt` });
    for (let i = 0; i < 40 && q.busy; i++) await flush();
    expect(state.batches.map((b) => b.error)).toEqual([undefined, undefined]);
    expect(state.batches.every((b) => !!b.changeId && b.title.length <= 200)).toBe(true);
  });
});

describe("UploadQueue: tracked changes and dismissing (review 4: the tray outlives the Files tab)", () => {
  const fc = (changeId: string, state: FileChange["state"] = "applying"): FileChange => ({ changeId, projectId: "p-1", mountName: "site", title: `T ${changeId}`, state, attempt: 1, proposalId: null, createdAt: "", updatedAt: "" });

  it("track adds a change made elsewhere (move, delete, an edit) as a batch with no items, once per change", () => {
    const t = setup();
    t.q.track(fc("fc-9"));
    t.q.track(fc("fc-9", "added"));
    expect(t.state().batches).toEqual([{ id: "act-fc-9", mount: "site", dir: "", title: "T fc-9", itemIds: [], changeId: "fc-9", change: fc("fc-9", "added") }]);
    expect(t.q.busy).toBe(false);
  });

  it("dismiss drops a finished batch and its items; a running one stays", async () => {
    const t = setup({ partSize: 4 });
    const running = t.q.add("site", "", [{ file: blob(4), relPath: "a" }]);
    await flush();
    t.q.dismiss(running);
    expect(t.state().batches.map((b) => b.id)).toEqual([running]);
    await t.settleAll();
    await flush();
    t.q.dismiss(running);
    t.q.track(fc("fc-2"));
    t.q.dismiss("act-fc-2");
    expect(t.state()).toEqual({ items: [], batches: [] });
  });

  it("a later subscriber (the Files tab mounted again) gets the current tray at once", async () => {
    const t = setup({ partSize: 4 });
    t.q.add("site", "", [{ file: blob(4), relPath: "a" }]);
    await flush();
    let seen: { items: UploadItem[] } | null = null;
    const off = t.q.subscribe((s) => (seen = s));
    expect(seen!.items.map((i) => i.state)).toEqual(["uploading"]);
    off();
  });
});
