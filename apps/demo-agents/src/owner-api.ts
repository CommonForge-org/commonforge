/**
 * The orchestrator's own API client (apps/worker/API.md). It acts as the project owner/developer
 * with the CLI session from `cforge login` (read from the owner's cforge config dir), and creates
 * tasks, takes leases, builds proposals, requests integration and reads the event log. The session
 * never leaves this process: agents get only their task's lease token.
 */
import { readFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { sleep } from "./proc.js";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** Same rule as the CLI: credentials over https, or plain http to loopback only. */
export function normalizeApiUrl(raw: string): string {
  const u = new URL(raw);
  const loopback = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i.test(u.hostname) || u.hostname.endsWith(".localhost");
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) throw new Error(`refusing to send credentials to ${u.origin}: use https (http only for localhost)`);
  return u.origin;
}

/** The owner's cforge config dir (`CFORGE_CONFIG_DIR`, else the CLI's per-OS default). */
export function ownerConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CFORGE_CONFIG_DIR) return env.CFORGE_CONFIG_DIR;
  const home = env.HOME || homedir();
  if (platform() === "darwin") return join(home, "Library", "Application Support", "commonforge");
  if (platform() === "win32") return join(env.APPDATA || join(home, "AppData", "Roaming"), "commonforge");
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "commonforge");
}

const SessionFile = z.object({ apiUrl: z.string(), sessionToken: z.string().startsWith("cfs_"), expiresAt: z.string() });

/** The session `cforge login` stored for `apiUrl`. */
export async function loadOwnerSession(configDir: string, apiUrl: string): Promise<string> {
  let raw: string;
  try {
    raw = await readFile(join(configDir, "session.json"), "utf8");
  } catch {
    throw new Error(`no cforge session in ${configDir}: run \`cforge login\` against ${apiUrl} first`);
  }
  const s = SessionFile.parse(JSON.parse(raw));
  if (normalizeApiUrl(s.apiUrl) !== normalizeApiUrl(apiUrl)) throw new Error(`the cforge session in ${configDir} is for ${s.apiUrl}, not ${apiUrl}`);
  if (Date.parse(s.expiresAt) <= Date.now()) throw new Error("the cforge session expired: run `cforge login`");
  return s.sessionToken;
}

export interface TaskView {
  taskId: string;
  changeId: string;
  state: string;
  lease: { generation: number; expiresAt: string } | null;
  workspaces: Array<{ taskWorkspaceId: string; mountName: string; resourceId: string; provider: string; access: string; state: string; error?: string }>;
  candidates?: Array<{ candidateId: string; resourceId: string; taskWorkspaceId: string; state: string; sha?: string; changedPaths: string[] }>;
}

export interface LeaseGrant {
  taskId: string;
  leaseToken: string;
  leaseGeneration: number;
  expiresAt: string;
}

export interface ApiEvent {
  seq: number;
  at: string;
  projectId: string | null;
  action: string;
  subject: { kind: string; id: string };
  actor: { kind: string; id?: string };
  detail?: Record<string, unknown>;
}

export interface ProposalView {
  proposalId: string;
  proposalHash: string;
  state: string;
  stale?: string[];
  integration: { jobId: string; checks: Array<{ checkId: string; result: string }>; contractChecks: Array<{ contractId: string; result: string }>; mergeOutcome: Array<{ resourceId: string; result: string; conflictPaths?: string[] }> } | null;
  candidates?: Array<{ candidateId: string; resourceId: string }>;
}

export class OwnerApi {
  readonly apiUrl: string;
  constructor(
    apiUrl: string,
    private readonly bearer: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {
    this.apiUrl = normalizeApiUrl(apiUrl);
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.apiUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.bearer}`, accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      redirect: "error",
    });
    if (!res.ok) {
      let e: { error?: { code?: string; message?: string; details?: Record<string, unknown> } } = {};
      try {
        e = (await res.json()) as typeof e;
      } catch {
        /* not JSON */
      }
      throw new ApiError(res.status, e.error?.code ?? `http_${res.status}`, `${method} ${path}: ${e.error?.message ?? `HTTP ${res.status}`}`, e.error?.details);
    }
    return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
  }

  /** Raw bytes (the edition ZIP download). */
  async download(path: string): Promise<Uint8Array> {
    const res = await this.fetchImpl(`${this.apiUrl}${path}`, { headers: { authorization: `Bearer ${this.bearer}` }, redirect: "error" });
    if (!res.ok) throw await toApiError(res, "GET", path);
    return new Uint8Array(await res.arrayBuffer());
  }

  /** A raw-body POST (the edition return ZIP); answers JSON. */
  async upload<T>(path: string, bytes: Uint8Array, contentType: string): Promise<T> {
    const res = await this.fetchImpl(`${this.apiUrl}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.bearer}`, accept: "application/json", "content-type": contentType, "content-length": String(bytes.length) },
      body: bytes,
      redirect: "error",
    });
    if (!res.ok) throw await toApiError(res, "POST", path);
    return (await res.json()) as T;
  }

  createTask(org: string, projectId: string, body: { title: string; request: string; writeMounts: string[]; readMounts: string[] }): Promise<TaskView> {
    return this.request("POST", `/api/orgs/${enc(org)}/projects/${enc(projectId)}/tasks`, body);
  }

  task(taskId: string): Promise<TaskView> {
    return this.request("GET", `/api/tasks/${enc(taskId)}`);
  }

  /** Poll until the server has provisioned the task's workspaces. */
  async waitReady(taskId: string, timeoutMs: number, pollMs = 1000): Promise<TaskView> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const t = await this.task(taskId);
      if (t.state === "ready" || t.state === "running") return t;
      if (t.state !== "provisioning") throw new Error(`task ${taskId} is ${t.state}: ${t.workspaces.map((w) => w.error).filter(Boolean).join("; ")}`);
      if (Date.now() > deadline) throw new Error(`task ${taskId} still provisioning after ${timeoutMs} ms`);
      await sleep(pollMs);
    }
  }

  /** Take the task lease (records `task.started`); the token is handed to exactly one agent. */
  lease(taskId: string, ttlSeconds: number): Promise<LeaseGrant> {
    return this.request("POST", `/api/tasks/${enc(taskId)}/lease`, { ttlSeconds });
  }

  releaseLease(taskId: string): Promise<unknown> {
    return this.request("DELETE", `/api/tasks/${enc(taskId)}/lease`);
  }

  createProposal(org: string, taskId: string): Promise<ProposalView> {
    return this.request("POST", `/api/orgs/${enc(org)}/proposals`, { taskId });
  }

  proposal(org: string, proposalId: string): Promise<ProposalView> {
    return this.request("GET", `/api/orgs/${enc(org)}/proposals/${enc(proposalId)}`);
  }

  integrate(org: string, proposalId: string): Promise<{ proposalId: string; jobId: string; state: string }> {
    return this.request("POST", `/api/orgs/${enc(org)}/proposals/${enc(proposalId)}/integrate`, {});
  }

  events(org: string, after: number, projectId?: string, limit = 500): Promise<{ events: ApiEvent[]; next: number }> {
    const q = new URLSearchParams({ after: String(after), limit: String(limit), ...(projectId ? { projectId } : {}) });
    return this.request("GET", `/api/orgs/${enc(org)}/events?${q}`);
  }

  /** Every event after `after` (paged). */
  async allEvents(org: string, after: number, projectId?: string): Promise<{ events: ApiEvent[]; next: number }> {
    const events: ApiEvent[] = [];
    let cursor = after;
    for (;;) {
      const page = await this.events(org, cursor, projectId);
      events.push(...page.events);
      // `next` is the last scanned seq, even when every row of the page was filtered out
      if (page.next <= cursor) return { events, next: cursor };
      cursor = page.next;
    }
  }
}

const enc = encodeURIComponent;

async function toApiError(res: Response, method: string, path: string): Promise<ApiError> {
  let e: { error?: { code?: string; message?: string; details?: Record<string, unknown> } } = {};
  try {
    e = (await res.json()) as typeof e;
  } catch {
    /* not JSON */
  }
  return new ApiError(res.status, e.error?.code ?? `http_${res.status}`, `${method} ${path}: ${e.error?.message ?? `HTTP ${res.status}`}`, e.error?.details);
}
