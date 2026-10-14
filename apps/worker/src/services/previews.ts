/**
 * Isolated private previews (Task 22; plan §C.1 row 10, §F "Preview production-data access",
 * AT-31, AT-37).
 *
 * - A preview is built by a runner `preview-build` job in the Sandbox at a proposal's
 *   **integration** shas (the commits the checks ran on), with the server-owned preview recipe.
 *   The job's only write scope is `org/<org>/previews/<previewId>/` (site + server bundles).
 * - It is served by the dedicated preview Worker (`COMMONFORGE_PREVIEW_URL`, another origin than
 *   the app) at `/p/<org>/<previewId>/<token>/`; the api bundle runs in a preview container with
 *   fixture bindings only and no internet (`apps/runner/src/preview-host.ts`).
 * - The token is minted here per preview, expires with the preview and is handed only to callers
 *   who can see the proposal. Revoking deletes `meta.json`, which the preview Worker requires.
 */
import { parseRevisionId, type ProjectSnapshot, type ProposalRecord, type RepoCoords } from "@commonforge-org/core";
import type { IntegrationJob, IntegrationJobInput, RunnerResult } from "@commonforge-org/runner-protocol";
import type { Services } from "../context.js";
import { newId } from "../lib/crypto.js";
import { ApiError, conflict } from "../lib/http.js";
import { mintPreviewToken, previewMetaKey, previewPrefix, type PreviewMeta } from "../lib/preview-token.js";
import { repoInfoCoords } from "./artifacts.js";
import { getProject, getResource, projectPolicy, resourceCoords } from "./directory.js";
import { recordEvent, userRef } from "./events.js";
import { latestIntegration, proposalResourceIds, type ProposalIndexRow } from "./proposals.js";
import { PreviewPolicySchema } from "./release-policy.js";
import { issueJob, onRunnerResult, type RunnerJobRow } from "./runner-jobs.js";

export interface PreviewRow {
  preview_id: string;
  org_id: string;
  project_id: string;
  proposal_id: string;
  proposal_hash: string;
  state: "queued" | "building" | "ready" | "failed" | "expired";
  sources_json: string;
  recipe_json: string;
  host_vars_json: string;
  ttl_seconds: number;
  job_id: string | null;
  receipt_json: string | null;
  error_code: string | null;
  error: string | null;
  expires_at: number | null;
  revoked_at: number | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/** The preview Worker's origin; refused when it is the app's or the API's own origin (AT-37). */
export function previewBase(svc: Services): string {
  const raw = (svc.env.COMMONFORGE_PREVIEW_URL ?? "").replace(/\/+$/, "");
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ApiError(503, "config_missing", "COMMONFORGE_PREVIEW_URL is not configured");
  }
  const own = [svc.env.COMMONFORGE_APP_URL, svc.env.COMMONFORGE_PUBLIC_URL].flatMap((x) => {
    try {
      return [new URL(x).origin];
    } catch {
      return [];
    }
  });
  if (own.includes(u.origin)) throw new ApiError(503, "config_invalid", "previews must be served from their own origin, not the app's");
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !local) throw new ApiError(503, "config_invalid", "COMMONFORGE_PREVIEW_URL must be https");
  if (!svc.env.COMMONFORGE_PREVIEW_KEY || svc.env.COMMONFORGE_PREVIEW_KEY.length < 32) throw new ApiError(503, "config_missing", "COMMONFORGE_PREVIEW_KEY is not configured");
  return raw;
}

export async function getPreview(svc: Services, orgId: string, previewId: string): Promise<PreviewRow | null> {
  return svc.db.prepare("SELECT * FROM previews WHERE org_id = ? AND preview_id = ?").bind(orgId, previewId).first<PreviewRow>();
}

/** Request a preview of a proposal's latest successful integration (must be for the current hash). */
export async function requestPreview(svc: Services, actor: { orgId: string; userId: string }, p: ProposalRecord, idx: ProposalIndexRow): Promise<PreviewRow> {
  // an assets-only proposal integrates no code: a preview would only show the base (assets are not built)
  if (p.resourceChanges.length === 0) throw conflict("nothing_to_preview", "this proposal changes assets only; there is no code to preview");
  const base = previewBase(svc);
  const project = await getProject(svc.db, actor.orgId, idx.project_id);
  const parsedPolicy = PreviewPolicySchema.safeParse(project ? projectPolicy(project).preview : undefined);
  if (!parsedPolicy.success) throw conflict("preview_not_configured", "this project has no preview recipe (owner: PUT …/policy with `preview`)");
  const policy = parsedPolicy.data;
  const integ = await latestIntegration(svc, actor.orgId, p.proposalId);
  if (!integ || integ.receipt.evidence.proposalHash !== p.proposalHash) {
    throw conflict("integration_required", "preview the integrated result: run integration for the current version of the proposal first");
  }
  const baseSnapshot = JSON.parse(idx.base_snapshot_json) as ProjectSnapshot;
  const needed = new Set<string>([
    ...policy.recipe.steps.map((s) => s.mountName as string),
    ...(policy.recipe.output ? [policy.recipe.output.mountName as string] : []),
    ...policy.bundles.map((b) => b.mountName as string),
  ]);
  const integrated = new Map(integ.receipt.results.map((r) => [r.resourceId as string, r.sha as string]));
  const sources: Array<{ resourceId: string; mountName: string; canonical: RepoCoords }> = [];
  const integrationSha: Record<string, string> = {};
  for (const mount of needed) {
    const e = baseSnapshot.entries.find((x) => x.mountName === mount);
    if (!e) throw conflict("preview_mount_missing", `the preview recipe needs mount ${mount}, which this project does not have`);
    const rev = parseRevisionId(e.revisionId);
    if (rev.kind !== "art") throw conflict("preview_mount_unsupported", `mount ${mount} is not a git resource`);
    const r = await getResource(svc.db, actor.orgId, e.resourceId);
    const coords = r ? resourceCoords(r) : null;
    if (!coords || coords.kind !== "artifacts") throw conflict("resource_not_ready", `no canonical repository for ${mount}`);
    const info = await svc.transport.getRepo(coords.namespace, coords.repoName);
    if (!info || info.id !== coords.repoId) throw conflict("repo_mismatch", `canonical repository of ${mount} changed`);
    sources.push({ resourceId: e.resourceId, mountName: mount, canonical: repoInfoCoords(coords.namespace, info) });
    // changed resources at their integration commit; everything else at the proposal's base
    integrationSha[e.resourceId] = integrated.get(e.resourceId) ?? (rev as { sha: string }).sha;
  }
  const building = await svc.db.prepare("SELECT COUNT(*) AS n FROM previews WHERE org_id = ? AND project_id = ? AND state IN ('queued', 'building') AND revoked_at IS NULL AND created_at > ?").bind(actor.orgId, idx.project_id, new Date(svc.now().getTime() - 3_600_000).toISOString()).first<{ n: number }>();
  if ((building?.n ?? 0) >= MAX_BUILDING_PREVIEWS) throw conflict("preview_limit", `at most ${MAX_BUILDING_PREVIEWS} previews of a project can be built at once; wait for one to finish`);
  const previewId = newId("pv", 12);
  const now = svc.nowIso();
  await svc.db
    .prepare(
      "INSERT INTO previews (preview_id, org_id, project_id, proposal_id, proposal_hash, state, sources_json, recipe_json, host_vars_json, ttl_seconds, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(previewId, actor.orgId, idx.project_id, p.proposalId, p.proposalHash, JSON.stringify(integrationSha), JSON.stringify(policy.recipe), JSON.stringify(policy.hostVars), policy.ttlSeconds, actor.userId, now, now)
    .run();
  const job = await issueJob(
    svc,
    {
      kind: "preview-build",
      previewId,
      integrationSha,
      sources,
      recipe: policy.recipe,
      ttlSeconds: policy.ttlSeconds,
      outputPrefix: previewPrefix(actor.orgId, previewId),
      ...(policy.bundles.length > 0 ? { bundles: policy.bundles } : {}),
    } as IntegrationJobInput,
    {
      orgId: actor.orgId,
      subject: `preview:${previewId}`,
      lifetimeSeconds: 3600,
      beforeEnqueue: async (jobId) => void (await svc.db.prepare("UPDATE previews SET job_id = ?, updated_at = ? WHERE preview_id = ?").bind(jobId, svc.nowIso(), previewId).run()),
    },
  );
  await recordEvent(svc, {
    orgId: actor.orgId,
    projectId: idx.project_id,
    actor: userRef(actor.userId),
    action: "preview.requested",
    subjectKind: "proposal",
    subjectId: p.proposalId,
    resourceIds: proposalResourceIds(p),
    detail: { previewId, jobId: job.jobId, base },
    clientVisible: true,
    clientDetail: { previewId },
  });
  return (await getPreview(svc, actor.orgId, previewId))!;
}

onRunnerResult("preview-build", async (svc: Services, row: RunnerJobRow, job: IntegrationJob, result: RunnerResult) => {
  if (job.kind !== "preview-build") return;
  const pv = await getPreview(svc, row.org_id, job.previewId);
  if (!pv || pv.job_id !== row.job_id) return;
  const now = svc.now().getTime();
  // review m-1: a preview revoked while it was building stays revoked (never re-create the switch)
  if (pv.revoked_at !== null) {
    await deletePreviewObjects(svc, pv);
    await svc.db.prepare("UPDATE previews SET state = ?, receipt_json = ?, updated_at = ? WHERE preview_id = ?").bind(result.ok ? "ready" : "failed", result.ok ? JSON.stringify(result.receipt) : null, svc.nowIso(), pv.preview_id).run();
    return;
  }
  if (result.ok) {
    const expiresAt = now + pv.ttl_seconds * 1000;
    const meta: PreviewMeta = { previewId: pv.preview_id, orgId: pv.org_id, expiresAt, hostVars: JSON.parse(pv.host_vars_json) as Record<string, string>, bundles: (job.bundles ?? []).map((b) => b.name) };
    await svc.env.COMMONFORGE_ASSETS.put(previewMetaKey(pv.org_id, pv.preview_id), JSON.stringify(meta), { httpMetadata: { contentType: "application/json" } });
    await svc.db.prepare("UPDATE previews SET state = 'ready', receipt_json = ?, expires_at = ?, updated_at = ? WHERE preview_id = ?").bind(JSON.stringify(result.receipt), expiresAt, svc.nowIso(), pv.preview_id).run();
  } else {
    await svc.db.prepare("UPDATE previews SET state = 'failed', error_code = ?, error = ?, updated_at = ? WHERE preview_id = ?").bind(result.code, result.detail.slice(0, 4000), svc.nowIso(), pv.preview_id).run();
  }
  await recordEvent(svc, {
    orgId: pv.org_id,
    projectId: pv.project_id,
    actor: { kind: "service", id: "runner" } as never,
    action: result.ok ? "preview.ready" : "preview.failed",
    subjectKind: "proposal",
    subjectId: pv.proposal_id,
    resourceIds: Object.keys(JSON.parse(pv.sources_json) as Record<string, string>),
    detail: { previewId: pv.preview_id, ...(result.ok ? {} : { code: result.code }) },
    clientVisible: true,
    clientDetail: { previewId: pv.preview_id, ...(result.ok ? {} : { code: result.code }) },
  });
});

/** Revoke: the preview Worker refuses every request once `meta.json` is gone. */
export async function revokePreview(svc: Services, pv: PreviewRow, userId: string): Promise<void> {
  // revoked_at first: a build finishing concurrently then sees it and never re-creates meta.json
  await svc.db.prepare("UPDATE previews SET revoked_at = ?, updated_at = ? WHERE preview_id = ?").bind(svc.now().getTime(), svc.nowIso(), pv.preview_id).run();
  await svc.env.COMMONFORGE_ASSETS.delete(previewMetaKey(pv.org_id, pv.preview_id));
  await deletePreviewObjects(svc, pv);
  await recordEvent(svc, { orgId: pv.org_id, projectId: pv.project_id, actor: userRef(userId), action: "preview.revoked", subjectKind: "proposal", subjectId: pv.proposal_id, resourceIds: Object.keys(JSON.parse(pv.sources_json) as Record<string, string>), detail: { previewId: pv.preview_id } });
}

/** Delete a preview's site/ and bundles/ objects (review m-1: nothing of a revoked preview stays served or stored). */
export async function deletePreviewObjects(svc: Services, pv: Pick<PreviewRow, "org_id" | "preview_id">): Promise<void> {
  const prefix = previewPrefix(pv.org_id, pv.preview_id);
  let cursor: string | undefined;
  do {
    const page = await svc.env.COMMONFORGE_ASSETS.list({ prefix, ...(cursor ? { cursor } : {}) });
    if (page.objects.length) await svc.env.COMMONFORGE_ASSETS.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

/** Previews being built at once per project (review m-9: each one is a standard-1 container). */
export const MAX_BUILDING_PREVIEWS = 3;

/** API view. `url` (with the per-preview token) only while ready, unexpired and not revoked. */
export async function presentPreview(svc: Services, pv: PreviewRow, opts: { developer: boolean; currentHash?: string }) {
  const now = svc.now().getTime();
  const expired = pv.state === "ready" && pv.expires_at !== null && pv.expires_at <= now;
  const state = pv.revoked_at !== null ? "revoked" : expired ? "expired" : pv.state === "queued" && pv.job_id ? await jobState(svc, pv.job_id) : pv.state;
  let url: string | null = null;
  if (state === "ready" && pv.expires_at !== null) {
    const token = await mintPreviewToken(svc.env.COMMONFORGE_PREVIEW_KEY ?? "", pv.org_id, pv.preview_id, pv.expires_at);
    url = `${previewBase(svc)}/p/${pv.org_id}/${pv.preview_id}/${token}/`;
  }
  return {
    previewId: pv.preview_id,
    proposalId: pv.proposal_id,
    proposalHash: pv.proposal_hash,
    forCurrentHash: opts.currentHash === undefined ? undefined : opts.currentHash === pv.proposal_hash,
    state,
    createdAt: pv.created_at,
    updatedAt: pv.updated_at,
    expiresAt: pv.expires_at !== null ? new Date(pv.expires_at).toISOString() : null,
    url,
    error: pv.error_code ? { code: pv.error_code, ...(opts.developer && pv.error ? { detail: pv.error } : {}) } : null,
    ...(opts.developer ? { jobId: pv.job_id, sources: JSON.parse(pv.sources_json) as Record<string, string> } : {}),
  };
}

/** A queued preview whose job expired without a result is shown as failed (runner never answered). */
async function jobState(svc: Services, jobId: string): Promise<PreviewRow["state"]> {
  const j = await svc.db.prepare("SELECT status, expires_at FROM runner_jobs WHERE job_id = ?").bind(jobId).first<{ status: string; expires_at: number }>();
  if (j && j.status === "queued" && j.expires_at < svc.now().getTime()) return "failed";
  return "queued";
}
