/**
 * The control plane's own calls to the Cloudflare API with the deploy token (Task 22 review):
 * creating the platform-owned KV namespaces an org's releases may bind (C-1b), looking up the
 * deploy account's workers.dev subdomain for the derived health URL (C-1c), and reading each
 * target's active version for the per-target health check (m-3). Never called with user input
 * other than names the platform derived.
 */
import { ApiError } from "../lib/http.js";
import type { Env } from "../env.js";

/**
 * A failed Cloudflare API call, with the HTTP status it answered (0: no response, e.g. a network
 * error). Callers retry `transient` failures (5xx, 429, no response) and fail on the rest (4xx,
 * e.g. a SQL statement D1 refused).
 */
export class DeployApiError extends ApiError {
  constructor(
    readonly httpStatus: number,
    message: string,
  ) {
    super(502, "provider_unavailable", message, { httpStatus });
  }
  get transient(): boolean {
    return this.httpStatus === 0 || this.httpStatus === 429 || this.httpStatus >= 500;
  }
}

export interface DeployApi {
  createKvNamespace(accountId: string, title: string): Promise<{ id: string }>;
  workersSubdomain(accountId: string): Promise<string>;
  /** version ids of the script's active deployment (empty when it has none or does not exist) */
  activeVersionIds(accountId: string, script: string): Promise<string[]>;
  /** delete a release Worker (rollback of a target only the failed release had; review m-d) */
  deleteScript(accountId: string, script: string): Promise<void>;
  /** platform-owned staging database (staging phase 1) */
  createD1Database(accountId: string, name: string): Promise<{ id: string }>;
  deleteD1Database(accountId: string, id: string): Promise<void>;
  /** one SQL file (several statements allowed); throws on the first failing statement */
  d1Query(accountId: string, id: string, sql: string): Promise<void>;
  deleteKvNamespace(accountId: string, id: string): Promise<void>;
  kvBulkPut(accountId: string, id: string, entries: Array<{ key: string; value: string }>): Promise<void>;
}

export function defaultDeployApi(env: Env): DeployApi {
  const call = async <T>(method: string, path: string, body?: unknown, opts: { nullOn404?: boolean } = {}): Promise<T> => {
    const token = env.COMMONFORGE_DEPLOY_API_TOKEN;
    if (!token) throw new ApiError(503, "config_missing", "COMMONFORGE_DEPLOY_API_TOKEN is not configured");
    const where = `Cloudflare API ${method} ${path.replace(/accounts\/[0-9a-f]+/, "accounts/…")}`;
    let res: Response;
    try {
      res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (e) {
      throw new DeployApiError(0, `${where}: no response (${String((e as Error)?.message ?? e).slice(0, 200)})`);
    }
    if (opts.nullOn404 && res.status === 404) {
      await res.body?.cancel();
      return null as T;
    }
    const json = (await res.json().catch(() => null)) as { success?: boolean; result?: T; errors?: Array<{ message?: string }> } | null;
    if (!res.ok || !json?.success) throw new DeployApiError(res.status, `${where}: HTTP ${res.status} ${json?.errors?.[0]?.message ?? ""}`.trim());
    return json.result as T;
  };
  return {
    async createKvNamespace(accountId, title) {
      const r = await call<{ id: string }>("POST", `/accounts/${accountId}/storage/kv/namespaces`, { title });
      return { id: r.id };
    },
    async workersSubdomain(accountId) {
      return (await call<{ subdomain: string }>("GET", `/accounts/${accountId}/workers/subdomain`)).subdomain;
    },
    async activeVersionIds(accountId, script) {
      const r = await call<{ deployments: Array<{ versions: Array<{ version_id: string; percentage: number }> }> } | null>("GET", `/accounts/${accountId}/workers/scripts/${encodeURIComponent(script)}/deployments`, undefined, { nullOn404: true });
      return (r?.deployments?.[0]?.versions ?? []).filter((v) => v.percentage > 0).map((v) => v.version_id);
    },
    async deleteScript(accountId, script) {
      await call<unknown>("DELETE", `/accounts/${accountId}/workers/scripts/${encodeURIComponent(script)}?force=true`, undefined, { nullOn404: true });
    },
    async createD1Database(accountId, name) {
      const r = await call<{ uuid: string }>("POST", `/accounts/${accountId}/d1/database`, { name });
      return { id: r.uuid };
    },
    async deleteD1Database(accountId, id) {
      await call<unknown>("DELETE", `/accounts/${accountId}/d1/database/${encodeURIComponent(id)}`, undefined, { nullOn404: true });
    },
    async d1Query(accountId, id, sql) {
      await call<unknown>("POST", `/accounts/${accountId}/d1/database/${encodeURIComponent(id)}/query`, { sql });
    },
    async deleteKvNamespace(accountId, id) {
      await call<unknown>("DELETE", `/accounts/${accountId}/storage/kv/namespaces/${encodeURIComponent(id)}`, undefined, { nullOn404: true });
    },
    async kvBulkPut(accountId, id, entries) {
      for (let i = 0; i < entries.length; i += 10_000) await call<unknown>("PUT", `/accounts/${accountId}/storage/kv/namespaces/${encodeURIComponent(id)}/bulk`, entries.slice(i, i + 10_000));
    },
  };
}
