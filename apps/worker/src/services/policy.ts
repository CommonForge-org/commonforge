/**
 * Project policy (admin screens spec §7): the schema PUT …/policy accepts, and the same checks as
 * issues for POST …/policy/validate, which never saves.
 */
import { CheckSpecSchema, ContractSpecSchema } from "@commonforge-org/core";
import { z } from "zod";
import type { Services } from "../context.js";
import { parseLedgerRpcError } from "../ledger/errors.js";
import { ApiError } from "../lib/http.js";
import { assertOrgD1NotInUse, assertOrgWorkerQuota, assertTargetsAllowed, orgD1Ids } from "./deploy-targets.js";
import { ROLES, type ProjectPolicy, type ProjectRow } from "./directory.js";
import { StagingPolicySchema, stagingIssues } from "./staging-policy.js";
import { PreviewPolicySchema, PublishRolesSchema, ReleasePolicySchema, type ReleasePolicy } from "./release-policy.js";

export const PolicySchema = z.object({
  checks: z.array(CheckSpecSchema).max(50).default([]),
  contracts: z.array(ContractSpecSchema).max(50).default([]),
  approvalRoles: z.array(z.enum(ROLES)).min(1).optional(),
  rules: z.array(z.string().max(4096)).max(100).default([]),
  // Task 22: previews and releases (server-owned, owner-only like the rest of the policy)
  preview: PreviewPolicySchema.optional(),
  release: ReleasePolicySchema.optional(),
  publishRoles: PublishRolesSchema.optional(),
  // staging phase 1: always-on staging (services/staging-policy.ts)
  staging: StagingPolicySchema.optional(),
});

export type PolicyIssue = { path: string; message: string };

/**
 * What a release section must satisfy beyond the schema: targets stay inside the org's Worker
 * namespace and platform-created bindings (review C-1; D1: org-owned and bound by one project only,
 * staging phase 2), and the org's Worker quota. Throws the refusal as an ApiError (PUT …/policy
 * surfaces it as is).
 */
export async function assertReleaseAllowed(svc: Services, orgId: string, projectId: string, release: ReleasePolicy): Promise<void> {
  await assertTargetsAllowed(svc, orgId, release.targets, Object.entries(release.environment).map(([targetId, e]) => ({ targetId, kvNamespaces: e.kvNamespaces, d1Databases: e.d1Databases ?? [] })), await orgD1Ids(svc, orgId));
  await assertOrgD1NotInUse(svc, orgId, projectId, Object.values(release.environment).flatMap((e) => (e.d1Databases ?? []).map((d) => d.id)));
  await assertOrgWorkerQuota(svc, orgId, projectId, release.targets.map((t) => t.workerName));
}

/** The schema, then the release-target and quota checks: what a save would refuse, as issues. */
export async function policyIssues(svc: Services, orgId: string, project: ProjectRow, raw: unknown): Promise<{ policy?: ProjectPolicy; issues: PolicyIssue[] }> {
  const r = PolicySchema.safeParse(raw);
  if (!r.success) return { issues: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) };
  if (r.data.release) {
    try {
      await assertReleaseAllowed(svc, orgId, project.project_id, r.data.release);
    } catch (e) {
      if (e instanceof ApiError) return { issues: [{ path: "release", message: e.message }] };
      throw e;
    }
  }
  if (r.data.staging) {
    const issues = stagingIssues(r.data.staging, r.data.release, r.data.approvalRoles);
    if (issues.length > 0) return { issues };
  }
  return { policy: r.data as ProjectPolicy, issues: [] };
}

/** A ledger RPC refusal coded `ledger_conflict` (for a policy save: the ledger's revision is already ahead). */
export function isLedgerConflict(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e);
  return /^ledger_[a-z_]+: /.test(message) && parseLedgerRpcError(e).code === "ledger_conflict";
}
