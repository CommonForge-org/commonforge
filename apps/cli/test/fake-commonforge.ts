/**
 * A fake CommonForge control plane for CLI tests, following apps/worker/API.md for the routes the
 * CLI uses. Repositories are real bare git repositories on disk:
 *
 *   <root>/repos/cf-o1-canonical/<resourceId>.git   canonical (never handed to agents)
 *   <root>/repos/cf-o1-tasks/ws-<id>.git            task repos (writable copy / read-only reference copy)
 *
 * Two transports:
 * - `fetch` (in-memory) + `file://` remotes — unit tests (git needs no credential for file://);
 * - `listen()` — a node:http server for the API and a smart-HTTP git front (`git http-backend`)
 *   that, like Artifacts, requires a broker-issued token as the basic-auth password, scoped to one
 *   repository and to read or write, revoked on freeze and on a new lease. Used by the AT-22 E2E.
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeAssetManifestIdSync, computeSnapshotIdSync, type AssetManifest, type MaterializationPlan, type ProjectSnapshot, type TaskWorkspaceHandle } from "@commonforge-org/core";
import { WORKSPACE_JSON_PATH, planMaterialization, type MaterializationGrant } from "@commonforge-org/runner-protocol";

export const ORG = "o-000000000001";
export const PROJECT = "p-000000000001";
const NS_CANONICAL = "cf-o1-canonical";
const NS_TASKS = "cf-o1-tasks";

export function cleanGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GIT_")) env[k] = v;
  // hermetic: the developer's global config (e.g. a git-lfs filter) never applies to the fake's repos
  return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
}

export function git(args: string[], cwd: string, env: NodeJS.ProcessEnv = cleanGitEnv()): string {
  return execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

const hex = (n: number) => randomBytes(n).toString("hex");

export interface Reply {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
  raw?: Uint8Array;
}

export interface RequestInfo {
  method: string;
  path: string;
  query: URLSearchParams;
  auth: string | null;
  body: unknown;
}

type Override = (req: RequestInfo) => Reply | Promise<Reply> | null | undefined;

interface Workspace {
  taskWorkspaceId: string;
  mountName: string;
  resourceId: string;
  access: "read" | "write";
  state: "provisioning" | "writable" | "frozen";
  repoName: string;
  baseSha: string;
}

interface Task {
  taskId: string;
  title: string;
  request: string;
  state: "provisioning" | "ready" | "running" | "submitted";
  /** GET /api/tasks/:id polls left before provisioning completes (the Worker's queue steps) */
  provisioningPolls: number;
  snapshot: ProjectSnapshot;
  lease: { token: string; generation: number; expiresAt: number; holder: string } | null;
  generation: number;
  workspaces: Workspace[];
  candidates: Array<{ candidateId: string; resourceId: string; taskWorkspaceId: string; state: string; preparedReceiptId: null; sha: string; changedPaths: string[] }>;
}

interface Token {
  tokenId: string;
  repoName: string;
  namespace: string;
  scope: "read" | "write";
  expiresAt: number;
  revoked: boolean;
}

const err = (status: number, code: string, message = code): Reply => ({ status, body: { error: { code, message } } });

export class FakeCommonForge {
  readonly root = mkdtempSync(join(tmpdir(), "cforge-fake-"));
  readonly repos = join(this.root, "repos");
  baseUrl = "https://api.fake.test";
  /** set by listen(): remotes become http URLs behind the token-checking git front */
  httpGit = false;
  /** the Worker's default when a task is created without writeMounts (the project's access settings) */
  defaultWriteMounts = ["api"];
  server: Server | null = null;
  now = () => Date.now();

  readonly users = new Map<string, { userId: string; email: string }>();
  readonly codes = new Map<string, string>();
  readonly sessions = new Map<string, { userId: string; expiresAt: number }>();
  readonly resources = new Map<string, { resourceId: string; name: string; mountName: string; writable: boolean; repoId: string; provider: "artifacts" | "r2-assets"; manifest?: AssetManifest; objects?: Map<string, Uint8Array> }>();
  readonly tasks = new Map<string, Task>();
  readonly tokens = new Map<string, Token>();
  readonly exports = new Map<string, { exportId: string; polls: number; receipt: unknown; blobs: Map<string, Uint8Array>; snapshot: ProjectSnapshot }>();
  readonly calls: RequestInfo[] = [];
  /** review I2: the next N `/credential` calls answer 503 provider_unavailable */
  credentialOutages = 0;
  readonly gitRequests: Array<{ repo: string; service: string; username: string | null; password: string | null; status: number }> = [];
  readonly overrides = new Map<string, Override>();
  memberships = [{ orgId: ORG, name: "Demo Org", role: "owner" }];
  /** respond 503 to this many receive-pack POSTs (Artifacts' one-push-per-repo busy) */
  busyPushes = 0;
  /** a git mount's LFS URL in the plan, as the Worker's `lfsEndpointUrl` (null: none) */
  lfsUrlFor: (resourceId: string) => string | null = (rid) => `${this.baseUrl}/api/lfs/${ORG}/${rid}/info/lfs`;

  constructor() {
    mkdirSync(join(this.repos, NS_CANONICAL), { recursive: true });
    mkdirSync(join(this.repos, NS_TASKS), { recursive: true });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        rmSync(this.root, { recursive: true, force: true });
        resolve();
      };
      if (this.server) {
        this.server.closeAllConnections();
        this.server.close(() => done());
      } else done();
    });
  }

  // ------------------------------------------------------------------------------- seeding

  addUser(email: string): { userId: string; email: string } {
    const u = { userId: `u-${hex(6)}`, email };
    this.users.set(email, u);
    return u;
  }

  /** A logged-in session token for `email` (bypasses the email code). */
  sessionFor(email: string): string {
    const u = this.users.get(email) ?? this.addUser(email);
    const token = `cfs_${hex(24)}`;
    this.sessions.set(token, { userId: u.userId, expiresAt: this.now() + 86_400_000 });
    return token;
  }

  repoPath(namespace: string, repoName: string): string {
    return join(this.repos, namespace, `${repoName}.git`);
  }

  remoteUrl(namespace: string, repoName: string): string {
    return this.httpGit ? `${this.baseUrl}/git/${namespace}/${repoName}.git` : `file://${this.repoPath(namespace, repoName)}`;
  }

  /** Canonical resource with one commit of `files`; mounted in the project. */
  addResource(mountName: string, files: Record<string, string>, writable = true): { resourceId: string; sha: string } {
    const resourceId = `res-${hex(8)}`;
    const work = mkdtempSync(join(this.root, "src-"));
    git(["init", "-q", "-b", "main"], work);
    for (const [p, c] of Object.entries(files)) {
      mkdirSync(join(work, p, ".."), { recursive: true });
      writeFileSync(join(work, p), c);
    }
    git(["add", "-A"], work);
    git(["commit", "-q", "-m", `init ${mountName}`], work);
    const sha = git(["rev-parse", "HEAD"], work);
    git(["clone", "-q", "--bare", work, this.repoPath(NS_CANONICAL, resourceId)], this.root);
    rmSync(work, { recursive: true, force: true });
    this.resources.set(resourceId, { resourceId, name: `${mountName}-repo`, mountName, writable, repoId: resourceId, provider: "artifacts" });
    return { resourceId, sha };
  }

  /** An r2-assets resource whose accepted head is a manifest of `files` (read-only in tasks). */
  addAssetResource(mountName: string, files: Record<string, string>): { resourceId: string; manifest: AssetManifest } {
    const resourceId = `res-${hex(8)}`;
    const objects = new Map<string, Uint8Array>();
    const entries = Object.entries(files)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([path, content]) => {
        const bytes = new TextEncoder().encode(content);
        const sha = createHash("sha256").update(bytes).digest("hex");
        objects.set(path, bytes);
        return { path, sha256: sha, size: bytes.length, mime: "application/octet-stream", objectKey: `org/${ORG}/res/${resourceId}/obj/${sha}` };
      });
    const manifestId = computeAssetManifestIdSync({ resourceId, parentManifestId: null, entries } as never);
    const manifest = { manifestId, resourceId, parentManifestId: null, entries, createdAt: new Date(this.now()).toISOString() } as unknown as AssetManifest;
    this.resources.set(resourceId, { resourceId, name: `${mountName}-assets`, mountName, writable: false, repoId: resourceId, provider: "r2-assets", manifest, objects });
    return { resourceId, manifest };
  }

  revisionOf(r: { resourceId: string; repoId: string; provider: string; manifest?: AssetManifest }): string {
    return r.provider === "r2-assets" ? `r2m:${r.manifest!.manifestId}` : `local:${r.repoId}:${this.canonicalHead(r.resourceId)}`;
  }

  canonicalHead(resourceId: string): string {
    return git(["--git-dir", this.repoPath(NS_CANONICAL, resourceId), "rev-parse", "refs/heads/main"], this.root);
  }

  /**
   * A task writing `writeMounts`, with read-only reference copies of every other git mount (I-6).
   * `provisioningPolls > 0` models the Worker's `workspace.create` queue steps: the task stays
   * `provisioning` (lease → 409 task_not_ready) for that many `GET /api/tasks/:id`.
   */
  createTask(title: string, writeMounts: string[], request = "", provisioningPolls = 0): Task {
    const taskId = `task-${crypto.randomUUID()}`;
    const entries = [...this.resources.values()].map((r) => ({
      resourceId: r.resourceId,
      revisionId: this.revisionOf(r),
      mode: "must-match-accepted" as const,
      mountName: r.mountName,
      operations: writeMounts.includes(r.mountName) ? ["read", "write"] : ["read"],
    }));
    const base = { projectId: PROJECT, organizationId: ORG, membershipRevision: 1, policyRevision: 1, entries };
    const snapshot = { ...base, snapshotId: computeSnapshotIdSync(base as never), createdAt: new Date(this.now()).toISOString() } as unknown as ProjectSnapshot;
    const workspaces: Workspace[] = [];
    for (const r of this.resources.values()) {
      if (r.provider !== "artifacts") continue;
      const access = writeMounts.includes(r.mountName) ? "write" : "read";
      const taskWorkspaceId = `tw-${hex(12)}`;
      const repoName = `ws-${taskWorkspaceId}`;
      git(["clone", "-q", "--bare", this.repoPath(NS_CANONICAL, r.resourceId), this.repoPath(NS_TASKS, repoName)], this.root);
      workspaces.push({ taskWorkspaceId, mountName: r.mountName, resourceId: r.resourceId, access, state: provisioningPolls > 0 ? "provisioning" : "writable", repoName, baseSha: this.canonicalHead(r.resourceId) });
    }
    const t: Task = { taskId, title, request, state: provisioningPolls > 0 ? "provisioning" : "ready", provisioningPolls, snapshot, lease: null, generation: 0, workspaces, candidates: [] };
    this.tasks.set(taskId, t);
    return t;
  }

  taskRepoHead(ws: Workspace, ref = "refs/heads/main"): string | null {
    try {
      return git(["--git-dir", this.repoPath(NS_TASKS, ws.repoName), "rev-parse", "--verify", "--quiet", ref], this.root);
    } catch {
      return null;
    }
  }

  liveTokens(): Token[] {
    return [...this.tokens.values()].filter((t) => !t.revoked && t.expiresAt > this.now());
  }

  secrets(): string[] {
    return [...this.tokens.keys(), ...this.sessions.keys(), ...[...this.tasks.values()].flatMap((t) => (t.lease ? [t.lease.token] : []))];
  }

  // ------------------------------------------------------------------------------- API

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers);
    const r = await this.handle(init?.method ?? "GET", url, headers.get("authorization"), typeof init?.body === "string" ? init.body : null);
    const h = new Headers(r.headers);
    if (r.raw) return new Response(r.raw, { status: r.status, headers: h });
    if (r.body === undefined) return new Response(null, { status: r.status, headers: h });
    h.set("content-type", "application/json");
    return new Response(JSON.stringify(r.body), { status: r.status, headers: h });
  };

  async handle(method: string, url: URL, authorization: string | null, rawBody: string | null): Promise<Reply> {
    let body: unknown = undefined;
    if (rawBody) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        return err(400, "invalid_request");
      }
    }
    const auth = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
    const req: RequestInfo = { method, path: url.pathname, query: url.searchParams, auth, body };
    this.calls.push(req);
    for (const [pattern, fn] of this.overrides) {
      const [m, re] = pattern.split(" ");
      if (m === method && new RegExp(`^${re}$`).test(url.pathname)) {
        const r = await fn(req);
        if (r) return r;
      }
    }
    try {
      return await this.route(req);
    } catch (e) {
      return err(500, "internal", String(e));
    }
  }

  #user(req: RequestInfo): { userId: string; email: string } | null {
    if (!req.auth?.startsWith("cfs_")) return null;
    const s = this.sessions.get(req.auth);
    if (!s || s.expiresAt <= this.now()) return null;
    return [...this.users.values()].find((u) => u.userId === s.userId) ?? null;
  }

  #agentTask(req: RequestInfo, taskId: string): Task | null {
    if (!req.auth?.startsWith("cfl_")) return null;
    const t = this.tasks.get(taskId);
    return t?.lease && t.lease.token === req.auth && t.lease.expiresAt > this.now() ? t : null;
  }

  #revokeWrites(t: Task, ws?: Workspace): void {
    for (const tok of this.tokens.values()) {
      if (tok.scope === "write" && t.workspaces.some((w) => (!ws || w === ws) && w.repoName === tok.repoName)) tok.revoked = true;
    }
  }

  #presentTask(t: Task, seesRepos: boolean) {
    return {
      taskId: t.taskId,
      orgId: ORG,
      projectId: PROJECT,
      changeId: `chg-${t.taskId.slice(5)}`,
      title: t.title,
      request: t.request,
      state: t.state,
      snapshot: t.snapshot,
      lease: t.lease ? { generation: t.lease.generation, expiresAt: new Date(t.lease.expiresAt).toISOString(), holder: t.lease.holder } : null,
      workspaces: t.workspaces.map((w) => ({
        taskWorkspaceId: w.taskWorkspaceId,
        mountName: w.mountName,
        resourceId: w.resourceId,
        provider: "artifacts",
        access: w.access,
        baseRevision: `local:${w.resourceId}:${w.baseSha}`,
        state: w.state,
        ...(seesRepos ? { remoteUrl: this.remoteUrl(NS_TASKS, w.repoName) } : {}),
      })),
      candidates: t.candidates,
    };
  }

  #plan(t: Task, root: string): MaterializationPlan {
    const handles: TaskWorkspaceHandle[] = [];
    const copies = new Map<string, Workspace>();
    for (const w of t.workspaces) {
      if (w.state !== "writable") continue;
      if (w.access === "write") {
        handles.push({
          taskWorkspaceId: w.taskWorkspaceId,
          resourceId: w.resourceId,
          baseRevision: `local:${w.resourceId}:${w.baseSha}`,
          provider: "local-git",
          coords: { kind: "local-git", namespace: NS_TASKS, repoName: w.repoName, repoId: w.repoName, remoteUrl: this.remoteUrl(NS_TASKS, w.repoName) },
          state: "writable",
        } as unknown as TaskWorkspaceHandle);
      } else copies.set(w.resourceId, w);
    }
    const grants: MaterializationGrant[] = t.snapshot.entries.map((e) => {
      const r = this.resources.get(e.resourceId)!;
      if (r.provider === "r2-assets") {
        return { resourceId: e.resourceId, operations: ["read"], coords: { kind: "r2-assets", bucket: "commonforge-assets", prefix: `org/${ORG}/res/${r.resourceId}/`, manifestId: r.manifest!.manifestId }, manifest: r.manifest };
      }
      return { resourceId: e.resourceId, operations: e.operations, coords: { kind: "local-git", namespace: NS_CANONICAL, repoName: e.resourceId, repoId: e.resourceId, remoteUrl: this.remoteUrl(NS_CANONICAL, e.resourceId) } };
    }) as MaterializationGrant[];
    const plan = planMaterialization(t.snapshot, handles, {
      principal: { kind: "agent", id: t.taskId },
      workspaceRoot: root,
      grants,
      context: { request: `${t.title}\n\n${t.request}`, roles: [], rules: ["Keep the API contract."], validationCommands: [] },
    });
    // I-6: reference mounts come from their read-only -tasks copy, never canonical (as the Worker does)
    const mounts = plan.mounts.map((m) => {
      if (m.source.kind !== "git") return m;
      const lfsUrl = this.lfsUrlFor(m.resourceId);
      const source = { ...m.source, ...(lfsUrl ? { lfsUrl } : {}) };
      const c = copies.get(m.resourceId);
      if (!c || m.writable) return { ...m, source };
      return { ...m, source: { ...source, remoteUrl: this.remoteUrl(NS_TASKS, c.repoName), credential: "helper" as const } };
    });
    const contextFiles = plan.contextFiles.map((f) => {
      if (f.path !== WORKSPACE_JSON_PATH) return f;
      const doc = JSON.parse(f.content) as { mounts: Array<{ resourceId: string; writable: boolean; source: { remoteUrl?: string }; coords: unknown }> };
      for (const m of doc.mounts) {
        const c = copies.get(m.resourceId);
        if (!c || m.writable) continue;
        m.source.remoteUrl = this.remoteUrl(NS_TASKS, c.repoName);
        m.coords = { kind: "local-git", namespace: NS_TASKS, repoName: c.repoName, repoId: c.repoName, remoteUrl: this.remoteUrl(NS_TASKS, c.repoName) };
      }
      return { ...f, content: `${JSON.stringify(doc, null, 2)}\n` };
    });
    return { ...plan, mounts, contextFiles };
  }

  async route(req: RequestInfo): Promise<Reply> {
    const { method, path } = req;
    const body = (req.body ?? {}) as Record<string, unknown>;
    let m: RegExpExecArray | null;

    if (method === "POST" && path === "/api/auth/magic-link") {
      const email = String(body.email);
      if (body.client === "cli") {
        if (!this.users.has(email)) this.addUser(email);
        this.codes.set(`cfm_${hex(16)}`, email);
      }
      return { status: 202, body: { ok: true } };
    }
    if (method === "POST" && path === "/api/auth/cli/verify") {
      const email = this.codes.get(String(body.code));
      if (!email) return err(401, "invalid_token");
      this.codes.delete(String(body.code));
      const token = this.sessionFor(email);
      const u = this.users.get(email)!;
      return { status: 200, headers: { "cache-control": "no-store" }, body: { user: u, sessionToken: token, expiresAt: new Date(this.sessions.get(token)!.expiresAt).toISOString() } };
    }
    if (method === "POST" && path === "/api/auth/logout") {
      if (req.auth) this.sessions.delete(req.auth);
      return { status: 200, body: { ok: true } };
    }

    // A bearer that is no session and no live lease is no principal: 401 everywhere (as authenticate does)
    if (req.auth && !this.#user(req) && ![...this.tasks.values()].some((t) => t.lease?.token === req.auth && t.lease.expiresAt > this.now())) {
      return err(401, "unauthenticated", "authentication required");
    }

    // ---- agent routes (lease token) and shared task routes
    if ((m = /^\/api\/tasks\/([^/]+)\/credential$/.exec(path)) && method === "POST") {
      const t = this.#agentTask(req, m[1]!);
      if (!t) return this.#user(req) ? err(403, "lease_required") : err(401, "unauthenticated");
      // review I2: a transient Artifacts outage surfaces as 503 provider_unavailable
      if (this.credentialOutages > 0) {
        this.credentialOutages--;
        return err(503, "provider_unavailable", "GET /repos/x → 403: 10004 Access denied");
      }
      if (t.state !== "running") return err(409, "task_not_running");
      const ws = t.workspaces.find((w) => w.mountName === body.mountName);
      if (!ws) return err(404, "not_found", "mount not in this task");
      if (body.access === "write" && ws.access !== "write") return err(403, "read_only_mount");
      if (body.access === "write" && ws.state !== "writable") return err(409, "workspace_not_writable");
      const secret = `art_v1_${hex(20)}`;
      const tok: Token = { tokenId: `tok-${hex(6)}`, repoName: ws.repoName, namespace: NS_TASKS, scope: body.access === "write" ? "write" : "read", expiresAt: Math.min(this.now() + 3_600_000, t.lease!.expiresAt), revoked: false };
      this.tokens.set(secret, tok);
      return { status: 200, headers: { "cache-control": "no-store" }, body: { tokenId: tok.tokenId, secret, scope: tok.scope, expiresAt: new Date(tok.expiresAt).toISOString(), remoteUrl: this.remoteUrl(NS_TASKS, ws.repoName) } };
    }

    // GET /api/tasks/:id/assets/file (API.md "Agent asset reads"): the lease of exactly this task,
    // task running, a snapshot mount pinned to an asset manifest, a path in that manifest
    if ((m = /^\/api\/tasks\/([^/]+)\/assets\/file$/.exec(path)) && method === "GET") {
      const t = this.tasks.get(m[1]!);
      if (!t) return err(404, "not_found", "task not found");
      if (!req.auth) return err(401, "unauthenticated");
      if (this.#user(req)) return err(403, "lease_required");
      if (!this.#agentTask(req, t.taskId)) return err(404, "not_found", "task not found");
      if (t.state !== "running") return err(409, "task_not_running");
      const source = req.query.get("source") ?? "snapshot";
      if (source !== "snapshot" && source !== "workspace") return err(400, "invalid_request", "source");
      const entry = t.snapshot.entries.find((e) => e.mountName === req.query.get("mount"));
      if (!entry) return err(404, "not_found", "mount not in this task");
      if (!entry.revisionId.startsWith("r2m:")) return err(400, "not_assets");
      const r = this.resources.get(entry.resourceId)!;
      // the base fake has no asset workspaces (written asset mounts: apps/demo-agents/test/demo-fake.ts)
      if (source === "workspace") return err(404, "not_found", "no asset workspace for this mount");
      if (r.manifest!.manifestId !== entry.revisionId.slice(4)) return err(404, "not_found", "manifest not found");
      const p = req.query.get("path") ?? "";
      if (!p || p.startsWith("/") || p.split("/").some((s) => s === "" || s === "." || s === "..")) return err(400, "invalid_path");
      const e = r.manifest!.entries.find((x) => x.path === p);
      const bytes = r.objects!.get(p);
      if (!e || !bytes) return err(404, "not_found", "file not found");
      return { status: 200, headers: { "content-type": "application/octet-stream", "cache-control": "private, no-store", "x-commonforge-revision": entry.revisionId, "x-commonforge-sha256": e.sha256 }, raw: bytes };
    }

    if ((m = /^\/api\/tasks\/([^/]+)\/workspaces\/([^/]+)\/freeze$/.exec(path)) && method === "POST") {
      const t = this.tasks.get(m[1]!);
      if (!t) return err(404, "not_found");
      const user = this.#user(req);
      const agent = this.#agentTask(req, t.taskId);
      if (!agent && !user) return err(401, "unauthenticated");
      if (!agent && (t.lease?.holder !== user!.userId || t.lease.expiresAt <= this.now())) return err(403, "not_task_assignee");
      const ws = t.workspaces.find((w) => w.taskWorkspaceId === m![2]);
      if (!ws) return err(404, "not_found", "workspace not found");
      if (ws.access !== "write") return err(409, "workspace_read_only");
      if (ws.state !== "writable") return err(409, "workspace_not_writable");
      const head = this.taskRepoHead(ws);
      if (head !== body.expectedSha) return err(409, "candidate_moved", `HEAD is ${head}`);
      this.#revokeWrites(t, ws);
      ws.state = "frozen";
      const changedPaths = git(["--git-dir", this.repoPath(NS_TASKS, ws.repoName), "diff", "--name-only", ws.baseSha, head!], this.root).split("\n").filter(Boolean);
      const cand = { candidateId: `cand:${ws.taskWorkspaceId}:${head}`, resourceId: ws.resourceId, taskWorkspaceId: ws.taskWorkspaceId, state: "frozen", preparedReceiptId: null, sha: head!, changedPaths };
      t.candidates.push(cand);
      if (t.workspaces.every((w) => w.access === "read" || w.state === "frozen")) t.state = "submitted";
      return { status: 201, body: { ...cand, baseRevision: `local:${ws.resourceId}:${ws.baseSha}`, treeId: "0".repeat(40), frozenAt: new Date(this.now()).toISOString(), tool: body.tool } };
    }

    if ((m = /^\/api\/tasks\/([^/]+)\/materialization$/.exec(path)) && method === "GET") {
      const t = this.tasks.get(m[1]!);
      if (!t || (!this.#user(req) && !this.#agentTask(req, t.taskId))) return err(404, "not_found");
      const root = req.query.get("root");
      if (!root?.startsWith("/")) return err(400, "invalid_request", "root must be absolute");
      return { status: 200, body: this.#plan(t, root) };
    }

    if ((m = /^\/api\/tasks\/([^/]+)$/.exec(path)) && method === "GET") {
      const t = this.tasks.get(m[1]!);
      const user = this.#user(req);
      const agent = t ? this.#agentTask(req, t.taskId) : null;
      if (!t || (!user && !agent)) return err(404, "not_found");
      if (t.state === "provisioning" && --t.provisioningPolls <= 0) {
        t.state = "ready";
        for (const w of t.workspaces) w.state = "writable";
      }
      return { status: 200, body: this.#presentTask(t, !!agent || t.lease?.holder === user?.userId) };
    }

    // ---- user routes
    const user = this.#user(req);
    if (!user) return req.auth?.startsWith("cfl_") ? err(403, "agent_not_allowed") : err(401, "unauthenticated");

    if ((m = /^\/api\/tasks\/([^/]+)\/lease$/.exec(path))) {
      const t = this.tasks.get(m[1]!);
      if (!t) return err(404, "not_found");
      if (method === "POST") {
        const ttl = body.ttlSeconds === undefined ? 3600 : body.ttlSeconds;
        if (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl < 300 || ttl > 28_800) return err(400, "invalid_request", "ttlSeconds must be 300..28800");
        if (t.state !== "ready" && t.state !== "running") return err(409, "task_not_ready", `task is ${t.state}`);
        const owner = this.memberships.some((x) => x.orgId === ORG && x.role === "owner");
        if (t.lease && t.lease.expiresAt > this.now() && t.lease.holder !== user.userId && !owner) return err(409, "lease_held");
        t.generation += 1;
        t.lease = { token: `cfl_${hex(24)}`, generation: t.generation, expiresAt: this.now() + ttl * 1000, holder: user.userId };
        t.state = "running";
        this.#revokeWrites(t);
        return { status: 200, headers: { "cache-control": "no-store" }, body: { taskId: t.taskId, leaseToken: t.lease.token, leaseGeneration: t.generation, expiresAt: new Date(t.lease.expiresAt).toISOString() } };
      }
      if (method === "DELETE") {
        const owner = this.memberships.some((x) => x.orgId === ORG && x.role === "owner");
        if (t.lease?.holder !== user.userId && !owner) return err(403, "not_task_assignee");
        t.lease = null;
        t.generation += 1;
        this.#revokeWrites(t);
        return { status: 200, body: { ok: true } };
      }
    }

    if (method === "GET" && path === "/api/me") return { status: 200, body: { user, memberships: this.memberships } };
    if ((m = /^\/api\/orgs\/([^/]+)\/(.*)$/.exec(path))) {
      if (!this.memberships.some((x) => x.orgId === m![1])) return err(404, "not_found");
      const rest = m[2]!;
      if (method === "GET" && rest === "projects") return { status: 200, body: { projects: [{ projectId: PROJECT, name: "Customer Portal", createdAt: "2026-10-06T00:00:00.000Z" }] } };
      if (method === "GET" && rest === `projects/${PROJECT}`) {
        return {
          status: 200,
          body: {
            projectId: PROJECT,
            name: "Customer Portal",
            membershipRevision: 1,
            policyRevision: 1,
            mounts: [...this.resources.values()].map((r) => ({ mountName: r.mountName, resourceId: r.resourceId, provider: r.provider, resourceName: r.name, mode: "must-match-accepted", operations: r.writable ? ["read", "write"] : ["read"] })),
          },
        };
      }
      if (rest === `projects/${PROJECT}/tasks`) {
        if (method === "GET") return { status: 200, body: { tasks: [...this.tasks.values()].map((t) => ({ taskId: t.taskId, title: t.title, state: t.state, changeId: "chg-x", createdAt: "2026-10-06T00:00:00.000Z" })) } };
        if (method === "POST") {
          const t = this.createTask(String(body.title), (body.writeMounts as string[] | undefined) ?? this.defaultWriteMounts, String(body.request ?? ""), 2);
          return { status: 201, body: this.#presentTask(t, false) };
        }
      }
      if (method === "GET" && rest === `projects/${PROJECT}/file`) {
        const r = [...this.resources.values()].find((x) => x.mountName === req.query.get("mount"));
        if (!r) return err(404, "not_found", "mount not found");
        if (r.provider !== "r2-assets") return err(400, "not_assets");
        if (req.query.get("revision") !== `r2m:${r.manifest!.manifestId}`) return err(404, "not_found", "revision");
        const bytes = r.objects!.get(req.query.get("path") ?? "");
        if (!bytes) return err(404, "not_found", "path");
        const e = r.manifest!.entries.find((x) => x.path === req.query.get("path"))!;
        return { status: 200, headers: { "content-type": "application/octet-stream", "x-commonforge-sha256": e.sha256 }, raw: bytes };
      }
      if (method === "POST" && rest === `projects/${PROJECT}/exports`) return this.#createExport();
      let e: RegExpExecArray | null;
      if (method === "GET" && (e = /^exports\/([^/]+)$/.exec(rest))) {
        const x = this.exports.get(e[1]!);
        if (!x) return err(404, "not_found");
        x.polls += 1;
        const done = x.polls > 1;
        const receipt = x.receipt as { items: Array<{ r2Key: string }> };
        return {
          status: 200,
          body: { exportId: x.exportId, projectId: PROJECT, state: done ? "succeeded" : "queued", snapshot: x.snapshot, receipt: done ? receipt : null, downloads: done ? receipt.items.map((i) => `/api/orgs/${ORG}/exports/${x.exportId}/download?key=${encodeURIComponent(i.r2Key)}`) : [] },
        };
      }
      if (method === "GET" && (e = /^exports\/([^/]+)\/download$/.exec(rest))) {
        const x = this.exports.get(e[1]!);
        const bytes = x?.blobs.get(req.query.get("key") ?? "");
        if (!bytes) return err(404, "not_found");
        return { status: 200, headers: { "content-type": "application/octet-stream" }, raw: bytes };
      }
    }
    return err(404, "not_found", `${method} ${path}`);
  }

  #createExport(): Reply {
    const exportId = `exp-${hex(8)}`;
    const blobs = new Map<string, Uint8Array>();
    const items: unknown[] = [];
    for (const r of this.resources.values()) {
      if (r.provider === "r2-assets") {
        const m = r.manifest!;
        const r2Key = `org/${ORG}/exports/${exportId}/${r.resourceId}/manifest-${m.manifestId}.json`;
        blobs.set(r2Key, new TextEncoder().encode(JSON.stringify(m)));
        items.push({ resourceId: r.resourceId, kind: "asset-manifest", r2Key, manifestId: m.manifestId, objects: m.entries.length, bytes: m.entries.reduce((a, e) => a + e.size, 0) });
        continue;
      }
      const file = join(this.root, `${exportId}-${r.resourceId}.bundle`);
      git(["--git-dir", this.repoPath(NS_CANONICAL, r.resourceId), "bundle", "create", "-q", file, "HEAD", "refs/heads/main"], this.root);
      const bytes = new Uint8Array(readFileSync(file));
      const r2Key = `org/${ORG}/exports/${exportId}/${r.resourceId}/${this.canonicalHead(r.resourceId)}.bundle`;
      blobs.set(r2Key, bytes);
      items.push({ resourceId: r.resourceId, kind: "git-bundle", r2Key, sha256: createHash("sha256").update(bytes).digest("hex"), headSha: this.canonicalHead(r.resourceId), historyMode: "full" });
    }
    const structureKey = `org/${ORG}/exports/${exportId}/project.json`;
    blobs.set(structureKey, new TextEncoder().encode(JSON.stringify({ projectId: PROJECT })));
    items.push({ kind: "project-structure", r2Key: structureKey });
    const t = this.createSnapshotOnly();
    const receipt = { exportId, snapshotId: t.snapshotId, items, createdAt: new Date(this.now()).toISOString() };
    this.exports.set(exportId, { exportId, polls: 0, receipt, blobs, snapshot: t });
    return { status: 202, body: { exportId, snapshotId: t.snapshotId, jobId: `job-${hex(12)}`, state: "queued" } };
  }

  createSnapshotOnly(): ProjectSnapshot {
    const entries = [...this.resources.values()].map((r) => ({ resourceId: r.resourceId, revisionId: this.revisionOf(r), mode: "must-match-accepted" as const, mountName: r.mountName, operations: ["read"] }));
    const base = { projectId: PROJECT, organizationId: ORG, membershipRevision: 1, policyRevision: 1, entries };
    return { ...base, snapshotId: computeSnapshotIdSync(base as never), createdAt: new Date(this.now()).toISOString() } as unknown as ProjectSnapshot;
  }

  // ------------------------------------------------------------------------------- HTTP

  /** Serve the API and the git front on 127.0.0.1; remotes become http URLs from now on. */
  async listen(): Promise<string> {
    this.server = createServer((req, res) => {
      void this.#serve(req, res).catch((e) => {
        res.statusCode = 500;
        res.end(String(e));
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const addr = this.server.address();
    if (!addr || typeof addr === "string") throw new Error("no address");
    this.baseUrl = `http://127.0.0.1:${addr.port}`;
    this.httpGit = true;
    return this.baseUrl;
  }

  async #serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.baseUrl);
    if (url.pathname.startsWith("/git/")) return this.#serveGit(req, res, url);
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const r = await this.handle(req.method ?? "GET", url, req.headers.authorization ?? null, chunks.length ? Buffer.concat(chunks).toString("utf8") : null);
    res.statusCode = r.status;
    for (const [k, v] of Object.entries(r.headers ?? {})) res.setHeader(k, v);
    if (r.raw) res.end(Buffer.from(r.raw));
    else if (r.body !== undefined) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(r.body));
    } else res.end();
  }

  async #serveGit(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const m = /^\/git\/([^/]+)\/([^/]+)\.git(\/.*)$/.exec(url.pathname);
    const record = (status: number, username: string | null, password: string | null, repo = "", service = "") => this.gitRequests.push({ repo, service, username, password, status });
    if (!m) {
      record(404, null, null);
      res.statusCode = 404;
      return void res.end();
    }
    const [, namespace, repoName, rest] = m;
    const service = url.searchParams.get("service") ?? rest!.slice(1);
    const write = service === "git-receive-pack";
    let username: string | null = null;
    let password: string | null = null;
    const a = req.headers.authorization;
    if (a?.startsWith("Basic ")) {
      const dec = Buffer.from(a.slice(6), "base64").toString("utf8");
      const i = dec.indexOf(":");
      username = dec.slice(0, i);
      password = dec.slice(i + 1);
    } else if (a?.startsWith("Bearer ")) password = a.slice(7);
    const tok = password ? this.tokens.get(password) : undefined;
    const ok = tok && !tok.revoked && tok.expiresAt > this.now() && tok.namespace === namespace && tok.repoName === repoName && (!write || tok.scope === "write");
    if (!ok) {
      record(401, username, password, `${namespace}/${repoName}`, service);
      res.statusCode = 401;
      res.setHeader("www-authenticate", 'Basic realm="commonforge"');
      return void res.end("authentication required");
    }
    if (write && req.method === "POST" && this.busyPushes > 0) {
      this.busyPushes -= 1;
      record(503, username, password, `${namespace}/${repoName}`, service);
      res.statusCode = 503;
      return void res.end("artifacts_git_receive_pack_busy");
    }
    record(200, username, password, `${namespace}/${repoName}`, service);
    const cgi = spawn("git", ["http-backend"], {
      env: {
        ...cleanGitEnv(),
        GIT_PROJECT_ROOT: this.repos,
        GIT_HTTP_EXPORT_ALL: "1",
        REMOTE_USER: "agent",
        REQUEST_METHOD: req.method ?? "GET",
        PATH_INFO: `/${namespace}/${repoName}.git${rest}`,
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: req.headers["content-type"] ?? "",
        ...(req.headers["content-encoding"] ? { HTTP_CONTENT_ENCODING: req.headers["content-encoding"] } : {}),
        ...(req.headers["git-protocol"] ? { GIT_PROTOCOL: String(req.headers["git-protocol"]) } : {}),
      },
      stdio: ["pipe", "pipe", "inherit"],
    });
    req.pipe(cgi.stdin);
    let buf = Buffer.alloc(0);
    let headersDone = false;
    cgi.stdout.on("data", (chunk: Buffer) => {
      if (headersDone) return void res.write(chunk);
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf("\r\n\r\n");
      if (idx < 0) return;
      headersDone = true;
      for (const line of buf.subarray(0, idx).toString("utf8").split("\r\n")) {
        const c = line.indexOf(":");
        const k = line.slice(0, c).trim();
        const v = line.slice(c + 1).trim();
        if (k.toLowerCase() === "status") res.statusCode = Number(v.split(" ")[0]);
        else res.setHeader(k, v);
      }
      res.write(buf.subarray(idx + 4));
    });
    await new Promise<void>((resolve) => cgi.on("close", () => resolve()));
    res.end();
  }
}
