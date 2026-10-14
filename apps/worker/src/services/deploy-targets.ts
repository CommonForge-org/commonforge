/**
 * Release targets are platform-controlled (Task 22 review C-1). The deploy token is account-wide
 * (Cloudflare tokens cannot be scoped per Worker), so the platform decides what an org may touch:
 *
 * - **Worker names** must be `<deployPrefix>-<orgId>-<name>` (`COMMONFORGE_DEPLOY_WORKER_PREFIX`,
 *   default `cfapp`). Names starting with `commonforge` (the platform's own Workers) are always
 *   refused. Enforced at policy save, prepare, deploy, and again by the Sandbox egress gateway.
 * - **Bindings**: only KV namespaces and D1 databases the platform created for that org
 *   (`org_deploy_resources`, `POST /api/orgs/:org/deploy-resources`), never an arbitrary id on the
 *   account (and never a staging resource: those live in `staging_resources`).
 * - **Health URL**: derived from the target Worker's own workers.dev URL (no free-form URL).
 *
 * The strongest control is deployment-level: point `COMMONFORGE_DEPLOY_ACCOUNT_ID` (and a token
 * scoped to it) at a separate account, so the deploy token cannot reach the platform at all.
 */
import type { Env } from "../env.js";
import type { Services } from "../context.js";
import { ApiError } from "../lib/http.js";

export const PLATFORM_WORKER_PREFIX = "commonforge";
/** Organization ids (routes/orgs.ts `newId("o", 6)`). */
export const ORG_ID_RE = /^o-[0-9a-f]{12}$/;
/** Review m-b: per-org caps (the deploy account is shared until a separate one is configured). */
export const MAX_ORG_KV = 5;
/** Staging phase 2: production D1 databases per org (kind `d1`). */
export const MAX_ORG_D1 = 3;
export const MAX_ORG_RELEASE_WORKERS = 5;

export function deployPrefix(env: Pick<Env, "COMMONFORGE_DEPLOY_WORKER_PREFIX">): string {
  const p = env.COMMONFORGE_DEPLOY_WORKER_PREFIX || "cfapp";
  if (!/^[a-z][a-z0-9]{1,15}$/.test(p) || p.startsWith(PLATFORM_WORKER_PREFIX)) throw new ApiError(503, "config_invalid", "COMMONFORGE_DEPLOY_WORKER_PREFIX must be a short lowercase word that does not start with commonforge");
  return p;
}

/** Every Worker an org's releases deploy is named `<prefix>-<orgId>-<name>`. */
export function orgWorkerPrefix(env: Pick<Env, "COMMONFORGE_DEPLOY_WORKER_PREFIX">, orgId: string): string {
  // review m-e: prefixes are disjoint only because org ids are fixed-length server-generated ids
  if (!ORG_ID_RE.test(orgId)) throw new ApiError(500, "internal", "unexpected organization id format");
  return `${deployPrefix(env)}-${orgId}-`;
}

/** Why `name` may not be a release target of `orgId` (null: it may). */
export function workerNameProblem(env: Pick<Env, "COMMONFORGE_DEPLOY_WORKER_PREFIX">, orgId: string, name: string): string | null {
  if (name.startsWith(PLATFORM_WORKER_PREFIX)) return `${name} is a platform Worker name`;
  const prefix = orgWorkerPrefix(env, orgId);
  if (!name.startsWith(prefix) || name.length === prefix.length) return `release Workers of this organization must be named ${prefix}<name>`;
  return null;
}

export async function orgKvIds(svc: Services, orgId: string): Promise<Set<string>> {
  const r = await svc.db.prepare("SELECT resource_id FROM org_deploy_resources WHERE org_id = ? AND kind = 'kv'").bind(orgId).all<{ resource_id: string }>();
  return new Set(r.results.map((x) => x.resource_id));
}

/** The org's production D1 databases (staging phase 2, R8): the only D1 ids a production release may bind. */
export async function orgD1Ids(svc: Services, orgId: string): Promise<Set<string>> {
  const r = await svc.db.prepare("SELECT resource_id FROM org_deploy_resources WHERE org_id = ? AND kind = 'd1'").bind(orgId).all<{ resource_id: string }>();
  return new Set(r.results.map((x) => x.resource_id));
}

/** Refuse targets outside the org's namespace and bindings the platform did not create for the org. */
export async function assertTargetsAllowed(
  svc: Services,
  orgId: string,
  targets: ReadonlyArray<{ targetId: string; workerName: string }>,
  bindings: ReadonlyArray<{ targetId: string; kvNamespaces: ReadonlyArray<{ binding: string; id: string }>; d1Databases?: ReadonlyArray<{ binding: string; id: string }> }>,
  /** D1 database ids the caller has verified as platform-created for this use (production: {@link orgD1Ids}); none given → every D1 id is refused */
  allowedD1Ids: ReadonlySet<string> = new Set(),
): Promise<void> {
  for (const t of targets) {
    const why = workerNameProblem(svc.env, orgId, t.workerName);
    if (why) throw new ApiError(403, "release_target_not_allowed", why, { targetId: t.targetId });
  }
  const kv = await orgKvIds(svc, orgId);
  for (const b of bindings) {
    for (const k of b.kvNamespaces) {
      if (!kv.has(k.id)) throw new ApiError(403, "binding_not_allowed", `KV namespace ${k.id} was not created by CommonForge for this organization (POST …/deploy-resources)`, { targetId: b.targetId, binding: k.binding });
    }
    for (const d of b.d1Databases ?? []) {
      if (!allowedD1Ids.has(d.id)) throw new ApiError(403, "binding_not_allowed", `D1 database ${d.id} was not created by CommonForge for this organization (POST …/deploy-resources with kind d1)`, { targetId: b.targetId, binding: d.binding });
    }
  }
}

/**
 * Staging phase 2 (review I3): an org D1 database belongs to ONE project of the org. Two projects'
 * releases migrating the same database would race (the deploy lock is per project) and could apply
 * each other's migrations. A database is taken while another project's stored release policy binds it.
 */
export async function assertOrgD1NotInUse(svc: Services, orgId: string, projectId: string, d1Ids: Iterable<string>): Promise<void> {
  const wanted = new Set(d1Ids);
  if (wanted.size === 0) return;
  const rows = await svc.db.prepare("SELECT project_id, policy_json FROM projects WHERE org_id = ? AND project_id != ?").bind(orgId, projectId).all<{ project_id: string; policy_json: string }>();
  for (const r of rows.results) {
    const environment = (JSON.parse(r.policy_json) as { release?: { environment?: Record<string, { d1Databases?: Array<{ id?: unknown }> }> } }).release?.environment ?? {};
    for (const e of Object.values(environment)) {
      const clash = (e?.d1Databases ?? []).find((d) => typeof d?.id === "string" && wanted.has(d.id));
      if (clash) throw new ApiError(409, "binding_in_use", `D1 database ${String(clash.id)} is already bound by project ${r.project_id}; each project needs its own production database`, { id: clash.id, projectId: r.project_id });
    }
  }
}

/**
 * Review m-b: at most {@link MAX_ORG_RELEASE_WORKERS} distinct release Workers per org (across its
 * projects). Follow-up n-2: a Worker name belongs to ONE project of the org. Another project's
 * deploy (or its rollback cleanup, review m-d) would otherwise overwrite or delete a Worker this
 * project's live release still serves. A name is taken while another project's policy names it or
 * another project's live release records a deployment to it.
 */
export async function assertOrgWorkerQuota(svc: Services, orgId: string, projectId: string, names: readonly string[]): Promise<void> {
  const rows = await svc.db.prepare("SELECT project_id, policy_json FROM projects WHERE org_id = ? AND project_id != ?").bind(orgId, projectId).all<{ project_id: string; policy_json: string }>();
  const live = await svc.db.prepare("SELECT project_id, deployments_json FROM release_live WHERE org_id = ? AND project_id != ? AND channel = 'production'").bind(orgId, projectId).all<{ project_id: string; deployments_json: string }>();
  const all = new Set(names);
  const taken = new Map<string, string>();
  for (const r of rows.results) {
    const targets = (JSON.parse(r.policy_json) as { release?: { targets?: Array<{ workerName?: string }> } }).release?.targets ?? [];
    for (const t of targets) {
      if (!t.workerName) continue;
      all.add(t.workerName);
      taken.set(t.workerName, r.project_id);
    }
  }
  for (const r of live.results) {
    for (const d of JSON.parse(r.deployments_json) as Array<{ workerName?: string }>) {
      if (!d.workerName) continue;
      all.add(d.workerName);
      if (!taken.has(d.workerName)) taken.set(d.workerName, r.project_id);
    }
  }
  const clash = names.find((n) => taken.has(n));
  if (clash) throw new ApiError(409, "release_target_in_use", `Worker ${clash} is already a release target of project ${taken.get(clash)} in this organization; each project needs its own Worker names`, { workerName: clash, projectId: taken.get(clash) });
  if (all.size > MAX_ORG_RELEASE_WORKERS) throw new ApiError(409, "quota_exceeded", `an organization can deploy at most ${MAX_ORG_RELEASE_WORKERS} release Workers`);
}
