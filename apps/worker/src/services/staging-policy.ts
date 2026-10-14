/**
 * The `staging` policy section (spec 2026-10-07 §6): staging mode is on when a project's policy has
 * a valid `staging` section and a `release` section. Staging deploys the release targets under
 * `<workerName>-staging` with platform-owned D1/KV and these staging-only vars.
 */
import { BuildRecipeSchema, PromotionRuleSchema, RelativePathSchema } from "@commonforge-org/core";
import { z } from "zod";
import { projectPolicy, type ProjectRow } from "./directory.js";
import { ReleasePolicySchema, type ReleasePolicy } from "./release-policy.js";

const STAGING_SUFFIX = "-staging";
const MAX_WORKER_NAME = 63;
const VarName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/);
const BindingName = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);

export const StagingPolicySchema = z.object({
  recipe: BuildRecipeSchema.optional(),
  environment: z
    .record(
      z.string(),
      z.object({
        vars: z.record(VarName, z.string().max(4096)).default({}),
        kv: z.array(z.object({ binding: BindingName, seed: RelativePathSchema.optional() })).max(4).default([]),
        d1: z.array(z.object({ binding: BindingName, migrationsDir: RelativePathSchema.optional(), seed: z.array(RelativePathSchema).max(20).optional() })).max(4).default([]),
      }),
    )
    .default({}),
  captureVars: z.array(VarName).max(8).default([]),
  promotion: z
    .object({
      rules: z.array(PromotionRuleSchema).max(100).default([]),
      classifier: z.object({ provider: z.enum(["jev", "openai-decisions", "none"]).default("none"), threshold: z.number().min(0.5).max(1).default(0.9) }).default({ provider: "none", threshold: 0.9 }),
    })
    .default({ rules: [], classifier: { provider: "none", threshold: 0.9 } }),
});
export type StagingPolicy = z.infer<typeof StagingPolicySchema>;

export function stagingIssues(staging: StagingPolicy, release: ReleasePolicy | undefined, approvalRoles?: readonly string[]): Array<{ path: string; message: string }> {
  if (!release) return [{ path: "staging", message: "staging needs a release section: staging deploys the release targets" }];
  const issues: Array<{ path: string; message: string }> = [];
  // promotions that need a developer are approved only by an owner or developer in approvalRoles
  if (approvalRoles && !approvalRoles.some((r) => r === "owner" || r === "developer")) issues.push({ path: "approvalRoles", message: "in staging mode approvalRoles must include owner or developer: promotions that need a developer could never be approved" });
  const ids = new Set(release.targets.map((t) => t.targetId as string));
  for (const [targetId, env] of Object.entries(staging.environment)) {
    if (!ids.has(targetId)) issues.push({ path: `staging.environment.${targetId}`, message: `${targetId} is not a release target` });
    const names = [...env.kv.map((k) => k.binding), ...env.d1.map((d) => d.binding)];
    if (new Set(names).size !== names.length) issues.push({ path: `staging.environment.${targetId}`, message: "each binding name may be used once per target" });
    for (const v of staging.captureVars) if (v in env.vars) issues.push({ path: "staging.captureVars", message: `${v} is set to the capture sink; remove it from ${targetId}'s vars` });
  }
  // staging deploys every release target as `<workerName>-staging`, which must fit 63 characters
  release.targets.forEach((t, i) => {
    if (`${t.workerName}${STAGING_SUFFIX}`.length > MAX_WORKER_NAME) issues.push({ path: `release.targets.${i}.workerName`, message: `${t.workerName}${STAGING_SUFFIX} (the staging Worker) is longer than ${MAX_WORKER_NAME} characters; shorten workerName to ${MAX_WORKER_NAME - STAGING_SUFFIX.length} or fewer` });
  });
  return issues;
}

/** Both sections, parsed; null when staging mode is off. */
export function stagingPolicyOf(project: ProjectRow): { staging: StagingPolicy; release: ReleasePolicy } | null {
  const p = projectPolicy(project) as { staging?: unknown; release?: unknown };
  if (p.staging === undefined || p.release === undefined) return null;
  const s = StagingPolicySchema.safeParse(p.staging);
  const r = ReleasePolicySchema.safeParse(p.release);
  return s.success && r.success ? { staging: s.data, release: r.data } : null;
}
