/** Organizations, members/roles, and per-principal grants. */
import { IdSegmentSchema, OperationSchema } from "@commonforge-org/core";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.js";
import { newId } from "../lib/crypto.js";
import { ApiError, badRequest, conflict, forbidden, notFound, readJson } from "../lib/http.js";
import { canReadResource, canReadProject, isDeveloper, orgActor, requireUser } from "../middleware/authz.js";
import { EmailSchema } from "../services/auth.js";
import { isInstanceAdmin } from "../services/admins.js";
import { ROLES, deleteGrant, ensureUser, getProject, getResource, getRole, getRoleInArchived, grantOperations, putGrant } from "../services/directory.js";
import { recordEvent, userRef } from "../services/events.js";
import { revokeEditionAccess } from "../services/editions.js";
import { revokeUserLeases } from "../services/tasks.js";
import { sendMemberInvite } from "../services/invites.js";

export const orgRoutes = new Hono<AppEnv>();

const RoleSchema = z.enum(ROLES);

orgRoutes.post("/orgs", async (c) => {
  const user = requireUser(c);
  if (!isInstanceAdmin(c.get("svc").env, user.email)) throw forbidden("org_create_forbidden", "only the agency's instance admins create organizations");
  const body = await readJson(c, z.object({ name: z.string().trim().min(1).max(128).regex(/^[^\p{Cc}]*$/u, "no control characters") }));
  const svc = c.get("svc");
  const orgId = newId("o", 6);
  const now = svc.nowIso();
  await svc.db.batch([
    svc.db.prepare("INSERT INTO orgs (org_id, name, created_by, created_at) VALUES (?, ?, ?, ?)").bind(orgId, body.name, user.userId, now),
    svc.db.prepare("INSERT INTO memberships (org_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)").bind(orgId, user.userId, now),
  ]);
  await recordEvent(svc, { orgId, actor: userRef(user.userId), action: "org.created", subjectKind: "org", subjectId: orgId });
  return c.json({ orgId, name: body.name, role: "owner" }, 201);
});

orgRoutes.get("/orgs", async (c) => {
  const user = requireUser(c);
  const rows = await c
    .get("svc")
    .db.prepare("SELECT o.org_id, o.name, m.role FROM memberships m JOIN orgs o ON o.org_id = m.org_id WHERE m.user_id = ? AND o.archived_at IS NULL ORDER BY o.name")
    .bind(user.userId)
    .all<{ org_id: string; name: string; role: string }>();
  return c.json({ orgs: rows.results.map((r) => ({ orgId: r.org_id, name: r.name, role: r.role })) });
});

orgRoutes.get("/orgs/:org", async (c) => {
  const actor = await orgActor(c, c.req.param("org"));
  const org = await c.get("svc").db.prepare("SELECT org_id, name, created_at FROM orgs WHERE org_id = ?").bind(actor.orgId).first<{ org_id: string; name: string; created_at: string }>();
  if (!org) throw notFound("organization not found");
  return c.json({ orgId: org.org_id, name: org.name, createdAt: org.created_at, role: actor.role });
});

/** Archive (owner): hidden from every member's lists and 404 to the member API; nothing is deleted. */
orgRoutes.post("/orgs/:org/archive", async (c) => {
  const actor = await orgActor(c, c.req.param("org"), ["owner"]);
  const svc = c.get("svc");
  const now = svc.nowIso();
  await svc.db.prepare("UPDATE orgs SET archived_at = ? WHERE org_id = ? AND archived_at IS NULL").bind(now, actor.orgId).run();
  await recordEvent(svc, { orgId: actor.orgId, actor: userRef(actor.userId), action: "org.archived", subjectKind: "org", subjectId: actor.orgId });
  return c.json({ orgId: actor.orgId, archivedAt: now });
});

/** Unarchive (owner of the archived org); 404 for anyone else and for an org that is not archived. */
orgRoutes.post("/orgs/:org/unarchive", async (c) => {
  const user = requireUser(c);
  const svc = c.get("svc");
  const orgId = c.req.param("org");
  const m = await getRoleInArchived(svc.db, orgId, user.userId);
  if (!m || m.role !== "owner" || !m.archivedAt) throw notFound("organization not found");
  await svc.db.prepare("UPDATE orgs SET archived_at = NULL WHERE org_id = ?").bind(orgId).run();
  await recordEvent(svc, { orgId, actor: userRef(user.userId), action: "org.unarchived", subjectKind: "org", subjectId: orgId });
  return c.json({ orgId, archivedAt: null });
});

orgRoutes.get("/orgs/:org/members", async (c) => {
  const actor = await orgActor(c, c.req.param("org"), ["owner", "developer"]);
  const rows = await c
    .get("svc")
    .db.prepare("SELECT m.user_id, u.email, m.role, m.created_at FROM memberships m JOIN users u ON u.user_id = m.user_id WHERE m.org_id = ? ORDER BY u.email")
    .bind(actor.orgId)
    .all<{ user_id: string; email: string; role: string; created_at: string }>();
  return c.json({ members: rows.results.map((r) => ({ userId: r.user_id, email: r.email, role: r.role, since: r.created_at })) });
});

orgRoutes.post("/orgs/:org/members", async (c) => {
  const actor = await orgActor(c, c.req.param("org"), ["owner"]);
  const body = await readJson(c, z.object({ email: EmailSchema, role: RoleSchema }));
  const svc = c.get("svc");
  const user = await ensureUser(svc.db, body.email, () => newId("u"), svc.nowIso());
  if (await getRole(svc.db, actor.orgId, user.user_id)) throw conflict("already_member", "already a member; use PATCH to change the role");
  await svc.db.prepare("INSERT INTO memberships (org_id, user_id, role, created_at) VALUES (?, ?, ?, ?)").bind(actor.orgId, user.user_id, body.role, svc.nowIso()).run();
  await recordEvent(svc, { orgId: actor.orgId, actor: userRef(actor.userId), action: "member.added", subjectKind: "user", subjectId: user.user_id, detail: { role: body.role } });
  const me = requireUser(c);
  const invite = await sendMemberInvite(svc, { orgId: actor.orgId, inviterId: actor.userId, inviterEmail: me.email, to: user.email, role: body.role });
  return c.json({ userId: user.user_id, email: user.email, role: body.role, invite }, 201);
});

/** Resend a member's invite email (owner). */
orgRoutes.post("/orgs/:org/members/:user/invite", async (c) => {
  const actor = await orgActor(c, c.req.param("org"), ["owner"]);
  const svc = c.get("svc");
  const target = c.req.param("user");
  const row = await svc.db
    .prepare("SELECT u.email, m.role FROM memberships m JOIN users u ON u.user_id = m.user_id WHERE m.org_id = ? AND m.user_id = ?")
    .bind(actor.orgId, target)
    .first<{ email: string; role: string }>();
  if (!row) throw notFound("member not found");
  const invite = await sendMemberInvite(svc, { orgId: actor.orgId, inviterId: actor.userId, inviterEmail: requireUser(c).email, to: row.email, role: row.role });
  if (invite === "rate_limited") throw new ApiError(429, "invite_rate_limited", "too many invites were sent recently; try again later");
  if (invite === "failed") throw new ApiError(502, "invite_failed", "the invite email could not be sent");
  return c.json({ invite });
});

async function ownerCount(db: D1Database, orgId: string): Promise<number> {
  return (await db.prepare("SELECT count(*) AS n FROM memberships WHERE org_id = ? AND role = 'owner'").bind(orgId).first<{ n: number }>())?.n ?? 0;
}

orgRoutes.patch("/orgs/:org/members/:user", async (c) => {
  const actor = await orgActor(c, c.req.param("org"), ["owner"]);
  const body = await readJson(c, z.object({ role: RoleSchema }));
  const svc = c.get("svc");
  const target = c.req.param("user");
  const current = await getRole(svc.db, actor.orgId, target);
  if (!current) throw notFound("member not found");
  if (current === "owner" && body.role !== "owner" && (await ownerCount(svc.db, actor.orgId)) <= 1) throw conflict("last_owner", "an organization needs at least one owner");
  if (current !== body.role) await svc.ledger(actor.orgId).revokeNativeAuthority(actor.orgId, target);
  await svc.db.prepare("UPDATE memberships SET role = ? WHERE org_id = ? AND user_id = ?").bind(body.role, actor.orgId, target).run();
  // a real role change keeps read grants only when the person leaves a developer role or was a
  // client: a client's write is "Can change" through tasks, which would become canonical write for a
  // developer (and a developer's write would become Can change for a client)
  const narrow = current !== body.role && (!isDeveloper(body.role) || current === "client");
  if (narrow) {
    const rows = await svc.db.prepare("SELECT scope_kind, scope_id, operations_json FROM grants WHERE org_id = ? AND user_id = ?").bind(actor.orgId, target).all<{ scope_kind: "project" | "resource"; scope_id: string; operations_json: string }>();
    for (const g of rows.results) {
      const ops = (JSON.parse(g.operations_json) as string[]).filter((o) => o === "read");
      if (ops.length === 0) await deleteGrant(svc.db, actor.orgId, target, g.scope_kind, g.scope_id);
      else await putGrant(svc.db, { orgId: actor.orgId, userId: target, scopeKind: g.scope_kind, scopeId: g.scope_id, operations: ["read"], grantedBy: actor.userId, now: svc.nowIso() });
    }
  }
  if (narrow) await revokeUserLeases(svc, actor.orgId, target);
  // Task 21 review M-7: viewers hold no edition grants
  if (body.role === "viewer") await revokeEditionAccess(svc, actor.orgId, target);
  await recordEvent(svc, { orgId: actor.orgId, actor: userRef(actor.userId), action: "member.role_changed", subjectKind: "user", subjectId: target, detail: { from: current, to: body.role } });
  return c.json({ userId: target, role: body.role });
});

orgRoutes.delete("/orgs/:org/members/:user", async (c) => {
  const actor = await orgActor(c, c.req.param("org"), ["owner"]);
  const svc = c.get("svc");
  const target = c.req.param("user");
  const current = await getRole(svc.db, actor.orgId, target);
  if (!current) throw notFound("member not found");
  if (current === "owner" && (await ownerCount(svc.db, actor.orgId)) <= 1) throw conflict("last_owner", "an organization needs at least one owner");
  await svc.ledger(actor.orgId).revokeNativeAuthority(actor.orgId, target);
  await svc.db.batch([
    svc.db.prepare("DELETE FROM memberships WHERE org_id = ? AND user_id = ?").bind(actor.orgId, target),
    svc.db.prepare("DELETE FROM grants WHERE org_id = ? AND user_id = ?").bind(actor.orgId, target),
  ]);
  await revokeUserLeases(svc, actor.orgId, target);
  await revokeEditionAccess(svc, actor.orgId, target);
  await recordEvent(svc, { orgId: actor.orgId, actor: userRef(actor.userId), action: "member.removed", subjectKind: "user", subjectId: target });
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------------------- grants

const GrantSchema = z.object({
  userId: IdSegmentSchema,
  scope: z.object({ kind: z.enum(["project", "resource"]), id: IdSegmentSchema }),
  operations: z.array(OperationSchema).min(1),
});

/**
 * Grant a member access to a project (visibility of the project and its mount list) or a resource
 * (its contents). Owners grant anything; developers grant **read** on scopes they can read.
 * Viewers only ever hold read grants; a client's write means "Can change" through tasks.
 */
orgRoutes.put("/orgs/:org/grants", async (c) => {
  const actor = await orgActor(c, c.req.param("org"), ["owner", "developer"]);
  const body = await readJson(c, GrantSchema);
  const svc = c.get("svc");
  const targetRole = await getRole(svc.db, actor.orgId, body.userId);
  if (!targetRole) throw notFound("member not found");
  const ops = [...new Set(body.operations)];
  // a client's write is "Can change" through tasks (canStageWrite); viewers only ever read
  if (ops.includes("write") && !isDeveloper(targetRole) && targetRole !== "client") throw badRequest("grant_exceeds_role", `a ${targetRole} can only hold read grants`);
  if (body.scope.kind === "project") {
    if (!(await getProject(svc.db, actor.orgId, body.scope.id)) || !(await canReadProject(svc, actor, body.scope.id))) throw notFound("project not found");
  } else if (!(await getResource(svc.db, actor.orgId, body.scope.id)) || !(await canReadResource(svc, actor, body.scope.id))) {
    throw notFound("resource not found");
  }
  if (actor.role !== "owner") {
    if (ops.includes("write")) throw badRequest("grant_exceeds_role", "only owners grant write");
    // M-2: developers only add read; they never narrow an existing grant
    const existing = await grantOperations(svc.db, actor.orgId, body.userId, body.scope.kind, body.scope.id);
    if (existing.includes("write")) throw forbidden("grant_owner_only", "only owners change a grant that includes write");
    for (const o of existing) if (!ops.includes(o)) ops.push(o);
  }
  const before = await grantOperations(svc.db, actor.orgId, body.userId, body.scope.kind, body.scope.id);
  if (before.some(op => !ops.includes(op))) await svc.ledger(actor.orgId).revokeNativeAuthority(actor.orgId, body.userId);
  await putGrant(svc.db, { orgId: actor.orgId, userId: body.userId, scopeKind: body.scope.kind, scopeId: body.scope.id, operations: ops, grantedBy: actor.userId, now: svc.nowIso() });
  // N-2: narrowing write → read is lease loss, like a revocation
  if (before.includes("write") && !ops.includes("write")) await revokeUserLeases(svc, actor.orgId, body.userId);
  await recordEvent(svc, { orgId: actor.orgId, actor: userRef(actor.userId), action: "grant.put", subjectKind: body.scope.kind, subjectId: body.scope.id, detail: { userId: body.userId, operations: ops } });
  return c.json({ userId: body.userId, scope: body.scope, operations: ops.sort() });
});

orgRoutes.delete("/orgs/:org/grants", async (c) => {
  const actor = await orgActor(c, c.req.param("org"), ["owner"]);
  const body = await readJson(c, GrantSchema.omit({ operations: true }));
  const svc = c.get("svc");
  await svc.ledger(actor.orgId).revokeNativeAuthority(actor.orgId, body.userId);
  if (!(await deleteGrant(svc.db, actor.orgId, body.userId, body.scope.kind, body.scope.id))) throw notFound("grant not found");
  await revokeUserLeases(svc, actor.orgId, body.userId);
  await recordEvent(svc, { orgId: actor.orgId, actor: userRef(actor.userId), action: "grant.revoked", subjectKind: body.scope.kind, subjectId: body.scope.id, detail: { userId: body.userId } });
  return c.json({ ok: true });
});

orgRoutes.get("/orgs/:org/grants", async (c) => {
  const actor = await orgActor(c, c.req.param("org"));
  const svc = c.get("svc");
  const who = c.req.query("userId") ?? actor.userId;
  if (who !== actor.userId && actor.role !== "owner") throw notFound("member not found");
  const rows = await svc.db
    .prepare("SELECT scope_kind, scope_id, operations_json, granted_by, created_at FROM grants WHERE org_id = ? AND user_id = ? ORDER BY scope_kind, scope_id")
    .bind(actor.orgId, who)
    .all<{ scope_kind: string; scope_id: string; operations_json: string; granted_by: string; created_at: string }>();
  return c.json({
    userId: who,
    grants: rows.results.map((g) => ({ scope: { kind: g.scope_kind, id: g.scope_id }, operations: JSON.parse(g.operations_json) as string[], grantedBy: g.granted_by, createdAt: g.created_at })),
  });
});
