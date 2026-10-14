// apps/worker/src/services/staging-state.ts
import type { Services } from "../context.js";
import { getProject } from "./directory.js";
import { stagingPolicyOf } from "./staging-policy.js";

export async function isStagingProject(svc: Services, orgId: string, projectId: string): Promise<boolean> {
  const project = await getProject(svc.db, orgId, projectId);
  return !!project && stagingPolicyOf(project) !== null;
}

/** The live staging revision: the newest build that reached `live`. */
export async function currentStaging(svc: Services, orgId: string, projectId: string): Promise<{ buildId: string; seq: number; since: string; shas: Record<string, { sha: string; revisionId: string }> } | null> {
  const row = await svc.db
    .prepare("SELECT build_id, seq, staging_json, updated_at FROM staging_builds WHERE org_id = ? AND project_id = ? AND state = 'live' ORDER BY seq DESC LIMIT 1")
    .bind(orgId, projectId)
    .first<{ build_id: string; seq: number; staging_json: string; updated_at: string }>();
  return row ? { buildId: row.build_id, seq: row.seq, since: row.updated_at, shas: parseShas(row.staging_json) } : null;
}

/** `staging_json`, or `{}` when it is missing or not a JSON object (callers still check each entry). */
function parseShas(json: string | null): Record<string, { sha: string; revisionId: string }> {
  try {
    const v: unknown = json ? JSON.parse(json) : {};
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, { sha: string; revisionId: string }>) : {};
  } catch {
    return {};
  }
}
