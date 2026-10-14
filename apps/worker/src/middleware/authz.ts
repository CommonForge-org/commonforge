/**
 * Authentication and authorization (plan §F).
 *
 * - Principals: a user (session cookie `cf_session` or `Authorization: Bearer cfs_…`) or an agent
 *   (`Authorization: Bearer cfl_…`, a task lease token). Agents may only call `/api/tasks/<their
 *   task>/…`; they act on behalf of the lease holder, whose membership and grants are re-checked on
 *   every request (no implicit copy of the owner's rights).
 * - Non-members get 404 for anything inside an org (no existence leak). Inside an org: role checks
 *   (owner / developer / client / viewer), then per-resource grants. Owners have implicit grants.
 * - Every resource read resolves (org, project, mount) → resource and checks the resource grant;
 *   a project grant alone never exposes a resource (AT-16).
 * - Client and viewer principals never receive canonical coordinates (namespace, repo id, remote
 *   URL) and never receive credentials (AT-25); see `presentResource`. Staging mode (spec
 *   2026-10-07 §4): a client may create and lease their own tasks; only that task's agent (the lease
 *   token) receives credentials, and only for the task's own `-tasks` copies, never canonical.
 * - Policy (checks, approval roles) comes from the server-owned project policy, never from files in
 *   a repository or candidate (AT-18/AT-38).
 */
import type { Operation } from "@commonforge-org/core";
import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv, Principal, Services } from "../context.js";
import { forbidden, notFound, unauthorized } from "../lib/http.js";
import { resolveLease, resolveSession } from "../services/auth.js";
import {
  getMount,
  getProject,
  getResource,
  getRole,
  grantOperations,
  listMounts,
  resourceCoords,
  type MountRow,
  type ProjectRow,
  type ResourceRow,
  type Role,
} from "../services/directory.js";
import { stagingPolicyOf } from "../services/staging-policy.js";
import { isStagingProject } from "../services/staging-state.js";

/**
 * `__Host-` (review I-2): the browser accepts it only with `Secure`, `Path=/` and no `Domain`, so
 * a sibling host on the same site (a preview or demo Worker on `<sub>.workers.dev`) cannot plant a
 * session cookie for this origin (cookie tossing / session fixation).
 */
export const SESSION_COOKIE = "__Host-cf_session";
/** The pre-review name: still cleared on logout, never accepted as a credential. */
export const LEGACY_SESSION_COOKIE = "cf_session";

/** The session cookie value; null when absent. Duplicates (a planted second copy) → "duplicate". */
export function sessionCookie(c: Context): string | null | "duplicate" {
  const raw = c.req.header("cookie") ?? "";
  const values = raw
    .split(";")
    .map((p) => p.trim())
    .filter((p) => p.startsWith(`${SESSION_COOKIE}=`))
    .map((p) => p.slice(SESSION_COOKIE.length + 1));
  if (values.length > 1) return "duplicate";
  return values[0] ?? null;
}

export function bearer(c: Context): string | null {
  const h = c.req.header("authorization");
  const m = h ? /^Bearer\s+(\S+)$/i.exec(h) : null;
  return m ? m[1]! : null;
}

/** Resolve the principal (or null). Never throws for a bad credential; routes decide. */
export function authenticate(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const svc = c.get("svc");
    let principal: Principal | null = null;
    // a planted duplicate session cookie authenticates nobody (review I-2)
    const fromCookie = bearer(c) ? null : sessionCookie(c);
    const token = bearer(c) ?? (fromCookie === "duplicate" ? null : fromCookie);
    if (token?.startsWith("cfs_")) {
      const user = await resolveSession(svc, token);
      if (user) principal = { kind: "user", userId: user.user_id, email: user.email };
    } else if (token?.startsWith("cfl_")) {
      const lease = await resolveLease(svc, token);
      if (lease) {
        principal = {
          kind: "agent",
          taskId: lease.task_id,
          orgId: lease.org_id,
          leaseGeneration: lease.lease_generation,
          leaseExpiresAt: lease.lease_expires_at,
          holderUserId: lease.lease_holder,
        };
      }
    }
    c.set("principal", principal);
    await next();
  };
}

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * CSRF (I-5). State-changing requests that do not carry an `Authorization` bearer (so they may be
 * riding on the session cookie, or establishing one) must come from the web app or this Worker's
 * own origin: a present `Origin` must match; without `Origin`, `Sec-Fetch-Site` must be
 * `same-origin` or `none` when present. Runner routes authenticate with the SignedJob and are exempt;
 * so is the staging capture sink (`/api/sink/<token>`): staging Workers call it server to server, it
 * has no session, and it changes nothing but its own log.
 * SameSite=Strict alone does not stop same-site sibling hosts.
 */
export function csrfGuard(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const pathname = new URL(c.req.url).pathname;
    if (!UNSAFE.has(c.req.method) || bearer(c) || pathname.startsWith("/api/runner/") || pathname.startsWith("/api/sink/")) return next();
    const allowed = new Set([new URL(c.req.url).origin]);
    try {
      allowed.add(new URL(c.env.COMMONFORGE_APP_URL).origin);
    } catch {
      /* misconfigured app URL: only same-origin */
    }
    const origin = c.req.header("origin");
    const site = c.req.header("sec-fetch-site");
    const ok = origin ? allowed.has(origin) : !site || site === "same-origin" || site === "none";
    if (!ok) return c.json({ error: { code: "csrf_refused", message: "cross-origin state change refused" } }, 403);
    return next();
  };
}

export function requireUser(c: Context<AppEnv>): Extract<Principal, { kind: "user" }> {
  const p = c.get("principal");
  if (!p) throw unauthorized();
  if (p.kind !== "user") throw forbidden("agent_not_allowed", "task lease tokens may only call /api/tasks/<task>/…");
  return p;
}

export interface OrgActor {
  orgId: string;
  userId: string;
  role: Role;
  /** set when an agent acts on behalf of `userId` */
  agentTaskId?: string;
}

export const isDeveloper = (role: Role) => role === "owner" || role === "developer";
/** Clients and viewers never see canonical coordinates or receive credentials. */
export const seesCanonical = (role: Role) => isDeveloper(role);

/** The calling user's membership in `orgId`; 404 for non-members. */
export async function orgActor(c: Context<AppEnv>, orgId: string, roles?: readonly Role[]): Promise<OrgActor> {
  const user = requireUser(c);
  const role = await getRole(c.get("svc").db, orgId, user.userId);
  if (!role) throw notFound("organization not found");
  const actor = { orgId, userId: user.userId, role };
  if (roles) requireRole(actor, roles);
  return actor;
}

export function requireRole(actor: OrgActor, roles: readonly Role[]): void {
  if (!roles.includes(actor.role)) throw forbidden("insufficient_role", `requires one of: ${roles.join(", ")}`);
}

/**
 * An agent (or a user) acting on a task. Agents must hold the current lease of exactly this task;
 * the lease holder must still be a developer/owner of the org, or (staging mode, spec 2026-10-07 §4)
 * a client who created this task in a project that is in staging mode now (checked on every call).
 */
export async function taskActor(
  c: Context<AppEnv>,
  task: { task_id: string; org_id: string; project_id?: string; created_by?: string },
  opts: { allowUser?: boolean } = {},
): Promise<OrgActor & { agent: boolean }> {
  const p = c.get("principal");
  if (!p) throw unauthorized();
  const db = c.get("svc").db;
  if (p.kind === "agent") {
    if (p.taskId !== task.task_id) throw notFound("task not found");
    const role = await getRole(db, task.org_id, p.holderUserId);
    const stagingClient =
      role === "client" && task.project_id !== undefined && task.created_by !== undefined && task.created_by === p.holderUserId && (await isStagingProject(c.get("svc"), task.org_id, task.project_id));
    if (!role || (!isDeveloper(role) && !stagingClient)) throw forbidden("lease_holder_not_authorized", "the lease holder may no longer work on this task");
    return { orgId: task.org_id, userId: p.holderUserId, role, agentTaskId: p.taskId, agent: true };
  }
  const role = await getRole(db, task.org_id, p.userId);
  if (!role) throw notFound("task not found");
  if (opts.allowUser === false) throw forbidden("lease_required", "this call requires the task lease token");
  return { orgId: task.org_id, userId: p.userId, role, agent: false };
}

/**
 * A task is visible to a user only with read on its project and on **every** resource its snapshot
 * names (the task view and its events name them; AT-16). Agents see only their own task. A client
 * sees only the tasks they created, and only while the project is in staging mode.
 */
export async function canSeeTask(svc: Services, actor: OrgActor, task: { project_id: string; snapshot_json: string; created_by: string }): Promise<boolean> {
  if (actor.role === "client") {
    if (task.created_by !== actor.userId || !(await isStagingProject(svc, actor.orgId, task.project_id))) return false;
  } else if (!isDeveloper(actor.role)) return false;
  if (!(await canReadProject(svc, actor, task.project_id))) return false;
  const snap = JSON.parse(task.snapshot_json) as { entries: Array<{ resourceId: string }> };
  for (const e of snap.entries) if (!(await canReadResource(svc, actor, e.resourceId))) return false;
  return true;
}

export async function resourceOps(svc: Services, actor: OrgActor, resourceId: string): Promise<Operation[]> {
  if (actor.role === "owner") return ["read", "write"];
  const ops = await grantOperations(svc.db, actor.orgId, actor.userId, "resource", resourceId);
  // clients and viewers never write canonical resources, whatever a grant says (a client's `write`
  // grant means "may change it through tasks": canStageWrite)
  return isDeveloper(actor.role) ? ops : ops.filter((o) => o === "read");
}

export async function canReadResource(svc: Services, actor: OrgActor, resourceId: string): Promise<boolean> {
  return (await resourceOps(svc, actor, resourceId)).includes("read");
}

export async function canWriteResource(svc: Services, actor: OrgActor, resourceId: string): Promise<boolean> {
  return (await resourceOps(svc, actor, resourceId)).includes("write");
}

/**
 * Staging mode (spec 2026-10-07 §4): a client may change, in a task workspace only, a folder the
 * owner opened to them: the project is in staging mode, the mount's operations include `write`, the
 * folder is a code (Artifacts) folder, the client can read the project, and the owner gave them
 * **Can change** on the folder (their resource grant includes `write`; project access "Change").
 * That grant never lets a client write canonical ({@link resourceOps} reads it as `read`): their
 * changes reach staging through landings, never a head. Owners/developers: {@link canWriteResource}.
 * Viewers: never.
 */
export async function canStageWrite(svc: Services, actor: OrgActor, project: ProjectRow, mountName: string, resourceId: string): Promise<boolean> {
  if (isDeveloper(actor.role)) return canWriteResource(svc, actor, resourceId);
  if (actor.role !== "client" || project.org_id !== actor.orgId || !stagingPolicyOf(project)) return false;
  const mount = (await listMounts(svc.db, project.org_id, project.project_id)).find((m) => m.mount_name === mountName);
  if (!mount || mount.resource_id !== resourceId || !(JSON.parse(mount.operations_json) as string[]).includes("write")) return false;
  if ((await getResource(svc.db, actor.orgId, resourceId))?.provider !== "artifacts") return false;
  if (!(await canReadProject(svc, actor, project.project_id))) return false;
  const granted = await grantOperations(svc.db, actor.orgId, actor.userId, "resource", resourceId);
  return granted.includes("read") && granted.includes("write");
}

/** Write on a task's workspace: {@link canStageWrite} for clients (their own staging-mode tasks), else {@link canWriteResource}. */
export async function canWriteTaskResource(svc: Services, actor: OrgActor, task: { org_id: string; project_id: string }, mountName: string, resourceId: string): Promise<boolean> {
  if (actor.role !== "client") return canWriteResource(svc, actor, resourceId);
  const project = await getProject(svc.db, task.org_id, task.project_id);
  return !!project && (await canStageWrite(svc, actor, project, mountName, resourceId));
}

export async function canReadProject(svc: Services, actor: OrgActor, projectId: string): Promise<boolean> {
  if (actor.role === "owner") return true;
  return (await grantOperations(svc.db, actor.orgId, actor.userId, "project", projectId)).length > 0;
}

/** Project visible to the actor, else 404. */
export async function readableProject(svc: Services, actor: OrgActor, projectId: string): Promise<ProjectRow> {
  const project = await getProject(svc.db, actor.orgId, projectId);
  if (!project || !(await canReadProject(svc, actor, projectId))) throw notFound("project not found");
  return project;
}

/** Resource visible to the actor, else 404 (no existence leak). */
export async function readableResource(svc: Services, actor: OrgActor, resourceId: string): Promise<ResourceRow> {
  const r = await getResource(svc.db, actor.orgId, resourceId);
  if (!r || !(await canReadResource(svc, actor, resourceId))) throw notFound("resource not found");
  return r;
}

export async function writableResource(svc: Services, actor: OrgActor, resourceId: string): Promise<ResourceRow> {
  const r = await readableResource(svc, actor, resourceId);
  if (!(await canWriteResource(svc, actor, resourceId))) throw forbidden("no_write_grant", "no write grant on this resource");
  return r;
}

/** §F: every read resolves (org, project, mount) → resource and checks the resource grant. */
export async function readableMount(
  svc: Services,
  actor: OrgActor,
  projectId: string,
  mountName: string,
): Promise<{ project: ProjectRow; mount: MountRow; resource: ResourceRow }> {
  const project = await readableProject(svc, actor, projectId);
  const mount = await getMount(svc.db, actor.orgId, projectId, mountName);
  if (!mount) throw notFound("mount not found");
  const resource = await getResource(svc.db, actor.orgId, mount.resource_id);
  if (!resource || !(await canReadResource(svc, actor, resource.resource_id))) throw notFound("mount not found");
  return { project, mount, resource };
}

/** Resource as shown to `role`: coordinates only for owners and developers. */
export function presentResource(r: ResourceRow, role: Role) {
  const base = {
    resourceId: r.resource_id,
    name: r.name,
    provider: r.provider,
    state: r.state,
    branch: r.branch,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...(r.error ? { error: r.error } : {}),
  };
  if (!seesCanonical(role)) return base;
  return { ...base, coords: resourceCoords(r), source: r.source_json ? (JSON.parse(r.source_json) as unknown) : null };
}
