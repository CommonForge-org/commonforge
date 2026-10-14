/**
 * Shared staging test fixture (staging phase 1): an owner org, an `api` code resource with a
 * `wrangler.jsonc`, migrations and seed files, a project with that mount, a policy with `release`
 * (one Worker target `cfapp-<org>-api`) and a `staging` section, and a fake "deploy account" whose
 * Workers answer `/version` with the release they run.
 */
import { artRevisionId, parseRevisionId, type RepoCoords } from "@commonforge-org/core";
import type { SignedJob } from "@commonforge-org/runner-protocol";
import { expect } from "vitest";
import { repoInfoCoords } from "../src/services/artifacts.js";
import { getProject, getResource, resourceCoords, type ProjectRow } from "../src/services/directory.js";
import { deployRelease, getRelease, prepareStagingRelease, startStagingDeploy, type ReleaseRow } from "../src/services/releases.js";
import { ensureStagingResources } from "../src/services/staging-data.js";
import { stagingPolicyOf } from "../src/services/staging-policy.js";
import { codeResource, harness, member, ownerWithOrg, prepareAndIntegrate, projectWith, type Harness } from "./helpers.js";

export const STAGING_FILES: Record<string, string> = {
  "wrangler.jsonc": '{ "name": "api", "main": "src/index.ts", "compatibility_date": "2026-08-22" }\n',
  "src/index.ts": "export default { fetch() { return new Response('api'); } };\n",
  "migrations/0001_init.sql": "CREATE TABLE contacts (id INTEGER PRIMARY KEY, name TEXT);\n",
  "seed/contacts.sql": "INSERT INTO contacts (id, name) VALUES (1, 'Ada');\n",
  "seed/orders.json": '[{"key":"order:1","value":"{}"}]\n',
};

export const STAGING_SECTION = {
  environment: { api: { vars: { APP_ENV: "staging" }, kv: [{ binding: "ORDERS", seed: "seed/orders.json" }], d1: [{ binding: "DB", migrationsDir: "migrations", seed: ["seed/contacts.sql"] }] } },
  captureVars: ["PAYMENT_WEBHOOK_URL"],
  promotion: { rules: [{ paths: ["api/migrations/**"], level: "classify" }], classifier: { provider: "jev", threshold: 0.9 } },
};

export function stagingReleasePolicy(orgId: string) {
  return {
    recipe: { recipeId: "api-release", revision: 1, steps: [{ stepId: "build", mountName: "api", command: "pnpm exec wrangler deploy --dry-run --outdir dist" }] },
    targets: [{ targetId: "api", kind: "worker", mountName: "api", outputPath: "dist", main: "index.js", workerName: `cfapp-${orgId}-api` }],
    environment: {},
    healthCheck: { targetId: "api", path: "/version" },
  };
}

export const CAPTURE_URL = "https://commonforge.example/api/sink/tok";

/**
 * The deploy account as `/version` sees it: a Worker reports the release whose upload is its active
 * version (the fake runner activates `ver-<jobId>-<targetId>` on deploy).
 */
export function installHealth(h: Harness): void {
  h.deps.healthFetch = async (url: string) => {
    const name = /^https:\/\/([a-z0-9-]+)\.demo\.workers\.dev\/version$/.exec(url)?.[1];
    const active = name ? h.cf.active.get(name)?.[0] : undefined;
    const job = active
      ? (h.runnerJobs as Array<{ signedJob: SignedJob }>).map((m) => m.signedJob).find((sj) => sj.job.kind === "release-deploy" && sj.job.targets.some((t) => active === `ver-${sj.jobId}-${t.targetId}`))
      : undefined;
    if (!job) return new Response("no such worker", { status: 404 });
    return Response.json({ name, release: (job.job as { releaseId: string }).releaseId });
  };
}

export interface StagingFixtureOptions {
  /** files of the `api` resource (default {@link STAGING_FILES}) */
  files?: Record<string, string>;
  /** the policy's `staging` section (default {@link STAGING_SECTION}); `false` saves only `release` (staging mode off) */
  staging?: unknown;
  /** the policy's `release` section (default {@link stagingReleasePolicy}) */
  release?: (orgId: string) => unknown;
  /**
   * seed the owner baseline (staging phase 2b, B6) after the policy save, standing for an owner
   * publish of the current `main` (default true); `false`: staging waits for {@link ownerPublish}
   */
  baseline?: boolean;
}

export async function stagingFixture(opts: StagingFixtureOptions = {}) {
  const h = harness();
  const o = await ownerWithOrg(h);
  const api = await codeResource(h, o, "api", opts.files ?? STAGING_FILES);
  const pid = await projectWith(h, o, [{ mountName: "api", resourceId: api.resourceId }]);
  const put = await h.api("PUT", `/api/orgs/${o.orgId}/projects/${pid}/policy`, { token: o.token, body: { release: (opts.release ?? stagingReleasePolicy)(o.orgId), ...(opts.staging === false ? {} : { staging: opts.staging ?? STAGING_SECTION }) } });
  expect(put.status, JSON.stringify(put.body)).toBe(200);
  const svc = h.services();
  installHealth(h);
  const project = async (): Promise<ProjectRow> => (await getProject(svc.db, o.orgId, pid))!;

  /**
   * A test seam for the owner baseline: a `staging_baselines` row at the `api` head, as if the owner
   * had published it (`rel-test-baseline`). Production code writes the row only through
   * `establishBaseline`.
   */
  async function seedBaseline(): Promise<void> {
    const head = await svc.ledger(o.orgId).getHead(api.resourceId);
    if (!head) throw new Error("api resource has no head");
    await svc.db
      .prepare("INSERT INTO staging_baselines (org_id, project_id, release_id, accepted_version_id, sources_json, established_at) VALUES (?, ?, 'rel-test-baseline', ?, ?, ?)")
      .bind(o.orgId, pid, head.acceptedVersionId ?? "av-test-baseline", JSON.stringify({ [api.resourceId]: head.revisionId }), svc.nowIso())
      .run();
  }
  if (opts.baseline !== false) await seedBaseline();

  /** Sources at the mounts' ledger heads (what a staging build would have merged). */
  async function sources(): Promise<Array<{ resourceId: string; mountName: string; canonical: RepoCoords; sha: string; revisionId: string }>> {
    const head = await svc.ledger(o.orgId).getHead(api.resourceId);
    const r = (await getResource(svc.db, o.orgId, api.resourceId))!;
    const coords = resourceCoords(r);
    if (!head || !coords || coords.kind !== "artifacts") throw new Error("api resource has no head");
    const info = (await svc.transport.getRepo(coords.namespace, coords.repoName))!;
    return [{ resourceId: api.resourceId, mountName: "api", canonical: repoInfoCoords(coords.namespace, info), sha: (parseRevisionId(head.revisionId) as { sha: string }).sha, revisionId: head.revisionId }];
  }

  async function stagingInput(buildId: string) {
    const p = await project();
    const both = stagingPolicyOf(p);
    if (!both) throw new Error("staging mode is off for the fixture project");
    const resources = await ensureStagingResources(svc, p, both.staging);
    return { orgId: o.orgId, projectId: pid, userId: o.userId, buildId, sources: await sources(), staging: both.staging, release: both.release, resources, captureUrl: CAPTURE_URL };
  }

  async function until(cond: () => Promise<boolean>, ms = 5000): Promise<void> {
    const end = Date.now() + ms;
    for (;;) {
      if (await cond()) return;
      if (Date.now() > end) throw new Error("timed out");
      await h.drainSteps();
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  const state = async (releaseId: string) => (await getRelease(svc, o.orgId, releaseId))!.state;

  /** Prepare, build, deploy and verify a staging release; returns its live row. */
  async function liveStaging(buildId: string): Promise<ReleaseRow> {
    const rel = await prepareStagingRelease(svc, await stagingInput(buildId));
    await until(async () => (await state(rel.release_id)) === "publish_approved");
    await startStagingDeploy(svc, (await getRelease(svc, o.orgId, rel.release_id))!, o.userId);
    await until(async () => (await state(rel.release_id)) === "live");
    return (await getRelease(svc, o.orgId, rel.release_id))!;
  }

  /**
   * A live staging build whose merge moved `api` to a new commit (reachable in the canonical repo, as
   * if pushed to `refs/commonforge/staging`); returns that sha.
   */
  async function seedLiveStagingBuild(): Promise<string> {
    const head = (await sources())[0]!;
    const sha = h.artifacts.makeCommit({ ...(opts.files ?? STAGING_FILES), "STAGING.md": "staged\n" }, [head.sha]);
    h.artifacts.addObject(head.canonical.namespace, head.canonical.repoName, sha);
    const seq = ((await svc.db.prepare("SELECT MAX(seq) AS m FROM staging_builds WHERE org_id = ? AND project_id = ?").bind(o.orgId, pid).first<{ m: number | null }>())?.m ?? 0) + 1;
    const now = svc.nowIso();
    await svc.db
      .prepare("INSERT INTO staging_builds (build_id, org_id, project_id, seq, landings_json, state, staging_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, '[]', 'live', ?, ?, ?, ?)")
      .bind(`sb-test-${crypto.randomUUID()}`, o.orgId, pid, seq, JSON.stringify({ [api.resourceId]: { sha, revisionId: artRevisionId(api.repoId, sha) } }), o.userId, now, now)
      .run();
    return sha;
  }

  /** The ledger head commit of the `api` resource (main; staging never moves it). */
  async function headSha(): Promise<string> {
    const head = await svc.ledger(o.orgId).getHead(api.resourceId);
    if (!head) throw new Error("api resource has no head");
    return (parseRevisionId(head.revisionId) as { sha: string }).sha;
  }
  const initialHeadSha = await headSha();

  /** A member in `role` with `level` on the project. */
  async function memberWithAccess(role: string, level = "read"): Promise<{ token: string; userId: string }> {
    const c = await member(h, o, role);
    const r = await h.api("PUT", `/api/orgs/${o.orgId}/projects/${pid}/access`, { token: o.token, body: { userId: c.userId, level } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return c;
  }

  /** A client member who may change the project's folders ("Change": in staging mode they create and submit their own tasks). */
  async function clientWithAccess(level = "write"): Promise<{ token: string; userId: string }> {
    return memberWithAccess("client", level);
  }

  /**
   * Move `main` of `api` from outside staging: a second project (no staging) mounts the same
   * resource and accepts `files` through the ordinary flow (task, freeze, propose, integrate,
   * approve, accept). A FakeRunner must be running.
   */
  let otherProject: string | null = null;
  let mainMoves = 0;
  async function acceptOnMain(files: Record<string, string>): Promise<void> {
    otherProject ??= await projectWith(h, o, [{ mountName: "api", resourceId: api.resourceId }]);
    const t = await h.api("POST", `/api/orgs/${o.orgId}/projects/${otherProject}/tasks`, { token: o.token, body: { title: "Change main", writeMounts: ["api"] } });
    expect(t.status, JSON.stringify(t.body)).toBe(201);
    const taskId = t.body.taskId as string;
    await until(async () => (await h.api("GET", `/api/tasks/${taskId}`, { token: o.token })).body.state === "ready");
    const lease = await h.api("POST", `/api/tasks/${taskId}/lease`, { token: o.token, body: {} });
    expect(lease.status, JSON.stringify(lease.body)).toBe(200);
    const agent = lease.body.leaseToken as string;
    const ws = (await h.api("GET", `/api/tasks/${taskId}`, { token: agent })).body.workspaces.find((w: { mountName: string }) => w.mountName === "api");
    const cred = await h.api("POST", `/api/tasks/${taskId}/credential`, { token: agent, body: { mountName: "api", access: "write" } });
    expect(cred.status, JSON.stringify(cred.body)).toBe(200);
    const where = h.artifacts.tokenByPlaintext(cred.body.secret)!;
    const base = h.artifacts.repo(where.ns, where.name).refs.get("main")!;
    const sha = h.artifacts.makeCommit({ ...h.artifacts.files.get(base), ...files }, [base]);
    h.artifacts.push(where.ns, where.name, "main", sha);
    const frozen = await h.api("POST", `/api/tasks/${taskId}/workspaces/${ws.taskWorkspaceId}/freeze`, { token: agent, body: { expectedSha: sha } });
    expect(frozen.status, JSON.stringify(frozen.body)).toBe(201);
    const proposal = (await h.api("POST", `/api/orgs/${o.orgId}/proposals`, { token: o.token, body: { taskId } })).body as { proposalId: string };
    const p = await prepareAndIntegrate(h, o, proposal.proposalId);
    const a = await h.api("POST", `/api/orgs/${o.orgId}/proposals/${proposal.proposalId}/approvals`, { token: o.token, body: { proposalHash: p.proposalHash } });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    const acc = await h.api("POST", `/api/orgs/${o.orgId}/proposals/${proposal.proposalId}/accept`, { token: o.token, body: { idempotencyKey: `accept-main-${++mainMoves}` } });
    expect(acc.status, JSON.stringify(acc.body)).toBe(200);
  }

  /**
   * Create a task on the `api` mount as `token`, push `files` on top of its base as its agent, and
   * freeze it (the task becomes `submitted`; in staging mode that enqueues `staging.land`). Steps
   * are not drained after the freeze. `beforeFreeze` runs between the push and the freeze.
   */
  async function submitTask(token: string, title: string, files: Record<string, string>, opts: { beforeFreeze?: () => void | Promise<void> } = {}): Promise<string> {
    const t = await h.api("POST", `/api/orgs/${o.orgId}/projects/${pid}/tasks`, { token, body: { title, writeMounts: ["api"] } });
    expect(t.status, JSON.stringify(t.body)).toBe(201);
    const taskId = t.body.taskId as string;
    await until(async () => (await h.api("GET", `/api/tasks/${taskId}`, { token })).body.state === "ready");
    const lease = await h.api("POST", `/api/tasks/${taskId}/lease`, { token, body: {} });
    expect(lease.status, JSON.stringify(lease.body)).toBe(200);
    const agent = lease.body.leaseToken as string;
    const task = (await h.api("GET", `/api/tasks/${taskId}`, { token: agent })).body;
    const ws = task.workspaces.find((w: { mountName: string }) => w.mountName === "api");
    const cred = await h.api("POST", `/api/tasks/${taskId}/credential`, { token: agent, body: { mountName: "api", access: "write" } });
    expect(cred.status, JSON.stringify(cred.body)).toBe(200);
    const where = h.artifacts.tokenByPlaintext(cred.body.secret)!;
    const base = h.artifacts.repo(where.ns, where.name).refs.get("main")!;
    const sha = h.artifacts.makeCommit({ ...h.artifacts.files.get(base), ...files }, [base]);
    h.artifacts.push(where.ns, where.name, "main", sha);
    await opts.beforeFreeze?.();
    const frozen = await h.api("POST", `/api/tasks/${taskId}/workspaces/${ws.taskWorkspaceId}/freeze`, { token: agent, body: { expectedSha: sha } });
    expect(frozen.status, JSON.stringify(frozen.body)).toBe(201);
    return taskId;
  }

  /** The task's newest staging landing (draining steps until `staging.land` made it). */
  async function landingIdOf(taskId: string): Promise<string> {
    const find = async () => (await svc.db.prepare("SELECT landing_id FROM staging_landings WHERE org_id = ? AND task_id = ? ORDER BY seq DESC LIMIT 1").bind(o.orgId, taskId).first<{ landing_id: string }>())?.landing_id;
    await until(async () => !!(await find()), 15_000);
    return (await find())!;
  }

  /**
   * Wait until no staging build is in flight and either the task's newest landing is `landed`
   * (`taskId`), or `n` landings of the project are `landed` (a count: only while none was promoted).
   */
  async function untilLanded(taskOrCount: string | number): Promise<void> {
    await until(async () => {
      const busy = await svc.db.prepare("SELECT 1 FROM staging_builds WHERE org_id = ? AND project_id = ? AND state IN ('queued', 'merging', 'building', 'deploying')").bind(o.orgId, pid).first();
      if (busy) return false;
      if (typeof taskOrCount === "string") {
        const l = await svc.db.prepare("SELECT state FROM staging_landings WHERE org_id = ? AND task_id = ? ORDER BY seq DESC LIMIT 1").bind(o.orgId, taskOrCount).first<{ state: string }>();
        return l?.state === "landed";
      }
      const landed = await svc.db.prepare("SELECT COUNT(*) AS n FROM staging_landings WHERE org_id = ? AND project_id = ? AND state = 'landed'").bind(o.orgId, pid).first<{ n: number }>();
      return (landed?.n ?? 0) >= taskOrCount;
    }, 15_000);
  }

  /**
   * The owner's normal production publish through the release routes: prepare, build, publish
   * approval, deploy, until `live` (a FakeRunner must be running). Publishing the current `main`
   * establishes the owner baseline.
   */
  async function ownerPublish(): Promise<ReleaseRow> {
    const r = await h.api("POST", `/api/orgs/${o.orgId}/projects/${pid}/releases`, { token: o.token, body: {} });
    expect([200, 202], JSON.stringify(r.body)).toContain(r.status);
    await until(async () => (await getRelease(svc, o.orgId, r.body.releaseId))!.build_state !== "building", 20_000);
    const rel = (await getRelease(svc, o.orgId, r.body.releaseId))!;
    expect(rel.build_state, rel.error ?? "").toBe("built");
    const a = await h.api("POST", `/api/orgs/${o.orgId}/releases/${rel.release_id}/publish-approvals`, { token: o.token, body: { outputDigest: rel.output_digest } });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    const d = await h.api("POST", `/api/orgs/${o.orgId}/releases/${rel.release_id}/deploy`, { token: o.token, body: { idempotencyKey: `owner-publish-${rel.release_id}` } });
    expect(d.status, JSON.stringify(d.body)).toBe(202);
    await until(async () => (await state(rel.release_id)) === "live", 20_000);
    return (await getRelease(svc, o.orgId, rel.release_id))!;
  }

  return { h, o, pid, api, svc, project, sources, stagingInput, until, liveStaging, seedLiveStagingBuild, headSha, initialHeadSha, memberWithAccess, clientWithAccess, acceptOnMain, submitTask, landingIdOf, untilLanded, seedBaseline, ownerPublish };
}

export type StagingFixture = Awaited<ReturnType<typeof stagingFixture>>;

/** The `api` Worker and its source, without migrations or seed (production fixtures add their own). */
export const PRODUCTION_FILES: Record<string, string> = {
  "wrangler.jsonc": STAGING_FILES["wrangler.jsonc"]!,
  "src/index.ts": STAGING_FILES["src/index.ts"]!,
};

export interface ProductionFixtureOptions {
  /** extra files of the `api` resource (on top of {@link PRODUCTION_FILES}) */
  files?: Record<string, string>;
  /** create an org D1 (`deploy-resources` kind d1) and bind it as `DB` with `migrations: [{ api, DB, migrations }]` */
  withD1?: boolean;
}

/**
 * Production release fixture (staging phase 2, Task 4): an owner org, an `api` code resource, a
 * project with that mount and a release policy (one Worker target `cfapp-<org>-api`; staging mode
 * off). Releases go through the real routes: prepare, build (a FakeRunner the test creates),
 * publish approval by the owner, then `deployRelease`.
 */
export async function productionFixture(opts: ProductionFixtureOptions = {}) {
  const h = harness();
  const o = await ownerWithOrg(h);
  const api = await codeResource(h, o, "api", { ...PRODUCTION_FILES, ...(opts.files ?? {}) });
  const pid = await projectWith(h, o, [{ mountName: "api", resourceId: api.resourceId }]);
  const svc = h.services();
  installHealth(h);

  const putPolicy = (body: Record<string, unknown>) => h.api("PUT", `/api/orgs/${o.orgId}/projects/${pid}/policy`, { token: o.token, body });
  /** the fixture's release section with `api`'s production environment (and `migrations`) */
  function releaseWith(e: { d1?: Array<{ binding: string; id: string }>; migrations?: Array<{ targetId: string; binding: string; dir: string }>; data?: string[]; kv?: Array<{ binding: string; id: string }> } = {}) {
    return {
      ...stagingReleasePolicy(o.orgId),
      environment: { api: { vars: {}, kvNamespaces: e.kv ?? [], ...(e.d1 ? { d1Databases: e.d1 } : {}), ...(e.data ? { data: e.data } : {}) } },
      ...(e.migrations ? { migrations: e.migrations } : {}),
    };
  }
  async function createD1(name: string): Promise<string> {
    const r = await h.api("POST", `/api/orgs/${o.orgId}/deploy-resources`, { token: o.token, body: { kind: "d1", name } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.id as string;
  }
  let d1Id: string | undefined;
  if (opts.withD1) {
    d1Id = await createD1("contacts");
    const put = await putPolicy({ release: releaseWith({ d1: [{ binding: "DB", id: d1Id }], migrations: [{ targetId: "api", binding: "DB", dir: "migrations" }] }) });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
  } else {
    const put = await putPolicy({ release: releaseWith() });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
  }

  async function until(cond: () => Promise<boolean>, ms = 5000): Promise<void> {
    const end = Date.now() + ms;
    for (;;) {
      if (await cond()) return;
      if (Date.now() > end) throw new Error("timed out");
      await h.drainSteps();
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  const release = async (releaseId: string): Promise<ReleaseRow> => (await getRelease(svc, o.orgId, releaseId))!;

  /** Accept `files` into `api` through a task: freeze, propose, integrate, approve, accept (the usual flow). */
  let accepts = 0;
  async function acceptFiles(files: Record<string, string>): Promise<void> {
    const t = await h.api("POST", `/api/orgs/${o.orgId}/projects/${pid}/tasks`, { token: o.token, body: { title: "Change the api", writeMounts: ["api"] } });
    expect(t.status, JSON.stringify(t.body)).toBe(201);
    const taskId = t.body.taskId as string;
    await until(async () => (await h.api("GET", `/api/tasks/${taskId}`, { token: o.token })).body.state === "ready");
    const lease = await h.api("POST", `/api/tasks/${taskId}/lease`, { token: o.token, body: {} });
    expect(lease.status, JSON.stringify(lease.body)).toBe(200);
    const agent = lease.body.leaseToken as string;
    const task = (await h.api("GET", `/api/tasks/${taskId}`, { token: agent })).body;
    const ws = task.workspaces.find((w: { mountName: string }) => w.mountName === "api");
    const cred = await h.api("POST", `/api/tasks/${taskId}/credential`, { token: agent, body: { mountName: "api", access: "write" } });
    expect(cred.status, JSON.stringify(cred.body)).toBe(200);
    const where = h.artifacts.tokenByPlaintext(cred.body.secret)!;
    const base = h.artifacts.repo(where.ns, where.name).refs.get("main")!;
    const sha = h.artifacts.makeCommit({ ...h.artifacts.files.get(base), ...files }, [base]);
    h.artifacts.push(where.ns, where.name, "main", sha);
    const frozen = await h.api("POST", `/api/tasks/${taskId}/workspaces/${ws.taskWorkspaceId}/freeze`, { token: agent, body: { expectedSha: sha } });
    expect(frozen.status, JSON.stringify(frozen.body)).toBe(201);
    const p = await h.api("POST", `/api/orgs/${o.orgId}/proposals`, { token: o.token, body: { taskId } });
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    const proposal = await prepareAndIntegrate(h, o, p.body.proposalId);
    await h.api("POST", `/api/orgs/${o.orgId}/proposals/${p.body.proposalId}/approvals`, { token: o.token, body: { proposalHash: proposal.proposalHash } });
    const acc = await h.api("POST", `/api/orgs/${o.orgId}/proposals/${p.body.proposalId}/accept`, { token: o.token, body: { idempotencyKey: `accept-prod-${++accepts}` } });
    expect(acc.status, JSON.stringify(acc.body)).toBe(200);
    await h.drainSteps();
  }

  /** Prepare (after accepting `files`, if any) and build a production release (a FakeRunner must be running). */
  async function preparedRelease(o2: { files?: Record<string, string> } = {}): Promise<ReleaseRow> {
    if (o2.files) await acceptFiles(o2.files);
    const r = await h.api("POST", `/api/orgs/${o.orgId}/projects/${pid}/releases`, { token: o.token, body: {} });
    expect([200, 202], JSON.stringify(r.body)).toContain(r.status);
    await until(async () => (await release(r.body.releaseId)).build_state !== "building");
    const rel = await release(r.body.releaseId);
    expect(rel.build_state, rel.error ?? "").toBe("built");
    return rel;
  }

  /** {@link preparedRelease}, then the owner's publish approval. */
  async function publishedRelease(o2: { files?: Record<string, string> } = {}): Promise<ReleaseRow> {
    const rel = await preparedRelease(o2);
    const a = await h.api("POST", `/api/orgs/${o.orgId}/releases/${rel.release_id}/publish-approvals`, { token: o.token, body: { outputDigest: rel.output_digest } });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    return release(rel.release_id);
  }

  /** `deployRelease` (throws what it throws), then wait until the deploy settled (live or failed). */
  let deploys = 0;
  async function deploy(rel: ReleaseRow): Promise<ReleaseRow> {
    await deployRelease(svc, { orgId: o.orgId, userId: o.userId }, await release(rel.release_id), `deploy-prod-${++deploys}`);
    await until(async () => !["deploying", "health_verification"].includes((await release(rel.release_id)).state));
    return release(rel.release_id);
  }

  return { h, o, pid, api, svc, d1Id, putPolicy, releaseWith, createD1, until, release, acceptFiles, preparedRelease, publishedRelease, deploy };
}

export type ProductionFixture = Awaited<ReturnType<typeof productionFixture>>;
