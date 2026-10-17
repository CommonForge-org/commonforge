/**
 * The gated release service (Task 22; plan §A.5 rule 6, §A.6 Release, §C.1 row 11, §F
 * "Partial provider/deployment failure"; AT-21, AT-33, AT-34, AT-35).
 *
 * Approval ≠ acceptance ≠ publish approval ≠ release: accepting a Change never deploys anything.
 *
 * 1. `prepareRelease` binds `{acceptedVersionId, recipe (revision), envDigest}` and the exact
 *    source revisions (the ledger heads at that accepted version) into a new `ReleaseId`, and
 *    starts a runner `release-build` job (Sandbox; read-only canonical access; no token, no
 *    deploy). Same inputs → the same release (idempotent).
 * 2. The build receipt fixes the release's `outputDigest` (every file's sha256 + deploy config).
 * 3. `approvePublish` is its own record, role-checked against `publishRoles` (default owner), and
 *    bound to `{releaseId, outputDigest, envDigest}`. Anything else changing is another release.
 * 4. `deploy` (idempotency key) needs a matching, still-authorized publish approval; it starts a
 *    `release-deploy` job: the runner deploys the stored, digest-checked outputs with its own
 *    pinned `wrangler deploy`. The account token (`COMMONFORGE_DEPLOY_API_TOKEN`) is handed out
 *    only for that open job (`POST /api/runner/deploy-credential`, or injected by the Sandbox
 *    egress gateway).
 * 5. After the deploy receipt, a queue step checks `<target>/version`: its `release` must be this
 *    release id. Only then does the project's live pointer move. Any failure leaves the previous
 *    live pointer untouched and the release shows "Approved, not live"; retrying deploys the same
 *    release again (no new acceptance, no new approval).
 */
import { canonicalJson, parseRevisionId, sha256Hex, stagingWorkerName, type PrincipalRef, type RepoCoords } from "@commonforge-org/core";
import { configDigest, type IntegrationJob, type IntegrationJobInput, type ReleaseBuildReceipt, type ReleaseDeployReceipt, type RunnerResult } from "@commonforge-org/runner-protocol";
import type { Services } from "../context.js";
import { newId } from "../lib/crypto.js";
import { ApiError, conflict, forbidden } from "../lib/http.js";
import { canReadProject } from "../middleware/authz.js";
import { repoInfoCoords } from "./artifacts.js";
import { getProject, getResource, getRole, listMounts, projectPolicy, resourceCoords, type Role } from "./directory.js";
import { recordEvent, userRef, type AppEvent } from "./events.js";
import { DEFAULT_PUBLISH_ROLES, ReleasePolicySchema, type ReleasePolicy } from "./release-policy.js";
import { issueJob, onRunnerResult, type RunnerJobRow } from "./runner-jobs.js";
import { assertOrgD1NotInUse, assertTargetsAllowed, orgD1Ids, workerNameProblem } from "./deploy-targets.js";
import { applyProductionMigrations, productionDataFor, productionDataProblem } from "./production-data.js";
import type { StagingResource } from "./staging-data.js";
import type { StagingPolicy } from "./staging-policy.js";
import { RESULT_GRACE_MS } from "./runner-jobs.js";
import { enqueueStep, onStep, onStepFailed } from "./steps.js";

import { assertNativeRelease, nativeBindingStatement, nativeReleaseState, prepareNativeReleaseBinding, presentNativeRelease, recordNativeReleaseHealth, type NativeReleaseBinding } from "./native-release.js";

export type ReleaseChannel = "production" | "staging";

export type ReleaseState = "not_requested" | "prepared" | "publish_approved" | "deploying" | "health_verification" | "live" | "failed" | "partial" | "recovery_required";

export interface ReleaseRow {
  release_id: string;
  org_id: string;
  project_id: string;
  accepted_version_id: string;
  sources_json: string;
  recipe_json: string;
  recipe_revision: number;
  policy_revision: number;
  environment_json: string;
  env_digest: string;
  identity_key: string;
  /** `staging` releases have their own live pointer, deploy lock and rollback, and no publish approval */
  channel: ReleaseChannel;
  state: ReleaseState;
  build_state: "building" | "built" | "failed";
  build_job_id: string | null;
  build_receipt_json: string | null;
  output_digest: string | null;
  deploy_job_id: string | null;
  deploy_attempts: number;
  deploy_receipt_json: string | null;
  health_json: string | null;
  previous_release_id: string | null;
  rollback_job_id: string | null;
  rollback_state: "running" | "verifying" | "done" | "failed" | null;
  rollback_receipt_json: string | null;
  error_code: string | null;
  error: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface LiveRow {
  org_id: string;
  project_id: string;
  channel: ReleaseChannel;
  release_id: string;
  accepted_version_id: string;
  output_digest: string;
  deployments_json: string;
  since: string;
}

/** What the release was prepared against (server-owned; snapshotted so later policy edits cannot change it). */
interface ReleaseEnvironment {
  targets: ReleasePolicy["targets"];
  /** as built: for production, each target's `data` is derived from `migrations` */
  environment: ReleasePolicy["environment"];
  healthCheck: ReleasePolicy["healthCheck"];
  accountId: string;
  /** production D1 migrations folders (staging phase 2, R8); absent when there are none, so older env digests stay valid */
  migrations?: ReleasePolicy["migrations"];
}

/** Where a release's build stores its outputs (and the deploy reads them). */
export function releaseOutputPrefix(rel: { org_id: string; release_id: string }): string {
  return `org/${rel.org_id}/releases/${rel.release_id}/`;
}

/**
 * The production environment a release is built with: the policy's, plus each target's `data`
 * derived from `release.migrations` (its migrations folders only; production is never seeded, and
 * the schema refuses `data` in the policy itself). Unchanged when there are no migrations.
 */
function productionEnvironment(policy: ReleasePolicy): ReleasePolicy["environment"] {
  const out: ReleasePolicy["environment"] = { ...policy.environment };
  for (const t of policy.targets) {
    const data = productionDataFor(policy.migrations, t.targetId);
    if (data.length > 0) out[t.targetId] = { ...(out[t.targetId] ?? { vars: {}, kvNamespaces: [] }), data };
  }
  return out;
}

/**
 * Every `release.*` event carries the release's channel in `detail` and `clientDetail`, so a
 * staging release is never shown as production (e.g. the web app's "Live in production").
 */
function recordReleaseEvent(svc: Services, channel: ReleaseChannel, e: AppEvent): Promise<void> {
  return recordEvent(svc, { ...e, detail: { ...(e.detail ?? {}), channel }, clientDetail: { ...(e.clientDetail ?? {}), channel } });
}

export const RELEASE_SERVICE = { kind: "service", id: "release-service" } as never;

export async function getRelease(svc: Services, orgId: string, releaseId: string): Promise<ReleaseRow | null> {
  return svc.db.prepare("SELECT * FROM releases WHERE org_id = ? AND release_id = ?").bind(orgId, releaseId).first<ReleaseRow>();
}

export async function getLive(svc: Services, orgId: string, projectId: string, channel: ReleaseChannel = "production"): Promise<LiveRow | null> {
  return svc.db.prepare("SELECT * FROM release_live WHERE org_id = ? AND project_id = ? AND channel = ?").bind(orgId, projectId, channel).first<LiveRow>();
}

function releasePolicy(policy: unknown): ReleasePolicy {
  const parsed = ReleasePolicySchema.safeParse(policy);
  if (!parsed.success) throw conflict("release_not_configured", "this project has no release recipe (owner: PUT …/policy with `release`)");
  return parsed.data;
}

function deployAccount(svc: Services): string {
  const id = svc.env.COMMONFORGE_DEPLOY_ACCOUNT_ID || svc.env.CF_ACCOUNT_ID;
  if (!id || !/^[0-9a-f]{32}$/.test(id)) throw new ApiError(503, "config_missing", "the deploy account (COMMONFORGE_DEPLOY_ACCOUNT_ID or CF_ACCOUNT_ID) is not configured");
  return id;
}

/**
 * Who asks for a release step. Routes pass the signed-in owner/developer. The promotion service
 * (staging phase 2) passes `principal` (itself, `onBehalfOf` the user who cleared the promotion) and
 * `userId` = that user: events name the service, `created_by` the user it acts for. These functions
 * never check roles themselves (the routes do); the promotion service is the only other caller.
 */
export interface ReleaseActor {
  orgId: string;
  userId: string;
  principal?: PrincipalRef;
}
const actorRef = (actor: ReleaseActor): PrincipalRef => actor.principal ?? userRef(actor.userId);

/** Step 1: prepare (idempotent per identity). */
export async function prepareRelease(svc: Services, actor: ReleaseActor, projectId: string, body: { acceptedVersionId?: string | undefined }): Promise<{ release: ReleaseRow; created: boolean }> {
  const project = await getProject(svc.db, actor.orgId, projectId);
  if (!project) throw new ApiError(404, "not_found", "project not found");
  const policy = releasePolicy(projectPolicy(project).release);
  const accountId = deployAccount(svc);
  // review C-1: re-checked here (the policy may predate the rule, or a binding may have been removed)
  await assertTargetsAllowed(svc, actor.orgId, policy.targets, Object.entries(policy.environment).map(([targetId, e]) => ({ targetId, kvNamespaces: e.kvNamespaces, d1Databases: e.d1Databases ?? [] })), await orgD1Ids(svc, actor.orgId));
  await assertOrgD1NotInUse(svc, actor.orgId, projectId, Object.values(policy.environment).flatMap((e) => (e.d1Databases ?? []).map((d) => d.id)));
  const mounts = await listMounts(svc.db, actor.orgId, projectId);
  const needed = new Set<string>([...policy.recipe.steps.map((s) => s.mountName as string), ...policy.targets.map((t) => t.mountName as string)]);
  const ledger = svc.ledger(actor.orgId);
  const sources: Array<{ resourceId: string; mountName: string; canonical: RepoCoords; sha: string; revisionId: string }> = [];
  for (const mountName of [...needed].sort()) {
    const m = mounts.find((x) => x.mount_name === mountName);
    if (!m) throw conflict("release_mount_missing", `the release recipe needs mount ${mountName}, which this project does not have`);
    const head = await ledger.getHead(m.resource_id);
    if (!head) throw conflict("resource_not_ready", `mount ${mountName} has no accepted version yet`);
    const rev = parseRevisionId(head.revisionId);
    if (rev.kind !== "art") throw conflict("release_mount_unsupported", `mount ${mountName} is not a git resource`);
    const r = await getResource(svc.db, actor.orgId, m.resource_id);
    const coords = r ? resourceCoords(r) : null;
    if (!coords || coords.kind !== "artifacts") throw conflict("resource_not_ready", `no canonical repository for ${mountName}`);
    const info = await svc.transport.getRepo(coords.namespace, coords.repoName);
    if (!info || info.id !== coords.repoId) throw conflict("repo_mismatch", `canonical repository of ${mountName} changed`);
    sources.push({ resourceId: m.resource_id, mountName, canonical: repoInfoCoords(coords.namespace, info), sha: (rev as { sha: string }).sha, revisionId: head.revisionId });
  }
  // the accepted version these heads came from: the latest one touching any source resource
  const ids = new Set(sources.map((s) => s.resourceId));
  let latest: Awaited<ReturnType<typeof ledger.listAcceptedVersions>>[number] | undefined;
  for (let after = 0; ; ) {
    const page = await ledger.listAcceptedVersions({ after, limit: 500 });
    for (const v of page) if (v.heads.some((h) => ids.has(h.resourceId))) latest = v;
    if (page.length < 500) break;
    after = page[page.length - 1]!.sequence;
  }
  if (!latest) throw conflict("resource_not_ready", "no accepted version to release");
  if (body.acceptedVersionId !== undefined && body.acceptedVersionId !== latest.acceptedVersionId) {
    throw conflict("accepted_version_stale", "a newer version was accepted; prepare a release of the current version", { currentAcceptedVersionId: latest.acceptedVersionId });
  }
  // the derived data and the migrations are part of the env digest, hence of the identity: adding
  // migrations to the policy is a new release (whose build carries the migration files)
  const environment: ReleaseEnvironment = { targets: policy.targets, environment: productionEnvironment(policy), healthCheck: policy.healthCheck, accountId, ...(policy.migrations.length > 0 ? { migrations: policy.migrations } : {}) };
  const envDigest = configDigest(environment); // = what insertReleaseAndBuild stores as env_digest
  const sourceMap = Object.fromEntries(sources.map((s) => [s.resourceId, s.revisionId]));
  const nativeBinding = await prepareNativeReleaseBinding(svc, actor.orgId, projectId, sourceMap, policy.recipe, environment);
  const identityKey = await sha256Hex(canonicalJson({ projectId, acceptedVersionId: latest.acceptedVersionId, sources: sourceMap, recipe: policy.recipe, envDigest, ...(nativeBinding ? {manifestHash:nativeBinding.manifestHash} : {}) }));
  const existing = await svc.db
    .prepare("SELECT * FROM releases WHERE org_id = ? AND identity_key = ? AND build_state != 'failed' ORDER BY created_at DESC LIMIT 1")
    .bind(actor.orgId, identityKey)
    .first<ReleaseRow>();
  if (existing) { await assertNativeRelease(svc,existing); return { release: existing, created: false }; }

  const { releaseId, jobId } = await insertReleaseAndBuild(svc, {
    orgId: actor.orgId,
    projectId,
    userId: actor.userId,
    channel: "production",
    acceptedVersionId: latest.acceptedVersionId,
    sources,
    recipe: policy.recipe,
    targets: policy.targets,
    environment: environment.environment,
    environmentRecord: environment,
    policyRevision: project.policy_revision,
    identityKey,
    nativeBinding,
  });
  await recordReleaseEvent(svc, "production", { orgId: actor.orgId, projectId, actor: actorRef(actor), action: "release.prepare_requested", subjectKind: "release", subjectId: releaseId, resourceIds: [...ids], detail: { acceptedVersionId: latest.acceptedVersionId, recipeRevision: policy.recipe.revision, envDigest, jobId }, clientVisible: true, clientDetail: { acceptedVersionId: latest.acceptedVersionId } });
  return { release: (await getRelease(svc, actor.orgId, releaseId))!, created: true };
}

type ReleaseSource = { resourceId: string; mountName: string; canonical: RepoCoords; sha: string; revisionId: string };

/** Insert a release row (any channel) and start its `release-build` job. */
async function insertReleaseAndBuild(
  svc: Services,
  r: {
    orgId: string;
    projectId: string;
    userId: string;
    channel: ReleaseChannel;
    acceptedVersionId: string;
    sources: ReleaseSource[];
    recipe: ReleasePolicy["recipe"];
    targets: ReleasePolicy["targets"];
    environment: ReleasePolicy["environment"];
    environmentRecord: ReleaseEnvironment;
    policyRevision: number;
    identityKey: string;
    nativeBinding?: NativeReleaseBinding | null;
  },
): Promise<{ releaseId: string; jobId: string }> {
  const releaseId = newId("rel", 12);
  const now = svc.nowIso();
  const sourceMap = Object.fromEntries(r.sources.map((s) => [s.resourceId, s.revisionId]));
  const insert = svc.db
    .prepare(
      "INSERT INTO releases (release_id, org_id, project_id, accepted_version_id, sources_json, recipe_json, recipe_revision, policy_revision, environment_json, env_digest, identity_key, state, build_state, channel, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'not_requested', 'building', ?, ?, ?, ?)",
    )
    .bind(releaseId, r.orgId, r.projectId, r.acceptedVersionId, JSON.stringify(sourceMap), JSON.stringify(r.recipe), r.recipe.revision, r.policyRevision, JSON.stringify(r.environmentRecord), configDigest(r.environmentRecord), r.identityKey, r.channel, r.userId, now, now);
  await svc.db.batch([insert,...(r.nativeBinding ? [nativeBindingStatement(svc,releaseId,r.orgId,r.projectId,r.nativeBinding)] : [])]);
  const job = await issueJob(
    svc,
    {
      kind: "release-build",
      releaseId,
      acceptedVersionId: r.acceptedVersionId,
      sources: r.sources.map(({ revisionId: _r, ...s }) => s),
      recipe: r.recipe,
      targets: r.targets,
      environment: r.environment,
      outputPrefix: releaseOutputPrefix({ org_id: r.orgId, release_id: releaseId }),
    } as IntegrationJobInput,
    {
      orgId: r.orgId,
      subject: `release:${releaseId}`,
      lifetimeSeconds: 3600,
      beforeEnqueue: async (jobId) => void (await svc.db.prepare("UPDATE releases SET build_job_id = ?, updated_at = ? WHERE release_id = ?").bind(jobId, svc.nowIso(), releaseId).run()),
    },
  );
  return { releaseId, jobId: job.jobId };
}

/**
 * A staging release (staging phase 1): the release targets under `<workerName>-staging`, bound to
 * the project's platform-created staging D1/KV (never a production id), the staging vars and the
 * capture sink, plus the migrations and seed as data files. Built like any release; once built it
 * is deployable without a publish approval ({@link startStagingDeploy}). Idempotent per build.
 */
export async function prepareStagingRelease(
  svc: Services,
  input: {
    orgId: string;
    projectId: string;
    userId: string;
    buildId: string;
    sources: ReleaseSource[];
    staging: StagingPolicy;
    release: ReleasePolicy;
    resources: StagingResource[];
    captureUrl: string;
  },
): Promise<ReleaseRow> {
  const project = await getProject(svc.db, input.orgId, input.projectId);
  if (!project) throw new ApiError(404, "not_found", "project not found");
  const identityKey = await sha256Hex(`cf.staging-release/1|${input.orgId}|${input.projectId}|${input.buildId}`);
  const existing = await svc.db
    .prepare("SELECT * FROM releases WHERE org_id = ? AND identity_key = ? AND build_state != 'failed' ORDER BY created_at DESC LIMIT 1")
    .bind(input.orgId, identityKey)
    .first<ReleaseRow>();
  if (existing) return existing;
  const targets = input.release.targets.map((t) => ({ ...t, workerName: stagingWorkerName(t.workerName) }));
  const environment: ReleasePolicy["environment"] = {};
  for (const t of targets) {
    const env = input.staging.environment[t.targetId];
    const mine = input.resources.filter((r) => r.target_id === t.targetId && r.state === "active");
    const d1 = mine.filter((r) => r.kind === "d1").map((r) => ({ binding: r.binding, id: r.resource_id }));
    const data = env ? [...env.d1.flatMap((d) => [...(d.migrationsDir ? [d.migrationsDir] : []), ...(d.seed ?? [])]), ...env.kv.flatMap((k) => (k.seed ? [k.seed] : []))] : [];
    environment[t.targetId] = {
      vars: { ...(env?.vars ?? {}), ...Object.fromEntries(input.staging.captureVars.map((v) => [v, input.captureUrl])) },
      kvNamespaces: mine.filter((r) => r.kind === "kv").map((r) => ({ binding: r.binding, id: r.resource_id })),
      ...(d1.length > 0 ? { d1Databases: d1 } : {}),
      ...(data.length > 0 ? { data } : {}),
      // the sink is a workers.dev Worker on the same account: without this flag Cloudflare refuses the fetch (1042)
      ...(input.staging.captureVars.length > 0 ? { compatibilityFlags: ["global_fetch_strictly_public" as const] } : {}),
    };
  }
  const recipe = input.staging.recipe ?? input.release.recipe;
  const environmentRecord: ReleaseEnvironment = { targets, environment, healthCheck: input.release.healthCheck, accountId: deployAccount(svc) };
  const { releaseId, jobId } = await insertReleaseAndBuild(svc, {
    orgId: input.orgId,
    projectId: input.projectId,
    userId: input.userId,
    channel: "staging",
    acceptedVersionId: `staging-${input.buildId}`,
    sources: input.sources,
    recipe,
    targets,
    environment,
    environmentRecord,
    policyRevision: project.policy_revision,
    identityKey,
  });
  await recordReleaseEvent(svc, "staging", { orgId: input.orgId, projectId: input.projectId, actor: userRef(input.userId), action: "release.prepare_requested", subjectKind: "release", subjectId: releaseId, resourceIds: input.sources.map((s) => s.resourceId), detail: { buildId: input.buildId, recipeRevision: recipe.revision, jobId }, clientVisible: false });
  return (await getRelease(svc, input.orgId, releaseId))!;
}

onRunnerResult("release-build", async (svc, row: RunnerJobRow, job: IntegrationJob, result: RunnerResult) => {
  if (job.kind !== "release-build") return;
  const rel = await getRelease(svc, row.org_id, job.releaseId);
  if (!rel || rel.build_job_id !== row.job_id || rel.build_state !== "building") return;
  if (result.ok) {
    const receipt = result.receipt as ReleaseBuildReceipt;
    await svc.db
      // a staging release needs no publish approval: built means deployable
      .prepare("UPDATE releases SET state = CASE WHEN channel = 'staging' THEN 'publish_approved' ELSE 'prepared' END, build_state = 'built', build_receipt_json = ?, output_digest = ?, updated_at = ? WHERE release_id = ? AND build_state = 'building'")
      .bind(JSON.stringify(receipt), receipt.outputDigest, svc.nowIso(), rel.release_id)
      .run();
  } else {
    await svc.db
      .prepare("UPDATE releases SET build_state = 'failed', error_code = ?, error = ?, updated_at = ? WHERE release_id = ? AND build_state = 'building'")
      .bind(result.code, result.detail.slice(0, 4000), svc.nowIso(), rel.release_id)
      .run();
  }
  await recordReleaseEvent(svc, rel.channel, { orgId: rel.org_id, projectId: rel.project_id, actor: RELEASE_SERVICE, action: result.ok ? "release.prepared" : "release.build_failed", subjectKind: "release", subjectId: rel.release_id, resourceIds: Object.keys(JSON.parse(rel.sources_json) as object), detail: result.ok ? { outputDigest: (result.receipt as ReleaseBuildReceipt).outputDigest } : { code: result.code }, clientVisible: true, clientDetail: result.ok ? {} : { code: result.code } });
});

async function publishRoles(svc: Services, orgId: string, projectId: string): Promise<Role[]> {
  const project = await getProject(svc.db, orgId, projectId);
  return (project ? projectPolicy(project).publishRoles : undefined) ?? [...DEFAULT_PUBLISH_ROLES];
}

/** Step 3: the publish approval, a separate record bound to the exact output. */
export async function approvePublish(svc: Services, actor: { orgId: string; userId: string; role: Role }, rel: ReleaseRow, body: { outputDigest: string }) {
  await assertNativeRelease(svc,rel);
  if (rel.channel === "staging") throw conflict("staging_release", "staging deploys need no publish approval; this release deploys to staging only");
  const roles = await publishRoles(svc, actor.orgId, rel.project_id);
  if (!roles.includes(actor.role)) throw forbidden("publish_role_not_allowed", `publishing needs approval from: ${roles.join(", ")}`);
  if (rel.build_state !== "built" || !rel.output_digest) throw conflict("release_not_prepared", "the release is still building (or its build failed)");
  if (body.outputDigest !== rel.output_digest) throw conflict("output_digest_mismatch", "the release output differs from what you reviewed", { currentOutputDigest: rel.output_digest });
  if (rel.state === "live") throw conflict("already_live", "this release is already live");
  const approval = { approvalId: newId("pub", 10), releaseId: rel.release_id, outputDigest: rel.output_digest, envDigest: rel.env_digest, approver: actor.userId, role: actor.role, approvedAt: svc.nowIso() };
  await svc.db
    .prepare("INSERT INTO release_publish_approvals (approval_id, org_id, release_id, output_digest, env_digest, approver, role, approved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(approval.approvalId, actor.orgId, rel.release_id, approval.outputDigest, approval.envDigest, actor.userId, actor.role, approval.approvedAt)
    .run();
  await svc.db.prepare("UPDATE releases SET state = 'publish_approved', updated_at = ? WHERE release_id = ? AND state = 'prepared'").bind(svc.nowIso(), rel.release_id).run();
  await recordReleaseEvent(svc, rel.channel, { orgId: actor.orgId, projectId: rel.project_id, actor: userRef(actor.userId), action: "release.publish_approved", subjectKind: "release", subjectId: rel.release_id, resourceIds: Object.keys(JSON.parse(rel.sources_json) as object), detail: { outputDigest: rel.output_digest, role: actor.role }, clientVisible: true, clientDetail: { role: actor.role } });
  return approval;
}

/** Role prefix of a publish approval written by the promotion service (`clearance:self|classifier|developer`). */
export const CLEARANCE_PUBLISH_PREFIX = "clearance:";

/**
 * Staging phase 2: a promotion's clearance authorizes the production publish of its own release.
 * The promotion service writes a publish approval with role `clearance:<kind>` and approver = the
 * user who cleared the promotion (a client may have cleared it by itself), bound to the output and
 * environment like any publish approval, and moves the release `prepared → publish_approved` exactly
 * as {@link approvePublish} does (the deploy claim only takes deployable states). Idempotent: a
 * matching clearance approval is not written twice. Never reachable from a route.
 */
export async function approvePublishByClearance(svc: Services, rel: ReleaseRow, promotion: { promotionId: string; kind: string; clearedBy: string }): Promise<void> {
  if (rel.channel !== "production") throw conflict("staging_release", "only production releases take a publish approval");
  if (rel.build_state !== "built" || !rel.output_digest) throw conflict("release_not_prepared", "the release is still building (or its build failed)");
  const role = `${CLEARANCE_PUBLISH_PREFIX}${promotion.kind}`;
  const existing = await svc.db
    .prepare("SELECT 1 AS x FROM release_publish_approvals WHERE release_id = ? AND role = ? AND approver = ? AND output_digest = ? AND env_digest = ?")
    .bind(rel.release_id, role, promotion.clearedBy, rel.output_digest, rel.env_digest)
    .first<{ x: number }>();
  if (!existing) {
    await svc.db
      .prepare("INSERT INTO release_publish_approvals (approval_id, org_id, release_id, output_digest, env_digest, approver, role, approved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(newId("pub", 10), rel.org_id, rel.release_id, rel.output_digest, rel.env_digest, promotion.clearedBy, role, svc.nowIso())
      .run();
  }
  const moved = await svc.db.prepare("UPDATE releases SET state = 'publish_approved', updated_at = ? WHERE release_id = ? AND state = 'prepared'").bind(svc.nowIso(), rel.release_id).run();
  if (existing && (moved.meta.changes ?? 0) === 0) return;
  await recordReleaseEvent(svc, rel.channel, {
    orgId: rel.org_id,
    projectId: rel.project_id,
    actor: { kind: "service", id: "promotion-service", onBehalfOf: { kind: "user", id: promotion.clearedBy } } as PrincipalRef,
    action: "release.publish_approved",
    subjectKind: "release",
    subjectId: rel.release_id,
    resourceIds: Object.keys(JSON.parse(rel.sources_json) as object),
    detail: { outputDigest: rel.output_digest, role, promotionId: promotion.promotionId },
    clientVisible: true,
    clientDetail: { role },
  });
}

/**
 * A publish approval that still counts: same release, output and environment, approver still in a
 * publish role. A `clearance:<kind>` approval (staging phase 2) counts instead only while a
 * promotion releasing exactly this release was cleared with that kind by that approver (who must
 * still be a member and, unless owner or developer, read the project); `publishRoles` does not apply.
 */
export async function validPublishApproval(svc: Services, rel: ReleaseRow): Promise<{ approval_id: string; approver: string } | null> {
  const roles = await publishRoles(svc, rel.org_id, rel.project_id);
  const rows = await svc.db
    .prepare("SELECT approval_id, approver, role, output_digest, env_digest FROM release_publish_approvals WHERE release_id = ? ORDER BY approved_at DESC")
    .bind(rel.release_id)
    .all<{ approval_id: string; approver: string; role: string; output_digest: string; env_digest: string }>();
  for (const a of rows.results) {
    if (a.output_digest !== rel.output_digest || a.env_digest !== rel.env_digest) continue;
    const role = await getRole(svc.db, rel.org_id, a.approver);
    if (!role) continue;
    if (a.role.startsWith(CLEARANCE_PUBLISH_PREFIX)) {
      if (rel.channel !== "production") continue;
      // like a clearance on a proposal: a client approver still reads the project
      if (role !== "owner" && role !== "developer" && !(await canReadProject(svc, { orgId: rel.org_id, userId: a.approver, role }, rel.project_id))) continue;
      const releasing = await svc.db
        .prepare("SELECT 1 AS x FROM promotions WHERE org_id = ? AND project_id = ? AND release_id = ? AND state = 'releasing' AND clearance_kind = ? AND cleared_by = ?")
        .bind(rel.org_id, rel.project_id, rel.release_id, a.role.slice(CLEARANCE_PUBLISH_PREFIX.length), a.approver)
        .first<{ x: number }>();
      if (releasing) return { approval_id: a.approval_id, approver: a.approver };
      continue;
    }
    if (roles.includes(role)) return { approval_id: a.approval_id, approver: a.approver };
  }
  return null;
}

/** States from which a deploy may (re)start: retry after failure (AT-35), after a partial deploy (review I-5) or after recovery. */
const DEPLOYABLE = ["publish_approved", "failed", "partial", "recovery_required"] as const;

/** The release-deploy job body for a built release (also used to roll back to the previous release). */
function deployJobFor(rel: ReleaseRow): IntegrationJobInput {
  const env = JSON.parse(rel.environment_json) as ReleaseEnvironment;
  const built = JSON.parse(rel.build_receipt_json ?? "null") as ReleaseBuildReceipt | null;
  if (!built || !rel.output_digest) throw conflict("release_not_prepared", "the release has no build");
  return {
    kind: "release-deploy",
    releaseId: rel.release_id,
    outputDigest: rel.output_digest,
    outputPrefix: releaseOutputPrefix(rel),
    accountId: env.accountId,
    targets: built.targets.map((t) => {
      const spec = env.targets.find((x) => x.targetId === t.targetId)!;
      // the target digest covers the data files (migrations, seed), so they travel with the job
      return { targetId: t.targetId, kind: spec.kind, workerName: spec.workerName, ...(spec.main ? { main: spec.main } : {}), digest: t.digest, files: t.files, config: t.config, ...(t.dataFiles?.length ? { dataFiles: t.dataFiles } : {}) };
    }),
  } as IntegrationJobInput;
}

/** review C-1: the stored release is re-checked against the org's namespace and bindings at deploy time. */
async function assertReleaseAllowed(svc: Services, rel: ReleaseRow): Promise<void> {
  const env = JSON.parse(rel.environment_json) as ReleaseEnvironment;
  const built = JSON.parse(rel.build_receipt_json ?? "null") as ReleaseBuildReceipt | null;
  if (rel.channel === "staging") return assertStagingReleaseAllowed(svc, rel, env, built);
  await assertTargetsAllowed(svc, rel.org_id, env.targets, (built?.targets ?? []).map((t) => ({ targetId: t.targetId, kvNamespaces: t.config.kvNamespaces, d1Databases: t.config.d1Databases ?? [] })), await orgD1Ids(svc, rel.org_id));
  // review I3: an older release must not migrate a D1 another project's policy binds by now
  await assertOrgD1NotInUse(svc, rel.org_id, rel.project_id, (built?.targets ?? []).flatMap((t) => (t.config.d1Databases ?? []).map((d) => d.id)));
  // R8: production data files are migrations-folder files only (never a seed)
  for (const t of built?.targets ?? []) {
    const why = productionDataProblem(env.migrations ?? [], t.targetId, t.dataFiles ?? []);
    if (why) throw new ApiError(403, "release_data_not_allowed", why, { targetId: t.targetId });
  }
}

/**
 * Migrations before code (staging phase 2, R8): a claimed production deploy applies the release's
 * pending D1 migrations before any release-deploy job exists. On failure the release is `failed`
 * and nothing deployed: `migration_failed` (D1 refused a migration; retry once fixed),
 * `migration_state_unknown` (a migration was sent without a definite answer; an owner must resolve
 * it before any retry), `migration_unavailable` (a transient error before any query was sent;
 * retryable as is), or the verification's own code. Applied migrations stay recorded and never re-run.
 */
async function migrateBeforeDeploy(svc: Services, rel: ReleaseRow): Promise<void> {
  const env = JSON.parse(rel.environment_json) as ReleaseEnvironment;
  if (!env.migrations?.length) return;
  const built = JSON.parse(rel.build_receipt_json ?? "null") as ReleaseBuildReceipt | null;
  if (!built) throw conflict("release_not_prepared", "the release has no build");
  const resources = Object.keys(JSON.parse(rel.sources_json) as object);
  let applied: string[];
  try {
    ({ applied } = await applyProductionMigrations(svc, { ...rel, output_prefix: releaseOutputPrefix(rel) }, env.accountId, built, env.migrations));
  } catch (e) {
    // applyProductionMigrations classifies everything after a query was sent; anything else
    // (reading the stored files, D1 bookkeeping before the query) ran nothing and can be retried
    const failure = e instanceof ApiError ? e : new ApiError(503, "migration_unavailable", `production migrations could not start; retry the deploy: ${String((e as Error)?.message ?? e)}`);
    await svc.db
      .prepare("UPDATE releases SET state = 'failed', error_code = ?, error = ?, updated_at = ? WHERE release_id = ? AND state = 'deploying'")
      .bind(failure.code, failure.message.slice(0, 4000), svc.nowIso(), rel.release_id)
      .run();
    await recordReleaseEvent(svc, rel.channel, { orgId: rel.org_id, projectId: rel.project_id, actor: RELEASE_SERVICE, action: "release.migration_failed", subjectKind: "release", subjectId: rel.release_id, resourceIds: resources, detail: { code: failure.code, error: failure.message.slice(0, 2000), ...(failure.code === "migration_state_unknown" ? { resourceId: failure.details?.resourceId, key: failure.details?.key } : {}) }, clientVisible: true, clientDetail: { code: failure.code } });
    throw failure;
  }
  // outside the try: the migrations ran, so a failed event write must not mark them failed
  if (applied.length > 0) await recordReleaseEvent(svc, rel.channel, { orgId: rel.org_id, projectId: rel.project_id, actor: RELEASE_SERVICE, action: "release.migrations_applied", subjectKind: "release", subjectId: rel.release_id, resourceIds: resources, detail: { applied }, clientVisible: false });
}

/**
 * A staging release deploys only `-staging` Workers in the org namespace, bound only to staging
 * D1/KV the platform created for THIS project (active, or retired: an older staging release that
 * is rolled back to still binds its generation). Never a production binding of the org.
 */
async function assertStagingReleaseAllowed(svc: Services, rel: ReleaseRow, env: ReleaseEnvironment, built: ReleaseBuildReceipt | null): Promise<void> {
  for (const t of env.targets) {
    const why = workerNameProblem(svc.env, rel.org_id, t.workerName) ?? (t.workerName.endsWith("-staging") ? null : `staging Workers must be named <release Worker>-staging, not ${t.workerName}`);
    if (why) throw new ApiError(403, "release_target_not_allowed", why, { targetId: t.targetId });
  }
  // a staging name must never be a production Worker of the org
  const production = await productionWorkerNames(svc, rel.org_id);
  const clash = env.targets.find((t) => production.has(t.workerName));
  if (clash) throw new ApiError(409, "release_target_in_use", `Worker ${clash.workerName} is a production release Worker of project ${production.get(clash.workerName)}; staging cannot deploy to it. Rename that production target.`, { targetId: clash.targetId, workerName: clash.workerName });
  const rows = await svc.db
    .prepare("SELECT kind, resource_id FROM staging_resources WHERE org_id = ? AND project_id = ? AND state IN ('active', 'retired')")
    .bind(rel.org_id, rel.project_id)
    .all<{ kind: "d1" | "kv"; resource_id: string }>();
  const owned = { d1: new Set<string>(), kv: new Set<string>() };
  for (const r of rows.results) owned[r.kind].add(r.resource_id);
  for (const t of built?.targets ?? []) {
    for (const [kind, list] of [["kv", t.config.kvNamespaces], ["d1", t.config.d1Databases ?? []]] as const) {
      for (const b of list) {
        if (!owned[kind].has(b.id)) throw new ApiError(403, "binding_not_allowed", `${kind === "kv" ? "KV namespace" : "D1 database"} ${b.id} is not a staging resource of this project`, { targetId: t.targetId, binding: b.binding });
      }
    }
  }
}

/**
 * The org's production release Workers (name → project): every target of any project's stored
 * release policy (including one saved before `-staging` names were reserved) and every Worker a
 * production live pointer records. Staging must never deploy to or delete one of these.
 */
async function productionWorkerNames(svc: Services, orgId: string): Promise<Map<string, string>> {
  const production = new Map<string, string>();
  const policies = await svc.db.prepare("SELECT project_id, policy_json FROM projects WHERE org_id = ?").bind(orgId).all<{ project_id: string; policy_json: string }>();
  for (const p of policies.results) {
    for (const t of (JSON.parse(p.policy_json) as { release?: { targets?: Array<{ workerName?: unknown }> } }).release?.targets ?? []) if (typeof t.workerName === "string") production.set(t.workerName, p.project_id);
  }
  const live = await svc.db.prepare("SELECT project_id, deployments_json FROM release_live WHERE org_id = ? AND channel = 'production'").bind(orgId).all<{ project_id: string; deployments_json: string }>();
  for (const l of live.results) {
    for (const d of JSON.parse(l.deployments_json) as Array<{ workerName?: unknown }>) if (typeof d.workerName === "string" && !production.has(d.workerName)) production.set(d.workerName, l.project_id);
  }
  return production;
}

/** A health/rollback check that has not progressed for this long is lost (its queue step died). */
export const STALE_CHECK_MS = 30 * 60_000;
/**
 * Follow-up n-1: a runner result is stored (job `succeeded`/`failed`) before its applier runs, and
 * the failure applier makes Cloudflare API calls. A job that got a real result is therefore only
 * "lost" once its completion is this old: until then the applier may still be moving the release.
 */
export const RESULT_APPLY_GRACE_MS = 2 * 60_000;

/**
 * Review R-1: a deploy or rollback whose job ended without a result (queue gave up, container
 * died, job expired and was closed by GC, credential refused) must not hold the per-project
 * deploy lock forever. Such releases become `recovery_required` (`deploy_lost`) or, for a lost
 * rollback, `rollback_failed`; the lock is then free. Called before every deploy claim, by the
 * GC sweep (every 10 min) and by the owner's recover action.
 */
export async function sweepStaleReleases(svc: Services, orgId: string, projectId?: string, channel?: ReleaseChannel): Promise<string[]> {
  const now = svc.now().getTime();
  const rows = await svc.db
    .prepare(
      `SELECT r.*, j.status AS dj_status, j.expires_at AS dj_exp, j.completed_at AS dj_done, j.result_hash AS dj_hash,
              rj.status AS rj_status, rj.expires_at AS rj_exp, rj.completed_at AS rj_done, rj.result_hash AS rj_hash FROM releases r
       LEFT JOIN runner_jobs j ON j.job_id = r.deploy_job_id LEFT JOIN runner_jobs rj ON rj.job_id = r.rollback_job_id
       WHERE r.org_id = ? ${projectId ? "AND r.project_id = ?" : ""} ${channel ? "AND r.channel = ?" : ""} AND (r.state IN ('deploying', 'health_verification') OR r.rollback_state IN ('running', 'verifying'))`,
    )
    .bind(orgId, ...(projectId ? [projectId] : []), ...(channel ? [channel] : []))
    .all<ReleaseRow & { dj_status: string | null; dj_exp: number | null; dj_done: number | null; dj_hash: string | null; rj_status: string | null; rj_exp: number | null; rj_done: number | null; rj_hash: string | null }>();
  const swept: string[] = [];
  const old = (iso: string, ms: number) => now - Date.parse(iso) > ms;
  // queued: lost once past expiry + grace. Ended: lost when it was closed without a result (GC
  // stores no result hash, and no applier runs), or when the applier of its result had
  // RESULT_APPLY_GRACE_MS and the release still did not move (n-1: never race a result being applied).
  const jobLost = (j: { id: string | null; status: string | null; exp: number | null; done: number | null; hash: string | null }, updated: string) => {
    if (j.id === null) return old(updated, 10 * 60_000);
    if (j.status === "queued") return j.exp === null || j.exp + RESULT_GRACE_MS < now;
    return j.hash === null || j.done === null || j.done + RESULT_APPLY_GRACE_MS < now;
  };
  for (const r of rows.results) {
    const resources = Object.keys(JSON.parse(r.sources_json) as object);
    if (r.rollback_state === "running" && jobLost({ id: r.rollback_job_id, status: r.rj_status, exp: r.rj_exp, done: r.rj_done, hash: r.rj_hash }, r.updated_at)) {
      if (await rollbackFailed(svc, r, "the rollback job ended without a result", "running")) swept.push(r.release_id);
    } else if (r.rollback_state === "verifying" && old(r.updated_at, STALE_CHECK_MS)) {
      if (await rollbackFailed(svc, r, "the rollback check never finished", "verifying")) swept.push(r.release_id);
    } else if ((r.state === "deploying" && jobLost({ id: r.deploy_job_id, status: r.dj_status, exp: r.dj_exp, done: r.dj_done, hash: r.dj_hash }, r.updated_at)) || (r.state === "health_verification" && old(r.updated_at, STALE_CHECK_MS))) {
      const moved = await svc.db
        .prepare("UPDATE releases SET state = 'recovery_required', error_code = 'deploy_lost', error = ?, updated_at = ? WHERE release_id = ? AND state = ?")
        .bind(r.state === "deploying" ? "the deploy job ended without a result: production state is unverified" : "the health check never finished: production state is unverified", svc.nowIso(), r.release_id, r.state)
        .run();
      if ((moved.meta.changes ?? 0) === 0) continue;
      await clearLive(svc, r); // unknown production state: the pointer must not claim anything
      await recordReleaseEvent(svc, r.channel, { orgId: r.org_id, projectId: r.project_id, actor: RELEASE_SERVICE, action: "release.deploy_lost", subjectKind: "release", subjectId: r.release_id, resourceIds: resources, detail: { fromState: r.state, jobId: r.deploy_job_id }, clientVisible: true, clientDetail: { code: "deploy_lost" } });
      swept.push(r.release_id);
    }
  }
  return swept;
}

/**
 * Owner action (review R-1): after checking production by hand, mark a stuck or unverified release
 * as recovered. It becomes `failed` (retryable) and stops blocking the project; the live pointer
 * is re-established only by a verified deploy (the owner retries a release).
 */
export async function markRecovered(svc: Services, actor: { orgId: string; userId: string }, rel: ReleaseRow, note: string): Promise<void> {
  await sweepStaleReleases(svc, rel.org_id, rel.project_id);
  const fresh = (await getRelease(svc, rel.org_id, rel.release_id))!;
  if (!["recovery_required", "partial"].includes(fresh.state) || fresh.rollback_state === "running" || fresh.rollback_state === "verifying") {
    throw conflict("not_recoverable", `the release is ${fresh.state}${fresh.rollback_state ? ` (rollback ${fresh.rollback_state})` : ""}; only a release needing recovery can be marked recovered`);
  }
  await svc.db
    .prepare("UPDATE releases SET state = 'failed', rollback_state = NULL, error_code = 'recovered_by_owner', error = ?, updated_at = ? WHERE release_id = ? AND state = ?")
    .bind(`marked recovered by the owner: ${note}`.slice(0, 1000), svc.nowIso(), fresh.release_id, fresh.state)
    .run();
  await recordReleaseEvent(svc, rel.channel, { orgId: rel.org_id, projectId: rel.project_id, actor: userRef(actor.userId), action: "release.marked_recovered", subjectKind: "release", subjectId: rel.release_id, resourceIds: Object.keys(JSON.parse(rel.sources_json) as object), detail: { fromState: fresh.state, note }, clientVisible: true, clientDetail: {} });
}

/** Step 4: deploy (or retry the same release). Idempotent per key; one deploy per project in flight (review I-4). */
export async function deployRelease(svc: Services, actor: ReleaseActor, rel: ReleaseRow, idempotencyKey: string, opts: { skipApproval?: boolean } = {}): Promise<{ releaseId: string; jobId: string; attempt: number; replayed: boolean }> {
  await assertNativeRelease(svc,rel);
  const prior = await svc.db
    .prepare("SELECT release_id, attempt, job_id FROM release_deploy_requests WHERE org_id = ? AND idempotency_key = ?")
    .bind(actor.orgId, idempotencyKey)
    .first<{ release_id: string; attempt: number; job_id: string }>();
  if (prior) {
    if (prior.release_id !== rel.release_id) throw conflict("idempotency_key_conflict", "this idempotency key was used for another release");
    return { releaseId: rel.release_id, jobId: prior.job_id, attempt: prior.attempt, replayed: true };
  }
  if (!opts.skipApproval && !(await validPublishApproval(svc, rel))) throw conflict("publish_approval_required", "publishing needs a publish approval for exactly this release output (AT-21)");
  // review R-1: a lost deploy/rollback never holds the project's deploy lock (of this channel)
  if ((await sweepStaleReleases(svc, rel.org_id, rel.project_id, rel.channel)).includes(rel.release_id)) rel = (await getRelease(svc, rel.org_id, rel.release_id))!;
  if (rel.state === "deploying" || rel.state === "health_verification" || rel.rollback_state === "running" || rel.rollback_state === "verifying") throw conflict("deploy_in_progress", "a deploy of this release is in progress");
  if (rel.state === "live") throw conflict("already_live", "this release is already live");
  if (!svc.env.COMMONFORGE_DEPLOY_API_TOKEN) throw new ApiError(503, "config_missing", "COMMONFORGE_DEPLOY_API_TOKEN is not configured");
  await assertReleaseAllowed(svc, rel);
  await assertNativeRelease(svc,rel);
  const body = deployJobFor(rel);

  // claim the deploy first (CAS on the state), so two requests can never start two deploys, and no
  // other release of the project may be deploying, verifying or rolling back meanwhile (review I-4).
  // The live pointer and the lock are per channel: staging never blocks or is blocked by production.
  const claim = await svc.db
    .prepare(
      `UPDATE releases SET state = 'deploying', deploy_attempts = deploy_attempts + 1, deploy_job_id = NULL, error_code = NULL, error = NULL, rollback_job_id = NULL, rollback_state = NULL, rollback_receipt_json = NULL,
         previous_release_id = (SELECT l.release_id FROM release_live l WHERE l.org_id = releases.org_id AND l.project_id = releases.project_id AND l.channel = releases.channel AND l.release_id != releases.release_id),
         updated_at = ?
       WHERE release_id = ? AND state IN (${DEPLOYABLE.map(() => "?").join(", ")})
         AND (rollback_state IS NULL OR rollback_state NOT IN ('running', 'verifying'))
         AND NOT EXISTS (SELECT 1 FROM releases r2 WHERE r2.org_id = ? AND r2.project_id = ? AND r2.channel = releases.channel AND r2.release_id != ? AND (r2.state IN ('deploying', 'health_verification') OR r2.rollback_state IN ('running', 'verifying')))
       RETURNING deploy_attempts`,
    )
    .bind(svc.nowIso(), rel.release_id, ...DEPLOYABLE, rel.org_id, rel.project_id, rel.release_id)
    .first<{ deploy_attempts: number }>();
  if (!claim) throw conflict("deploy_in_progress", "another deploy of this project is in progress, or the release changed state; reload it");
  if (rel.channel === "production") await migrateBeforeDeploy(svc, rel);
  let jobId: string;
  try {
    const job = await issueJob(svc, body, {
      orgId: rel.org_id,
      subject: `release:${rel.release_id}`,
      lifetimeSeconds: 1800,
      jobKey: `release-deploy:${rel.release_id}:${claim.deploy_attempts}`,
      // the deploy credential and the result are only honoured for the release's current job
      beforeEnqueue: async (id) => void (await svc.db.prepare("UPDATE releases SET deploy_job_id = ?, updated_at = ? WHERE release_id = ?").bind(id, svc.nowIso(), rel.release_id).run()),
    });
    jobId = job.jobId;
  } catch (e) {
    await svc.db.prepare("UPDATE releases SET state = 'failed', error_code = 'deploy_not_started', error = ?, updated_at = ? WHERE release_id = ?").bind(String((e as Error).message).slice(0, 500), svc.nowIso(), rel.release_id).run();
    throw e;
  }
  await svc.db.prepare("INSERT INTO release_deploy_requests (org_id, idempotency_key, release_id, attempt, job_id, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(rel.org_id, idempotencyKey, rel.release_id, claim.deploy_attempts, jobId, svc.nowIso()).run();
  await recordReleaseEvent(svc, rel.channel, { orgId: rel.org_id, projectId: rel.project_id, actor: actorRef(actor), action: "release.deploy_requested", subjectKind: "release", subjectId: rel.release_id, resourceIds: Object.keys(JSON.parse(rel.sources_json) as object), detail: { jobId, attempt: claim.deploy_attempts, outputDigest: rel.output_digest, fromState: rel.state }, clientVisible: true, clientDetail: { attempt: claim.deploy_attempts } });
  return { releaseId: rel.release_id, jobId, attempt: claim.deploy_attempts, replayed: false };
}

/** Deploy a built staging release: no publish approval (staging only ever runs staging Workers and staging data). */
export async function startStagingDeploy(svc: Services, rel: ReleaseRow, userId: string): Promise<void> {
  if (rel.channel !== "staging") throw conflict("not_staging", "only staging releases deploy without a publish approval");
  await deployRelease(svc, { orgId: rel.org_id, userId }, rel, `staging-deploy:${rel.release_id}:${rel.deploy_attempts + 1}`, { skipApproval: true });
}

/**
 * The release whose current deploy or rollback is this job, if any (the deploy credential and
 * results are honoured only for those). For a rollback, `release` is the failed release being
 * rolled back and the job deploys `release.previous_release_id`.
 */
export async function releaseForDeployJob(svc: Services, orgId: string, jobId: string): Promise<{ release: ReleaseRow; rollback: boolean } | null> {
  const r = await svc.db.prepare("SELECT * FROM releases WHERE org_id = ? AND (deploy_job_id = ? OR rollback_job_id = ?)").bind(orgId, jobId, jobId).first<ReleaseRow>();
  if (!r) return null;
  if (r.rollback_job_id === jobId) return r.rollback_state === "running" ? { release: r, rollback: true } : null;
  return r.state === "deploying" ? { release: r, rollback: false } : null;
}

onRunnerResult("release-deploy", async (svc, row: RunnerJobRow, job: IntegrationJob, result: RunnerResult) => {
  if (job.kind !== "release-deploy") return;
  const found = await releaseForDeployJob(svc, row.org_id, row.job_id);
  if (!found) return;
  const rel = found.release;
  const resources = Object.keys(JSON.parse(rel.sources_json) as object);
  if (found.rollback) {
    if (result.ok) {
      await svc.db.prepare("UPDATE releases SET rollback_state = 'verifying', rollback_receipt_json = ?, updated_at = ? WHERE release_id = ? AND rollback_state = 'running'").bind(JSON.stringify(result.receipt), svc.nowIso(), rel.release_id).run();
      await enqueueStep(svc, { type: "release.health", orgId: rel.org_id, releaseId: rel.release_id, rollback: true });
    } else {
      await rollbackFailed(svc, rel, `the rollback deploy failed: ${result.code}`, "running");
    }
    return;
  }
  if (result.ok) {
    await svc.db.prepare("UPDATE releases SET state = 'health_verification', deploy_receipt_json = ?, updated_at = ? WHERE release_id = ? AND state = 'deploying'").bind(JSON.stringify(result.receipt), svc.nowIso(), rel.release_id).run();
    await enqueueStep(svc, { type: "release.health", orgId: rel.org_id, releaseId: rel.release_id });
  } else {
    // review R-2: a failed (or partial) deploy may still have changed production. Compare every
    // target with the live pointer; any difference → rollback / recovery_required, never "previous live".
    const drift = await productionDrift(svc, rel);
    if ("unknown" in drift || drift.drift) {
      await startRecovery(svc, rel, "deploying", "unknown" in drift ? "deploy_unverified" : "deploy_changed_production", "the deploy failed after changing production", { error: result.detail.slice(0, 2000) }, "unknown" in drift ? { unknown: drift.unknown } : { targets: drift.targets });
      return;
    }
    const partial = result.detail.startsWith("partial:");
    await svc.db
      .prepare("UPDATE releases SET state = ?, error_code = ?, error = ?, updated_at = ? WHERE release_id = ? AND state = 'deploying'")
      .bind(partial ? "partial" : "failed", partial ? "deploy_partial" : result.code, result.detail.slice(0, 4000), svc.nowIso(), rel.release_id)
      .run();
    await recordReleaseEvent(svc, rel.channel, { orgId: rel.org_id, projectId: rel.project_id, actor: RELEASE_SERVICE, action: "release.deploy_failed", subjectKind: "release", subjectId: rel.release_id, resourceIds: resources, detail: { code: result.code, partial }, clientVisible: true, clientDetail: { code: partial ? "deploy_partial" : result.code } });
  }
});

/** The workers.dev URL of a release target (review C-1c: derived, never free-form). */
async function targetUrl(svc: Services, accountId: string, workerName: string): Promise<string> {
  const sub = await svc.deps.deployApi(svc.env).workersSubdomain(accountId);
  return `https://${workerName}.${sub}.workers.dev`;
}

interface HealthObservation {
  targetId: string;
  workerName: string;
  ok: boolean;
  /** what the target's active deployment runs vs what this deploy uploaded (m-3) */
  activeVersions?: string[];
  expectedVersion?: string | null;
  url?: string;
  status?: number;
  body?: unknown;
  error?: string;
}

/**
 * Health of a deployed release (review m-3: every target): each target's active deployment must
 * run the version this deploy uploaded, and the health-check target's `/version` (its own
 * workers.dev URL) must report the release id.
 */
async function observeHealth(svc: Services, release: ReleaseRow, receipt: ReleaseDeployReceipt): Promise<HealthObservation[]> {
  const env = JSON.parse(release.environment_json) as ReleaseEnvironment;
  const out: HealthObservation[] = [];
  for (const d of receipt.deployments) {
    const o: HealthObservation = { targetId: d.targetId, workerName: d.workerName, ok: false, expectedVersion: d.versionId };
    try {
      if (d.versionId) {
        o.activeVersions = await svc.deps.deployApi(svc.env).activeVersionIds(env.accountId, d.workerName);
        if (!o.activeVersions.includes(d.versionId)) {
          o.error = "the target does not run the uploaded version";
          out.push(o);
          continue;
        }
      }
      if (d.targetId === env.healthCheck.targetId) {
        o.url = `${await targetUrl(svc, env.accountId, d.workerName)}${env.healthCheck.path}`;
        const res = await svc.deps.healthFetch(o.url);
        const text = await res.text();
        o.status = res.status;
        try {
          o.body = JSON.parse(text);
        } catch {
          o.body = text.slice(0, 500);
        }
        o.ok = res.status === 200 && (o.body as { release?: unknown } | null)?.release === release.release_id;
        if (!o.ok) o.error = "the target does not report this release";
      } else o.ok = !!d.versionId; // assets targets: verified by their active version only
      if (!d.versionId && !o.ok) o.error = "wrangler reported no version id for this target";
    } catch (e) {
      o.error = String((e as Error)?.message ?? e).slice(0, 300);
    }
    out.push(o);
  }
  return out;
}

/** Step 5 (queue step `release.health`): verify the deploy, or (rollback=true) the rollback. */
export async function checkReleaseHealth(svc: Services, orgId: string, releaseId: string, attempt: number, rollback = false): Promise<{ done: true } | { retry: true; delaySeconds: number; reason: string }> {
  const rel = await getRelease(svc, orgId, releaseId);
  if (!rel) return { done: true };
  if (rollback) return checkRollback(svc, rel, attempt);
  if (rel.state !== "health_verification" || !rel.deploy_receipt_json) return { done: true };
  const receipt = JSON.parse(rel.deploy_receipt_json) as ReleaseDeployReceipt;
  const targets = await observeHealth(svc, rel, receipt);
  const ok = targets.length > 0 && targets.every((t) => t.ok);
  const health = { attempt, checkedAt: svc.nowIso(), ok, targets };
  await recordNativeReleaseHealth(svc,rel,health);
  if (!ok && attempt < HEALTH_ATTEMPTS) {
    await svc.db.prepare("UPDATE releases SET health_json = ?, updated_at = ? WHERE release_id = ?").bind(JSON.stringify(health), svc.nowIso(), rel.release_id).run();
    return { retry: true, delaySeconds: Math.min(30, 2 * attempt), reason: "the deployed service does not report this release yet" };
  }
  if (!ok) {
    await failHealth(svc, rel, health);
    return { done: true };
  }
  const moved = await svc.db
    .prepare("UPDATE releases SET state = 'live', health_json = ?, updated_at = ? WHERE release_id = ? AND state = 'health_verification'")
    .bind(JSON.stringify(health), svc.nowIso(), rel.release_id)
    .run();
  if ((moved.meta.changes ?? 0) === 0) return { done: true };
  await setLive(svc, rel, receipt.deployments);
  await recordReleaseEvent(svc, rel.channel, { orgId: rel.org_id, projectId: rel.project_id, actor: RELEASE_SERVICE, action: "release.live", subjectKind: "release", subjectId: rel.release_id, resourceIds: Object.keys(JSON.parse(rel.sources_json) as object), detail: { acceptedVersionId: rel.accepted_version_id, outputDigest: rel.output_digest, deployments: receipt.deployments }, clientVisible: true, clientDetail: { acceptedVersionId: rel.accepted_version_id } });
  // after the release is recorded live: a failing hook never undoes or hides that, nor the other
  // hooks (the promotion's own step also checks live; the baseline is also checked on build requests)
  if (rel.channel === "production") {
    for (const hook of productionLiveHooks) {
      try {
        await hook(svc, rel);
      } catch (e) {
        console.error(`release ${rel.release_id} live; a production-live hook failed: ${e instanceof Error ? e.message.slice(0, 300) : String(e)}`);
      }
    }
  }
  return { done: true };
}

/**
 * Called when a production release goes live (after the pointer moved), whatever started it, in
 * registration order: the promotion service marks failed promotions whose version it contains as
 * live; staging establishes the owner baseline (hooks, so this module imports neither).
 */
const productionLiveHooks: Array<(svc: Services, rel: ReleaseRow) => Promise<void>> = [];
export function onProductionLive(fn: (svc: Services, rel: ReleaseRow) => Promise<void>): void {
  productionLiveHooks.push(fn);
}

async function setLive(svc: Services, rel: ReleaseRow, deployments: ReleaseDeployReceipt["deployments"]): Promise<void> {
  await svc.db
    .prepare(
      "INSERT INTO release_live (org_id, project_id, channel, release_id, accepted_version_id, output_digest, deployments_json, since) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (org_id, project_id, channel) DO UPDATE SET release_id = excluded.release_id, accepted_version_id = excluded.accepted_version_id, output_digest = excluded.output_digest, deployments_json = excluded.deployments_json, since = excluded.since",
    )
    .bind(rel.org_id, rel.project_id, rel.channel, rel.release_id, rel.accepted_version_id, rel.output_digest, JSON.stringify(deployments), svc.nowIso())
    .run();
}

/**
 * Health failed after a SUCCESSFUL deploy: the new code is serving, so "previous release still
 * live" would be false (review I-4). Roll production back by redeploying the previous live
 * release's stored, digest-checked outputs (a release-deploy job for it); only when that verifies
 * is the release `failed` ("Approved, not live", previous release live). Without a previous
 * release, or when the rollback fails, the release is `recovery_required` and the UI says so.
 */
async function failHealth(svc: Services, rel: ReleaseRow, health: unknown): Promise<void> {
  await startRecovery(svc, rel, "health_verification", "health_check_failed", "deployed but not verified", { health_json: JSON.stringify(health) }, { health });
}

/**
 * Production no longer matches the live pointer (a health failure after a good deploy, or a
 * partial/ambiguous failed deploy, review R-2): clear the pointer (it must never name a release
 * whose code is not what serves; editions record it, AT-30), then roll back to the previous live
 * release, or go to `recovery_required` when there is nothing to roll back to.
 */
async function startRecovery(svc: Services, rel: ReleaseRow, fromState: ReleaseState, code: string, why: string, extra: { health_json?: string; error?: string } = {}, detail: Record<string, unknown> = {}): Promise<void> {
  const resources = Object.keys(JSON.parse(rel.sources_json) as object);
  const prev = rel.previous_release_id ? await getRelease(svc, rel.org_id, rel.previous_release_id) : null;
  const native = await nativeReleaseState(svc,rel.org_id,rel.project_id);
  const canRollback = !native && !!prev && !!prev.build_receipt_json && !!prev.output_digest;
  const message = native ? `${why}; explicit recovery under current project requirements is required; external effects are not reverted automatically` : canRollback ? `${why}; rolling back to ${prev!.release_id}` : `${why}, and there is no previous release to roll back to: production may run this release unverified`;
  const moved = await svc.db
    .prepare(`UPDATE releases SET state = 'recovery_required', rollback_state = ?, error_code = ?, error = ?, health_json = COALESCE(?, health_json), updated_at = ? WHERE release_id = ? AND state = ?`)
    .bind(canRollback ? "running" : null, code, extra.error ? `${message}\n${extra.error}`.slice(0, 4000) : message, extra.health_json ?? null, svc.nowIso(), rel.release_id, fromState)
    .run();
  if ((moved.meta.changes ?? 0) === 0) return;
  await clearLive(svc, rel);
  await recordReleaseEvent(svc, rel.channel, { orgId: rel.org_id, projectId: rel.project_id, actor: RELEASE_SERVICE, action: code === "health_check_failed" ? "release.health_failed" : "release.production_drift", subjectKind: "release", subjectId: rel.release_id, resourceIds: resources, detail: { ...detail, ...(canRollback ? { rollbackTo: prev!.release_id } : { rollback: "none" }) }, clientVisible: true, clientDetail: { code } });
  if (!canRollback) return;
  try {
    await issueJob(svc, deployJobFor(prev!), {
      orgId: rel.org_id,
      subject: `release:${rel.release_id}`,
      lifetimeSeconds: 1800,
      jobKey: `release-rollback:${rel.release_id}:${prev!.release_id}:${rel.deploy_attempts}`,
      beforeEnqueue: async (id) => void (await svc.db.prepare("UPDATE releases SET rollback_job_id = ?, updated_at = ? WHERE release_id = ?").bind(id, svc.nowIso(), rel.release_id).run()),
    });
  } catch (e) {
    await rollbackFailed(svc, rel, `the rollback could not start: ${String((e as Error).message).slice(0, 300)}`, "running");
  }
}

/** The project's live pointer (of the release's channel) is dropped while production is unverified (re-set only by a verified deploy or rollback). */
async function clearLive(svc: Services, rel: ReleaseRow): Promise<void> {
  await svc.db.prepare("DELETE FROM release_live WHERE org_id = ? AND project_id = ? AND channel = ?").bind(rel.org_id, rel.project_id, rel.channel).run();
}

/**
 * Does production still run exactly what the live pointer records (review R-2)? Compares every
 * target of this release and of the live release: active version ids vs the recorded ones (a
 * target with no live record must not exist). `unknown` when it cannot be checked.
 */
export async function productionDrift(svc: Services, rel: ReleaseRow): Promise<{ drift: boolean; targets: Array<{ workerName: string; expected: string[]; active: string[] }> } | { unknown: string }> {
  const env = JSON.parse(rel.environment_json) as ReleaseEnvironment;
  const live = await getLive(svc, rel.org_id, rel.project_id, rel.channel);
  const liveDeps = live ? (JSON.parse(live.deployments_json) as ReleaseDeployReceipt["deployments"]) : [];
  const names = [...new Set([...env.targets.map((t) => t.workerName), ...liveDeps.map((d) => d.workerName)])];
  const targets: Array<{ workerName: string; expected: string[]; active: string[] }> = [];
  try {
    for (const name of names) {
      const rec = liveDeps.find((d) => d.workerName === name);
      if (rec && !rec.versionId) return { unknown: `the live record of ${name} has no version id` };
      const active = (await svc.deps.deployApi(svc.env).activeVersionIds(env.accountId, name)).sort();
      targets.push({ workerName: name, expected: rec ? [rec.versionId!] : [], active });
    }
  } catch (e) {
    return { unknown: String((e as Error)?.message ?? e).slice(0, 300) };
  }
  return { drift: targets.some((t) => t.expected.join(",") !== t.active.join(",")), targets };
}

/**
 * The rollback failed or was lost. `from` (n-1) guards the update with the rollback state the
 * caller observed, so a sweep that read `running` never overwrites a rollback that a concurrent
 * result has just moved to `verifying` (or that already finished). Returns whether it applied.
 */
export async function rollbackFailed(svc: Services, rel: ReleaseRow, why: string, from: "running" | "verifying"): Promise<boolean> {
  const moved = await svc.db
    .prepare("UPDATE releases SET state = 'recovery_required', rollback_state = 'failed', error_code = 'rollback_failed', error = ?, updated_at = ? WHERE release_id = ? AND rollback_state = ?")
    .bind(`${why}; production state is unverified: recovery required`, svc.nowIso(), rel.release_id, from)
    .run();
  if ((moved.meta.changes ?? 0) === 0) return false;
  await recordReleaseEvent(svc, rel.channel, { orgId: rel.org_id, projectId: rel.project_id, actor: RELEASE_SERVICE, action: "release.rollback_failed", subjectKind: "release", subjectId: rel.release_id, resourceIds: Object.keys(JSON.parse(rel.sources_json) as object), detail: { why }, clientVisible: true, clientDetail: { code: "rollback_failed" } });
  return true;
}

/** The rollback deploy finished: the previous release must report itself again on every target. */
async function checkRollback(svc: Services, rel: ReleaseRow, attempt: number): Promise<{ done: true } | { retry: true; delaySeconds: number; reason: string }> {
  if (rel.rollback_state !== "verifying" || !rel.rollback_receipt_json || !rel.previous_release_id) return { done: true };
  const prev = await getRelease(svc, rel.org_id, rel.previous_release_id);
  if (!prev) {
    await rollbackFailed(svc, rel, "the previous release record is missing", "verifying");
    return { done: true };
  }
  const receipt = JSON.parse(rel.rollback_receipt_json) as ReleaseDeployReceipt;
  const targets = await observeHealth(svc, prev, receipt);
  const ok = targets.length > 0 && targets.every((t) => t.ok);
  if (!ok && attempt < HEALTH_ATTEMPTS) return { retry: true, delaySeconds: Math.min(30, 2 * attempt), reason: "the rolled-back service does not report the previous release yet" };
  if (!ok) {
    await rollbackFailed(svc, rel, "the rolled-back service did not report the previous release", "verifying");
    return { done: true };
  }
  // review m-d: Workers only the failed release deployed would keep serving it: delete them
  const prevNames = new Set((JSON.parse(prev.environment_json) as ReleaseEnvironment).targets.map((t) => t.workerName));
  const env = JSON.parse(rel.environment_json) as ReleaseEnvironment;
  const production = rel.channel === "staging" ? await productionWorkerNames(svc, rel.org_id) : null;
  for (const t of env.targets) {
    if (prevNames.has(t.workerName)) continue;
    if (workerNameProblem(svc.env, rel.org_id, t.workerName)) continue; // never touch anything outside the org namespace
    if (production?.has(t.workerName)) continue; // a staging rollback never deletes a production Worker
    try {
      await svc.deps.deployApi(svc.env).deleteScript(env.accountId, t.workerName);
    } catch (e) {
      await rollbackFailed(svc, rel, `could not remove ${t.workerName}, which only the failed release deployed: ${String((e as Error)?.message ?? e).slice(0, 200)}`, "verifying");
      return { done: true };
    }
  }
  await svc.db
    .prepare("UPDATE releases SET state = 'failed', rollback_state = 'done', error = ?, updated_at = ? WHERE release_id = ? AND rollback_state = 'verifying'")
    .bind(`deployed but not verified; rolled back to ${prev.release_id}, which is live again`, svc.nowIso(), rel.release_id)
    .run();
  // the previous release is live again, now as the versions the rollback uploaded
  await setLive(svc, prev, receipt.deployments);
  await recordReleaseEvent(svc, rel.channel, { orgId: rel.org_id, projectId: rel.project_id, actor: RELEASE_SERVICE, action: "release.rolled_back", subjectKind: "release", subjectId: rel.release_id, resourceIds: Object.keys(JSON.parse(rel.sources_json) as object), detail: { liveReleaseId: prev.release_id, deployments: receipt.deployments }, clientVisible: true, clientDetail: { liveReleaseId: prev.release_id } });
  return { done: true };
}

export const HEALTH_ATTEMPTS = 6;

onStep("release.health", (svc, msg, attempt) => checkReleaseHealth(svc, msg.orgId, msg.releaseId, attempt, msg.rollback === true));
onStepFailed("release.health", async (svc, msg, reason) => {
  const rel = await getRelease(svc, msg.orgId, msg.releaseId);
  if (!rel) return;
  if (msg.rollback) await rollbackFailed(svc, rel, `the rollback check failed: ${reason}`, "verifying");
  else if (rel.state === "health_verification") await failHealth(svc, rel, { error: reason });
});

/** API view of a release (clients see states and digests, never job ids, runner detail or bindings). */
export async function presentRelease(svc: Services, rel: ReleaseRow, developer: boolean) {
  const live = await getLive(svc, rel.org_id, rel.project_id, rel.channel);
  const approval = rel.output_digest ? await validPublishApproval(svc, rel) : null;
  const deploy = rel.deploy_receipt_json ? (JSON.parse(rel.deploy_receipt_json) as ReleaseDeployReceipt) : null;
  const isLive = live?.release_id === rel.release_id;
  const label = statusLabel(rel, !!approval, isLive);
  const build = rel.build_receipt_json ? (JSON.parse(rel.build_receipt_json) as ReleaseBuildReceipt) : null;
  return {
    releaseId: rel.release_id,
    projectId: rel.project_id,
    ...(await presentNativeRelease(svc,rel)),
    acceptedVersionId: rel.accepted_version_id,
    recipeRevision: rel.recipe_revision,
    envDigest: rel.env_digest,
    outputDigest: rel.output_digest,
    state: rel.state,
    buildState: rel.build_state,
    /** what the UI shows, e.g. "Approved, not live" (AT-35) */
    status: label,
    live: isLive,
    publishApproved: !!approval,
    deployAttempts: rel.deploy_attempts,
    createdAt: rel.created_at,
    updatedAt: rel.updated_at,
    error: rel.error_code ? { code: rel.error_code, ...(developer && rel.error ? { detail: rel.error } : {}) } : null,
    deployments: deploy?.deployments.map((d) => ({ targetId: d.targetId, workerName: d.workerName, url: d.url, ...(developer ? { versionId: d.versionId } : {}) })) ?? [],
    // review m-2: clients and viewers get the verdict only, never the observed response bodies
    health: rel.health_json ? presentHealth(JSON.parse(rel.health_json) as { ok: boolean; checkedAt: string; targets?: Array<Record<string, unknown>> }, developer) : null,
    rollback: rel.rollback_state ? { state: rel.rollback_state, ...(developer ? { toReleaseId: rel.previous_release_id, jobId: rel.rollback_job_id } : {}) } : null,
    ...(developer
      ? {
          sources: JSON.parse(rel.sources_json) as Record<string, string>,
          buildJobId: rel.build_job_id,
          deployJobId: rel.deploy_job_id,
          // review m-7: the full deploy config the output digest covers (what the publish approval binds)
          targets:
            build?.targets.map((t) => {
              const spec = (JSON.parse(rel.environment_json) as ReleaseEnvironment).targets.find((x) => x.targetId === t.targetId);
              return { targetId: t.targetId, workerName: spec?.workerName ?? null, kind: spec?.kind ?? null, digest: t.digest, files: t.files.length, config: t.config };
            }) ?? [],
        }
      : {}),
  };
}

function presentHealth(h: { ok: boolean; checkedAt: string; targets?: Array<Record<string, unknown>> }, developer: boolean) {
  if (developer) return h;
  return { ok: h.ok, checkedAt: h.checkedAt, targets: (h.targets ?? []).map((t) => ({ targetId: t.targetId, ok: t.ok })) };
}

export function statusLabel(rel: ReleaseRow, approved: boolean, isLive: boolean): string {
  if (isLive) return "Live";
  if (rel.build_state === "building") return "Building";
  if (rel.build_state === "failed") return "Build failed";
  if (rel.rollback_state === "running" || rel.rollback_state === "verifying") return "Not verified, rolling back";
  switch (rel.state) {
    case "prepared":
      return "Ready for publish approval";
    case "publish_approved":
      return "Approved, not live";
    case "deploying":
      return "Deploying";
    case "health_verification":
      return "Verifying the live version";
    case "live":
      return "Superseded";
    case "partial":
      return "Partly deployed, retry to finish";
    case "recovery_required":
      return "Recovery required: production is unverified";
    case "failed":
      return approved ? "Approved, not live" : "Not live";
    default:
      return "Not live";
  }
}
