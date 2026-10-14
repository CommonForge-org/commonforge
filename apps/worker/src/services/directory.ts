/**
 * D1 directory access: users, orgs, memberships, projects, resources, mounts, grants.
 * Pure data access; authorization decisions live in middleware/authz.ts.
 */
import type { ArtifactsCoords, AssetManifestCoords, DependencyMode, Operation } from "@commonforge-org/core";

export const ROLES = ["owner", "developer", "client", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export interface UserRow {
  user_id: string;
  email: string;
  display_name: string | null;
  created_at: string;
}

export interface ProjectPolicy {
  /** validation commands run by the integration runner (server-owned; never from repo files) */
  checks?: Array<{ checkId: string; mountName: string; command: string; timeoutSeconds?: number; required?: boolean; gatesAlone?: boolean }>;
  contracts?: unknown[];
  /** roles whose approval counts for acceptance (default: owner, developer, client) */
  approvalRoles?: Role[];
  /** free-text rules copied into PROJECT-CONTEXT.md */
  rules?: string[];
  /** Task 22: private preview recipe (services/release-policy.ts) */
  preview?: import("./release-policy.js").PreviewPolicy;
  /** Task 22: release recipe, targets, production environment, health check */
  release?: import("./release-policy.js").ReleasePolicy;
  /** Task 22: roles whose publish approval counts (default owner) */
  publishRoles?: Array<"owner" | "developer" | "client">;
  /** staging phase 1: always-on staging (services/staging-policy.ts) */
  staging?: import("./staging-policy.js").StagingPolicy;
}

export interface ProjectRow {
  org_id: string;
  project_id: string;
  name: string;
  membership_revision: number;
  policy_revision: number;
  policy_json: string;
  created_by: string;
  created_at: string;
}

export type ResourceState = "empty" | "importing" | "active" | "failed";

export interface ResourceRow {
  org_id: string;
  resource_id: string;
  name: string;
  provider: "artifacts" | "r2-assets";
  state: ResourceState;
  coords_json: string | null;
  branch: string | null;
  source_json: string | null;
  error: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface MountRow {
  org_id: string;
  project_id: string;
  mount_name: string;
  resource_id: string;
  mode: DependencyMode;
  operations_json: string;
  created_at: string;
}

export const resourceCoords = (r: ResourceRow): ArtifactsCoords | AssetManifestCoords | null =>
  r.coords_json ? (JSON.parse(r.coords_json) as ArtifactsCoords | AssetManifestCoords) : null;
export const mountOperations = (m: MountRow): Operation[] => JSON.parse(m.operations_json) as Operation[];
export const projectPolicy = (p: ProjectRow): ProjectPolicy => JSON.parse(p.policy_json) as ProjectPolicy;

export async function getUserByEmail(db: D1Database, email: string): Promise<UserRow | null> {
  return db.prepare("SELECT * FROM users WHERE email = ?").bind(email).first<UserRow>();
}

export async function getUser(db: D1Database, userId: string): Promise<UserRow | null> {
  return db.prepare("SELECT * FROM users WHERE user_id = ?").bind(userId).first<UserRow>();
}

/** Find or create the user for a (normalized) email. */
export async function ensureUser(db: D1Database, email: string, newId: () => string, now: string): Promise<UserRow> {
  await db.prepare("INSERT OR IGNORE INTO users (user_id, email, created_at) VALUES (?, ?, ?)").bind(newId(), email, now).run();
  const u = await getUserByEmail(db, email);
  if (!u) throw new Error("user upsert failed");
  return u;
}

/** The user's role in `orgId`; null for non-members and for archived organizations. */
export async function getRole(db: D1Database, orgId: string, userId: string): Promise<Role | null> {
  const r = await db
    .prepare("SELECT m.role FROM memberships m JOIN orgs o ON o.org_id = m.org_id WHERE m.org_id = ? AND m.user_id = ? AND o.archived_at IS NULL")
    .bind(orgId, userId)
    .first<{ role: Role }>();
  return r?.role ?? null;
}

/** The user's role in `orgId` even while it is archived (only unarchiving needs this). */
export async function getRoleInArchived(db: D1Database, orgId: string, userId: string): Promise<{ role: Role; archivedAt: string | null } | null> {
  const r = await db
    .prepare("SELECT m.role, o.archived_at FROM memberships m JOIN orgs o ON o.org_id = m.org_id WHERE m.org_id = ? AND m.user_id = ?")
    .bind(orgId, userId)
    .first<{ role: Role; archived_at: string | null }>();
  return r ? { role: r.role, archivedAt: r.archived_at } : null;
}

export async function getProject(db: D1Database, orgId: string, projectId: string): Promise<ProjectRow | null> {
  return db.prepare("SELECT * FROM projects WHERE org_id = ? AND project_id = ?").bind(orgId, projectId).first<ProjectRow>();
}

export async function getResource(db: D1Database, orgId: string, resourceId: string): Promise<ResourceRow | null> {
  return db.prepare("SELECT * FROM resources WHERE org_id = ? AND resource_id = ?").bind(orgId, resourceId).first<ResourceRow>();
}

export async function listMounts(db: D1Database, orgId: string, projectId: string): Promise<MountRow[]> {
  const r = await db.prepare("SELECT * FROM mounts WHERE org_id = ? AND project_id = ? ORDER BY mount_name").bind(orgId, projectId).all<MountRow>();
  return r.results;
}

export async function getMount(db: D1Database, orgId: string, projectId: string, mountName: string): Promise<MountRow | null> {
  return db
    .prepare("SELECT * FROM mounts WHERE org_id = ? AND project_id = ? AND mount_name = ?")
    .bind(orgId, projectId, mountName.normalize("NFC"))
    .first<MountRow>();
}

export async function grantOperations(
  db: D1Database,
  orgId: string,
  userId: string,
  scopeKind: "project" | "resource",
  scopeId: string,
): Promise<Operation[]> {
  const r = await db
    .prepare("SELECT operations_json FROM grants WHERE org_id = ? AND user_id = ? AND scope_kind = ? AND scope_id = ?")
    .bind(orgId, userId, scopeKind, scopeId)
    .first<{ operations_json: string }>();
  return r ? (JSON.parse(r.operations_json) as Operation[]) : [];
}

export function grantStatement(
  db: D1Database,
  g: { orgId: string; userId: string; scopeKind: "project" | "resource"; scopeId: string; operations: Operation[]; grantedBy: string; now: string },
): D1PreparedStatement {
  const ops = [...new Set(g.operations)].sort();
  return db
    .prepare(
      "INSERT INTO grants (org_id, user_id, scope_kind, scope_id, operations_json, granted_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT (org_id, user_id, scope_kind, scope_id) DO UPDATE SET operations_json = excluded.operations_json, granted_by = excluded.granted_by",
    )
    .bind(g.orgId, g.userId, g.scopeKind, g.scopeId, JSON.stringify(ops), g.grantedBy, g.now);
}

export async function putGrant(db: D1Database, g: Parameters<typeof grantStatement>[1]): Promise<void> {
  await grantStatement(db, g).run();
}

export async function deleteGrant(db: D1Database, orgId: string, userId: string, scopeKind: string, scopeId: string): Promise<boolean> {
  const r = await db.prepare("DELETE FROM grants WHERE org_id = ? AND user_id = ? AND scope_kind = ? AND scope_id = ?").bind(orgId, userId, scopeKind, scopeId).run();
  return (r.meta.changes ?? 0) > 0;
}

export async function updateResource(db: D1Database, orgId: string, resourceId: string, patch: Partial<Pick<ResourceRow, "state" | "coords_json" | "branch" | "error" | "source_json">>, now: string): Promise<void> {
  const keys = Object.keys(patch) as Array<keyof typeof patch>;
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k} = ?`).join(", ");
  await db
    .prepare(`UPDATE resources SET ${sets}, updated_at = ? WHERE org_id = ? AND resource_id = ?`)
    .bind(...keys.map((k) => patch[k] ?? null), now, orgId, resourceId)
    .run();
}
