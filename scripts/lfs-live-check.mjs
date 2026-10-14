#!/usr/bin/env node
/**
 * Live check of "folders with uploads" against a deployed Worker (Node 22, no dependencies).
 *
 *   COMMONFORGE_URL=https://… COMMONFORGE_TOKEN=cfs_… ORG=… PROJECT=… MOUNT=… SIZE_MB=2048 \
 *     node scripts/lfs-live-check.mjs
 *
 * Variables:
 *   COMMONFORGE_URL    the deployed Worker's URL (default: the apiUrl of the cforge CLI session)
 *   COMMONFORGE_TOKEN  a `cfs_` session token of an owner (default: the cforge CLI's stored session);
 *                      never printed
 *   ORG, PROJECT       organization id and project id
 *   MOUNT              a git folder (mount name) in that project
 *   SIZE_MB            upload size in MiB (default 2048); generated and hashed part by part, so the
 *                      file is never held in memory
 *
 * Steps: upload random bytes through the uploads API (hashing locally) → wait for the platform's
 * hash step → change putting the file at live-check/<timestamp>.bin → change editing
 * live-check/notes.txt → LFS download batch, stream the object, hash it → one JSON summary on
 * stdout (progress goes to stderr) → a last change deleting live-check/. Exits non-zero on any
 * failure. It talks to a live service and creates (then deletes) files in the folder: run it
 * against a scratch project.
 *
 * Timings: states are polled every 1 s growing to every 5 s, so the hash-step and change times are
 * accurate to about 5 s. Up to 3 consecutive transient poll errors (network, 429, 5xx) are
 * tolerated. A failed upload is aborted (best effort). The token is only ever sent to
 * COMMONFORGE_URL's origin (a download href elsewhere fails the check). A change that waits for an
 * approval or fails is reported with its proposalId.
 */
import { createHash, randomFillSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const env = process.env;
const log = (m) => process.stderr.write(`${new Date().toISOString()} ${m}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ms = (t0) => Math.round(performance.now() - t0);

// ---- configuration ----------------------------------------------------------------------------

/** The cforge CLI's config directory (apps/cli/src/config.ts `configDir`). */
function cliConfigDir() {
  if (env.CFORGE_CONFIG_DIR) return env.CFORGE_CONFIG_DIR;
  const home = env.HOME || homedir();
  switch (platform()) {
    case "darwin":
      return join(home, "Library", "Application Support", "commonforge");
    case "win32":
      return join(env.APPDATA || join(home, "AppData", "Roaming"), "commonforge");
    default:
      return join(env.XDG_CONFIG_HOME || join(home, ".config"), "commonforge");
  }
}

/** The CLI's stored session (`session.json`: { apiUrl, sessionToken, expiresAt, … }), or null. */
function cliSession() {
  try {
    const s = JSON.parse(readFileSync(join(cliConfigDir(), "session.json"), "utf8"));
    if (typeof s.sessionToken === "string" && s.sessionToken.startsWith("cfs_")) return s;
  } catch {
    // no stored session
  }
  return null;
}

class CheckError extends Error {}

function configure() {
  const session = env.COMMONFORGE_TOKEN ? null : cliSession();
  const token = env.COMMONFORGE_TOKEN || session?.sessionToken;
  if (!token) throw new CheckError("no token: set COMMONFORGE_TOKEN or sign in with `cforge login`");
  if (session && Date.parse(session.expiresAt) <= Date.now()) throw new CheckError("the stored cforge session has expired: run `cforge login`");
  const url = (env.COMMONFORGE_URL || session?.apiUrl || "").replace(/\/+$/, "");
  if (!url) throw new CheckError("COMMONFORGE_URL is required");
  for (const k of ["ORG", "PROJECT", "MOUNT"]) if (!env[k]) throw new CheckError(`${k} is required`);
  const sizeMb = env.SIZE_MB === undefined || env.SIZE_MB === "" ? 2048 : Number(env.SIZE_MB);
  if (!Number.isFinite(sizeMb) || sizeMb <= 0 || sizeMb * 1048576 > 5_000_000_000) throw new CheckError("SIZE_MB must be a positive number of MiB, at most about 4768 (5 GB)");
  return { token, url, org: env.ORG, project: env.PROJECT, mount: env.MOUNT, size: Math.max(1, Math.floor(sizeMb * 1048576)) };
}

// ---- HTTP -------------------------------------------------------------------------------------

let SECRET = "";
/** Error text can echo request details; the token is never allowed into it. */
const scrub = (t) => (SECRET ? String(t).split(SECRET).join("[token]") : String(t));

class HttpError extends Error {
  constructor(status, body, what) {
    super(scrub(`${what}: HTTP ${status}${body ? ` ${typeof body === "string" ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300)}` : ""}`));
    this.status = status;
  }
}

/** Worth another poll: no response at all (fetch threw), 429 or a 5xx. */
const transient = (e) => !(e instanceof CheckError) && (!(e instanceof HttpError) || e.status === 429 || e.status >= 500);

async function call(cfg, method, path, { json, body, headers = {}, accept } = {}, what = `${method} ${path}`) {
  const res = await fetch(path.startsWith("http") ? path : cfg.url + path, {
    method,
    headers: { authorization: `Bearer ${cfg.token}`, ...(accept ? { accept } : {}), ...(json !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    body: json !== undefined ? JSON.stringify(json) : body,
  });
  const text = await res.text();
  let parsed = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // not JSON
  }
  if (!res.ok) throw new HttpError(res.status, parsed?.error ? parsed.error : parsed, what);
  return { status: res.status, body: parsed, headers: res.headers };
}

const folderPath = (cfg) => `/api/orgs/${cfg.org}/projects/${cfg.project}/folders/${encodeURIComponent(cfg.mount)}`;

/** Consecutive transient errors a poll tolerates before it fails. */
const MAX_TRANSIENT = 3;

/**
 * Poll `read()` until `done(value)` returns a result; interval grows from `first` to `max` ms (so
 * measured times are accurate to about `max`). Up to {@link MAX_TRANSIENT} consecutive transient
 * read errors are logged and retried.
 */
async function poll(what, read, done, { first = 1000, max = 5000, timeout }) {
  const t0 = performance.now();
  let wait = first;
  let errors = 0;
  let v;
  for (;;) {
    try {
      v = await read();
      errors = 0;
    } catch (e) {
      if (!transient(e) || ++errors > MAX_TRANSIENT) throw e;
      log(`${what}: transient error ${errors}/${MAX_TRANSIENT} (${scrub(e instanceof Error ? e.message : e)}); polling again`);
      v = undefined;
    }
    if (v !== undefined) {
      const r = done(v);
      if (r !== undefined) return r;
    }
    if (performance.now() - t0 > timeout) throw new CheckError(`${what}: timed out after ${Math.round(timeout / 1000)} s (last state: ${v?.state ?? "unknown"})`);
    await sleep(wait);
    wait = Math.min(max, Math.round(wait * 1.5));
  }
}

// ---- the steps --------------------------------------------------------------------------------

/** Generate `size` random bytes part by part, hash them locally and upload each part (retried once); a failed upload is aborted. */
async function upload(cfg, name) {
  const path = `live-check/${name}.bin`;
  const start = (await call(cfg, "POST", `${folderPath(cfg)}/uploads`, { json: { path, size: cfg.size, mime: "application/octet-stream" } }, "start upload")).body;
  const { uploadId } = start;
  try {
    return await sendParts(cfg, start, path);
  } catch (e) {
    // best effort: the open upload would otherwise wait 24 h for GC
    try {
      await call(cfg, "DELETE", `/api/orgs/${cfg.org}/uploads/${uploadId}`, {}, "abort upload");
      log(`upload ${uploadId} aborted`);
    } catch (abortError) {
      log(`upload ${uploadId} not aborted (${scrub(abortError instanceof Error ? abortError.message : abortError)}); GC aborts it after 24 h`);
    }
    throw e;
  }
}

async function sendParts(cfg, start, path) {
  const { uploadId, partSize, parts } = start;
  log(`upload ${uploadId}: ${cfg.size} bytes in ${parts} parts of ${partSize}`);
  const hash = createHash("sha256");
  const buf = Buffer.allocUnsafe(Math.min(partSize, cfg.size));
  const etags = [];
  const t0 = performance.now();
  for (let n = 1; n <= parts; n++) {
    const len = n < parts ? partSize : cfg.size - (parts - 1) * partSize;
    // generate in chunks of 1 MiB: randomFillSync is fast and the part buffer is reused
    const part = buf.subarray(0, len);
    for (let off = 0; off < len; off += 1048576) randomFillSync(part, off, Math.min(1048576, len - off));
    hash.update(part);
    let etag;
    for (let attempt = 1; ; attempt++) {
      try {
        etag = (await call(cfg, "PUT", `/api/orgs/${cfg.org}/uploads/${uploadId}/parts/${n}`, { body: part, headers: { "content-type": "application/octet-stream" } }, `part ${n}`)).body.etag;
        break;
      } catch (e) {
        if (attempt >= 2) throw e;
        log(`part ${n} failed (${scrub(e.message)}); retrying once`);
      }
    }
    etags.push({ n, etag });
    if (n % 5 === 0 || n === parts) log(`uploaded part ${n}/${parts}`);
  }
  const localSha256 = hash.digest("hex");
  await call(cfg, "POST", `/api/orgs/${cfg.org}/uploads/${uploadId}/complete`, { json: { parts: etags } }, "complete upload");
  return { uploadId, path, localSha256, uploadMs: ms(t0), completedAt: performance.now() };
}

async function waitVerified(cfg, up) {
  const row = await poll(
    "hash step",
    async () => (await call(cfg, "GET", `/api/orgs/${cfg.org}/uploads/${up.uploadId}`, {}, "upload status")).body,
    (u) => {
      if (u.state === "verified") return u;
      if (u.state === "rejected") throw new CheckError(`the upload was rejected: ${u.error ?? "no reason given"}`);
      return undefined;
    },
    { first: 1000, max: 5000, timeout: 30 * 60_000 },
  );
  return { hashMs: Math.round(performance.now() - up.completedAt), platformSha256: row.sha256, size: row.size };
}

/** A check failure that names the change (and its proposal) it is about. */
class ChangeError extends CheckError {
  constructor(message, c) {
    super(message);
    this.changeId = c.changeId;
    this.proposalId = c.proposalId ?? null;
    this.state = c.state;
  }
}

/** Create a change and poll it to `added` (waiting_approval and failed are failures here). */
async function change(cfg, ops, title, what) {
  const t0 = performance.now();
  const created = (await call(cfg, "POST", `${folderPath(cfg)}/changes`, { json: { ops, title } }, `create ${what} change`)).body;
  log(`${what} change ${created.changeId}: ${created.state}`);
  const done = await poll(
    `${what} change`,
    async () => (await call(cfg, "GET", `/api/orgs/${cfg.org}/file-changes/${created.changeId}`, {}, `${what} change status`)).body,
    (c) => {
      if (c.state === "added") return c;
      if (c.state === "failed") throw new ChangeError(`${what} change ${c.changeId} failed: ${c.error?.code}: ${c.error?.message} (proposal ${c.proposalId ?? "none"})`, c);
      if (c.state === "waiting_approval") throw new ChangeError(`${what} change ${c.changeId} is waiting for an approval of proposal ${c.proposalId}: the signed-in user's role is not in the project's approvalRoles`, c);
      return undefined;
    },
    { first: 1500, max: 5000, timeout: 20 * 60_000 },
  );
  return { changeId: created.changeId, proposalId: done.proposalId, state: done.state, note: done.note, applyAttempts: done.attempt, ms: ms(t0) };
}

async function editNotes(cfg, stamp) {
  const path = "live-check/notes.txt";
  // the version being edited: a new file, unless an earlier run left one behind
  let baseBlob = "";
  try {
    const r = await fetch(`${cfg.url}/api/orgs/${cfg.org}/projects/${cfg.project}/file?mount=${encodeURIComponent(cfg.mount)}&path=${encodeURIComponent(path)}`, { headers: { authorization: `Bearer ${cfg.token}` } });
    if (r.ok) baseBlob = r.headers.get("x-commonforge-blob") ?? "";
    await r.arrayBuffer();
  } catch {
    // treated as a new file
  }
  return change(cfg, [{ edit: path, content: `live check ${stamp}\n`, baseBlob }], "Live check notes", "edit");
}

/** LFS download batch for the oid, then a streamed GET, hashed and compared. */
async function download(cfg, oid, size) {
  const t0 = performance.now();
  const mounts = (await call(cfg, "GET", `/api/orgs/${cfg.org}/projects/${cfg.project}`, {}, "project")).body.mounts ?? [];
  const mount = mounts.find((m) => m.mountName === cfg.mount);
  if (!mount) throw new CheckError(`mount ${cfg.mount} not found in the project`);
  const lfs = `/api/lfs/${cfg.org}/${mount.resourceId}/info/lfs`;
  const type = "application/vnd.git-lfs+json";
  const batch = (await call(cfg, "POST", `${lfs}/objects/batch`, { json: { operation: "download", transfer: ["basic"], hash_algo: "sha256", objects: [{ oid, size }] }, headers: { "content-type": type }, accept: type }, "lfs batch")).body;
  const obj = batch.objects?.[0];
  if (!obj || obj.error || !obj.actions?.download) throw new CheckError(`lfs batch: no download action for the object (${obj?.error ? `${obj.error.code} ${obj.error.message}` : "missing"})`);
  const { href, header = {} } = obj.actions.download;
  // the action's header carries the token: never send it anywhere but the service itself
  let target;
  try {
    target = new URL(href);
  } catch {
    throw new CheckError("lfs batch: the download href is not a URL");
  }
  if (target.origin !== new URL(cfg.url).origin) throw new CheckError(`lfs batch: the download href's origin ${target.origin} is not COMMONFORGE_URL's (${new URL(cfg.url).origin}); the token is not sent there`);
  const res = await fetch(target, { headers: header });
  if (!res.ok || !res.body) throw new HttpError(res.status, await res.text().catch(() => ""), "lfs download");
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of res.body) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  const sha256 = hash.digest("hex");
  return { ms: ms(t0), bytes, sha256, sizeMatches: bytes === size, shaMatches: sha256 === oid };
}

// ---- main -------------------------------------------------------------------------------------

async function main() {
  const summary = { ok: false, url: undefined, org: undefined, project: undefined, mount: undefined, sizeBytes: undefined, steps: {}, cleanup: undefined };
  const t0 = performance.now();
  let cfg;
  let touched = false;
  const failures = [];
  const step = async (name, fn) => {
    try {
      summary.steps[name] = await fn();
      return summary.steps[name];
    } catch (e) {
      failures.push(`${name}: ${scrub(e instanceof Error ? e.message : e)}`);
      summary.steps[name] = { ok: false, error: failures.at(-1), ...(e instanceof ChangeError ? { changeId: e.changeId, state: e.state, proposalId: e.proposalId } : {}) };
      return undefined;
    }
  };
  try {
    cfg = configure();
    SECRET = cfg.token;
  } catch (e) {
    summary.error = scrub(e.message);
    return finish(summary, t0);
  }
  Object.assign(summary, { url: cfg.url, org: cfg.org, project: cfg.project, mount: cfg.mount, sizeBytes: cfg.size });
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const name = `${stamp}-${Math.random().toString(36).slice(2, 8)}`;

  const up = await step("upload", async () => {
    const u = await upload(cfg, name);
    return { path: u.path, uploadId: u.uploadId, uploadMs: u.uploadMs, localSha256: u.localSha256, _completedAt: u.completedAt };
  });
  const hashed = up ? await step("hashStep", async () => ({ ...(await waitVerified(cfg, { uploadId: up.uploadId, completedAt: up._completedAt })), localSha256: up.localSha256 })) : undefined;
  if (hashed) {
    hashed.shaMatches = hashed.platformSha256 === hashed.localSha256;
    hashed.sizeMatches = hashed.size === cfg.size;
    if (!hashed.shaMatches) failures.push("hashStep: the platform's sha256 differs from the local one");
    if (!hashed.sizeMatches) failures.push("hashStep: the platform's size differs from the uploaded one");
  }
  if (up) delete up._completedAt;

  let put;
  if (up && hashed?.shaMatches) {
    touched = true;
    put = await step("putChange", () => change(cfg, [{ put: up.path, stagingId: up.uploadId }], "Live check upload", "put"));
  }
  if (put) {
    touched = true;
    await step("editChange", () => editNotes(cfg, stamp));
    const dl = await step("download", () => download(cfg, hashed.platformSha256, cfg.size));
    if (dl && !(dl.shaMatches && dl.sizeMatches)) failures.push("download: the downloaded bytes differ from the uploaded ones");
  }

  // cleanup: both files in one change (a delete of what is not there is a no-op)
  if (touched) {
    summary.cleanup = await step("cleanup", () => change(cfg, [{ delete: "live-check" }], "Live check cleanup", "cleanup"));
  }

  summary.ok = failures.length === 0;
  if (failures.length) summary.failures = failures;
  return finish(summary, t0);
}

function finish(summary, t0) {
  summary.totalMs = ms(t0);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.exitCode = summary.ok ? 0 : 1;
}

main().catch((e) => {
  process.stdout.write(`${JSON.stringify({ ok: false, error: scrub(e instanceof Error ? e.message : e) }, null, 2)}\n`);
  process.exitCode = 1;
});
