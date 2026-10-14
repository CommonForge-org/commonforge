/** Intake: public URL import and ZIP upload → inventory → placement plan → confirm. */
import { IdSegmentSchema, MountNameSchema } from "@commonforge-org/core";
import { IncrementalSha256 } from "@commonforge-org/provider-cloudflare";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.js";
import { newId } from "../lib/crypto.js";
import { ApiError, badRequest, conflict, forbidden, notFound, readJson } from "../lib/http.js";
import { orgActor, readableProject, type OrgActor } from "../middleware/authz.js";
import { grantFolderToProjectPeople } from "../services/access.js";
import { recordEvent, userRef } from "../services/events.js";
import { MAX_ZIP_BYTES, getIntake, resolveIncludes, updateIntake, validateImportUrl, type IntakeRow, type PlacementPlan, type UrlIntakeRequest } from "../services/intake.js";
import { createResource, insertResource } from "../services/resources.js";
import { issueJob } from "../services/runner-jobs.js";
import { enqueueStep } from "../services/steps.js";

export const intakeRoutes = new Hono<AppEnv>();

const BranchSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/).refine((b) => !b.includes("..") && !b.endsWith(".lock"), "invalid branch");

/**
 * Adding a mount is project membership, which only owners change (`POST /projects/:pid/mounts`).
 * Intake creates resources for owners and developers, but attaches them to a project for owners only.
 */
function assertCanMount(actor: OrgActor): void {
  if (actor.role !== "owner") throw forbidden("insufficient_role", "only owners add folders to a project; import without projectId to create the resources only");
}

/** The mount names a project already has. */
async function mountNames(c: { get: (k: "svc") => AppEnv["Variables"]["svc"] }, orgId: string, projectId: string): Promise<Set<string>> {
  const rows = await c.get("svc").db.prepare("SELECT mount_name FROM mounts WHERE org_id = ? AND project_id = ?").bind(orgId, projectId).all<{ mount_name: string }>();
  return new Set(rows.results.map((r) => r.mount_name));
}

/** The owner's include-anyway choice (`plan.includedAnyway`, `result.includedAnyway`) is shown to owners only, like its event. */
function presentIntake(i: IntakeRow, owner: boolean) {
  const plan = i.plan_json ? (JSON.parse(i.plan_json) as PlacementPlan) : null;
  const result = i.result_json ? (JSON.parse(i.result_json) as Record<string, unknown>) : null;
  if (!owner) {
    if (plan) delete plan.includedAnyway;
    if (result) delete result.includedAnyway;
  }
  return {
    intakeId: i.intake_id,
    kind: i.kind,
    state: i.state,
    request: JSON.parse(i.request_json) as unknown,
    ...(plan ? { plan } : {}),
    ...(i.inventory_json ? { inventory: { files: (JSON.parse(i.inventory_json) as { entries: unknown[] }).entries.length } } : {}),
    ...(result ? { result } : {}),
    ...(i.error ? { error: i.error } : {}),
    createdAt: i.created_at,
    updatedAt: i.updated_at,
  };
}

intakeRoutes.post("/orgs/:org/intake/url", async (c) => {
  const actor = await orgActor(c, c.req.param("org"), ["owner", "developer"]);
  const body = await readJson(
    c,
    z.object({
      url: z.string().max(2048),
      branch: BranchSchema,
      name: z.string().trim().min(1).max(128),
      depth: z.number().int().min(1).max(10_000).optional(),
      projectId: IdSegmentSchema.optional(),
      mountName: MountNameSchema.optional(),
    }),
  );
  const svc = c.get("svc");
  const url = validateImportUrl(body.url);
  if (!url) throw badRequest("invalid_url", "only public https:// remotes without credentials are imported (private repositories: not supported in P0)");
  if ((body.projectId === undefined) !== (body.mountName === undefined)) throw badRequest("invalid_request", "projectId and mountName go together");
  if (body.projectId) {
    assertCanMount(actor);
    await readableProject(svc, actor, body.projectId);
    // refuse before creating anything: a taken name would leave an orphan resource
    if ((await mountNames(c, actor.orgId, body.projectId)).has(body.mountName!)) throw conflict("mount_exists", `mount ${body.mountName} already exists`, { names: [body.mountName] });
  }
  const resource = await insertResource(svc, actor, { name: body.name, provider: "artifacts", branch: body.branch, state: "importing", source: { kind: "url", url, branch: body.branch } });
  const intakeId = newId("in", 8);
  const req: UrlIntakeRequest = { resourceId: resource.resource_id, url, branch: body.branch, ...(body.depth ? { depth: body.depth } : {}), ...(body.projectId ? { projectId: body.projectId, mountName: body.mountName! } : {}) };
  const now = svc.nowIso();
  await svc.db
    .prepare("INSERT INTO intakes (intake_id, org_id, kind, state, request_json, created_by, created_at, updated_at) VALUES (?, ?, 'url', 'queued', ?, ?, ?, ?)")
    .bind(intakeId, actor.orgId, JSON.stringify(req), actor.userId, now, now)
    .run();
  await enqueueStep(svc, { type: "intake.import", orgId: actor.orgId, intakeId });
  await recordEvent(svc, { orgId: actor.orgId, actor: userRef(actor.userId), action: "intake.requested", subjectKind: "intake", subjectId: intakeId, resourceIds: [resource.resource_id], detail: { kind: "url", url } });
  return c.json({ intakeId, resourceId: resource.resource_id, state: "queued" }, 202);
});

/** Raw ZIP body (`content-type: application/zip`), `?name=<archive name>`. Max 100 MiB. */
intakeRoutes.post("/orgs/:org/intake/zip", async (c) => {
  const actor = await orgActor(c, c.req.param("org"), ["owner", "developer"]);
  const svc = c.get("svc");
  const name = z.string().min(1).max(200).catch("upload.zip").parse(c.req.query("name"));
  const len = Number(c.req.header("content-length"));
  if (!Number.isFinite(len) || len <= 0) throw new ApiError(411, "length_required", "content-length is required");
  if (len > MAX_ZIP_BYTES) throw new ApiError(413, "too_large", `archives are limited to ${MAX_ZIP_BYTES} bytes`);
  if (!c.req.raw.body) throw badRequest("invalid_request", "body required");
  const intakeId = newId("in", 8);
  const key = `org/${actor.orgId}/intake/${intakeId}/upload.zip`;
  const hash = new IncrementalSha256();
  let seen = 0;
  const hasher = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, ctl) {
      seen += chunk.byteLength;
      if (seen > len) throw new Error("body longer than content-length");
      hash.update(chunk);
      ctl.enqueue(chunk);
    },
  });
  const fixed = new FixedLengthStream(len);
  const piping = c.req.raw.body.pipeThrough(hasher).pipeTo(fixed.writable);
  await Promise.all([svc.env.COMMONFORGE_ASSETS.put(key, fixed.readable), piping]);
  const sha256 = hash.digestHex();
  const now = svc.nowIso();
  await svc.db
    .prepare("INSERT INTO intakes (intake_id, org_id, kind, state, request_json, r2_key, created_by, created_at, updated_at) VALUES (?, ?, 'zip', 'inventorying', ?, ?, ?, ?, ?)")
    .bind(intakeId, actor.orgId, JSON.stringify({ filename: name, size: len, sha256 }), key, actor.userId, now, now)
    .run();
  const job = await issueJob(svc, { kind: "inventory", intakeId, upload: { r2Key: key, sha256, size: len }, limits: {} }, { orgId: actor.orgId, subject: `intake:${intakeId}`, lifetimeSeconds: 3600 });
  await updateIntake(svc, intakeId, { job_id: job.jobId });
  await recordEvent(svc, { orgId: actor.orgId, actor: userRef(actor.userId), action: "intake.requested", subjectKind: "intake", subjectId: intakeId, detail: { kind: "zip", size: len } });
  return c.json({ intakeId, state: "inventorying", sha256, jobId: job.jobId }, 202);
});

intakeRoutes.get("/orgs/:org/intake/:id", async (c) => {
  const actor = await orgActor(c, c.req.param("org"), ["owner", "developer"]);
  const i = await getIntake(c.get("svc"), actor.orgId, c.req.param("id"));
  if (!i) throw notFound("intake not found");
  return c.json(presentIntake(i, actor.role === "owner"));
});

/**
 * Confirm a ZIP placement plan: creates the planned resources (empty canonical repos / bound asset
 * collections) and optional mounts. Populating them from the staged archive needs a runner job kind
 * that does not exist yet (`intake-apply`, follow-up); the response says so (`pendingPopulation`).
 *
 * `include` (owners only): exact paths the dry run blocked by the secret-looking-name rule that the
 * owner inspected and wants kept. Any other path is refused (400 `include_refused`, `details.paths`)
 * before anything is created. The choice is recorded on the plan (`includedAnyway`) and as the
 * owner-only event `intake.included_anyway`; nothing reads those files until population lands.
 */
intakeRoutes.post("/orgs/:org/intake/:id/confirm", async (c) => {
  const actor = await orgActor(c, c.req.param("org"), ["owner", "developer"]);
  const body = await readJson(c, z.object({ projectId: IdSegmentSchema.optional(), skip: z.array(z.string()).default([]), include: z.array(z.string().min(1).max(4096)).max(1000).default([]) }));
  const svc = c.get("svc");
  const i = await getIntake(svc, actor.orgId, c.req.param("id"));
  if (!i || i.kind !== "zip") throw notFound("intake not found");
  if (i.state !== "inventoried") throw conflict("intake_not_ready", `intake is ${i.state}`);
  const plan = JSON.parse(i.plan_json!) as PlacementPlan;
  const chosen = plan.placements.filter((p) => !body.skip.includes(p.resourceName));
  if (body.include.length && actor.role !== "owner") throw forbidden("insufficient_role", "only owners include a blocked file anyway");
  const { included, refused } = body.include.length ? resolveIncludes(plan, JSON.parse(i.inventory_json ?? '{"entries":[]}') as { entries: Array<{ path: string; size: number }> }, chosen, body.include) : { included: [], refused: [] };
  if (refused.length) {
    throw badRequest("include_refused", `only files blocked for a secret-looking name, small enough for Git and going into a resource being added can be included: ${refused.map((r) => r.path).join(", ")}`, { paths: refused.map((r) => r.path), refused });
  }
  const mountOf = (p: { resourceName: string }) => (MountNameSchema.safeParse(p.resourceName).success ? p.resourceName : null);
  if (body.projectId) {
    assertCanMount(actor);
    await readableProject(svc, actor, body.projectId);
    // every planned folder name must be free, checked before anything is created (no orphans)
    const taken = await mountNames(c, actor.orgId, body.projectId);
    const clash = chosen.map(mountOf).filter((n): n is string => n !== null && taken.has(n));
    if (clash.length) throw conflict("mount_exists", `this project already has ${clash.length === 1 ? "a folder" : "folders"} named ${clash.join(", ")}; skip ${clash.length === 1 ? "it" : "them"} or rename`, { names: clash });
  }
  // claim the intake (one confirm wins)
  const claim = await svc.db.prepare("UPDATE intakes SET state = 'confirming', updated_at = ? WHERE intake_id = ? AND state = 'inventoried'").bind(svc.nowIso(), i.intake_id).run();
  if ((claim.meta.changes ?? 0) === 0) throw conflict("intake_not_ready", "intake is being confirmed");
  const created: Array<{ resourceId: string; name: string; provider: string; mountName?: string }> = [];
  for (const p of chosen) {
    const r = await createResource(svc, actor, { name: p.resourceName, provider: p.provider }, userRef(actor.userId));
    let mountName: string | undefined;
    if (body.projectId) {
      const name = mountOf(p) ?? r.resource_id;
      const ins = await svc.db
        .prepare("INSERT OR IGNORE INTO mounts (org_id, project_id, mount_name, resource_id, mode, operations_json, created_at) VALUES (?, ?, ?, ?, 'must-match-accepted', '[\"read\",\"write\"]', ?)")
        .bind(actor.orgId, body.projectId, name, r.resource_id, svc.nowIso())
        .run();
      // report a folder only when it was really added (a concurrent add could still win the name)
      if ((ins.meta.changes ?? 0) > 0) {
        mountName = name;
        await svc.db.prepare("UPDATE projects SET membership_revision = membership_revision + 1 WHERE org_id = ? AND project_id = ?").bind(actor.orgId, body.projectId).run();
        await recordEvent(svc, { orgId: actor.orgId, projectId: body.projectId, actor: userRef(actor.userId), action: "mount.added", subjectKind: "project", subjectId: body.projectId, resourceIds: [r.resource_id], detail: { mountName: name, resourceId: r.resource_id, intakeId: i.intake_id } });
        await grantFolderToProjectPeople(svc, { orgId: actor.orgId, projectId: body.projectId, resourceId: r.resource_id, actorId: actor.userId });
      }
    }
    created.push({ resourceId: r.resource_id, name: r.name, provider: r.provider, ...(mountName ? { mountName } : {}) });
  }
  const result = {
    resources: created,
    excluded: plan.excluded.length - included.length,
    ...(included.length ? { includedAnyway: included.map((x) => x.path) } : {}),
    pendingPopulation: true,
    note: "resources created; content population from the staged archive needs the runner intake-apply job (not yet available)",
  };
  await updateIntake(svc, i.intake_id, { state: "confirmed", result_json: JSON.stringify(result), ...(included.length ? { plan_json: JSON.stringify({ ...plan, includedAnyway: included }) } : {}) });
  if (included.length) {
    // org-level and naming no resource: owner-only in the activity log (API.md, event filtering)
    await recordEvent(svc, { orgId: actor.orgId, actor: userRef(actor.userId), action: "intake.included_anyway", subjectKind: "intake", subjectId: i.intake_id, detail: { paths: included.map((x) => x.path), into: included } });
  }
  await recordEvent(svc, { orgId: actor.orgId, actor: userRef(actor.userId), action: "intake.confirmed", subjectKind: "intake", subjectId: i.intake_id, resourceIds: created.map((r) => r.resourceId), detail: { resources: created.length } });
  return c.json(result);
});
