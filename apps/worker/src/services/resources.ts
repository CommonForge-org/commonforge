/** Resource lifecycle helpers shared by the resources and intake routes. */
import {
  artRevisionId,
  r2mRevisionId,
  resourceId as toResourceId,
  type AssetManifestCoords,
  type PrincipalRef,
  type ResourceRef,
  type RevisionId,
} from "@commonforge-org/core";
import { r2AssetKeys } from "@commonforge-org/provider-cloudflare";
import type { Services } from "../context.js";
import { newId } from "../lib/crypto.js";
import { ApiError, conflict } from "../lib/http.js";
import { getResource, putGrant, resourceCoords, updateResource, type ResourceRow, type Role } from "./directory.js";

export const ASSET_BUCKET_LABEL = "COMMONFORGE_ASSETS";

export interface NewResource {
  name: string;
  provider: "artifacts" | "r2-assets";
  /** artifacts: branch of the canonical repo (default main) */
  branch?: string;
  state?: "empty" | "importing";
  source?: Record<string, unknown>;
}

/** Insert the directory row and give a non-owner creator a read+write grant. */
export async function insertResource(svc: Services, actor: { orgId: string; userId: string; role: Role }, r: NewResource & { resourceId?: string }): Promise<ResourceRow> {
  const resourceId = r.resourceId ?? newId("res", 8);
  const now = svc.nowIso();
  await svc.db
    .prepare(
      "INSERT INTO resources (org_id, resource_id, name, provider, state, coords_json, branch, source_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)",
    )
    .bind(actor.orgId, resourceId, r.name, r.provider, r.state ?? "empty", r.branch ?? null, r.source ? JSON.stringify(r.source) : null, actor.userId, now, now)
    .run();
  if (actor.role !== "owner") {
    await putGrant(svc.db, { orgId: actor.orgId, userId: actor.userId, scopeKind: "resource", scopeId: resourceId, operations: ["read", "write"], grantedBy: actor.userId, now });
  }
  return (await getResource(svc.db, actor.orgId, resourceId))!;
}

/** Genesis head in the ledger (planBindHead). Idempotent per resource. */
export async function bindHead(svc: Services, orgId: string, resourceId: string, revisionId: RevisionId, actor: PrincipalRef): Promise<string> {
  const d = await svc.ledger(orgId).bindHead({ organizationId: orgId, resourceId, revisionId, idempotencyKey: `bind:${resourceId}`, actor });
  if (!d.ok) throw conflict(d.code, d.detail ?? "resource head already bound");
  return d.acceptedVersionId;
}

/** Create an empty canonical repo (artifacts) or an empty bound asset collection (r2-assets). */
export async function createResource(svc: Services, actor: { orgId: string; userId: string; role: Role }, input: NewResource, principal: PrincipalRef): Promise<ResourceRow> {
  const row = await insertResource(svc, actor, { ...input, branch: input.provider === "artifacts" ? (input.branch ?? "main") : undefined });
  const now = svc.nowIso();
  if (input.provider === "artifacts") {
    const coords = await svc.provider().ensureCanonicalRepo(actor.orgId, row.resource_id, { defaultBranch: input.branch ?? "main", description: input.name.slice(0, 120) });
    await updateResource(svc.db, actor.orgId, row.resource_id, { coords_json: JSON.stringify(coords), state: "empty" }, now);
  } else {
    const assets = await svc.assets(actor.orgId);
    const manifest = await assets.writeManifest({ resourceId: toResourceId(row.resource_id), parentManifestId: null, entries: [] });
    const coords: AssetManifestCoords = { kind: "r2-assets", bucket: ASSET_BUCKET_LABEL, prefix: r2AssetKeys.resourcePrefix(actor.orgId, row.resource_id), manifestId: manifest.manifestId };
    await bindHead(svc, actor.orgId, row.resource_id, r2mRevisionId(manifest.manifestId), principal);
    await updateResource(svc.db, actor.orgId, row.resource_id, { coords_json: JSON.stringify(coords), state: "active" }, now);
  }
  return (await getResource(svc.db, actor.orgId, row.resource_id))!;
}

/** Bind an artifacts resource to the current head of its recorded branch (genesis only). */
export async function adoptBranchHead(svc: Services, r: ResourceRow, principal: PrincipalRef): Promise<RevisionId> {
  const coords = resourceCoords(r);
  if (r.provider !== "artifacts" || !coords || coords.kind !== "artifacts") throw new ApiError(400, "not_artifacts", "only Artifacts resources have branches");
  const [commit] = await svc.transport.log(coords.namespace, coords.repoName, { ref: r.branch ?? "main", limit: 1 });
  if (!commit) throw conflict("branch_empty", `branch ${r.branch ?? "main"} has no commits yet`);
  const rev = artRevisionId(coords.repoId, commit.hash);
  await bindHead(svc, r.org_id, r.resource_id, rev, principal);
  await updateResource(svc.db, r.org_id, r.resource_id, { state: "active", error: null }, svc.nowIso());
  return rev;
}

/** Engine ResourceRef for a directory row. */
export function resourceRef(r: ResourceRow): ResourceRef {
  const coords = resourceCoords(r);
  if (!coords) throw conflict("resource_not_ready", `resource ${r.resource_id} has no coordinates yet`);
  return {
    organizationId: r.org_id,
    resourceId: toResourceId(r.resource_id),
    provider: r.provider,
    authority: "commonforge_ledger",
    coords,
  } as ResourceRef;
}
