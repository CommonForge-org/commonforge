/**
 * The Files tab's upload queue (spec §8, plan phase 3 Task 8). Files go up in the server's parts
 * (`partSize` from the start answer), at most 2 files and 4 parts at once across the whole tray.
 * A failed part retries after 1 s, 4 s and 10 s; then the file is failed and offers Retry. Files
 * added together form a batch, which becomes exactly one change once every file in it is done
 * (or canceled). Sending that change retries the same way; still failing, the batch keeps its
 * uploads and offers "Send again" (`resend`); every try carries the batch's one idempotency key, so
 * a try whose reply was lost makes no second change. A refusal (4xx) is final. `cancelAll` (leaving the
 * project or the page) never sends a change. No React and no timers of its own: `sleep` is
 * injectable, ids come from counters.
 */
import { ApiError, type CommonForgeApi } from "../api/client.js";
import type { FileChange, FileChangeOp, UploadStart } from "../api/types.js";
import { checkBatch, checkFilePath, joinPath, replaceTitle, titleOf, uploadTitle } from "./file-ops.js";
import { newFileChangeKey } from "./model.js";

export type UploadItemState = "queued" | "uploading" | "hashing" | "done" | "failed" | "canceled";

export interface UploadItem {
  id: string;
  batchId: string;
  path: string;
  size: number;
  sent: number;
  state: UploadItemState;
  error?: string;
  stagingId?: string;
}

export interface UploadBatch {
  id: string;
  mount: string;
  dir: string;
  title: string;
  itemIds: string[];
  changeId?: string;
  change?: FileChange;
  /** final: the batch was refused, or its change was */
  error?: string;
  /** the change could not be sent (the connection, or the server's trouble): `resend` tries again with the same uploads */
  sendError?: string;
}

export interface UploadQueueDeps {
  api: Pick<CommonForgeApi, "startUpload" | "putUploadPart" | "completeUpload" | "cancelUpload" | "createFileChange">;
  org: string;
  pid: string;
  sleep?: (ms: number) => Promise<void>;
  /** a new idempotency key (one per batch: every send of its change carries it) */
  newKey?: () => string;
}

export interface UploadQueueState {
  items: UploadItem[];
  batches: UploadBatch[];
}

const MAX_FILES = 2;
const MAX_PARTS = 4;
/** the waits before the 1st, 2nd and 3rd retry of a part */
const BACKOFF_MS = [1000, 4000, 10_000] as const;

/** `sleep(ms)`, ended early (rejecting with an AbortError) when `signal` aborts. */
function sleepUnless(sleep: (ms: number) => Promise<void>, ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((ok, fail) => {
    const onAbort = () => fail(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    sleep(ms).then(
      () => {
        signal.removeEventListener("abort", onAbort);
        ok();
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        fail(e);
      },
    );
  });
}

const isAbort = (e: unknown) => (e as { name?: unknown } | null)?.name === "AbortError";
const abortError = () => new DOMException("the upload was canceled", "AbortError");
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Worth another try: the connection, the server's own trouble, or "slow down". A refusal is final. */
function retryable(e: unknown): boolean {
  if (!(e instanceof ApiError)) return true;
  return e.status === 0 || e.status === 408 || e.status === 429 || e.status >= 500;
}

/** A FIFO counting semaphore: the tray-wide cap on parts in flight. */
class Slots {
  private waiting: Array<() => void> = [];
  constructor(private free: number) {}
  acquire(): Promise<void> {
    if (this.free > 0) {
      this.free--;
      return Promise.resolve();
    }
    return new Promise((ok) => this.waiting.push(ok));
  }
  release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.free++;
  }
}

interface Entry {
  item: UploadItem;
  file: Blob;
  mime: string;
  mount: string;
  /** bumps on every (re)start, so a superseded run's late answers are ignored */
  run: number;
  ctl?: AbortController;
  uploadId?: string;
  partSent: Map<number, number>;
}

interface BatchEntry {
  batch: UploadBatch;
  /** the change's idempotency key: the same on every try and on Send again, so a lost reply makes no second change */
  key: string;
  explicitTitle?: string;
  replace?: string;
  sending: boolean;
  sent: boolean;
}

const TERMINAL: ReadonlySet<UploadItemState> = new Set(["done", "failed", "canceled"]);

export class UploadQueue {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly entries: Entry[] = [];
  private readonly batches: BatchEntry[] = [];
  private readonly listeners = new Set<(s: UploadQueueState) => void>();
  private readonly slots = new Slots(MAX_PARTS);
  private activeFiles = 0;
  /** set by `cancelAll`: no change is sent until the user acts again (add, retry, Send again) or `reopen` */
  private closing = false;
  private batchSeq = 0;
  private itemSeq = 0;

  constructor(private readonly deps: UploadQueueDeps) {
    this.sleep = deps.sleep ?? ((ms) => new Promise((ok) => setTimeout(ok, ms)));
  }

  /**
   * Queues `files` under `dir` of `mount` as one batch (one change). With `replace`, the batch is
   * one file uploaded over that path. A batch the limits or path rules refuse is kept with its
   * `error` and starts nothing.
   */
  add(mount: string, dir: string, files: Array<{ file: Blob; relPath: string; mime?: string }>, opts: { title?: string; replace?: string } = {}): string {
    this.closing = false;
    const id = `batch-${++this.batchSeq}`;
    const folder = joinPath(dir, "");
    const paths = files.map((f) => opts.replace ?? joinPath(folder, f.relPath));
    const explicitTitle = opts.title?.trim() ? titleOf(opts.title) : undefined;
    const batch: UploadBatch = { id, mount, dir: folder, title: explicitTitle ?? (opts.replace ? replaceTitle(opts.replace) : uploadTitle(files.length, folder)), itemIds: [] };
    const be: BatchEntry = { batch, key: (this.deps.newKey ?? newFileChangeKey)(), explicitTitle, replace: opts.replace, sending: false, sent: false };
    this.batches.push(be);
    const refusal = this.refusal(files, paths, opts.replace);
    if (refusal) {
      batch.error = refusal;
      this.emit();
      return id;
    }
    files.forEach((f, i) => {
      const item: UploadItem = { id: `item-${++this.itemSeq}`, batchId: id, path: paths[i]!, size: f.file.size, sent: 0, state: "queued" };
      batch.itemIds.push(item.id);
      this.entries.push({ item, file: f.file, mime: f.mime || f.file.type || "application/octet-stream", mount, run: 0, partSent: new Map() });
    });
    this.emit();
    this.pump();
    return id;
  }

  /** Stops an item: a queued one never starts; a running one has its parts aborted and its upload canceled. */
  cancel(itemId: string): void {
    const e = this.entry(itemId);
    if (!e || e.item.state === "done" || e.item.state === "canceled") return;
    const running = e.item.state === "uploading" || e.item.state === "hashing";
    this.setState(e, "canceled");
    if (running) {
      e.ctl?.abort();
      this.dropUpload(e);
    }
    this.emit();
    this.settle(e.item.batchId);
  }

  /** Starts a failed (or canceled) item again, from a new upload. */
  retry(itemId: string): void {
    const e = this.entry(itemId);
    if (!e || (e.item.state !== "failed" && e.item.state !== "canceled")) return;
    const b = this.batchEntry(e.item.batchId);
    // its batch's change has gone without it (or may have: a send whose reply was lost; Send again
    // repeats the same operations under the same key)
    if (b?.sending || b?.sent || b?.batch.sendError !== undefined) return;
    this.closing = false; // a user action: the queue is open again
    this.setState(e, "queued");
    e.item.sent = 0;
    e.partSent.clear();
    this.emit();
    this.pump();
  }

  /** Drops a failed (or canceled) item from its batch; the rest of the batch may then go. */
  remove(itemId: string): void {
    const e = this.entry(itemId);
    if (!e || (e.item.state !== "failed" && e.item.state !== "canceled")) return;
    this.entries.splice(this.entries.indexOf(e), 1);
    const b = this.batchEntry(e.item.batchId);
    if (b) b.batch.itemIds = b.batch.itemIds.filter((x) => x !== itemId);
    this.emit();
    this.settle(e.item.batchId);
  }

  /**
   * Cancels everything unfinished (leaving the project or the page). It never sends a change: a
   * batch whose last running file it cancels is not sent with the files that were done.
   */
  cancelAll(): void {
    this.closing = true;
    for (const e of [...this.entries]) if (!TERMINAL.has(e.item.state)) this.cancel(e.item.id);
  }

  /** Undoes `cancelAll`'s hold on sending (the page came back from the back/forward cache); it sends nothing by itself. */
  reopen(): void {
    this.closing = false;
  }

  /** Sends a batch's change again, with the same uploads, after it could not be sent (`sendError`). */
  resend(batchId: string): void {
    const b = this.batchEntry(batchId);
    if (!b || b.batch.sendError === undefined) return;
    this.closing = false; // a user action: the queue is open again
    delete b.batch.sendError;
    this.emit();
    this.settle(batchId);
  }

  /**
   * Shows a change made outside the queue (a move, a delete, a saved edit) in the tray, as a
   * batch with no items; tracking the same change again updates it.
   */
  track(change: FileChange): void {
    const id = `act-${change.changeId}`;
    const batch: UploadBatch = { id, mount: change.mountName, dir: "", title: change.title, itemIds: [], changeId: change.changeId, change: structuredClone(change) };
    const known = this.batchEntry(id);
    if (known) known.batch = batch;
    else this.batches.push({ batch, key: "", sending: false, sent: true });
    this.emit();
  }

  /** Drops a batch, and its items, from the tray: never one still uploading or being sent. */
  dismiss(batchId: string): void {
    const b = this.batchEntry(batchId);
    if (!b || b.sending) return;
    const mine = this.entries.filter((e) => e.item.batchId === batchId);
    if (mine.some((e) => !TERMINAL.has(e.item.state))) return;
    for (const e of mine) this.entries.splice(this.entries.indexOf(e), 1);
    this.batches.splice(this.batches.indexOf(b), 1);
    this.emit();
  }

  /**
   * Something is queued, uploading, finishing or being sent as a change, or is uploaded and not
   * sent yet (a batch held by a failed file, or one waiting for Send again): leaving loses it.
   */
  get busy(): boolean {
    if (this.entries.some((e) => !TERMINAL.has(e.item.state))) return true;
    return this.batches.some((b) => b.sending || (!b.sent && !b.batch.error && b.batch.itemIds.some((id) => this.entry(id)?.item.state === "done")));
  }

  /** Calls `fn` with the current state at once and after every change; returns the unsubscribe. */
  subscribe(fn: (s: UploadQueueState) => void): () => void {
    this.listeners.add(fn);
    fn(this.snapshot());
    return () => void this.listeners.delete(fn);
  }

  // ------------------------------------------------------------------------------------ inside

  private refusal(files: Array<{ file: Blob }>, paths: string[], replace: string | undefined): string | null {
    if (files.length === 0) return "Nothing to upload";
    if (replace !== undefined && files.length !== 1) return "A replacement is exactly one file";
    const limits = checkBatch(files.map((f) => ({ size: f.file.size })));
    if (!limits.ok) return limits.message;
    const seen = new Set<string>();
    for (const p of paths) {
      const r = checkFilePath(p);
      if (!r.ok) return `${p || "(empty path)"} ${r.reason}`;
      if (seen.has(p)) return `Two files would both be ${p}`;
      seen.add(p);
    }
    return null;
  }

  private entry(itemId: string) {
    return this.entries.find((e) => e.item.id === itemId);
  }

  private batchEntry(batchId: string) {
    return this.batches.find((b) => b.batch.id === batchId);
  }

  private setState(e: Entry, state: UploadItemState, error?: string) {
    e.item.state = state;
    if (error === undefined) delete e.item.error;
    else e.item.error = error;
  }

  /** Best effort: the server forgets an unfinished upload (it would expire anyway). */
  private dropUpload(e: Entry) {
    const uploadId = e.uploadId;
    delete e.uploadId;
    if (uploadId) this.forget(uploadId);
  }

  private forget(uploadId: string) {
    void Promise.resolve()
      .then(() => this.deps.api.cancelUpload(this.deps.org, uploadId))
      .catch(() => undefined);
  }

  private pump() {
    while (this.activeFiles < MAX_FILES) {
      const next = this.entries.find((e) => e.item.state === "queued");
      if (!next) return;
      this.activeFiles++;
      void this.runItem(next).finally(() => {
        this.activeFiles--;
        this.pump();
      });
    }
  }

  private async runItem(e: Entry): Promise<void> {
    const run = ++e.run;
    const ctl = new AbortController();
    e.ctl = ctl;
    e.partSent.clear();
    e.item.sent = 0;
    delete e.item.stagingId;
    this.setState(e, "uploading");
    this.emit();
    const live = () => e.run === run && !ctl.signal.aborted;
    const { api, org, pid } = this.deps;
    try {
      const start = await api.startUpload(org, pid, e.mount, { path: e.item.path, size: e.item.size, mime: e.mime });
      if (e.run !== run) {
        // superseded (canceled, then retried) while starting: this upload is nobody's
        this.forget(start.uploadId);
        return;
      }
      e.uploadId = start.uploadId;
      if (!live()) {
        // canceled while starting: `cancel` could not know the upload yet
        this.dropUpload(e);
        return;
      }
      // an empty file is an upload of no parts (`parts: 0`): nothing is sent, and it completes with `[]`
      const etags: string[] = [];
      let next = 1;
      const worker = async () => {
        while (next <= start.parts) {
          const n = next++;
          etags[n - 1] = await this.putPart(e, ctl.signal, start, n);
        }
      };
      try {
        await Promise.all(Array.from({ length: Math.min(MAX_PARTS, start.parts) }, worker));
      } catch (err) {
        ctl.abort(); // the item's other parts stop too
        throw err;
      }
      if (!live()) return;
      this.setState(e, "hashing");
      this.emit();
      const done = await api.completeUpload(
        org,
        start.uploadId,
        etags.map((etag, i) => ({ n: i + 1, etag })),
      );
      if (!live()) return;
      delete e.uploadId;
      e.item.stagingId = done.stagingId;
      e.item.sent = e.item.size;
      this.setState(e, "done");
      this.emit();
      this.settle(e.item.batchId);
    } catch (err) {
      if (e.run !== run || e.item.state === "canceled") return;
      this.dropUpload(e);
      this.setState(e, "failed", message(err));
      this.emit();
      this.settle(e.item.batchId);
    }
  }

  /** One part, with its retries; resolves to the part's etag. */
  private async putPart(e: Entry, signal: AbortSignal, start: UploadStart, n: number): Promise<string> {
    const from = (n - 1) * start.partSize;
    const bytes = e.file.slice(from, Math.min(from + start.partSize, e.item.size));
    for (let attempt = 0; ; attempt++) {
      await this.slots.acquire();
      if (signal.aborted) {
        this.slots.release();
        throw abortError();
      }
      try {
        const { etag } = await this.deps.api.putUploadPart(this.deps.org, start.uploadId, n, bytes, {
          signal,
          onProgress: (sent) => this.progress(e, n, sent),
        });
        this.slots.release();
        this.progress(e, n, bytes.size);
        return etag;
      } catch (err) {
        this.slots.release();
        this.progress(e, n, 0);
        const wait = BACKOFF_MS[attempt];
        if (isAbort(err) || signal.aborted || !retryable(err) || wait === undefined) throw err;
        await sleepUnless(this.sleep, wait, signal);
      }
    }
  }

  private progress(e: Entry, n: number, sent: number) {
    if (TERMINAL.has(e.item.state)) return;
    e.partSent.set(n, sent);
    let total = 0;
    for (const v of e.partSent.values()) total += v;
    e.item.sent = Math.min(total, e.item.size);
    this.emit();
  }

  /** A batch whose items are all done or canceled, with at least one done, becomes its one change. */
  private settle(batchId: string) {
    const b = this.batchEntry(batchId);
    if (!b || this.closing || b.sending || b.sent || b.batch.error || b.batch.sendError !== undefined) return;
    const items = b.batch.itemIds.map((id) => this.entry(id)?.item).filter((i): i is UploadItem => !!i);
    if (items.length === 0 || items.some((i) => i.state !== "done" && i.state !== "canceled")) return;
    const done = items.filter((i) => i.state === "done");
    if (done.length === 0) return;
    const ops: FileChangeOp[] = done.map((i) => ({ put: i.path, stagingId: i.stagingId! }));
    b.batch.title = b.explicitTitle ?? (b.replace ? replaceTitle(b.replace) : uploadTitle(done.length, b.batch.dir));
    b.sending = true;
    this.emit();
    void this.send(b, ops).finally(() => {
      b.sending = false;
      this.emit();
    });
  }

  /** The batch's change, retried like a part; still failing, `sendError` (Send again); refused, `error`. */
  private async send(b: BatchEntry, ops: FileChangeOp[]): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        const change = await this.deps.api.createFileChange(this.deps.org, this.deps.pid, b.batch.mount, { ops, title: b.batch.title, idempotencyKey: b.key });
        b.batch.changeId = change.changeId;
        b.batch.change = change;
        b.sent = true;
        return;
      } catch (err) {
        const wait = BACKOFF_MS[attempt];
        if (!retryable(err)) {
          b.batch.error = message(err);
          b.sent = true;
          return;
        }
        if (wait === undefined || this.closing) {
          b.batch.sendError = message(err);
          return;
        }
        await this.sleep(wait);
        if (this.closing) {
          b.batch.sendError = message(err);
          return;
        }
      }
    }
  }

  private snapshot(): UploadQueueState {
    return {
      items: this.entries.map((e) => ({ ...e.item })),
      batches: this.batches.map((b) => ({ ...b.batch, itemIds: [...b.batch.itemIds], ...(b.batch.change ? { change: structuredClone(b.batch.change) } : {}) })),
    };
  }

  private emit() {
    if (this.listeners.size === 0) return;
    const s = this.snapshot();
    for (const fn of this.listeners) fn(s);
  }
}
