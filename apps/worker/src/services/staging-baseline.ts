/**
 * The owner baseline (staging phase 2b, B6): staging in a project starts only after the owner
 * published the current `main` to production once. The baseline is that production release: it was
 * live while, for every resource it is built from, the ledger head was exactly the release's source
 * revision (production equalled `main`). One row per project, permanent (turning staging off and on
 * keeps it). Before it, nothing is built, deployed or promoted for the project's staging.
 *
 * Clearance releases start from it (B7) while nothing is live in production: `unclearedVersions`
 * then starts each resource at the baseline's revision, an owner-published point. Once a release is
 * live, a resource starts at the live release's revision, and a resource the start point lacks is
 * checked from its beginning (one owner publish first).
 *
 * Established lazily (`requestBuild`), when a production release goes live (staging.ts registers
 * the `onProductionLive` hook), when a staging policy is saved and by GC. No staging import (no cycle).
 *
 * The check and the insert are not one transaction: an accept between them leaves a baseline whose
 * release is already one accept behind `main`. That is accepted (the release was owner-published,
 * and `unclearedVersions` still needs an owner publish for that accept, which no promotion made); the
 * event's developer detail notes the resources whose heads moved (`headsMovedSince`).
 */
import type { Services } from "../context.js";
import { getProject } from "./directory.js";
import { recordEvent } from "./events.js";
import { getLive, getRelease, RELEASE_SERVICE } from "./releases.js";
import { stagingPolicyOf } from "./staging-policy.js";

export interface BaselineRow {
  org_id: string;
  project_id: string;
  release_id: string;
  accepted_version_id: string;
  /** `{resourceId: revisionId}` of that release */
  sources_json: string;
  established_at: string;
}

/** The project's baseline, if any (read only). */
export async function getBaseline(svc: Services, orgId: string, projectId: string): Promise<BaselineRow | null> {
  return svc.db.prepare("SELECT * FROM staging_baselines WHERE org_id = ? AND project_id = ?").bind(orgId, projectId).first<BaselineRow>();
}

/**
 * The baseline, establishing it when it can be: the project is in staging mode and its live
 * production release has, for every source resource, the ledger head's revision. `created` is true
 * only for the call that wrote the row (its caller starts the waiting landings' build). Null while
 * there is none (nothing live, or `main` ran ahead of production on some resource).
 */
export async function establishBaseline(svc: Services, orgId: string, projectId: string): Promise<{ row: BaselineRow; created: boolean } | null> {
  const existing = await getBaseline(svc, orgId, projectId);
  if (existing) return { row: existing, created: false };
  const project = await getProject(svc.db, orgId, projectId);
  if (!project || !stagingPolicyOf(project)) return null;
  const live = await getLive(svc, orgId, projectId, "production");
  const rel = live ? await getRelease(svc, orgId, live.release_id) : null;
  if (!rel) return null;
  const sources = JSON.parse(rel.sources_json) as Record<string, string>;
  const ledger = svc.ledger(orgId);
  for (const [resourceId, revisionId] of Object.entries(sources)) if ((await ledger.getHead(resourceId))?.revisionId !== revisionId) return null;
  const ins = await svc.db
    .prepare("INSERT OR IGNORE INTO staging_baselines (org_id, project_id, release_id, accepted_version_id, sources_json, established_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(orgId, projectId, rel.release_id, rel.accepted_version_id, rel.sources_json, svc.nowIso())
    .run();
  const row = (await getBaseline(svc, orgId, projectId))!;
  const created = (ins.meta.changes ?? 0) > 0;
  if (created) {
    const moved: string[] = [];
    for (const [resourceId, revisionId] of Object.entries(sources)) if ((await ledger.getHead(resourceId))?.revisionId !== revisionId) moved.push(resourceId);
    await recordEvent(svc, {
      orgId,
      projectId,
      actor: RELEASE_SERVICE,
      action: "staging.baseline_established",
      subjectKind: "project",
      subjectId: projectId,
      detail: { releaseId: rel.release_id, acceptedVersionId: rel.accepted_version_id, ...(moved.length > 0 ? { headsMovedSince: moved } : {}) },
      clientVisible: true,
      clientDetail: {},
    });
  }
  return { row, created };
}
