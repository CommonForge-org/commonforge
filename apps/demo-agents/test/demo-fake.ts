/**
 * The CLI's fake CommonForge (apps/cli/test/fake-commonforge.ts: real bare git repositories, a
 * token-checking smart-HTTP git front, leases, credentials, freeze) extended with the routes the
 * demo needs, following apps/worker/API.md:
 *
 * - task create honouring `readMounts`, with R2 asset write workspaces;
 * - `assets/stage` → `PUT assets/upload` → `assets/commit` and asset freeze (lease only);
 *   the task stays `running` until its git *and* asset workspaces are frozen (as the Worker);
 * - `GET /api/orgs/:org/events` with `task.started` / `task.candidate_frozen` / proposal events;
 * - proposals + integrate, where "integration" runs the `/quote` contract check on the proposal's
 *   candidate trees (base heads for resources without a candidate) — the trusted gate's stand-in;
 * - client editions (Task 21 shapes, apps/worker/API.md "Editions"): policy, build from the
 *   canonical website head through the read allowlist, grant, session, ZIP download, ZIP return
 *   (partial, write allowlist + protected paths) → proposal.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { FakeCommonForge, ORG, PROJECT, cleanGitEnv, type Reply, type RequestInfo } from "../../cli/test/fake-commonforge.js";
import { checkQuoteContract } from "../src/contract-check.js";
import { readZip, writeZip } from "../src/edition-zip.js";

export { ORG, PROJECT };

type Task = ReturnType<FakeCommonForge["createTask"]>;

interface AssetWorkspace {
  taskWorkspaceId: string;
  mountName: string;
  resourceId: string;
  baseManifestId: string;
  manifestId: string | null;
  state: "writable" | "frozen";
  entries: Map<string, { sha256: string; size: number; mime: string }>;
}

export interface FakeEvent {
  seq: number;
  at: string;
  projectId: string;
  action: string;
  subject: { kind: string; id: string };
  actor: { kind: string; id: string };
  detail?: Record<string, unknown>;
}

interface FakeProposal {
  proposalId: string;
  proposalHash: string;
  taskId: string;
  state: "prepared";
  candidates: Task["candidates"];
  integration: { jobId: string; forCurrentHash: boolean; integratedAt: string; checks: unknown[]; contractChecks: Array<{ contractId: string; result: string }>; mergeOutcome: unknown[] } | null;
}

const hex = (n: number) => randomBytes(n).toString("hex");
const err = (status: number, code: string, message = code): Reply => ({ status, body: { error: { code, message } } });
const NS_TASKS = "cf-o1-tasks";
const NS_CANONICAL = "cf-o1-canonical";

interface FakeEdition {
  editionId: string;
  name: string;
  policy: { sources: Array<{ mountName: string; include: string[]; write: string[] }>; protectedPaths: string[] };
  createdBy: string;
  builds: Array<{ buildId: string; state: "ready"; files: Map<string, Uint8Array> }>;
  grants: Set<string>;
}

export interface FakeEditionReturn {
  returnId: string;
  sessionId: string;
  userId: string;
  state: "proposed";
  mode: string;
  tool: string | null;
  changes: Array<{ path: string; kind: string }>;
  blocked: Array<{ path: string; reason: string }>;
  proposalId: string;
  taskId: string;
  /** the website as the candidate would have it */
  result: Map<string, Uint8Array>;
}

/** core `matchesPathPattern` subset: `dir/**`, `**`, or a path (itself and below). */
const matches = (path: string, pat: string) => pat === "**" || (pat.endsWith("/**") ? path.startsWith(pat.slice(0, -2)) : path === pat || path.startsWith(`${pat}/`));

export class DemoFake extends FakeCommonForge {
  readonly editions = new Map<string, FakeEdition>();
  readonly editionSessions = new Map<string, { sessionId: string; editionId: string; buildId: string; userId: string }>();
  readonly editionReturns = new Map<string, FakeEditionReturn>();
  readonly events: FakeEvent[] = [];
  readonly assetWorkspaces = new Map<string, AssetWorkspace[]>();
  readonly staged = new Map<string, Uint8Array>();
  readonly assetObjects = new Map<string, Uint8Array>();
  readonly proposals = new Map<string, FakeProposal>();
  /** tasks created through the API, with what was asked */
  readonly created: Array<{ taskId: string; writeMounts: string[]; readMounts: string[] }> = [];

  record(action: string, subject: { kind: string; id: string }, actor: { kind: string; id: string }, detail?: Record<string, unknown>): void {
    this.events.push({ seq: this.events.length + 1, at: new Date().toISOString(), projectId: PROJECT, action, subject, actor, ...(detail ? { detail } : {}) });
  }

  #userId(req: RequestInfo): string | null {
    if (!req.auth?.startsWith("cfs_")) return null;
    const s = this.sessions.get(req.auth);
    return s && s.expiresAt > Date.now() ? s.userId : null;
  }

  #agentTask(req: RequestInfo, taskId: string): Task | null {
    const t = this.tasks.get(taskId);
    return t?.lease && req.auth?.startsWith("cfl_") && t.lease.token === req.auth && t.lease.expiresAt > Date.now() ? t : null;
  }

  /** A task whose snapshot holds only `writeMounts` + `readMounts` (the base fake mounts everything). */
  createScopedTask(title: string, writeMounts: string[], readMounts: string[], request: string): Task {
    const keep = new Set([...writeMounts, ...readMounts]);
    const saved = [...this.resources.entries()];
    for (const [id, r] of saved) if (!keep.has(r.mountName)) this.resources.delete(id);
    let t: Task;
    try {
      const gitWrites = [...this.resources.values()].some((r) => r.provider === "artifacts");
      t = this.createTask(title, writeMounts, request, gitWrites ? 2 : 0);
    } finally {
      this.resources.clear();
      for (const [id, r] of saved) this.resources.set(id, r);
    }
    const assets: AssetWorkspace[] = [];
    for (const r of this.resources.values()) {
      if (r.provider !== "r2-assets" || !writeMounts.includes(r.mountName)) continue;
      const entries = new Map(r.manifest!.entries.map((e) => [e.path as string, { sha256: e.sha256 as string, size: e.size as number, mime: e.mime as string }]));
      assets.push({ taskWorkspaceId: `tw-${hex(12)}`, mountName: r.mountName, resourceId: r.resourceId, baseManifestId: r.manifest!.manifestId as string, manifestId: null, state: "writable", entries });
    }
    this.assetWorkspaces.set(t.taskId, assets);
    this.created.push({ taskId: t.taskId, writeMounts, readMounts });
    return t;
  }

  #allWritesFrozen(t: Task): boolean {
    return t.workspaces.every((w) => w.access === "read" || w.state === "frozen") && (this.assetWorkspaces.get(t.taskId) ?? []).every((w) => w.state === "frozen");
  }

  override async route(req: RequestInfo): Promise<Reply> {
    const { method, path } = req;
    const body = (req.body ?? {}) as Record<string, unknown>;
    let m: RegExpExecArray | null;

    if (/^\/api\/orgs\/[^/]+\/(projects\/[^/]+\/editions|editions|edition-sessions|edition-returns)(\/.*)?$/.test(path)) {
      const userId = this.#userId(req);
      return userId ? this.#editions(req, userId) : err(401, "unauthenticated");
    }

    if (method === "POST" && (m = /^\/api\/orgs\/([^/]+)\/projects\/([^/]+)\/tasks$/.exec(path))) {
      if (!this.#userId(req)) return err(401, "unauthenticated");
      if (m[1] !== ORG || m[2] !== PROJECT) return err(404, "not_found");
      const writeMounts = body.writeMounts as string[];
      const readMounts = (body.readMounts as string[] | undefined) ?? [...this.resources.values()].map((r) => r.mountName).filter((n) => !writeMounts.includes(n));
      const t = this.createScopedTask(String(body.title), writeMounts, readMounts, String(body.request ?? ""));
      this.record("task.created", { kind: "task", id: t.taskId }, { kind: "user", id: this.#userId(req)! }, { writeMounts });
      return { status: 201, body: { taskId: t.taskId, state: t.state, changeId: `chg-${t.taskId.slice(5)}`, workspaces: [] } };
    }

    if (method === "GET" && (m = /^\/api\/orgs\/([^/]+)\/events$/.exec(path))) {
      if (!this.#userId(req)) return err(401, "unauthenticated");
      const after = Number(req.query.get("after") ?? 0);
      const limit = Number(req.query.get("limit") ?? 100);
      const page = this.events.filter((e) => e.seq > after).slice(0, limit);
      return { status: 200, body: { events: page, next: page.length ? page[page.length - 1]!.seq : after } };
    }

    // ---- R2 asset workspace (agent routes: lease only)
    if (method === "POST" && (m = /^\/api\/tasks\/([^/]+)\/assets\/(stage|commit)$/.exec(path))) {
      const t = this.#agentTask(req, m[1]!);
      if (!t) return this.#userId(req) ? err(403, "lease_required") : err(401, "unauthenticated");
      if (t.state !== "running") return err(409, "task_not_running");
      const ws = this.assetWorkspaces.get(t.taskId)?.find((w) => w.mountName === body.mountName);
      if (!ws) return err(404, "not_found", "no asset workspace for this mount");
      if (ws.state !== "writable") return err(409, "workspace_not_writable");
      if (m[2] === "stage") {
        const stagingKey = `org/${ORG}/staging/${ws.taskWorkspaceId}/${hex(8)}`;
        return { status: 200, body: { stagingKey, uploadUrl: `/api/tasks/${t.taskId}/assets/upload?key=${encodeURIComponent(stagingKey)}` } };
      }
      for (const ch of body.changes as Array<{ path: string; stagingKey: string; sha256: string; mime: string }>) {
        const bytes = this.staged.get(ch.stagingKey);
        if (!bytes || !ch.stagingKey.startsWith(`org/${ORG}/staging/${ws.taskWorkspaceId}/`)) return err(403, "scope_violation");
        const sha = createHash("sha256").update(bytes).digest("hex");
        if (sha !== ch.sha256) return err(400, "asset_sha256_mismatch");
        this.assetObjects.set(sha, bytes);
        ws.entries.set(ch.path, { sha256: sha, size: bytes.length, mime: ch.mime });
      }
      const parentManifestId = ws.manifestId ?? ws.baseManifestId;
      ws.manifestId = `am_${createHash("sha256").update(JSON.stringify([...ws.entries.entries()].sort())).digest("hex").slice(0, 32)}`;
      this.record("assets.committed", { kind: "workspace", id: ws.taskWorkspaceId }, { kind: "agent", id: t.taskId }, { manifestId: ws.manifestId });
      return { status: 200, body: { taskWorkspaceId: ws.taskWorkspaceId, manifestId: ws.manifestId, parentManifestId, entries: ws.entries.size } };
    }

    if (method === "POST" && (m = /^\/api\/tasks\/([^/]+)\/workspaces\/([^/]+)\/freeze$/.exec(path))) {
      const ws = this.assetWorkspaces.get(m[1]!)?.find((w) => w.taskWorkspaceId === m![2]);
      if (ws) {
        const t = this.#agentTask(req, m[1]!);
        if (!t) return err(401, "unauthenticated");
        if (!ws.manifestId) return err(409, "nothing_to_freeze", "commit asset changes first");
        if (ws.state !== "writable") return err(409, "workspace_not_writable");
        ws.state = "frozen";
        this.record("task.candidate_frozen", { kind: "workspace", id: ws.taskWorkspaceId }, { kind: "agent", id: t.taskId }, { taskId: t.taskId, manifestId: ws.manifestId });
        if (this.#allWritesFrozen(t)) t.state = "submitted";
        return { status: 200, body: { taskWorkspaceId: ws.taskWorkspaceId, state: "frozen", manifestId: ws.manifestId } };
      }
    }

    // ---- proposals and (stand-in) integration
    if (method === "POST" && path === `/api/orgs/${ORG}/proposals`) {
      if (!this.#userId(req)) return err(401, "unauthenticated");
      const t = this.tasks.get(String(body.taskId));
      if (!t) return err(404, "not_found");
      const latest = new Map<string, Task["candidates"][number]>();
      for (const c of t.candidates) latest.set(c.resourceId, c);
      if (latest.size === 0) return err(409, "no_candidates");
      const p: FakeProposal = { proposalId: `prop-${hex(8)}`, proposalHash: `ph_${hex(16)}`, taskId: t.taskId, state: "prepared", candidates: [...latest.values()], integration: null };
      this.proposals.set(p.proposalId, p);
      this.record("proposal.created", { kind: "proposal", id: p.proposalId }, { kind: "user", id: this.#userId(req)! });
      return { status: 201, body: p };
    }
    if ((m = new RegExp(`^/api/orgs/${ORG}/proposals/([^/]+)(/integrate)?$`).exec(path))) {
      if (!this.#userId(req)) return err(401, "unauthenticated");
      const p = this.proposals.get(m[1]!);
      if (!p) return err(404, "not_found");
      if (method === "GET" && !m[2]) return { status: 200, body: { ...p, stale: [] } };
      if (method === "POST" && m[2]) return this.#integrate(p);
    }

    const r = await super.route(req);

    if (method === "POST" && r.status === 200 && (m = /^\/api\/tasks\/([^/]+)\/lease$/.exec(path))) {
      this.record("task.started", { kind: "task", id: m[1]! }, { kind: "user", id: this.#userId(req) ?? "?" }, { leaseGeneration: (r.body as { leaseGeneration: number }).leaseGeneration });
    }
    if (method === "POST" && r.status === 201 && (m = /^\/api\/tasks\/([^/]+)\/workspaces\/[^/]+\/freeze$/.exec(path))) {
      // as the Worker's refreshTaskState: submitted only once every written workspace (git and R2) is frozen
      const t = this.tasks.get(m[1]!)!;
      if (t.state === "submitted" && !this.#allWritesFrozen(t)) t.state = "running";
      const c = r.body as { candidateId: string; sha: string; changedPaths: string[] };
      this.record("task.candidate_frozen", { kind: "candidate", id: c.candidateId }, { kind: "agent", id: m[1]! }, { taskId: m[1]!, sha: c.sha, changedPaths: c.changedPaths.length });
    }
    if (method === "GET" && r.status === 200 && (m = /^\/api\/tasks\/([^/]+)$/.exec(path))) {
      const b = r.body as { workspaces: unknown[] };
      for (const w of this.assetWorkspaces.get(m[1]!) ?? []) {
        b.workspaces.push({ taskWorkspaceId: w.taskWorkspaceId, mountName: w.mountName, resourceId: w.resourceId, provider: "r2-assets", access: "write", baseRevision: `r2m:${w.baseManifestId}`, state: w.state, ...(w.manifestId ? { assetManifestId: w.manifestId } : {}) });
      }
    }
    return r;
  }

  #editionView(e: FakeEdition, developer: boolean) {
    return { editionId: e.editionId, projectId: PROJECT, name: e.name, state: e.builds.length ? "ready" : "draft", ready: e.builds.length > 0, ...(developer ? { policy: e.policy, builds: [...e.builds].reverse().map((b) => ({ buildId: b.buildId, state: b.state, sourceReleaseId: null })) } : {}) };
  }

  async #editions(req: RequestInfo, userId: string): Promise<Reply> {
    const { method, path } = req;
    const body = (req.body ?? {}) as Record<string, unknown>;
    let m: RegExpExecArray | null;
    const owner = (e: FakeEdition) => e.createdBy === userId;
    if (path === `/api/orgs/${ORG}/projects/${PROJECT}/editions`) {
      if (method === "GET") return { status: 200, body: { editions: [...this.editions.values()].filter((e) => owner(e) || e.grants.has(userId)).map((e) => this.#editionView(e, owner(e))) } };
      if (method === "POST") {
        const e: FakeEdition = { editionId: `edn-${hex(8)}`, name: String(body.name), policy: body as unknown as FakeEdition["policy"], createdBy: userId, builds: [], grants: new Set() };
        this.editions.set(e.editionId, e);
        return { status: 201, body: this.#editionView(e, true) };
      }
    }
    if ((m = new RegExp(`^/api/orgs/${ORG}/editions/([^/]+)(/builds|/grants|/sessions)?$`).exec(path))) {
      const e = this.editions.get(m[1]!);
      if (!e || (!owner(e) && !e.grants.has(userId))) return err(404, "not_found");
      if (method === "GET" && !m[2]) return { status: 200, body: this.#editionView(e, owner(e)) };
      if (method === "POST" && m[2] === "/builds") {
        if (!owner(e)) return err(403, "insufficient_role");
        const src = e.policy.sources[0]!;
        const r = [...this.resources.values()].find((x) => x.mountName === src.mountName)!;
        const gitDir = this.repoPath(NS_CANONICAL, r.resourceId);
        const head = this.canonicalHead(r.resourceId);
        const files = new Map<string, Uint8Array>();
        for (const f of execFileSync("git", ["--git-dir", gitDir, "ls-tree", "-r", "--name-only", head], { env: cleanGitEnv(), encoding: "utf8" }).split("\n").filter(Boolean)) {
          if (!src.include.some((p) => matches(f, p)) || /(^|\/)\.env/.test(f)) continue;
          files.set(f, new Uint8Array(execFileSync("git", ["--git-dir", gitDir, "show", `${head}:${f}`], { env: cleanGitEnv() })));
        }
        const buildId = `edb-${hex(8)}`;
        e.builds.push({ buildId, state: "ready", files });
        return { status: 202, body: { editionId: e.editionId, buildId, state: "queued", sourceReleaseId: null } };
      }
      if (method === "PUT" && m[2] === "/grants") {
        if (!owner(e)) return err(403, "insufficient_role");
        e.grants.add(String(body.userId));
        return { status: 201, body: { editionId: e.editionId, userId: body.userId } };
      }
      if (method === "POST" && m[2] === "/sessions") {
        if (!e.builds.length) return err(409, "edition_not_ready");
        const sessionId = `eds-${hex(8)}`;
        this.editionSessions.set(sessionId, { sessionId, editionId: e.editionId, buildId: e.builds[e.builds.length - 1]!.buildId, userId });
        return { status: 201, body: { sessionId, editionId: e.editionId, title: body.title, downloadUrl: `/api/orgs/${ORG}/edition-sessions/${sessionId}/download`, returnUrl: `/api/orgs/${ORG}/edition-sessions/${sessionId}/returns`, returns: [] } };
      }
    }
    if (method === "GET" && (m = new RegExp(`^/api/orgs/${ORG}/edition-sessions/([^/]+)/download$`).exec(path))) {
      const s = this.editionSessions.get(m[1]!);
      if (!s || s.userId !== userId) return err(404, "not_found");
      const files = this.editions.get(s.editionId)!.builds.find((b) => b.buildId === s.buildId)!.files;
      return { status: 200, raw: Buffer.from(writeZip(files)), headers: { "content-type": "application/zip" } } as Reply;
    }
    if (method === "GET" && (m = new RegExp(`^/api/orgs/${ORG}/edition-returns/([^/]+)$`).exec(path))) {
      const r = this.editionReturns.get(m[1]!);
      if (!r) return err(404, "not_found");
      const e = this.editions.get(this.editionSessions.get(r.sessionId)!.editionId)!;
      if (r.userId !== userId && !owner(e)) return err(404, "not_found");
      const { result: _r, taskId, userId: _u, ...view } = r;
      return { status: 200, body: { ...view, ...(owner(e) ? { taskId } : {}) } };
    }
    return err(404, "not_found");
  }

  /** `POST …/edition-sessions/:sid/returns` (raw ZIP): partial/full diff against the build, write allowlist, protected paths. */
  #editionReturn(info: RequestInfo, bytes: Uint8Array): Reply {
    const userId = this.#userId(info);
    if (!userId) return err(401, "unauthenticated");
    const sid = /edition-sessions\/([^/]+)\/returns$/.exec(info.path)?.[1];
    const s = sid ? this.editionSessions.get(sid) : undefined;
    if (!s || s.userId !== userId) return err(404, "not_found");
    const e = this.editions.get(s.editionId)!;
    const base = e.builds.find((b) => b.buildId === s.buildId)!.files;
    let returned: Map<string, Uint8Array>;
    try {
      returned = readZip(bytes);
    } catch (x) {
      return err(400, "zip_refused", String(x));
    }
    const mode = info.query.get("mode") ?? "partial";
    const deletions = info.query.getAll("delete");
    const src = e.policy.sources[0]!;
    const changes: FakeEditionReturn["changes"] = [];
    const blocked: FakeEditionReturn["blocked"] = [];
    const result = new Map(base);
    const allowed = (p: string) => (e.policy.protectedPaths.some((x) => matches(p, x)) ? "protected" : src.write.some((w) => matches(p, w)) ? null : "read_only");
    const touch = (path: string, kind: string, data?: Uint8Array) => {
      const why = allowed(path);
      if (why) return blocked.push({ path, reason: why });
      changes.push({ path, kind });
      if (data) result.set(path, data);
      else result.delete(path);
    };
    for (const [path, data] of returned) {
      const before = base.get(path);
      if (before && Buffer.compare(Buffer.from(before), Buffer.from(data)) === 0) continue;
      touch(path, before ? "modified" : "added", data);
    }
    const gone = mode === "full" ? [...base.keys()].filter((p) => !returned.has(p)) : deletions.filter((p) => base.has(p));
    for (const p of gone) touch(p, "deleted");
    changes.sort((a, b) => (a.path < b.path ? -1 : 1));
    if (!changes.length) return { status: 409, body: { error: { code: "no_allowed_changes", message: "nothing to return", details: { blocked } } } };
    const r: FakeEditionReturn = { returnId: `edr-${hex(8)}`, sessionId: s.sessionId, userId, state: "proposed", mode, tool: info.query.get("tool"), changes, blocked, proposalId: `prop-${hex(8)}`, taskId: `task-${hex(8)}`, result };
    this.editionReturns.set(r.returnId, r);
    this.record("edition.returned", { kind: "edition", id: e.editionId }, { kind: "user", id: userId }, { returnId: r.returnId, changed: changes.length });
    const { result: _r, taskId: _t, userId: _u, ...view } = r;
    return { status: 202, body: { ...view, state: "queued" } };
  }

  /** Check out website/api/requirements at the proposal's candidates (else the canonical heads) and run the contract. */
  async #integrate(p: FakeProposal): Promise<Reply> {
    const jobId = `job-${hex(8)}`;
    const t = this.tasks.get(p.taskId)!;
    const dir = mkdtempSync(join(this.root, "integrate-"));
    try {
      for (const r of this.resources.values()) {
        if (r.provider !== "artifacts") continue;
        const cand = p.candidates.find((c) => c.resourceId === r.resourceId);
        const ws = cand && t.workspaces.find((w) => w.taskWorkspaceId === cand.taskWorkspaceId);
        const repo = ws ? this.repoPath(NS_TASKS, ws.repoName) : this.repoPath(NS_CANONICAL, r.resourceId);
        const sha = cand ? cand.sha : this.canonicalHead(r.resourceId);
        const tar = execFileSync("git", ["--git-dir", repo, "archive", "--format=tar", sha], { env: cleanGitEnv(), maxBuffer: 64 * 1024 * 1024 });
        mkdirSync(join(dir, r.mountName), { recursive: true });
        execFileSync("tar", ["-x", "-C", join(dir, r.mountName)], { input: tar });
      }
      const res = await checkQuoteContract(dir);
      if (res.result === "fail") {
        this.record("proposal.integration_failed", { kind: "proposal", id: p.proposalId }, { kind: "runner", id: "integration-runner" }, { jobId, code: "contract_failed", detail: `quote: ${res.detail}` });
      } else {
        p.integration = { jobId, forCurrentHash: true, integratedAt: new Date().toISOString(), checks: [], contractChecks: [{ contractId: res.contractId, result: res.result }], mergeOutcome: p.candidates.map((c) => ({ resourceId: c.resourceId, result: "clean" })) };
        this.record("proposal.integrated", { kind: "proposal", id: p.proposalId }, { kind: "runner", id: "integration-runner" }, { jobId, checks: [] });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    return { status: 202, body: { proposalId: p.proposalId, jobId, state: "queued" } };
  }

  /** Raw-byte asset uploads bypass the base server's JSON body parsing. */
  override async listen(): Promise<string> {
    const url = await super.listen();
    const server = this.server!;
    const [base] = server.listeners("request") as Array<(req: IncomingMessage, res: ServerResponse) => void>;
    server.removeAllListeners("request");
    server.on("request", (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === "PUT" && /^\/api\/tasks\/[^/]+\/assets\/upload\?/.test(req.url ?? "")) void this.#upload(req, res);
      else if (req.method === "POST" && /^\/api\/orgs\/[^/]+\/edition-sessions\/[^/]+\/returns(\?|$)/.test(req.url ?? "")) void this.#rawReturn(req, res);
      else base!.call(server, req, res);
    });
    return url;
  }

  async #rawReturn(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const url = new URL(req.url!, this.baseUrl);
    const auth = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : null;
    const info: RequestInfo = { method: "POST", path: url.pathname, query: url.searchParams, auth, body: undefined };
    this.calls.push(info);
    const r = this.#editionReturn(info, new Uint8Array(Buffer.concat(chunks)));
    res.statusCode = r.status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(r.body));
  }

  async #upload(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const url = new URL(req.url!, this.baseUrl);
    const taskId = /^\/api\/tasks\/([^/]+)\//.exec(url.pathname)![1]!;
    const auth = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : null;
    const info: RequestInfo = { method: "PUT", path: url.pathname, query: url.searchParams, auth, body: undefined };
    this.calls.push(info);
    const send = (r: Reply) => {
      res.statusCode = r.status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(r.body));
    };
    const t = this.#agentTask(info, taskId);
    if (!t) return send(err(401, "unauthenticated"));
    if (req.headers["content-length"] === undefined) return send(err(411, "length_required"));
    const key = url.searchParams.get("key") ?? "";
    if (!(this.assetWorkspaces.get(taskId) ?? []).some((w) => w.state === "writable" && key.startsWith(`org/${ORG}/staging/${w.taskWorkspaceId}/`))) return send(err(403, "scope_violation"));
    const bytes = new Uint8Array(Buffer.concat(chunks));
    this.staged.set(key, bytes);
    send({ status: 201, body: { stagingKey: key, size: bytes.length } });
  }
}
