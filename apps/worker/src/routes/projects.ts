/** Projects, mounts, server-owned policy, snapshots and the project file browser. */
import {
  DependencyModeSchema,
  IdSegmentSchema,
  MountNameSchema,
  OperationSchema,
  RevisionIdSchema,
  checkPath,
  parseRevisionId,
  type AssetManifest,
  type RevisionId,
} from "@commonforge-org/core";
import { LFS_POINTER_MAX_BYTES, parseLfsPointer } from "@commonforge-org/runner-protocol";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.js";
import { gitBlobSha1, newId } from "../lib/crypto.js";
import { ApiError, badRequest, conflict, forbidden, notFound, parseQuery, readJson } from "../lib/http.js";
import { canReadResource, canWriteResource, isDeveloper, orgActor, readableMount, readableProject, seesCanonical } from "../middleware/authz.js";
import { stagingIssues } from "../services/staging-policy.js";
import { ROLES, getMount, getProject, getResource, listMounts, mountOperations, projectPolicy, putGrant, type ProjectPolicy } from "../services/directory.js";
import { PolicySchema, assertReleaseAllowed, isLedgerConflict, policyIssues } from "../services/policy.js";
import { afterFolderRemoval, grantFolderToProjectPeople, narrowClientWriteOnReadOnly, planFolderRemoval, projectAccess, setProjectAccess } from "../services/access.js";
import { nudgePromotions } from "../services/promotions.js";
import { settleBaseline } from "../services/staging.js";
import { recordEvent, userRef } from "../services/events.js";
import { createResource, resourceRef } from "../services/resources.js";
import { projectFolders } from "../services/folders.js";
import { retryFolderInit, startFolderInit } from "../services/folder-init.js";
import { presentSnapshot, projectSnapshot } from "../services/snapshot.js";
import { writeMountIssue } from "../services/task-create.js";
import { pointerObjects, servableObject } from "../services/lfs-store.js";
import { verifiedObjectBody } from "../services/lfs-hash.js";

export const projectRoutes = new Hono<AppEnv>();

// G1 freezes source membership at enablement; mutable legacy folder/policy workflows
// cannot detach source from an accepted manifest or activate shared staging.
projectRoutes.use('/orgs/:org/projects/:pid/*', async (c,next) => {
  if (c.req.method === 'GET') return next();
  const path=new URL(c.req.url).pathname;
  if (!/\/(folders|mounts)(\/|$)/.test(path)) return next();
  const actor=await orgActor(c,c.req.param('org')!,['owner','developer']);
  if (await c.get('svc').ledger(actor.orgId).getNativeProject(c.req.param('pid')!)) throw conflict('project_mode_unsupported','source membership is fixed for this agent-native project');
  return next();
});

projectRoutes.post("/orgs/:org/projects", async (c) => {
  const actor = await orgActor(c, c.req.param("org"), ["owner", "developer"]);
  const body = await readJson(c, z.object({ name: z.string().trim().min(1).max(128) }));
  const svc = c.get("svc");
  const projectId = newId("p", 6);
  const now = svc.nowIso();
  await svc.db.prepare("INSERT INTO projects (org_id, project_id, name, created_by, created_at) VALUES (?, ?, ?, ?, ?)").bind(actor.orgId, projectId, body.name, actor.userId, now).run();
  if (actor.role !== "owner") await putGrant(svc.db, { orgId: actor.orgId, userId: actor.userId, scopeKind: "project", scopeId: projectId, operations: ["read", "write"], grantedBy: actor.userId, now });
  await recordEvent(svc, { orgId: actor.orgId, projectId, actor: userRef(actor.userId), action: "project.created", subjectKind: "project", subjectId: projectId, clientVisible: true });
  return c.json({ projectId, name: body.name }, 201);
});

projectRoutes.get("/orgs/:org/projects", async (c) => {
  const actor = await orgActor(c, c.req.param("org"));
  const svc = c.get("svc");
  const rows =
    actor.role === "owner"
      ? await svc.db.prepare("SELECT project_id, name, created_at FROM projects WHERE org_id = ? ORDER BY name").bind(actor.orgId).all<{ project_id: string; name: string; created_at: string }>()
      : await svc.db
          .prepare(
            "SELECT p.project_id, p.name, p.created_at FROM projects p JOIN grants g ON g.org_id = p.org_id AND g.scope_kind = 'project' AND g.scope_id = p.project_id AND g.user_id = ? WHERE p.org_id = ? ORDER BY p.name",
          )
          .bind(actor.userId, actor.orgId)
          .all<{ project_id: string; name: string; created_at: string }>();
  return c.json({ projects: rows.results.map((p) => ({ projectId: p.project_id, name: p.name, createdAt: p.created_at })) });
});

projectRoutes.get("/orgs/:org/projects/:pid", async (c) => {
  const actor = await orgActor(c, c.req.param("org"));
  const svc = c.get("svc");
  const project = await readableProject(svc, actor, c.req.param("pid"));
  const mounts = [];
  for (const m of await listMounts(svc.db, actor.orgId, project.project_id)) {
    // AT-16 / FR-14: a mount whose resource the caller cannot read is not even named
    if (!(await canReadResource(svc, actor, m.resource_id))) continue;
    const r = await getResource(svc.db, actor.orgId, m.resource_id);
    // whether the Files tab offers write actions (plan folders phase 3); the write routes still check for themselves
    const canWrite = isDeveloper(actor.role) && (await canWriteResource(svc, actor, m.resource_id));
    // whether the caller may start a task writing to this folder (the New task form): createTask's own rule
    const canStartTask = !!r && (await writeMountIssue(svc, actor, project, m, r)) === null;
    mounts.push({ mountName: m.mount_name, resourceId: m.resource_id, provider: r?.provider, resourceName: r?.name, mode: m.mode, operations: mountOperations(m), canWrite, canStartTask });
  }
  const last = isDeveloper(actor.role)
    ? await svc.db
        .prepare("SELECT e.at, u.email FROM events e LEFT JOIN users u ON u.user_id = json_extract(e.actor_json, '$.id') WHERE e.org_id = ? AND e.project_id = ? AND e.action = 'project.policy_changed' ORDER BY e.seq DESC LIMIT 1")
        .bind(actor.orgId, project.project_id)
        .first<{ at: string; email: string | null }>()
    : null;
  return c.json({
    projectId: project.project_id,
    name: project.name,
    membershipRevision: project.membership_revision,
    policyRevision: project.policy_revision,
    mounts,
    ...(isDeveloper(actor.role) ? { policy: projectPolicy(project) } : {}),
    ...(last ? { policyChanged: { at: last.at, by: last.email } } : {}),
  });
});

/** Access to one project per member (admin screens §5): owners and developers who can read it; non-owners see only the folders they can read. */
projectRoutes.get("/orgs/:org/projects/:pid/access", async (c) => {
  const actor = await orgActor(c, c.req.param("org"), ["owner", "developer"]);
  const svc = c.get("svc");
  const project = await readableProject(svc, actor, c.req.param("pid"));
  return c.json({ people: await projectAccess(svc, actor.orgId, project.project_id, actor) });
});

const LevelSchema = z.enum(["none", "read", "write"]);

/** Set one person's project level and folder exceptions; all grant writes in one batch. */
projectRoutes.put("/orgs/:org/projects/:pid/access", async (c) => {
  const actor = await orgActor(c, c.req.param("org"), ["owner", "developer"]);
  const body = await readJson(c, z.object({ userId: IdSegmentSchema, level: LevelSchema, folders: z.record(z.string().min(1), LevelSchema).optional() }));
  const svc = c.get("svc");
  const project = await readableProject(svc, actor, c.req.param("pid"));
  return c.json(await setProjectAccess(svc, actor, project.project_id, body));
});

/** A project's folders (Settings → Folders): owners, and developers who can read the project. */
projectRoutes.get("/orgs/:org/projects/:pid/folders", async (c) => {
  const actor = await orgActor(c, c.req.param("org"), ["owner", "developer"]);
  const svc = c.get("svc");
  const project = await readableProject(svc, actor, c.req.param("pid"));
  return c.json({ folders: await projectFolders(svc, actor, project.project_id) });
});

/**
 * Add folder (folders phase 4, spec §8–§9): a new git folder attached to the project in one step
 * (owners, and developers who can read the project). Attaching an EXISTING folder stays owner-only
 * (POST …/mounts): it widens who sees that folder. `kind` is optional and ignored (P4-4): `"files"`
 * and `"code"` give the same folder. The answer comes before the first version exists: the runner's
 * `init-folder` job makes it (services/folder-init.ts) and the folder list shows `settingUp` until
 * then. File collections (`r2-assets`) are still made through POST /resources + POST …/mounts.
 */
projectRoutes.post("/orgs/:org/projects/:pid/folders", async (c) => {
  const actor = await orgActor(c, c.req.param("org"), ["owner", "developer"]);
  const body = await readJson(c, z.object({ name: MountNameSchema, kind: z.enum(["files", "code"]).optional() }));
  const svc = c.get("svc");
  const project = await readableProject(svc, actor, c.req.param("pid"));
  if (await getMount(svc.db, actor.orgId, project.project_id, body.name)) throw conflict("mount_exists", `this project already has a folder named ${body.name}`);
  const r = await createResource(svc, actor, { name: body.name, provider: "artifacts" }, userRef(actor.userId));
  await recordEvent(svc, { orgId: actor.orgId, actor: userRef(actor.userId), action: "resource.created", subjectKind: "resource", subjectId: r.resource_id, resourceIds: [r.resource_id], detail: { provider: r.provider, name: r.name } });
  const ins = await svc.db
    .prepare("INSERT OR IGNORE INTO mounts (org_id, project_id, mount_name, resource_id, mode, operations_json, created_at) VALUES (?, ?, ?, ?, 'must-match-accepted', '[\"read\",\"write\"]', ?)")
    .bind(actor.orgId, project.project_id, body.name, r.resource_id, svc.nowIso())
    .run();
  if ((ins.meta.changes ?? 0) === 0) throw conflict("mount_exists", `this project already has a folder named ${body.name}`);
  await svc.db.prepare("UPDATE projects SET membership_revision = membership_revision + 1 WHERE org_id = ? AND project_id = ?").bind(actor.orgId, project.project_id).run();
  await recordEvent(svc, { orgId: actor.orgId, projectId: project.project_id, actor: userRef(actor.userId), action: "mount.added", subjectKind: "project", subjectId: project.project_id, resourceIds: [r.resource_id], detail: { mountName: body.name, resourceId: r.resource_id } });
  await grantFolderToProjectPeople(svc, { orgId: actor.orgId, projectId: project.project_id, resourceId: r.resource_id, actorId: actor.userId });
  await startFolderInit(svc, { orgId: actor.orgId, resourceId: r.resource_id, projectId: project.project_id, mountName: body.name, requestedBy: actor.userId });
  return c.json({ mountName: body.name, resourceId: r.resource_id }, 201);
});

/**
 * Try again (P4-9): a folder whose setup failed starts it over. Owners, and developers with write on
 * the folder. 409 `setup_not_failed` unless its setup failed (still setting up, done, or a folder
 * that was attached rather than added here).
 */
projectRoutes.post("/orgs/:org/projects/:pid/folders/:mount/setup/retry", async (c) => {
  const actor = await orgActor(c, c.req.param("org"), ["owner", "developer"]);
  const svc = c.get("svc");
  const { project, mount, resource } = await readableMount(svc, actor, c.req.param("pid"), c.req.param("mount"));
  if (actor.role !== "owner" && !(await canWriteResource(svc, actor, resource.resource_id))) throw forbidden("no_write_grant", "trying the setup again needs write on the folder");
  await retryFolderInit(svc, actor.orgId, resource.resource_id);
  await recordEvent(svc, { orgId: actor.orgId, projectId: project.project_id, actor: userRef(actor.userId), action: "resource.init_retried", subjectKind: "resource", subjectId: resource.resource_id, resourceIds: [resource.resource_id], detail: { mountName: mount.mount_name } });
  return c.json({ state: "empty", settingUp: true }, 202);
});

/**
 * Server-owned policy, **owner only** (AT-38/FR-20: a developer must not weaken the checks or
 * approval roles that gate their own change). Repository files never become policy (AT-18).
 */
projectRoutes.put("/orgs/:org/projects/:pid/policy", async (c) => {
  const actor = await orgActor(c, c.req.param("org"), ["owner"]);
  const { expectedRevision, ...body } = await readJson(c, PolicySchema.extend({ expectedRevision: z.number().int().nonnegative().optional() }));
  const svc = c.get("svc");
  const project = await readableProject(svc, actor, c.req.param("pid"));
  if (expectedRevision !== undefined && project.policy_revision !== expectedRevision) throw conflict("policy_changed", "the policy changed since you opened it", { policyRevision: project.policy_revision });
  if (body.release) await assertReleaseAllowed(svc, actor.orgId, project.project_id, body.release);
  if (body.staging) {
    const issues = stagingIssues(body.staging, body.release, body.approvalRoles);
    if (issues.length > 0) throw badRequest("invalid_policy", issues[0]!.message, { issues });
  }
  if (body.staging && await svc.ledger(actor.orgId).getNativeProject(project.project_id)) throw conflict("project_mode_unsupported", "shared staging is unavailable for agent-native projects");
  const policy: ProjectPolicy = body;
  const rev = project.policy_revision + 1;
  const changed = async (message: string) => {
    const now = await getProject(svc.db, actor.orgId, project.project_id);
    return conflict("policy_changed", message, { policyRevision: now?.policy_revision ?? rev });
  };
  // ledger first: it refuses a decrease; the directory follows. The ledger accepts the same revision
  // more than once, so a concurrent save that loses the conditional UPDATE below leaves the ledger at
  // `rev`, and the next successful save, also at `rev`, is accepted. A refused decrease means another
  // save got further meanwhile: that is the same conflict as a stale expectedRevision.
  try {
    await svc.ledger(actor.orgId).setPolicyRevision(actor.orgId, project.project_id, rev);
  } catch (e) {
    if (isLedgerConflict(e)) throw await changed("the policy changed while saving");
    throw e;
  }
  const upd = await svc.db
    .prepare("UPDATE projects SET policy_json = ?, policy_revision = ? WHERE org_id = ? AND project_id = ? AND policy_revision = ?")
    .bind(JSON.stringify(policy), rev, actor.orgId, project.project_id, project.policy_revision)
    .run();
  if ((upd.meta.changes ?? 0) === 0) throw await changed("the policy changed while saving");
  await recordEvent(svc, { orgId: actor.orgId, projectId: project.project_id, actor: userRef(actor.userId), action: "project.policy_changed", subjectKind: "project", subjectId: project.project_id, detail: { policyRevision: rev } });
  // staging phase 2: promotions waiting for a developer (or cleared) are rebuilt and re-gated on the
  // new policy. The policy is saved: a failed nudge only delays that (the gate compares revisions too).
  try {
    await nudgePromotions(svc, actor.orgId, project.project_id);
  } catch (e) {
    console.error(`policy saved; nudging promotions failed: ${e instanceof Error ? e.message.slice(0, 300) : String(e)}`);
  }
  // staging phase 2b (B6): turning staging on while production already runs `main` establishes the
  // owner baseline now (never deleted: turning staging off keeps it), and landings still waiting for
  // it get their build. Same failure rule as above (GC repeats it).
  if (body.staging) {
    try {
      await settleBaseline(svc, actor.orgId, project.project_id);
    } catch (e) {
      console.error(`policy saved; checking the staging baseline failed: ${e instanceof Error ? e.message.slice(0, 300) : String(e)}`);
    }
  }
  return c.json({ projectId: project.project_id, policyRevision: rev, policy });
});

/** Validate a full policy document without saving (owner): the same checks as PUT …/policy, as issues. */
projectRoutes.post("/orgs/:org/projects/:pid/policy/validate", async (c) => {
  const actor = await orgActor(c, c.req.param("org"), ["owner"]);
  const raw = await readJson(c, z.unknown());
  const svc = c.get("svc");
  const project = await readableProject(svc, actor, c.req.param("pid"));
  const { issues } = await policyIssues(svc, actor.orgId, project, raw);
  return c.json({ ok: issues.length === 0, issues });
});

projectRoutes.post("/orgs/:org/projects/:pid/mounts", async (c) => {
  const actor = await orgActor(c, c.req.param("org"), ["owner"]);
  const body = await readJson(
    c,
    z.object({
      mountName: MountNameSchema,
      resourceId: z.string().min(1),
      mode: DependencyModeSchema.default("must-match-accepted"),
      operations: z.array(OperationSchema).min(1).default(["read", "write"]),
    }),
  );
  const svc = c.get("svc");
  const project = await readableProject(svc, actor, c.req.param("pid"));
  const resource = await getResource(svc.db, actor.orgId, body.resourceId);
  if (!resource || !(await canReadResource(svc, actor, body.resourceId))) throw notFound("resource not found");
  const ops = [...new Set([...body.operations, "read" as const])].sort();
  if (ops.includes("write") && !(await canWriteResource(svc, actor, body.resourceId))) throw forbidden("no_write_grant", "mounting for write needs a write grant on the resource");
  const now = svc.nowIso();
  // one mount per folder per project: a second one would make detaching either of them ambiguous
  const r = await svc.db
    .prepare(
      "INSERT OR IGNORE INTO mounts (org_id, project_id, mount_name, resource_id, mode, operations_json, created_at) SELECT ?, ?, ?, ?, ?, ?, ? " +
        "WHERE NOT EXISTS (SELECT 1 FROM mounts WHERE org_id = ? AND project_id = ? AND resource_id = ?)",
    )
    .bind(actor.orgId, project.project_id, body.mountName, body.resourceId, body.mode, JSON.stringify(ops), now, actor.orgId, project.project_id, body.resourceId)
    .run();
  if ((r.meta.changes ?? 0) === 0) {
    if (await getMount(svc.db, actor.orgId, project.project_id, body.mountName)) throw conflict("mount_exists", `mount ${body.mountName} already exists`);
    throw conflict("folder_already_attached", "this folder is already attached to this project");
  }
  await svc.db.prepare("UPDATE projects SET membership_revision = membership_revision + 1 WHERE org_id = ? AND project_id = ?").bind(actor.orgId, project.project_id).run();
  await recordEvent(svc, { orgId: actor.orgId, projectId: project.project_id, actor: userRef(actor.userId), action: "mount.added", subjectKind: "project", subjectId: project.project_id, resourceIds: [body.resourceId], detail: { mountName: body.mountName, resourceId: body.resourceId } });
  await grantFolderToProjectPeople(svc, { orgId: actor.orgId, projectId: project.project_id, resourceId: body.resourceId, actorId: actor.userId, writable: ops.includes("write") });
  return c.json({ mountName: body.mountName, resourceId: body.resourceId, mode: body.mode, operations: ops }, 201);
});

/**
 * Whether a folder may be changed in this project (owner only, as attaching): `{ writable }` sets
 * the mount's operations to read+write or read. Read-only: no new task may change it here (for
 * anyone), client agents stop changing it in tasks already started (`canStageWrite` reads the
 * mount; their leases end), and a client keeps Can change on it only through another project that
 * still lets it be changed. Developers' tasks already started keep their write grant. Writable:
 * owners and developers with write may change it; clients need Can change from the access settings.
 */
projectRoutes.patch("/orgs/:org/projects/:pid/mounts/:mount", async (c) => {
  const actor = await orgActor(c, c.req.param("org"), ["owner"]);
  const body = await readJson(c, z.object({ writable: z.boolean() }));
  const svc = c.get("svc");
  const project = await readableProject(svc, actor, c.req.param("pid"));
  const mount = await getMount(svc.db, actor.orgId, project.project_id, c.req.param("mount"));
  if (!mount) throw notFound("mount not found");
  const ops = body.writable ? ["read", "write"] : ["read"];
  const was = (JSON.parse(mount.operations_json) as string[]).includes("write");
  if (was !== body.writable) {
    await svc.db.batch([
      svc.db.prepare("UPDATE mounts SET operations_json = ? WHERE org_id = ? AND project_id = ? AND mount_name = ?").bind(JSON.stringify(ops), actor.orgId, project.project_id, mount.mount_name),
      svc.db.prepare("UPDATE projects SET membership_revision = membership_revision + 1 WHERE org_id = ? AND project_id = ?").bind(actor.orgId, project.project_id),
    ]);
    await recordEvent(svc, { orgId: actor.orgId, projectId: project.project_id, actor: userRef(actor.userId), action: "mount.changed", subjectKind: "project", subjectId: project.project_id, resourceIds: [mount.resource_id], detail: { mountName: mount.mount_name, resourceId: mount.resource_id, operations: ops } });
  }
  // always on read-only (safe to repeat): a retry after a narrowing that failed part-way finishes it
  const narrowed = body.writable ? [] : await narrowClientWriteOnReadOnly(svc, { orgId: actor.orgId, projectId: project.project_id, resourceId: mount.resource_id, actorId: actor.userId });
  return c.json({ mountName: mount.mount_name, resourceId: mount.resource_id, mode: mount.mode, operations: ops, changed: narrowed });
});

/**
 * Owner only (project membership is policy). Removing a mount never deletes the resource (PRD §4.4).
 * The mount DELETE, the revision bump and every grant write are one batch: a failure leaves all of it.
 */
projectRoutes.delete("/orgs/:org/projects/:pid/mounts/:mount", async (c) => {
  const actor = await orgActor(c, c.req.param("org"), ["owner"]);
  const svc = c.get("svc");
  const project = await readableProject(svc, actor, c.req.param("pid"));
  const mount = await getMount(svc.db, actor.orgId, project.project_id, c.req.param("mount"));
  if (!mount) throw notFound("mount not found");
  const o = { orgId: actor.orgId, projectId: project.project_id, mountName: mount.mount_name, resourceId: mount.resource_id, actorId: actor.userId };
  const plan = await planFolderRemoval(svc, o);
  const [del] = await svc.db.batch([
    svc.db.prepare("DELETE FROM mounts WHERE org_id = ? AND project_id = ? AND mount_name = ?").bind(actor.orgId, project.project_id, mount.mount_name),
    svc.db.prepare("UPDATE projects SET membership_revision = membership_revision + 1 WHERE org_id = ? AND project_id = ?").bind(actor.orgId, project.project_id),
    ...plan.statements,
  ]);
  // a concurrent detach got there first (its grant writes were the same ones)
  if ((del!.meta.changes ?? 0) === 0) throw notFound("mount not found");
  await recordEvent(svc, { orgId: actor.orgId, projectId: project.project_id, actor: userRef(actor.userId), action: "mount.removed", subjectKind: "project", subjectId: project.project_id, resourceIds: [mount.resource_id], detail: { mountName: mount.mount_name, resourceId: mount.resource_id } });
  const changed = await afterFolderRemoval(svc, o, plan.writes);
  return c.json({ ok: true, changed });
});

projectRoutes.get("/orgs/:org/projects/:pid/snapshot", async (c) => {
  const actor = await orgActor(c, c.req.param("org"));
  const svc = c.get("svc");
  const project = await readableProject(svc, actor, c.req.param("pid"));
  const snap = await projectSnapshot(svc, project);
  if (actor.role === "owner") return c.json(snap);
  const readable = new Set<string>();
  for (const e of snap.entries) if (await canReadResource(svc, actor, e.resourceId)) readable.add(e.resourceId);
  return c.json(presentSnapshot(snap, readable));
});

// ------------------------------------------------------------------------------------- browser

const BrowseQuery = z.object({
  mount: z.string().min(1),
  path: z.string().default(""),
  revision: RevisionIdSchema.optional(),
});

/** Resolve the revision to browse: the accepted head, or (developers only) an explicit revision. */
async function browseRevision(c: Parameters<typeof orgActor>[0], orgId: string, resourceId: string, role: (typeof ROLES)[number], requested?: RevisionId): Promise<RevisionId> {
  if (requested) {
    if (!seesCanonical(role)) throw forbidden("revision_not_allowed", "clients and viewers browse the accepted version only");
    return requested;
  }
  const head = await c.get("svc").ledger(orgId).getHead(resourceId);
  if (!head) throw conflict("no_accepted_head", "the resource has no accepted version yet");
  return head.revisionId;
}

async function manifestFor(svc: AppEnv["Variables"]["svc"], orgId: string, resourceId: string, rev: RevisionId): Promise<AssetManifest> {
  const p = parseRevisionId(rev);
  if (p.kind !== "r2m") throw badRequest("revision_mismatch", "not an asset manifest revision");
  const m = await (await svc.assets(orgId)).readManifest(p.manifestId, resourceId);
  if (!m) throw notFound("manifest not found");
  return m;
}

projectRoutes.get("/orgs/:org/projects/:pid/tree", async (c) => {
  const actor = await orgActor(c, c.req.param("org"));
  const q = parseQuery(c, BrowseQuery);
  const svc = c.get("svc");
  const { resource, mount } = await readableMount(svc, actor, c.req.param("pid"), q.mount);
  const path = q.path === "" ? "" : checkPath(q.path).ok ? (checkPath(q.path) as { path: string }).path : null;
  if (path === null) throw badRequest("invalid_path", "invalid path");
  const rev = await browseRevision(c, actor.orgId, resource.resource_id, actor.role, q.revision);
  let entries: Array<{ path: string; type: string; size?: number; lfs?: true }>;
  if (resource.provider === "artifacts") {
    const listed = await svc.provider().listTree(resourceRef(resource), rev, path);
    // LFS files by their pointer's blob id (plan phase 3, P3-2): one lookup per listing; staged objects only at an explicit revision
    const files = listed.filter((e) => e.type === "file" && e.oid !== undefined).map((e) => e.oid!);
    const lfs = files.length ? await pointerObjects(svc, { orgId: actor.orgId, resourceId: resource.resource_id, oids: files, staged: q.revision !== undefined }) : new Map();
    entries = listed.map((e) => {
      const obj = e.type === "file" && e.oid !== undefined ? lfs.get(e.oid) : undefined;
      if (obj) return { path: e.path, type: "file", size: obj.size, lfs: true as const };
      return { path: e.path, type: e.type, ...(e.size !== undefined ? { size: e.size } : {}) };
    });
  } else {
    const m = await manifestFor(svc, actor.orgId, resource.resource_id, rev);
    const prefix = path === "" ? "" : `${path}/`;
    const seen = new Map<string, { path: string; type: string; size?: number }>();
    for (const e of m.entries) {
      if (!e.path.startsWith(prefix)) continue;
      const rest = e.path.slice(prefix.length);
      const i = rest.indexOf("/");
      const child = prefix + (i < 0 ? rest : rest.slice(0, i));
      if (!seen.has(child)) seen.set(child, i < 0 ? { path: child, type: "file", size: e.size } : { path: child, type: "dir" });
    }
    entries = [...seen.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
  }
  return c.json({ mountName: mount.mount_name, resourceId: resource.resource_id, provider: resource.provider, revisionId: rev, path, entries });
});

projectRoutes.get("/orgs/:org/projects/:pid/file", async (c) => {
  const actor = await orgActor(c, c.req.param("org"));
  const q = parseQuery(c, BrowseQuery);
  const svc = c.get("svc");
  const { resource } = await readableMount(svc, actor, c.req.param("pid"), q.mount);
  const checked = checkPath(q.path);
  if (!checked.ok) throw badRequest("invalid_path", "invalid path");
  const rev = await browseRevision(c, actor.orgId, resource.resource_id, actor.role, q.revision);
  const headers = { "x-commonforge-revision": rev, "content-type": "application/octet-stream", "x-content-type-options": "nosniff", "content-disposition": "attachment" };
  if (resource.provider === "artifacts") {
    const bytes = await svc.provider().readFile(resourceRef(resource), rev, checked.path);
    if (!bytes) throw notFound("file not found");
    // an LFS pointer: people get the real file, never the pointer (spec §3; plan phase 3, P3-1)
    const pointer = bytes.length <= LFS_POINTER_MAX_BYTES ? parseLfsPointer(new TextDecoder().decode(bytes)) : null;
    if (pointer) {
      const row = await servableObject(svc, { orgId: actor.orgId, resourceId: resource.resource_id, oid: pointer.sha256, staged: q.revision !== undefined });
      if (row) {
        // pinned to the etag the hash step verified, as the LFS download route is
        const obj = await verifiedObjectBody(svc, row);
        if (!obj) throw new ApiError(404, "object_missing", "the file's stored object is missing");
        // no x-commonforge-blob: LFS files are not edited in place
        return new Response(obj.body, { headers: { ...headers, "x-commonforge-lfs": row.sha256!, "x-commonforge-sha256": row.sha256!, "content-length": String(row.size) } });
      }
      // an object CommonForge never received (an imported repository's): the pointer text, marked
      return new Response(bytes, { headers: { ...headers, "x-commonforge-lfs": "missing", "x-commonforge-blob": await gitBlobSha1(bytes) } });
    }
    // the blob id an edit sends back as `baseBlob` (routes/file-changes.ts)
    return new Response(bytes, { headers: { ...headers, "x-commonforge-blob": await gitBlobSha1(bytes) } });
  }
  const m = await manifestFor(svc, actor.orgId, resource.resource_id, rev);
  const entry = m.entries.find((e) => e.path === checked.path);
  if (!entry) throw notFound("file not found");
  const obj = await svc.env.COMMONFORGE_ASSETS.get(entry.objectKey);
  if (!obj) throw notFound("object missing");
  return new Response(obj.body, { headers: { ...headers, "x-commonforge-sha256": entry.sha256, "content-length": String(entry.size) } });
});

