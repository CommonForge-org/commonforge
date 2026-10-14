/**
 * Shared helpers for the live harnesses against the CI deployment (scripts/deploy-ci.sh).
 * Run with Node >= 23 (native TypeScript stripping), after `pnpm build`.
 *
 * Credentials: apps/worker/.dev.vars (CLOUDFLARE_* for `wrangler tail`; CF_ACCOUNT_ID/CF_API_TOKEN
 * for the operator genesis push and the per-run cleanup). Values are never printed.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile, cp, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const WORKER_DIR = join(REPO, "apps", "worker");
export const CFORGE = join(REPO, "apps", "cli", "dist", "index.js");
/** KEY=value lines of a .dev.vars file (quotes stripped); {} when it is missing */
function parseDevVars(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2]!.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]!] = v;
  }
  return out;
}
/** the deployment settings: the environment over apps/worker/.dev.vars (DEV_VARS=<path> for another file) */
const SETTINGS: Record<string, string | undefined> = (() => {
  let file: Record<string, string> = {};
  try {
    file = parseDevVars(readFileSync(process.env.DEV_VARS || join(WORKER_DIR, ".dev.vars"), "utf8"));
  } catch {
    /* no .dev.vars: the environment only */
  }
  return { ...file, ...process.env };
})();
/** the account's workers.dev host (<subdomain>.workers.dev); required for live runs */
const BASE = SETTINGS.COMMONFORGE_LIVE_BASE ?? "";
function workerUrl(worker: string): string {
  if (!BASE) throw new Error("COMMONFORGE_LIVE_BASE is not set (apps/worker/.dev.vars or the environment): the account's <subdomain>.workers.dev");
  return `https://${worker}.${BASE}`;
}
export const CI_WORKER = "commonforge-ci-worker";
export const PROD_WORKER = "commonforge-worker";
/**
 * `--target ci` (default): the CI deployment, log-mode sign-in links read from its Worker log.
 * `--target production`: the production Worker (email send mode). No log-mode sign-in ever: the
 * harness uses existing `cforge login` sessions (`--owner-config`/`--client-config` dirs), and only
 * e2e.ts supports it (see `requireCiTarget`).
 */
const targetArg = process.argv.includes("--target") ? process.argv[process.argv.indexOf("--target") + 1] : "ci";
if (targetArg !== "ci" && targetArg !== "production") throw new Error(`--target must be ci or production, not ${targetArg}`);
export const TARGET: "ci" | "production" = targetArg;
/**
 * production: COMMONFORGE_LIVE_APP_URL when it is on a custom domain (scripts/deploy-live.sh), else
 * its workers.dev URL; "" when neither the URL, the domain nor the base is known (review L4: a CI
 * run with CI_API_URL needs none of them, so this must not throw at import)
 */
const PROD_API = (SETTINGS.COMMONFORGE_LIVE_APP_URL || (SETTINGS.COMMONFORGE_LIVE_APP_DOMAIN ? `https://${SETTINGS.COMMONFORGE_LIVE_APP_DOMAIN}` : BASE ? workerUrl(PROD_WORKER) : "")).replace(/\/+$/, "");
export const API = TARGET === "production" ? PROD_API || workerUrl(PROD_WORKER) : process.env.CI_API_URL ?? workerUrl(CI_WORKER);
export const RELEASE_PREFIX = TARGET === "production" ? "cfapp" : "cfci";
export const NS_PREFIX = TARGET === "production" ? "commonforge-dev" : "commonforge-ci";
/** never touch these (production) unless `--target production` says so explicitly */
const FORBIDDEN_API = [PROD_API, ...(BASE ? [`https://${PROD_WORKER}.${BASE}`] : [])].filter(Boolean);
if (TARGET === "ci" && FORBIDDEN_API.includes(API)) throw new Error("the live harness never runs against the production Worker without --target production");
/** orgs no harness may clean up or write to (e.g. a recording org): COMMONFORGE_PROTECTED_ORGS, comma-separated */
export const PROTECTED_ORGS: string[] = (SETTINGS.COMMONFORGE_PROTECTED_ORGS ?? "").split(",").map((o) => o.trim()).filter(Boolean);
/** Harnesses that sign in through log-mode links (or sweep by prefix) call this first. */
export function requireCiTarget(what: string): void {
  if (TARGET !== "ci") throw new Error(`${what} runs only against the CI deployment (log-mode sign-in / prefix sweeps); production is e2e.ts --target production`);
}

const pexec = promisify(execFile);
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** 503 retries the harness made (each one is a platform blip a person would have clicked through) */
export const unavailableRetries: Array<{ at: string; method: string; path: string; body: string }> = [];

/** apps/worker/.dev.vars as a map (never printed). */
/** apps/worker/.dev.vars, or `DEV_VARS=<path>` (a worktree has no .dev.vars of its own). */
export async function devVars(): Promise<Record<string, string>> {
  return parseDevVars(await readFile(process.env.DEV_VARS || join(WORKER_DIR, ".dev.vars"), "utf8"));
}

// ---------------------------------------------------------------------------------------------
// Evidence

export interface Step {
  step: string;
  ok: boolean;
  startedAt: string;
  ms: number;
  detail?: unknown;
  error?: string;
}

export class Evidence {
  readonly steps: Step[] = [];
  readonly facts: Record<string, unknown> = {};
  readonly started = new Date();
  readonly name: string;
  constructor(name: string) {
    this.name = name;
  }

  async step<T>(name: string, fn: () => Promise<T>, summarize?: (v: T) => unknown): Promise<T> {
    const t0 = Date.now();
    const startedAt = new Date().toISOString();
    process.stderr.write(`[${startedAt.slice(11, 19)}] ${name} …\n`);
    try {
      const v = await fn();
      const s: Step = { step: name, ok: true, startedAt, ms: Date.now() - t0, ...(summarize ? { detail: summarize(v) } : {}) };
      this.steps.push(s);
      process.stderr.write(`[${new Date().toISOString().slice(11, 19)}]   ok (${s.ms} ms)${s.detail !== undefined ? ` ${JSON.stringify(s.detail).slice(0, 300)}` : ""}\n`);
      return v;
    } catch (e) {
      const error = redact(e instanceof Error ? e.message : String(e));
      this.steps.push({ step: name, ok: false, startedAt, ms: Date.now() - t0, error });
      process.stderr.write(`  FAILED: ${error}\n`);
      throw e;
    }
  }

  async write(path: string, extra: Record<string, unknown> = {}): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const doc = { name: this.name, mode: "live", deployment: API, startedAt: this.started.toISOString(), finishedAt: new Date().toISOString(), ok: this.steps.every((s) => s.ok), steps: this.steps, facts: this.facts, unavailableRetries: unavailableRetries.map((r) => ({ ...r, body: redact(r.body) })), ...extra };
    await writeFile(path, `${JSON.stringify(doc, null, 2)}\n`);
  }
}

let secrets: string[] = [];
/** register values that must never reach evidence or logs */
export function secret(v: string): string {
  if (v && v.length >= 8) secrets.push(v);
  return v;
}
export function redact(s: string): string {
  for (const v of secrets) s = s.split(v).join("[REDACTED]");
  return s.replace(/\b(cf[slm]_[A-Za-z0-9_-]{8,})/g, "[REDACTED]").replace(/x-token:[^@\s]+@/g, "x-token:[REDACTED]@");
}

// ---------------------------------------------------------------------------------------------
// Worker log (email log mode): `wrangler tail` of the CI worker

export class Tail {
  #buf = "";
  #proc: ChildProcess | null = null;

  static async start(env: Record<string, string>): Promise<Tail> {
    requireCiTarget("reading sign-in links from the Worker log");
    const t = new Tail();
    const p = spawn("pnpm", ["exec", "wrangler", "tail", CI_WORKER, "--format", "json"], {
      cwd: WORKER_DIR,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN!, CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID!, WRANGLER_SEND_METRICS: "false" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    t.#proc = p;
    let connected = false;
    p.stdout!.on("data", (d: Buffer) => (t.#buf += d.toString()));
    p.stderr!.on("data", (d: Buffer) => {
      if (/Connected to|Successfully created tail/i.test(d.toString())) connected = true;
    });
    for (let i = 0; i < 60 && !connected; i++) await sleep(500);
    await sleep(2000);
    return t;
  }

  /** The newest log-mode link for `email` (`kind`: `token` web link, `code` CLI link). */
  async link(email: string, kind: "token" | "code", sinceLen: number, timeoutMs = 90_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    const re = new RegExp(`magic link for ${email.replace(/[.+]/g, "\\$&")}: (https://[^"\\s\\\\]+)`, "g");
    while (Date.now() < deadline) {
      const found = [...this.#buf.slice(sinceLen).matchAll(re)].map((m) => new URL(m[1]!)).filter((u) => u.searchParams.has(kind));
      if (found.length) return secret(found[found.length - 1]!.searchParams.get(kind)!);
      await sleep(1000);
    }
    throw new Error(`no ${kind} link for ${email} in the CI worker log after ${timeoutMs} ms`);
  }

  get length(): number {
    return this.#buf.length;
  }

  stop(): void {
    this.#proc?.kill("SIGINT");
  }
}

// ---------------------------------------------------------------------------------------------
// API clients

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** A bearer (CLI session) or cookie (web session) client. */
export class Client {
  readonly label: string;
  private readonly auth: { bearer?: string; cookie?: string };
  constructor(label: string, auth: { bearer?: string; cookie?: string }) {
    this.label = label;
    this.auth = auth;
  }

  headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      accept: "application/json",
      ...(this.auth.bearer ? { authorization: `Bearer ${this.auth.bearer}` } : {}),
      // cookie sessions: the CSRF guard wants the app's Origin on state-changing requests
      ...(this.auth.cookie ? { cookie: this.auth.cookie, origin: API } : {}),
      ...extra,
    };
  }

  async req<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(`${API}${path}`, {
        method,
        headers: this.headers(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        redirect: "manual",
      });
      // a person clicks again on "temporarily unavailable" (503 provider_unavailable, review I2);
      // every such retry is counted into the evidence (unavailableRetries)
      if (res.status === 503 && attempt <= 3) {
        unavailableRetries.push({ at: new Date().toISOString(), method, path: path.replace(/\?.*$/, ""), body: (await res.text()).slice(0, 200) });
        await sleep(3000 * attempt);
        continue;
      }
      return parse<T>(res, method, path);
    }
  }

  async raw(method: string, path: string, bytes?: Uint8Array, contentType = "application/octet-stream"): Promise<Response> {
    return fetch(`${API}${path}`, {
      method,
      headers: this.headers(bytes ? { "content-type": contentType, "content-length": String(bytes.byteLength) } : {}),
      ...(bytes ? { body: bytes } : {}),
      redirect: "manual",
    });
  }

  async upload<T = any>(path: string, bytes: Uint8Array, contentType: string): Promise<T> {
    return parse<T>(await this.raw("POST", path, bytes, contentType), "POST", path);
  }

  async bytes(path: string): Promise<Uint8Array> {
    const res = await this.raw("GET", path);
    if (!res.ok) await parse(res, "GET", path);
    return new Uint8Array(await res.arrayBuffer());
  }
}

async function parse<T>(res: Response, method: string, path: string): Promise<T> {
  const text = await res.text();
  let j: any = null;
  try {
    j = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  if (!res.ok) throw new ApiError(res.status, j?.error?.code ?? `http_${res.status}`, `${method} ${path} → ${res.status} ${j?.error?.code ?? ""}: ${redact(j?.error?.message ?? text.slice(0, 300))}`, j?.error?.details);
  return j as T;
}

export async function poll<T>(what: string, fn: () => Promise<T>, done: (v: T) => boolean, timeoutMs = 10 * 60_000, everyMs = 2000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (done(v)) return v;
    if (Date.now() > deadline) throw new Error(`${what}: timed out after ${timeoutMs} ms (last: ${redact(JSON.stringify(v)).slice(0, 400)})`);
    await sleep(everyMs);
  }
}

// ---------------------------------------------------------------------------------------------
// Sign-in through log-mode links

export async function run(file: string, args: string[], opts: { cwd?: string; env: Record<string, string>; timeoutMs?: number }): Promise<{ stdout: string; stderr: string }> {
  try {
    const r = await pexec(file, args, { cwd: opts.cwd, env: opts.env, timeout: opts.timeoutMs ?? 15 * 60_000, maxBuffer: 64 * 1024 * 1024 });
    return { stdout: r.stdout.toString(), stderr: r.stderr.toString() };
  } catch (e: any) {
    throw new Error(`${file.endsWith("index.js") ? "cforge" : file} ${args.slice(0, 2).join(" ")} failed (exit ${e.code}): ${redact(String(e.stderr || e.stdout || e.message)).slice(-1500)}`);
  }
}

async function withRetries<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= attempts) throw e;
      process.stderr.write(`  (no link in the log yet; requesting another: ${i + 1}/${attempts})\n`);
    }
  }
}

/** `cforge login --email`, the code from the CI worker log, `cforge login --code`; returns the session bearer. */
export async function cliSignIn(tail: Tail, email: string, configDir: string): Promise<{ bearer: string; env: Record<string, string> }> {
  requireCiTarget("log-mode CLI sign-in");
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", CFORGE_CONFIG_DIR: configDir, CFORGE_API_URL: API, LANG: "C.UTF-8" };
  // `wrangler tail` may drop events: re-request the link (≤ 3 times; the limit is 5 per address per 15 min)
  const code = await withRetries(async () => {
    const mark = tail.length;
    await run(process.execPath, [CFORGE, "login", "--email", email, "--json"], { env });
    return tail.link(email, "code", mark, 30_000);
  });
  await run(process.execPath, [CFORGE, "login", "--code", code, "--json"], { env });
  const s = JSON.parse(await readFile(join(configDir, "session.json"), "utf8")) as { sessionToken: string };
  return { bearer: secret(s.sessionToken), env };
}

/** Browser flow: `POST /auth/magic-link`, the token from the log, `POST /auth/verify` (click) → cookie. */
export async function webSignIn(tail: Tail, email: string): Promise<string> {
  requireCiTarget("log-mode web sign-in");
  const h = { "content-type": "application/json", origin: API, accept: "application/json" };
  const token = await withRetries(async () => {
    const mark = tail.length;
    const r = await fetch(`${API}/api/auth/magic-link`, { method: "POST", headers: h, body: JSON.stringify({ email }) });
    if (r.status !== 202) throw new Error(`magic-link → ${r.status} ${await r.text()}`);
    return tail.link(email, "token", mark, 30_000);
  });
  const v = await fetch(`${API}/api/auth/verify`, { method: "POST", headers: h, body: JSON.stringify({ token }) });
  if (!v.ok) throw new Error(`verify → ${v.status} ${await v.text()}`);
  const set = v.headers.getSetCookie().find((c) => c.startsWith("__Host-cf_session="));
  if (!set) throw new Error("verify set no session cookie");
  return secret(set.split(";")[0]!);
}

// ---------------------------------------------------------------------------------------------
// Production: existing `cforge login` sessions (no log-mode links; production sends real email)

/**
 * The bearer of an existing `cforge login` session in `configDir` (CFORGE_CONFIG_DIR). The token is
 * read in-process, registered as a secret (redacted from evidence and logs) and never printed. The
 * session must belong to this deployment and stay valid for the run.
 */
export async function configSession(configDir: string): Promise<{ bearer: string; env: Record<string, string>; email: string; userId: string }> {
  const s = JSON.parse(await readFile(join(configDir, "session.json"), "utf8")) as { apiUrl?: string; sessionToken?: string; expiresAt?: string; user?: { userId?: string; email?: string } };
  if (!s.sessionToken) throw new Error(`${configDir}: no cforge session (run cforge login with CFORGE_CONFIG_DIR=${configDir})`);
  secret(s.sessionToken);
  if (s.apiUrl && s.apiUrl.replace(/\/$/, "") !== API) throw new Error(`${configDir}: the session belongs to ${s.apiUrl}, not ${API}`);
  if (s.expiresAt && Date.parse(s.expiresAt) < Date.now() + 2 * 3600_000) throw new Error(`${configDir}: the session expires at ${s.expiresAt}; sign in again`);
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", CFORGE_CONFIG_DIR: configDir, CFORGE_API_URL: API, LANG: "C.UTF-8" };
  return { bearer: s.sessionToken, env, email: s.user?.email ?? "", userId: s.user?.userId ?? "" };
}

/** Production pre-flight: /health is the production deployment, in send mode, without chaos flags. */
export async function assertProductionHealth(): Promise<Record<string, unknown>> {
  const h = (await (await fetch(`${API}/health`)).json()) as Record<string, unknown>;
  if (h.deployment !== "production" || h.emailMode !== "send" || "chaos" in h || h.ok !== true) throw new Error(`refusing: ${API}/health is not production/send without chaos: ${JSON.stringify(h)}`);
  return h;
}

// ---------------------------------------------------------------------------------------------
// Operator steps with the dev token (genesis push, cleanup). Never used for product flows.

export class ArtifactsOperator {
  private readonly accountId: string;
  private readonly token: string;
  constructor(accountId: string, token: string) {
    this.accountId = accountId;
    this.token = secret(token);
  }

  async call<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    let res!: Response;
    let j: any;
    // the platform's transient "403 10004 Access denied" (finding B5): retry like the product does
    for (let attempt = 0; attempt < 5; attempt++) {
      res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${this.accountId}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      j = await res.json().catch(() => ({}));
      if (!(res.status === 403 && (j?.errors ?? []).some((e: any) => e.code === 10004))) break;
      await sleep(1000 * (attempt + 1));
    }
    if (!res.ok || j.success === false) throw new ApiError(res.status, String(j?.errors?.[0]?.code ?? res.status), `${method} ${path.replace(this.accountId, "<acct>")} → ${res.status}: ${JSON.stringify(j?.errors ?? []).slice(0, 300)}`);
    return j.result as T;
  }

  /** Push a directory as the one genesis commit of an empty canonical repo, with a short-lived write token. */
  async genesisPush(o: { namespace: string; repoName: string; remoteUrl: string; dir: string; work: string }): Promise<{ sha: string; username: string }> {
    // a namespace the Worker just created can answer 403/404 for a few seconds: retry
    let tok!: { id: string; plaintext: string };
    for (let i = 1; ; i++) {
      try {
        tok = await this.call<{ id: string; plaintext: string }>("POST", `/artifacts/namespaces/${o.namespace}/tokens`, { repo: o.repoName, scope: "write", ttl: 600 });
        break;
      } catch (e) {
        if (i >= 6 || !(e instanceof ApiError) || ![403, 404].includes(e.status)) throw e;
        await sleep(2000 * i);
      }
    }
    secret(tok.plaintext);
    try {
      const askpass = join(o.work, "askpass.sh");
      await writeFile(askpass, '#!/bin/sh\ncase "$1" in Username*) echo x-token ;; *) printf %s "$CF_GENESIS_TOKEN" ;; esac\n');
      await chmod(askpass, 0o700);
      const env = { PATH: process.env.PATH ?? "", HOME: o.work, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: askpass, CF_GENESIS_TOKEN: tok.plaintext };
      const git = (...a: string[]) => run("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "credential.helper=", "-c", "user.name=CommonForge CI", "-c", "user.email=ci@commonforge.invalid", ...a], { cwd: o.dir, env });
      await git("init", "-q", "-b", "main");
      await git("add", "-A");
      await git("commit", "-q", "-m", "genesis (CI e2e fixture import)");
      // username x-token in the URL, password from askpass: what the cforge credential helper sends
      const u = new URL(o.remoteUrl);
      u.username = "x-token";
      await git("push", "-q", u.toString(), "main:refs/heads/main");
      const sha = (await git("rev-parse", "HEAD")).stdout.trim();
      return { sha, username: "x-token" };
    } finally {
      await this.call("DELETE", `/artifacts/namespaces/${o.namespace}/tokens/${tok.id}`).catch(() => undefined);
    }
  }

  async branchSha(namespace: string, repo: string, ref = "main"): Promise<string | null> {
    const r = await this.call<Array<{ hash?: string }>>("GET", `/artifacts/namespaces/${namespace}/repos/${encodeURIComponent(repo)}/log?ref=${ref}&limit=1`).catch(() => []);
    return r?.[0]?.hash ?? null;
  }

  /** Delete every repo of every `<prefix>-<orgId>-<kind>` namespace, then the namespaces. */
  async deleteOrgNamespaces(orgId: string, kinds: string[] = ["canonical", "tasks", "editions"]): Promise<string[]> {
    if (PROTECTED_ORGS.includes(orgId)) throw new Error(`refusing to delete the namespaces of protected org ${orgId}`);
    const deleted: string[] = [];
    for (const kind of kinds) {
      const ns = `${NS_PREFIX}-${orgId}-${kind}`;
      let repos: Array<{ name: string }> = [];
      try {
        repos = await this.call("GET", `/artifacts/namespaces/${ns}/repos?per_page=100`);
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) continue;
        throw e;
      }
      for (const r of repos ?? []) await this.call("DELETE", `/artifacts/namespaces/${ns}/repos/${encodeURIComponent(r.name)}`).catch(() => undefined);
      await this.call("DELETE", `/artifacts/namespaces/${ns}`).then(() => deleted.push(ns), () => deleted.push(`${ns} (${repos?.length ? "repos deleted; namespace delete refused" : "not present"})`));
    }
    return deleted;
  }
}

/** Copy the tracked files of `fixtures/<name>` (minus monorepo-only files) into `dest`. */
export async function copyFixture(name: string, dest: string): Promise<string[]> {
  const files = (await run("git", ["ls-files", `fixtures/${name}`], { cwd: REPO, env: { PATH: process.env.PATH ?? "" } })).stdout.split("\n").filter(Boolean);
  const out: string[] = [];
  for (const f of files) {
    const rel = f.slice(`fixtures/${name}/`.length);
    if (name === "website" && rel === "turbo.json") continue;
    await mkdir(dirname(join(dest, rel)), { recursive: true });
    await cp(join(REPO, f), join(dest, rel));
    out.push(rel);
  }
  return out;
}

export async function rmrf(p: string): Promise<void> {
  await rm(p, { recursive: true, force: true });
}
