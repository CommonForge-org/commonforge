/**
 * Export (plan §B.10, FR-15, AT-24): a runner `export` job writes git bundles + asset manifests to
 * R2 under `org/<org>/exports/<exportId>/`; reconstruction needs only git, curl and the manifest.
 */
import { ExportReceiptSchema, parseRevisionId, type AssetManifest, type RepoCoords } from "@commonforge-org/core";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.js";
import { newId } from "../lib/crypto.js";
import { conflict, forbidden, notFound, parseQuery } from "../lib/http.js";
import { canReadResource, orgActor, readableProject } from "../middleware/authz.js";
import { repoInfoCoords } from "../services/artifacts.js";
import { getResource, resourceCoords } from "../services/directory.js";
import { recordEvent, userRef } from "../services/events.js";
import { issueJob, onRunnerResult } from "../services/runner-jobs.js";
import { projectSnapshot } from "../services/snapshot.js";

export const exportRoutes = new Hono<AppEnv>();

interface ExportRow {
  export_id: string;
  org_id: string;
  project_id: string;
  state: "queued" | "succeeded" | "failed";
  snapshot_json: string;
  job_id: string | null;
  receipt_json: string | null;
  error: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

onRunnerResult("export", async (svc, row, job, result) => {
  if (job.kind !== "export") return;
  if (!result.ok) {
    await svc.db.prepare("UPDATE exports SET state = 'failed', error = ?, updated_at = ? WHERE export_id = ?").bind(`${result.code}: ${result.detail.slice(0, 500)}`, svc.nowIso(), job.exportId).run();
    return;
  }
  const receipt = ExportReceiptSchema.parse(result.receipt);
  const prefix = job.sink.r2Prefix;
  const ok = receipt.exportId === job.exportId && receipt.snapshotId === job.snapshotId && receipt.items.every((i) => i.r2Key.startsWith(prefix));
  await svc.db
    .prepare("UPDATE exports SET state = ?, receipt_json = ?, error = ?, updated_at = ? WHERE export_id = ? AND org_id = ?")
    .bind(ok ? "succeeded" : "failed", ok ? JSON.stringify(receipt) : null, ok ? null : "receipt does not match the job", svc.nowIso(), job.exportId, row.org_id)
    .run();
});

exportRoutes.post("/orgs/:org/projects/:pid/exports", async (c) => {
  const actor = await orgActor(c, c.req.param("org"), ["owner", "developer"]);
  const svc = c.get("svc");
  const project = await readableProject(svc, actor, c.req.param("pid"));
  const snapshot = await projectSnapshot(svc, project);
  if (snapshot.entries.length === 0) throw conflict("nothing_to_export", "the project has no accepted versions");
  const resources: Array<{ resourceId: string; coords: RepoCoords; sha: string; historyMode: "full" }> = [];
  const manifests: AssetManifest[] = [];
  for (const e of snapshot.entries) {
    if (!(await canReadResource(svc, actor, e.resourceId))) throw forbidden("export_incomplete", "you cannot read every mounted resource of this project");
    const r = await getResource(svc.db, actor.orgId, e.resourceId);
    const rev = parseRevisionId(e.revisionId);
    if (rev.kind === "art") {
      const coords = r ? resourceCoords(r) : null;
      if (!coords || coords.kind !== "artifacts") throw conflict("resource_not_ready", "no canonical repository");
      const info = await svc.transport.getRepo(coords.namespace, coords.repoName);
      if (!info || info.id !== coords.repoId) throw conflict("repo_mismatch", "canonical repository changed");
      resources.push({ resourceId: e.resourceId, coords: repoInfoCoords(coords.namespace, info), sha: rev.sha, historyMode: "full" });
    } else if (rev.kind === "r2m") {
      const m = await (await svc.assets(actor.orgId)).readManifest(rev.manifestId, e.resourceId);
      if (!m) throw conflict("manifest_missing", `manifest of ${e.resourceId} not found`);
      manifests.push(m);
    }
  }
  const exportId = newId("exp", 8);
  const now = svc.nowIso();
  await svc.db
    .prepare("INSERT INTO exports (export_id, org_id, project_id, state, snapshot_json, created_by, created_at, updated_at) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?)")
    .bind(exportId, actor.orgId, project.project_id, JSON.stringify(snapshot), actor.userId, now, now)
    .run();
  const job = await issueJob(svc, { kind: "export", exportId, snapshotId: snapshot.snapshotId, resources, manifests, sink: { kind: "r2", r2Prefix: `org/${actor.orgId}/exports/${exportId}/` } }, { orgId: actor.orgId, subject: `export:${exportId}`, lifetimeSeconds: 3600 });
  await svc.db.prepare("UPDATE exports SET job_id = ? WHERE export_id = ?").bind(job.jobId, exportId).run();
  await recordEvent(svc, { orgId: actor.orgId, projectId: project.project_id, actor: userRef(actor.userId), action: "export.requested", subjectKind: "export", subjectId: exportId, resourceIds: snapshot.entries.map((e) => e.resourceId), detail: { snapshotId: snapshot.snapshotId } });
  return c.json({ exportId, snapshotId: snapshot.snapshotId, jobId: job.jobId, state: "queued" }, 202);
});

async function readableExport(c: Parameters<typeof orgActor>[0]) {
  const actor = await orgActor(c, c.req.param("org")!, ["owner", "developer"]);
  const svc = c.get("svc");
  const row = await svc.db.prepare("SELECT * FROM exports WHERE org_id = ? AND export_id = ?").bind(actor.orgId, c.req.param("id")).first<ExportRow>();
  if (!row) throw notFound("export not found");
  await readableProject(svc, actor, row.project_id);
  return { actor, row };
}

exportRoutes.get("/orgs/:org/exports/:id", async (c) => {
  const { row } = await readableExport(c);
  const receipt = row.receipt_json ? (JSON.parse(row.receipt_json) as { items: Array<{ r2Key: string }> }) : null;
  return c.json({
    exportId: row.export_id,
    projectId: row.project_id,
    state: row.state,
    snapshot: JSON.parse(row.snapshot_json) as unknown,
    receipt,
    downloads: receipt ? receipt.items.map((i) => `/api/orgs/${row.org_id}/exports/${row.export_id}/download?key=${encodeURIComponent(i.r2Key)}`) : [],
    ...(row.error ? { error: row.error } : {}),
  });
});

exportRoutes.get("/orgs/:org/exports/:id/download", async (c) => {
  const { row } = await readableExport(c);
  const q = parseQuery(c, z.object({ key: z.string().min(1) }));
  const receipt = row.receipt_json ? (JSON.parse(row.receipt_json) as { items: Array<{ r2Key: string }> }) : null;
  if (!receipt || !receipt.items.some((i) => i.r2Key === q.key)) throw notFound("export item not found");
  const obj = await c.get("svc").env.COMMONFORGE_ASSETS.get(q.key);
  if (!obj) throw notFound("export object missing");
  return new Response(obj.body, { headers: { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="${q.key.split("/").pop()}"` } });
});
