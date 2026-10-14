/**
 * Worker API client (apps/worker/API.md). Two bearers:
 * - the CLI session (`cfs_…`, from `POST /api/auth/cli/verify`), for user routes;
 * - the task lease (`cfl_…`), for agent routes (`/api/tasks/<task>/credential`, freeze, …).
 * A bearer is only ever sent to the API origin it was issued by. The browser cookie is never used.
 */
import { CliError, rememberSecret, scrub, type CliIo } from "./context.js";
import type { ConfigStore, Lease, Session } from "./config.js";

export const DEFAULT_API_URL = "http://localhost:8787";

/** `localhost`, `127.0.0.0/8` or `[::1]`: the only hosts plain http is allowed for. */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h.endsWith(".localhost") || h === "::1" || /^127(?:\.\d{1,3}){3}$/.test(h);
}

/** A URL that may carry a credential: https anywhere, http only on loopback. */
export function isSecureEnough(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || (u.protocol === "http:" && isLoopbackHost(u.hostname));
  } catch {
    return false;
  }
}

export function normalizeApiUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new CliError("invalid_request", `invalid API URL ${JSON.stringify(raw)}`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new CliError("invalid_request", "the API URL must be http(s)");
  if (u.protocol === "http:" && !isLoopbackHost(u.hostname)) throw new CliError("insecure_url", `refusing to send credentials over plain http to ${u.host}; use https (http is only allowed for localhost)`);
  if (u.username || u.password) throw new CliError("invalid_request", "the API URL must not contain credentials");
  return u.origin;
}

export async function resolveApiUrl(io: CliIo, store: ConfigStore, flag?: string): Promise<string> {
  const raw = flag ?? (io.env.CFORGE_API_URL || undefined) ?? (await store.config()).apiUrl ?? (await store.session())?.apiUrl ?? DEFAULT_API_URL;
  return normalizeApiUrl(raw);
}

export interface ApiErrorBody {
  error?: { code?: string; message?: string; details?: Record<string, unknown> };
}

export interface ApiClientOptions {
  /** on 401 with this bearer, retry once with the client this returns (e.g. lease → session) */
  fallback?: () => Promise<ApiClient | null>;
}

export class ApiClient {
  constructor(
    readonly io: CliIo,
    readonly apiUrl: string,
    readonly bearer: string | null,
    readonly options: ApiClientOptions = {},
  ) {
    rememberSecret(bearer);
  }

  async request(method: string, path: string, body?: unknown, init: { accept?: string } = {}): Promise<Response> {
    try {
      return await this.#request(method, path, body, init);
    } catch (e) {
      if (!(e instanceof CliError) || e.details?.status !== 401 || !this.options.fallback) throw e;
      const other = await this.options.fallback();
      if (!other) throw e;
      return other.request(method, path, body, init);
    }
  }

  async #request(method: string, path: string, body?: unknown, init: { accept?: string } = {}): Promise<Response> {
    const headers: Record<string, string> = { accept: init.accept ?? "application/json" };
    if (this.bearer) headers.authorization = `Bearer ${this.bearer}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await this.io.fetch(`${this.apiUrl}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), redirect: "error" });
    } catch (e) {
      throw new CliError("network_error", scrub(`cannot reach ${this.apiUrl}: ${(e as Error).message}`));
    }
    if (!res.ok) {
      let parsed: ApiErrorBody = {};
      try {
        parsed = (await res.json()) as ApiErrorBody;
      } catch {
        /* non-JSON error */
      }
      const code = parsed.error?.code ?? `http_${res.status}`;
      throw new CliError(code, scrub(parsed.error?.message ?? `${method} ${path} failed with HTTP ${res.status}`), { status: res.status, ...(parsed.error?.details ?? {}) });
    }
    return res;
  }

  async json<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.request(method, path, body);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  get<T = unknown>(path: string): Promise<T> {
    return this.json<T>("GET", path);
  }

  post<T = unknown>(path: string, body: unknown = {}): Promise<T> {
    return this.json<T>("POST", path, body);
  }
}

/** Client with the stored CLI session; `login_required` when absent, expired or for another API. */
export async function sessionClient(io: CliIo, store: ConfigStore, apiFlag?: string): Promise<{ api: ApiClient; session: Session }> {
  const apiUrl = await resolveApiUrl(io, store, apiFlag);
  const session = await store.session();
  if (!session || normalizeApiUrl(session.apiUrl) !== apiUrl) throw new CliError("login_required", `not logged in to ${apiUrl}; run \`cforge login\``);
  if (Date.parse(session.expiresAt) <= io.now().getTime()) throw new CliError("login_required", "the CLI session expired; run `cforge login`");
  return { api: new ApiClient(io, apiUrl, session.sessionToken), session };
}

export interface LeaseBearer {
  token: string;
  source: "env" | "config";
  /** generation recorded with a stored lease */
  leaseGeneration?: number;
  /** expiry recorded with a stored lease (unknown for `CFORGE_LEASE_TOKEN`) */
  expiresAt?: string;
}

/**
 * The task lease bearer, only for the API origin it belongs to:
 * - `CFORGE_LEASE_TOKEN` (a lease handed to an agent) is bound to `CFORGE_LEASE_API_URL`, else to
 *   the origin of the stored CLI session; it is never sent anywhere else;
 * - otherwise the lease stored by `cforge checkout` / `cforge task lease` for this task and origin.
 * Returns null when there is none (or it expired).
 */
export async function leaseBearer(io: CliIo, store: ConfigStore, taskId: string, apiUrl: string): Promise<LeaseBearer | null> {
  const env = io.env.CFORGE_LEASE_TOKEN;
  if (env) {
    rememberSecret(env);
    const bound = io.env.CFORGE_LEASE_API_URL ?? (await store.session())?.apiUrl;
    if (!bound) throw new CliError("lease_origin_unknown", "CFORGE_LEASE_TOKEN is set but not bound to an API: set CFORGE_LEASE_API_URL to the API it was issued by");
    if (normalizeApiUrl(bound) !== apiUrl) throw new CliError("lease_origin_mismatch", `CFORGE_LEASE_TOKEN belongs to ${normalizeApiUrl(bound)}, not ${apiUrl}; it is not sent there`);
    return { token: env, source: "env" };
  }
  const lease: Lease | null = await store.lease(taskId);
  if (!lease || normalizeApiUrl(lease.apiUrl) !== apiUrl || lease.taskId !== taskId) return null;
  if (Date.parse(lease.expiresAt) <= io.now().getTime()) return null;
  return { token: lease.leaseToken, source: "config", leaseGeneration: lease.leaseGeneration, expiresAt: lease.expiresAt };
}

export const leaseHint = (taskId: string) => `the lease for ${taskId} is no longer valid (taken over or released); run \`cforge task lease ${taskId} --force\``;

/** Agent client for a task's lease; `lease_required` without one. */
export async function agentClient(io: CliIo, store: ConfigStore, taskId: string, apiUrl: string): Promise<ApiClient> {
  const bearer = await leaseBearer(io, store, taskId, apiUrl);
  if (!bearer) throw new CliError("lease_required", `no live lease for ${taskId}; run \`cforge checkout\` or \`cforge task lease ${taskId}\``);
  return new ApiClient(io, apiUrl, bearer.token);
}

/**
 * The agent client when a lease exists, else the user session (for routes both may call). A lease
 * that answers 401 falls back to the session, with a hint to take a new lease.
 */
export async function taskClient(io: CliIo, store: ConfigStore, taskId: string, apiUrl: string, warn: (line: string) => void = () => {}): Promise<ApiClient> {
  const bearer = await leaseBearer(io, store, taskId, apiUrl);
  if (bearer) {
    return new ApiClient(io, apiUrl, bearer.token, {
      fallback: async () => {
        const session = await store.session();
        if (!session || normalizeApiUrl(session.apiUrl) !== apiUrl || Date.parse(session.expiresAt) <= io.now().getTime()) {
          throw new CliError("lease_invalid", leaseHint(taskId));
        }
        warn(`warning: ${leaseHint(taskId)}; using your session instead`);
        return new ApiClient(io, apiUrl, session.sessionToken);
      },
    });
  }
  return (await sessionClient(io, store, apiUrl)).api;
}
