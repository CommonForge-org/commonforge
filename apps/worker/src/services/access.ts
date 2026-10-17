/**
 * Project access (admin screens spec §5): one level per person per project, with optional lower
 * levels for single folders (for a client: Can change, Read only or No access per folder), stored as the existing grants: a project grant plus one grant per
 * folder (a project grant alone never exposes a folder, AT-16). Owners have implicit access.
 */
import type { Operation } from "@commonforge-org/core";
import type { Services } from "../context.js";
import { badRequest, forbidden, notFound } from "../lib/http.js";
import { canReadProject, canReadResource, isDeveloper, type OrgActor } from "../middleware/authz.js";
import { getRole, grantOperations, grantStatement, listMounts, type Role } from "./directory.js";
import { projectEditionGrantIds, projectEditionGrantsDelete, revokeProjectEditionTokens } from "./editions.js";
import { recordEvent, userRef } from "./events.js";
import { revokeUserLeases } from "./tasks.js";

export type Level = "none" | "read" | "write";
const RANK: Record<Level, number> = { none: 0, read: 1, write: 2 };

export function levelOf(ops: readonly string[]): Level {
  return ops.includes("write") ? "write" : ops.includes("read") ? "read" : "none";
}

export function opsOf(level: Level): Operation[] {
  return level === "write" ? ["read", "write"] : level === "read" ? ["read"] : [];
}

const lower = (a: Level, b: Level): Level => (RANK[a] < RANK[b] ? a : b);

const mountWritable = (m: { operations_json: string }) => (JSON.parse(m.operations_json) as string[]).includes("write");

/**
 * Viewers never write, whatever a grant says. A client's `write` is "Can change": their agent may
 * change the folder in task copies in a staging-mode project (`canStageWrite`), never canonical
 * (`resourceOps` in authz reads it as read).
 */
function capped(level: Level, role: Role): Level {
  return level === "write" && !isDeveloper(role) && role !== "client" ? "read" : level;
}

export interface FolderAccess {
  mountName: string;
  resourceId: string;
  level: Level;
  /** the folder is read-only in this project (its mount has no `write`): nobody changes it here */
  readOnly?: true;
  /**
   * The floor: the highest level the person's other projects that attach this folder give (capped by
   * role), never above what they hold now. This project can't take the folder below it. Absent when none.
   */
  min?: Level;
  /** the floor is above this project's level: the folder is held there by another project (fixed here) */
  shared?: true;
  /** with `shared`: that other project's name, when the caller can see it */
  via?: string;
}

export interface PersonAccess {
  userId: string;
  email: string;
  role: Role;
  level: Level;
  folders: FolderAccess[];
}

async function orgGrants(svc: Services, orgId: string): Promise<Map<string, string[]>> {
  const rows = await svc.db
    .prepare("SELECT user_id, scope_kind, scope_id, operations_json FROM grants WHERE org_id = ?")
    .bind(orgId)
    .all<{ user_id: string; scope_kind: string; scope_id: string; operations_json: string }>();
  return new Map(rows.results.map((g) => [`${g.user_id}|${g.scope_kind}|${g.scope_id}`, JSON.parse(g.operations_json) as string[]]));
}

/**
 * Every member's access to one project; owners are `write` (implicit). For a non-owner `viewer`
 * (the caller), only the folders the caller can read are listed, for every person (no disclosure of
 * folders a developer cannot see).
 */
export async function projectAccess(svc: Services, orgId: string, projectId: string, viewer?: OrgActor): Promise<PersonAccess[]> {
  const all = await listMounts(svc.db, orgId, projectId);
  const mounts = [];
  for (const mt of all) if (!viewer || viewer.role === "owner" || (await canReadResource(svc, viewer, mt.resource_id))) mounts.push(mt);
  const members = await svc.db
    .prepare("SELECT m.user_id, u.email, m.role FROM memberships m JOIN users u ON u.user_id = m.user_id WHERE m.org_id = ? ORDER BY u.email")
    .bind(orgId)
    .all<{ user_id: string; email: string; role: Role }>();
  const grants = await orgGrants(svc, orgId);
  const others = await otherProjectGrants(svc, orgId, projectId);
  const visible = new Map<string, boolean>();
  const nameFor = async (p: { projectId: string; name: string }): Promise<string | undefined> => {
    if (!viewer || viewer.role === "owner") return p.name;
    if (!visible.has(p.projectId)) visible.set(p.projectId, await canReadProject(svc, viewer, p.projectId));
    return visible.get(p.projectId) ? p.name : undefined;
  };
  const out: PersonAccess[] = [];
  for (const m of members.results) {
    const owner = m.role === "owner";
    const level: Level = owner ? "write" : capped(levelOf(grants.get(`${m.user_id}|project|${projectId}`) ?? []), m.role);
    const floors = owner || level === "none" ? new Map<string, Floor>() : floorsOf(others.filter((r) => r.user_id === m.user_id), m.role);
    const folders: FolderAccess[] = [];
    for (const mt of mounts) {
      const fl: Level = owner ? "write" : level === "none" ? "none" : capped(levelOf(grants.get(`${m.user_id}|resource|${mt.resource_id}`) ?? []), m.role);
      const other = floors.get(mt.resource_id);
      const floor = other ? lower(other.level, fl) : "none";
      const held = other && RANK[floor] > RANK[level];
      const via = held ? await nameFor(other.project) : undefined;
      const readOnly = !mountWritable(mt);
      folders.push({ mountName: mt.mount_name, resourceId: mt.resource_id, level: fl, ...(readOnly ? { readOnly: true as const } : {}), ...(floor !== "none" ? { min: floor } : {}), ...(held ? { shared: true as const } : {}), ...(via !== undefined ? { via } : {}) });
    }
    out.push({ userId: m.user_id, email: m.email, role: m.role, level, folders });
  }
  return out;
}

interface OtherGrant {
  user_id: string;
  resource_id: string;
  project_id: string;
  name: string;
  operations_json: string;
}

/** Project grants on OTHER projects that attach one of this project's folders (by project name). */
async function otherProjectGrants(svc: Services, orgId: string, projectId: string, userId?: string): Promise<OtherGrant[]> {
  const rows = await svc.db
    .prepare(
      "SELECT g.user_id, mt.resource_id, p.project_id, p.name, g.operations_json FROM mounts mt JOIN grants g ON g.org_id = mt.org_id AND g.scope_kind = 'project' AND g.scope_id = mt.project_id " +
        "JOIN projects p ON p.org_id = mt.org_id AND p.project_id = mt.project_id " +
        `WHERE mt.org_id = ? AND mt.project_id <> ?${userId ? " AND g.user_id = ?" : ""} AND mt.resource_id IN (SELECT resource_id FROM mounts WHERE org_id = ? AND project_id = ?) ORDER BY p.name, p.project_id`,
    )
    .bind(orgId, projectId, ...(userId ? [userId] : []), orgId, projectId)
    .all<OtherGrant>();
  return rows.results;
}

interface Floor {
  level: Level;
  /** the first project (by name) giving that level */
  project: { projectId: string; name: string };
}

/** resource → the highest level one person's other projects give it, capped by the person's role. */
function floorsOf(rows: OtherGrant[], role: Role): Map<string, Floor> {
  const out = new Map<string, Floor>();
  for (const r of rows) {
    const level = capped(levelOf(JSON.parse(r.operations_json) as string[]), role);
    if (level === "none") continue;
    const cur = out.get(r.resource_id);
    if (!cur || RANK[level] > RANK[cur.level]) out.set(r.resource_id, { level, project: { projectId: r.project_id, name: r.name } });
  }
  return out;
}

export async function setProjectAccess(svc: Services, actor: OrgActor, projectId: string, change: { userId: string; level: Level; folders?: Record<string, Level> }): Promise<PersonAccess> {
  const role = await getRole(svc.db, actor.orgId, change.userId);
  if (!role) throw notFound("member not found");
  if (role === "owner") throw badRequest("owner_access_implicit", "owners already have access to every project");
  if (change.level === "write" && !isDeveloper(role) && role !== "client") throw badRequest("grant_exceeds_role", `a ${role} can only hold read access`);
  const mounts = await listMounts(svc.db, actor.orgId, projectId);
  const mounted = new Set(mounts.map((m) => m.resource_id));
  const exceptions = change.folders ?? {};
  for (const [rid, l] of Object.entries(exceptions)) {
    if (!mounted.has(rid)) throw badRequest("unknown_folder", `${rid} is not a folder of this project`);
    if (RANK[l] > RANK[change.level]) throw badRequest("folder_exceeds_project", "a folder cannot have more access than its project");
  }

  const before = new Map<string, Operation[]>();
  before.set(`project|${projectId}`, await grantOperations(svc.db, actor.orgId, change.userId, "project", projectId));
  for (const rid of mounted) before.set(`resource|${rid}`, await grantOperations(svc.db, actor.orgId, change.userId, "resource", rid));

  if (actor.role !== "owner") {
    const holdsWrite = [...before.values()].some((ops) => ops.includes("write"));
    const fromNone = before.get(`project|${projectId}`)!.length === 0;
    if (change.level !== "read" || Object.keys(exceptions).length > 0 || !fromNone || holdsWrite) throw forbidden("grant_owner_only", "developers can only give read access to someone who has none");
  }

  // shared folders: never below the level the person's other projects give them (capped by role)
  const floors = floorsOf(await otherProjectGrants(svc, actor.orgId, projectId, change.userId), role);
  if (change.level !== "write" || Object.values(exceptions).some(level => level !== "write")) await svc.ledger(actor.orgId).revokeNativeAuthority(actor.orgId, change.userId);
  const now = svc.nowIso();
  const writes: Array<{ kind: "project" | "resource"; id: string; ops: Operation[] }> = [];
  const want = (kind: "project" | "resource", id: string, level: Level) => {
    const prev = before.get(`${kind}|${id}`) ?? [];
    const next = opsOf(level);
    if (prev.length === next.length && prev.every((o) => next.includes(o))) return;
    writes.push({ kind, id, ops: next });
  };
  want("project", projectId, change.level);
  for (const rid of mounted) {
    const desired: Level = change.level === "none" ? "none" : (exceptions[rid] ?? change.level);
    // the floor only keeps what the person holds: it never raises a folder (nor undoes an exception elsewhere)
    const floor = lower(floors.get(rid)?.level ?? "none", capped(levelOf(before.get(`resource|${rid}`) ?? []), role));
    // a client's Can change only where this project lets the folder be changed (resource grants are
    // org-wide: write on a read-only folder here would let them change it through another project)
    const mt = mounts.find((x) => x.resource_id === rid)!;
    const allowed: Level = role === "client" && !mountWritable(mt) && desired === "write" ? "read" : desired;
    let target: Level = RANK[floor] > RANK[allowed] ? floor : allowed;
    if (actor.role !== "owner") {
      // developers grant only what they can read themselves (as PUT /grants), and never write
      if (!(await canReadResource(svc, actor, rid))) continue;
      if (target === "write") target = "read";
    }
    want("resource", rid, target);
  }

  // no access to the project also ends the person's access to its editions (in the same batch)
  // only on a real move to none (someone already at none keeps an edition-only grant)
  const toNone = change.level === "none" && before.get(`project|${projectId}`)!.length > 0;
  const editionGrants = toNone ? await projectEditionGrantIds(svc, actor.orgId, change.userId, projectId) : [];
  const statements = writes.map((w) =>
    w.ops.length
      ? grantStatement(svc.db, { orgId: actor.orgId, userId: change.userId, scopeKind: w.kind, scopeId: w.id, operations: w.ops, grantedBy: actor.userId, now })
      : svc.db.prepare("DELETE FROM grants WHERE org_id = ? AND user_id = ? AND scope_kind = ? AND scope_id = ?").bind(actor.orgId, change.userId, w.kind, w.id),
  );
  if (editionGrants.length) statements.push(projectEditionGrantsDelete(svc.db, actor.orgId, change.userId, projectId));
  if (statements.length) await svc.db.batch(statements);
  if (writes.length) {
    const lost = writes.some((w) => {
      const prev = before.get(`${w.kind}|${w.id}`) ?? [];
      return (prev.length > 0 && w.ops.length === 0) || (prev.includes("write") && !w.ops.includes("write"));
    });
    if (lost) await revokeUserLeases(svc, actor.orgId, change.userId);
    for (const w of writes)
      await recordEvent(svc, {
        orgId: actor.orgId,
        projectId,
        actor: userRef(actor.userId),
        action: w.ops.length ? "grant.put" : "grant.revoked",
        subjectKind: w.kind,
        subjectId: w.id,
        detail: { userId: change.userId, ...(w.ops.length ? { operations: w.ops } : {}) },
      });
  }
  if (toNone) {
    // revocation blocks future platform access (as DELETE …/editions/:eid/grants)
    await revokeProjectEditionTokens(svc, actor.orgId, change.userId, projectId);
    for (const editionId of editionGrants)
      await recordEvent(svc, { orgId: actor.orgId, projectId, actor: userRef(actor.userId), action: "edition.grant_revoked", subjectKind: "edition", subjectId: editionId, detail: { userId: change.userId } });
  }
  return (await projectAccess(svc, actor.orgId, projectId, actor)).find((p) => p.userId === change.userId)!;
}

/**
 * A folder attached to a project goes to everyone with access to that project, at their project
 * level capped by role (a client's Can change only when the folder is attached writable). Only
 * widens: an existing folder grant is merged, never narrowed.
 */
export async function grantFolderToProjectPeople(svc: Services, o: { orgId: string; projectId: string; resourceId: string; actorId: string; writable?: boolean }): Promise<void> {
  const rows = await svc.db
    .prepare(
      "SELECT g.user_id, g.operations_json, m.role FROM grants g JOIN memberships m ON m.org_id = g.org_id AND m.user_id = g.user_id WHERE g.org_id = ? AND g.scope_kind = 'project' AND g.scope_id = ?",
    )
    .bind(o.orgId, o.projectId)
    .all<{ user_id: string; operations_json: string; role: Role }>();
  const now = svc.nowIso();
  for (const r of rows.results) {
    if (r.role === "owner") continue;
    let level = capped(levelOf(JSON.parse(r.operations_json) as string[]), r.role);
    // a client's Can change reaches the folder only if this project lets it be changed
    if (r.role === "client" && level === "write" && o.writable === false) level = "read";
    if (level === "none") continue;
    const prev = await grantOperations(svc.db, o.orgId, r.user_id, "resource", o.resourceId);
    const next = [...new Set([...prev, ...opsOf(level)])].sort() as Operation[];
    if (next.length === prev.length) continue;
    await grantStatement(svc.db, { orgId: o.orgId, userId: r.user_id, scopeKind: "resource", scopeId: o.resourceId, operations: next, grantedBy: o.actorId, now }).run();
    await recordEvent(svc, { orgId: o.orgId, projectId: o.projectId, actor: userRef(o.actorId), action: "grant.put", subjectKind: "resource", subjectId: o.resourceId, detail: { userId: r.user_id, operations: next, reason: "folder.attached" } });
  }
}

export interface FolderRemovalWrite {
  userId: string;
  prev: Operation[];
  next: Operation[];
}

/**
 * Plans a folder detached from a project (call BEFORE the mount row is deleted, and run the returned
 * statements in the SAME batch as that DELETE): each non-owner with access to that project keeps only
 * what the folder's OTHER mounts (other projects, or another mount of it in this project) give them
 * through their project grants, capped by role; with none, the grant goes. People without access to
 * the project are untouched. Never raises: a narrowing is a plain UPDATE (it never re-creates a grant
 * removed meanwhile) and the target is never above what the person holds.
 */
export async function planFolderRemoval(
  svc: Services,
  o: { orgId: string; projectId: string; mountName: string; resourceId: string; actorId: string },
): Promise<{ statements: D1PreparedStatement[]; writes: FolderRemovalWrite[] }> {
  const people = await svc.db
    .prepare(
      "SELECT g.user_id, m.role FROM grants g JOIN memberships m ON m.org_id = g.org_id AND m.user_id = g.user_id WHERE g.org_id = ? AND g.scope_kind = 'project' AND g.scope_id = ?",
    )
    .bind(o.orgId, o.projectId)
    .all<{ user_id: string; role: Role }>();
  const writes: FolderRemovalWrite[] = [];
  for (const p of people.results) {
    if (p.role === "owner") continue;
    const prev = await grantOperations(svc.db, o.orgId, p.user_id, "resource", o.resourceId);
    if (prev.length === 0) continue;
    // the highest level any OTHER mount of this folder still gives this person (only the mount being removed is excluded)
    const others = await svc.db
      .prepare(
        "SELECT g.operations_json FROM mounts mt JOIN grants g ON g.org_id = mt.org_id AND g.scope_kind = 'project' AND g.scope_id = mt.project_id AND g.user_id = ? " +
          "WHERE mt.org_id = ? AND mt.resource_id = ? AND NOT (mt.project_id = ? AND mt.mount_name = ?)",
      )
      .bind(p.user_id, o.orgId, o.resourceId, o.projectId, o.mountName)
      .all<{ operations_json: string }>();
    let floor: Level = "none";
    for (const r of others.results) {
      const l = capped(levelOf(JSON.parse(r.operations_json) as string[]), p.role);
      if (RANK[l] > RANK[floor]) floor = l;
    }
    const target = lower(floor, capped(levelOf(prev), p.role));
    const next = opsOf(target);
    if (prev.length === next.length && prev.every((x) => next.includes(x))) continue;
    writes.push({ userId: p.user_id, prev, next });
  }
  const statements = writes.map((w) =>
    w.next.length
      ? svc.db
          .prepare("UPDATE grants SET operations_json = ?, granted_by = ? WHERE org_id = ? AND user_id = ? AND scope_kind = 'resource' AND scope_id = ?")
          .bind(JSON.stringify([...w.next].sort()), o.actorId, o.orgId, w.userId, o.resourceId)
      : svc.db.prepare("DELETE FROM grants WHERE org_id = ? AND user_id = ? AND scope_kind = 'resource' AND scope_id = ?").bind(o.orgId, w.userId, o.resourceId),
  );
  return { statements, writes };
}

/** After the detach batch committed: leases end for anyone who lost access or write; grant events. Returns the users whose folder access changed. */
export async function afterFolderRemoval(svc: Services, o: { orgId: string; projectId: string; resourceId: string; actorId: string }, writes: FolderRemovalWrite[]): Promise<string[]> {
  for (const w of writes) {
    if (w.next.length === 0 || (w.prev.includes("write") && !w.next.includes("write"))) await revokeUserLeases(svc, o.orgId, w.userId);
    await recordEvent(svc, {
      orgId: o.orgId,
      projectId: o.projectId,
      actor: userRef(o.actorId),
      action: w.next.length ? "grant.put" : "grant.revoked",
      subjectKind: "resource",
      subjectId: o.resourceId,
      detail: { userId: w.userId, ...(w.next.length ? { operations: w.next } : {}), reason: "folder.detached" },
    });
  }
  return writes.map((w) => w.userId);
}

/**
 * A folder made read-only in one project (`PATCH …/mounts/:mount`): a client keeps Can change on it
 * only where another project they have Can change in still attaches it writable; everyone else's
 * client write on it becomes read. Never widens. Returns the clients whose grant narrowed (their
 * task leases end).
 */
export async function narrowClientWriteOnReadOnly(svc: Services, o: { orgId: string; resourceId: string; actorId: string; projectId: string }): Promise<string[]> {
  const rows = await svc.db
    .prepare("SELECT g.user_id, g.operations_json FROM grants g JOIN memberships m ON m.org_id = g.org_id AND m.user_id = g.user_id AND m.role = 'client' WHERE g.org_id = ? AND g.scope_kind = 'resource' AND g.scope_id = ?")
    .bind(o.orgId, o.resourceId)
    .all<{ user_id: string; operations_json: string }>();
  const narrowed: string[] = [];
  for (const r of rows.results) {
    if (!(JSON.parse(r.operations_json) as string[]).includes("write")) continue;
    const elsewhere = await svc.db
      .prepare(
        "SELECT 1 FROM mounts mt JOIN grants g ON g.org_id = mt.org_id AND g.scope_kind = 'project' AND g.scope_id = mt.project_id AND g.user_id = ? " +
          "WHERE mt.org_id = ? AND mt.resource_id = ? AND mt.operations_json LIKE '%\"write\"%' AND g.operations_json LIKE '%\"write\"%' LIMIT 1",
      )
      .bind(r.user_id, o.orgId, o.resourceId)
      .first();
    if (elsewhere) continue;
    await grantStatement(svc.db, { orgId: o.orgId, userId: r.user_id, scopeKind: "resource", scopeId: o.resourceId, operations: ["read"], grantedBy: o.actorId, now: svc.nowIso() }).run();
    await revokeUserLeases(svc, o.orgId, r.user_id);
    await recordEvent(svc, { orgId: o.orgId, projectId: o.projectId, actor: userRef(o.actorId), action: "grant.put", subjectKind: "resource", subjectId: o.resourceId, detail: { userId: r.user_id, operations: ["read"], reason: "folder.read_only" } });
    narrowed.push(r.user_id);
  }
  return narrowed;
}
