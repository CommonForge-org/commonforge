/**
 * Server-owned preview and release policy (Task 22), part of the project policy (owner-only
 * `PUT …/policy`; repository files never become policy, AT-18). Changing it bumps the policy
 * revision, so every release prepared afterwards is a new identity (AT-33).
 */
import { BuildRecipeSchema, IdSegmentSchema, MountNameSchema, PathPrefixSchema, RelativePathSchema } from "@commonforge-org/core";
import { ReleaseTargetEnvironmentSchema, ReleaseTargetSchema } from "@commonforge-org/runner-protocol";
import { z } from "zod";

const VarName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/);
const BindingName = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);

export const PreviewPolicySchema = z.object({
  /** recipe run in the Sandbox at the integration shas (install + build steps, step env non-secret) */
  recipe: BuildRecipeSchema,
  /** server bundles the preview host runs with fixture bindings only (e.g. the api Worker) */
  bundles: z.array(z.object({ name: IdSegmentSchema, mountName: MountNameSchema, path: PathPrefixSchema })).max(4).default([]),
  /** non-secret vars for the preview host (never production values) */
  hostVars: z.record(VarName, z.string().max(1024)).default({}),
  /** link lifetime after the preview is ready */
  ttlSeconds: z.number().int().min(300).max(7 * 86_400).default(86_400),
});
export type PreviewPolicy = z.infer<typeof PreviewPolicySchema>;

export const ReleasePolicySchema = z
  .object({
    recipe: BuildRecipeSchema,
    targets: z.array(ReleaseTargetSchema).min(1).max(8),
    /** per targetId: production vars overlay and bindings (part of the env digest) */
    environment: z.record(z.string(), ReleaseTargetEnvironmentSchema).default({}),
    /**
     * Staging phase 2 (R8): the migrations folder (mount-relative) of each production D1 binding.
     * The Worker derives the targets' `data` from these folders (production carries migrations
     * only, never a seed) and applies pending migrations before the code (services/production-data.ts).
     */
    migrations: z.array(z.object({ targetId: IdSegmentSchema, binding: BindingName, dir: RelativePathSchema }).strict()).max(8).default([]),
    /**
     * `/version` health check after deploy: the response's `release` must be the release id. The
     * URL is always the target Worker's own workers.dev URL (review C-1c: never free-form).
     */
    healthCheck: z
      .object({
        targetId: IdSegmentSchema,
        path: z.string().regex(/^\/[A-Za-z0-9._~/-]*$/).default("/version"),
      })
      .strict(),
  })
  .superRefine((p, ctx) => {
    const ids = new Set(p.targets.map((t) => t.targetId as string));
    if (!ids.has(p.healthCheck.targetId)) ctx.addIssue({ code: "custom", message: "healthCheck.targetId must be a target", path: ["healthCheck", "targetId"] });
    if (p.targets.find((t) => t.targetId === p.healthCheck.targetId)?.kind !== "worker") ctx.addIssue({ code: "custom", message: "healthCheck.targetId must be a worker target (it answers /version)", path: ["healthCheck", "targetId"] });
    // names ending in -staging belong to staging (`stagingWorkerName`): a production target there
    // would be overwritten by a staging deploy or deleted by a staging rollback cleanup
    p.targets.forEach((t, i) => {
      if (t.workerName.endsWith("-staging")) ctx.addIssue({ code: "custom", message: "Worker names ending in -staging are reserved for staging; choose another name", path: ["targets", i, "workerName"] });
    });
    for (const k of Object.keys(p.environment)) if (!ids.has(k)) ctx.addIssue({ code: "custom", message: `environment for unknown target ${k}`, path: ["environment", k] });
    // Production D1 (staging phase 2, R8): `d1Databases` may be bound (ownership: only org-owned
    // ids, checked by assertTargetsAllowed with orgD1Ids). `data` is never taken from the policy:
    // the Worker derives it from `migrations`, so production never carries a seed. `compatibilityFlags`
    // is set by the platform for staging only (the capture sink); production takes the source's flags.
    for (const [k, e] of Object.entries(p.environment)) {
      if ((e.data?.length ?? 0) > 0) ctx.addIssue({ code: "custom", message: "data files cannot be set for production releases; name migrations folders in release.migrations instead", path: ["environment", k, "data"] });
      if ((e.compatibilityFlags?.length ?? 0) > 0) ctx.addIssue({ code: "custom", message: "compatibility flags are set by the platform for staging; set them in the source's wrangler.jsonc", path: ["environment", k, "compatibilityFlags"] });
    }
    const seen = new Set<string>();
    p.migrations.forEach((m, i) => {
      const t = p.targets.find((x) => x.targetId === m.targetId);
      if (!t || t.kind !== "worker") ctx.addIssue({ code: "custom", message: `migrations target ${m.targetId} must be a worker target`, path: ["migrations", i, "targetId"] });
      else if (!p.environment[m.targetId]?.d1Databases?.some((d) => d.binding === m.binding)) ctx.addIssue({ code: "custom", message: `${m.targetId} binds no D1 database ${m.binding} (environment.${m.targetId}.d1Databases)`, path: ["migrations", i, "binding"] });
      const key = `${m.targetId}/${m.binding}`;
      if (seen.has(key)) ctx.addIssue({ code: "custom", message: `migrations for ${key} are named twice`, path: ["migrations", i] });
      seen.add(key);
    });
  });
export type ReleasePolicy = z.infer<typeof ReleasePolicySchema>;

/** Roles whose publish approval counts (default: owner only). Separate from proposal approval roles. */
export const PublishRolesSchema = z.array(z.enum(["owner", "developer", "client"])).min(1);
export const DEFAULT_PUBLISH_ROLES = ["owner"] as const;
