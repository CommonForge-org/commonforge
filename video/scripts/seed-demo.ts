/**
 * Seeds a fresh, fully configured demo project ("Demo Client / Customer Portal") on a CommonForge
 * Worker before a recording take, and writes `seed-output.json` for capture and the demo agents.
 *
 * Sequence (docs/plans/capture-briefing.md "No live seed script"; apps/worker/API.md):
 *  1. `GET /api/me` (the owner session works), then the org: `--org <id>` or `POST /api/orgs`.
 *     Idempotent per project name: an existing project of that name is refused unless `--replace`.
 *  2. Three Artifacts resources (`website`, `api`, `requirements`); each canonical repo gets its
 *     fixture pushed with a minted Artifacts write token, then `adopt-head`.
 *  3. The `brand-assets` R2 resource, the project and its four mounts.
 *  4. Logo and ~50 MB video into brand-assets. There is no owner upload route: the only asset write
 *     path is a task lease (`readMounts: []`, so the task snapshot holds brand-assets only; stage →
 *     upload → commit → freeze), then proposal → integrate →
 *     approve → accept. This runs before the policy is set, so the integration has no checks.
 *  5. The org's `orders` KV (`deploy-resources`), then the whole policy in one `PUT` (checks,
 *     contracts, rules, preview, release; release Workers `cfapp-<orgId>-<name>`).
 *  6. The client member and read grants on the project and each resource (with `--staging`: Can
 *     change, i.e. write, on the project and the three git folders).
 *  7. The website client edition: create, build, grant to the client.
 *
 * `--staging` (staging Phase 4-2, ruling P42-3): the project runs always-on staging as the spec's demo
 * (docs/superpowers/specs/2026-10-07-always-on-preview-promotion-design.md §3, §12). Step 5 also creates the
 * production D1 (`contacts`) and the policy gets the `staging` section (promotion rules, classifier
 * `jev`/0.9, capture vars) with `release.migrations`; step 7 is skipped (staging-mode projects use
 * client tasks, not editions); then the owner publishes `main` to production (the baseline staging
 * starts from) and the run waits for staging to be `active`.
 * `--stage-tasks` (needs `--staging` and `CAPTURE_CLIENT_SESSION_FILE`): the client creates the three
 * demo tasks (seed-demo-tasks.ts) and hands each lease to their agent (cforge checkout, the edit,
 * cforge submit), and the run waits for each to land in staging, so a take starts on a Tasks board
 * with three In staging cards and promotes them on camera.
 *
 * Usage (from video/, after `source ../scripts/load-dev-vars.sh` for CF_API_TOKEN / CF_ACCOUNT_ID;
 * the session is the owner capture signs in as, README "Capture day runbook"):
 *   CAPTURE_OWNER_SESSION_FILE=~/cf-capture/owner/session.json \
 *   pnpm seed -- --client-email you+client@example.com [--new-org "Demo Client" | --org o-…]
 *     [--project-name "Customer Portal"] [--replace] [--plan] [--workers-subdomain sub] [--out file]
 *     [--staging [--stage-tasks]]
 * `--stage-tasks` runs cforge from apps/cli and apps/demo-agents: `pnpm --filter @commonforge-org/cli
 * --filter @commonforge-org/demo-agents build` first (from the repo root).
 *
 * `--plan` prints the request sequence against a scripted stand-in and sends nothing.
 * Tokens (session, lease, Cloudflare, Artifacts) and the Cloudflare account id are never printed.
 *
 * On a failure the run stops, prints `partial: org=<id> project=<id> resources=<ids…>` and writes
 * `seed-output.partial.json` (next to `--out`) with everything it created before the failure.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createApi, type Api } from './seed-demo-api';
import { pushFixture, withWriteToken, type ArtifactsAccount } from './seed-demo-artifacts';
import { createPlanServer, type RecordedCall } from './seed-demo-plan';
import { ASSETS_MOUNT, D1_NAME, GIT_FIXTURES, KV_NAME, projectPolicy, websiteEditionPolicy, type GitFixture } from './seed-demo-policy';
import { applyDemoTask, DEMO_TASKS, type DemoTask, type DemoTaskKey } from './seed-demo-tasks';

export interface SeedAsset {
  /** path inside the brand-assets collection */
  path: string;
  mime: string;
  load(): Promise<Uint8Array>;
}

export interface SeedOptions {
  baseUrl: string;
  /** owner `cfs_…` session bearer */
  sessionToken: string;
  artifacts: ArtifactsAccount;
  org: { id: string } | { newName: string };
  projectName: string;
  clientEmail: string;
  replace: boolean;
  workersSubdomain: string;
  assets: SeedAsset[];
  /** staging mode (`--staging`): production D1, the `staging` policy, no edition, the owner baseline */
  staging?: boolean;
  /** `--stage-tasks`: the client's `cfs_…` session; the client lands the three demo tasks in staging */
  stageTasks?: { clientToken: string };
}

export interface SeedDeps {
  fetch: typeof fetch;
  /** push the fixture to the empty canonical repo with `token`; returns the pushed sha */
  pushFixture(o: { fixture: GitFixture; remoteUrl: string; token: string; branch: string }): Promise<string>;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
  /**
   * `--stage-tasks`: the client's agent works task `taskId` with `leaseToken` (cforge checkout, the
   * demo edit, cforge submit, which freezes the task and lands it in staging).
   */
  agentTask?(o: { task: DemoTask; taskId: string; leaseToken: string }): Promise<void>;
}

export interface StagedTask {
  key: DemoTaskKey;
  taskId: string;
  landingId: string;
}

export interface SeedOutput {
  orgId: string;
  projectId: string;
  resourceIds: { website: string; api: string; requirements: string; brandAssets: string };
  /** Canonical repo remote URLs (no credentials): scene 2's clone script shows the client denied there. */
  canonicalRemotes: { website: string; api: string; requirements: string };
  /** the website client edition; null in staging mode (client tasks replace editions) */
  editionId: string | null;
  clientUserId: string;
  /** `--staging` only */
  staging?: {
    /** the staging website (`GET …/staging` `url`) */
    url: string | null;
    productionD1Id: string;
    baselineReleaseId: string;
    /** `--stage-tasks`: the three demo tasks, landed in staging, in landing order */
    tasks: StagedTask[];
  };
}

/** What a failed run created (or was given) before it stopped. Projects and orgs cannot be deleted. */
export interface SeedPartial {
  /** the org the run used: given with `--org`, or created by this run; null when it got no org */
  orgId: string | null;
  /** true when this run created the org */
  orgCreated: boolean;
  projectId: string | null;
  /** every resource this run created, in creation order */
  resourceIds: Partial<SeedOutput['resourceIds']>;
  /** the brand assets task (its lease is released on failure; GC cancels a leaseless running task after 7 days) */
  taskId?: string;
  proposalId?: string;
  kvId?: string;
  clientUserId?: string;
  editionId?: string;
  d1Id?: string;
  baselineReleaseId?: string;
  /** `--stage-tasks`: the demo tasks created so far (landed or not) */
  stagedTasks?: Array<{ key: DemoTaskKey; taskId: string }>;
  /** the message of the error that stopped the run */
  error: string;
}

/** A failed run: the message is the original error's, `partial` names what exists. */
export class SeedFailure extends Error {
  constructor(
    readonly partial: SeedPartial,
    cause: unknown,
  ) {
    super(partial.error, { cause });
    this.name = 'SeedFailure';
  }
}

/** `partial: org=<id> project=<id> resources=<id,…>` (`none` for what does not exist). */
export function partialLine(p: SeedPartial): string {
  const ids = Object.values(p.resourceIds);
  return `partial: org=${p.orgId ?? 'none'} project=${p.projectId ?? 'none'} resources=${ids.length ? ids.join(',') : 'none'}`;
}

/** For a `SeedFailure`: print its partial line and write the partial state to `file`. Other errors: nothing. */
export function reportPartial(e: unknown, file: string, print: (line: string) => void): void {
  if (!(e instanceof SeedFailure)) return;
  print(partialLine(e.partial));
  writeFileSync(file, `${JSON.stringify(e.partial, null, 2)}\n`);
  print(`wrote ${file}`);
}

const enc = encodeURIComponent;
const POLL_MS = 2000;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function poll<T>(deps: SeedDeps, what: string, timeoutMs: number, fn: () => Promise<T>, done: (v: T) => boolean): Promise<T> {
  for (let waited = 0; ; waited += POLL_MS) {
    const v = await fn();
    if (done(v)) return v;
    if (waited >= timeoutMs) throw new Error(`${what}: still not done after ${Math.round(timeoutMs / 60_000)} min`);
    await deps.sleep(POLL_MS);
  }
}

interface ProjectRow {
  projectId: string;
  name: string;
}

/** Step 1: the org, refusing (or with --replace, retiring) an existing project of the same name. */
async function resolveOrg(api: Api, o: SeedOptions, deps: SeedDeps, partial: SeedPartial): Promise<string> {
  const named = async (orgId: string) => (await api.json<{ projects: ProjectRow[] }>('GET', `/api/orgs/${enc(orgId)}/projects`)).projects.filter((p) => p.name === o.projectName);
  if ('id' in o.org) {
    const orgId = o.org.id;
    partial.orgId = orgId;
    const existing = await named(orgId);
    if (existing.length && !o.replace) throw new Error(`project "${o.projectName}" already exists in ${orgId} (${existing.map((p) => p.projectId).join(', ')}); pass --replace to seed a fresh one`);
    for (const p of existing) {
      // projects cannot be deleted; free the old project's release Worker names for the new one
      const view = await api.json<{ policy?: Record<string, unknown> }>('GET', `/api/orgs/${enc(orgId)}/projects/${enc(p.projectId)}`);
      if (!view.policy?.release && !view.policy?.staging) continue;
      // staging Workers are named after the release Workers (`<name>-staging`), so staging goes too
      const { release: _release, staging: _staging, ...rest } = view.policy;
      await api.json('PUT', `/api/orgs/${enc(orgId)}/projects/${enc(p.projectId)}/policy`, rest);
      deps.log(`--replace: removed the release recipe${view.policy.staging ? ' and staging' : ''} of the old ${p.projectId} so its Worker names are free`);
    }
    return orgId;
  }
  const name = o.org.newName;
  const orgs = (await api.json<{ orgs: Array<{ orgId: string; name: string }> }>('GET', '/api/orgs')).orgs.filter((x) => x.name === name);
  for (const org of orgs) {
    const existing = await named(org.orgId);
    if (existing.length && !o.replace) throw new Error(`project "${o.projectName}" already exists in org "${name}" (${org.orgId}, ${existing.map((p) => p.projectId).join(', ')}); pass --replace to seed a fresh org`);
  }
  const created = await api.json<{ orgId: string }>('POST', '/api/orgs', { name });
  partial.orgId = created.orgId;
  partial.orgCreated = true;
  deps.log(`org ${created.orgId} "${name}" created`);
  return created.orgId;
}

/** Step 2: one Artifacts resource, populated from its fixture and bound as the genesis head. */
async function gitResource(api: Api, orgId: string, fixture: GitFixture, o: SeedOptions, deps: SeedDeps, partial: SeedPartial): Promise<{ resourceId: string; remoteUrl: string }> {
  const r = await api.json<{ resourceId: string; branch: string; coords?: { namespace: string; repoName: string; remoteUrl: string } }>('POST', `/api/orgs/${enc(orgId)}/resources`, { name: fixture, provider: 'artifacts' });
  partial.resourceIds[fixture] = r.resourceId;
  const coords = r.coords;
  if (!coords) throw new Error(`resource ${r.resourceId} came back without coordinates (is the session an owner?)`);
  const sha = await withWriteToken(
    deps.fetch,
    o.artifacts,
    coords.namespace,
    coords.repoName,
    (token) => deps.pushFixture({ fixture, remoteUrl: coords.remoteUrl, token, branch: r.branch || 'main' }),
    (e) => deps.log(`could not revoke the ${fixture} write token (it expires in 15 min): ${message(e)}`),
  );
  const head = await api.json<{ revisionId: string }>('POST', `/api/orgs/${enc(orgId)}/resources/${enc(r.resourceId)}/adopt-head`);
  deps.log(`${fixture}: ${r.resourceId} pushed ${sha.slice(0, 12)}, head ${head.revisionId}`);
  return { resourceId: r.resourceId, remoteUrl: coords.remoteUrl };
}

/** Step 4: the brand assets through a task lease and an assets-only proposal. */
async function seedAssets(api: Api, orgId: string, projectId: string, o: SeedOptions, deps: SeedDeps, partial: SeedPartial): Promise<void> {
  const org = `/api/orgs/${enc(orgId)}`;
  const task = await api.json<{ taskId: string }>('POST', `${org}/projects/${enc(projectId)}/tasks`, {
    title: 'Add brand assets',
    request: 'Initial brand assets: logo and brand video.',
    writeMounts: [ASSETS_MOUNT],
    // no reference copies: without this the Worker adds every other readable mount (tasks.ts), which
    // provisions three git reference workspaces (runner seed jobs, task stays `provisioning` until
    // they finish) and makes the assets-only integrate install dependencies on them
    readMounts: [],
  });
  partial.taskId = task.taskId;
  const t = `/api/tasks/${enc(task.taskId)}`;
  await poll(deps, 'brand assets task', 10 * 60_000, () => api.json<{ state: string }>('GET', t), (v) => v.state === 'ready');
  const lease = await api.json<{ leaseToken: string }>('POST', `${t}/lease`, { ttlSeconds: 3600 });
  const agent = api.withToken(lease.leaseToken);
  try {
    const view = await agent.json<{ workspaces: Array<{ taskWorkspaceId: string; mountName: string }> }>('GET', t);
    const ws = view.workspaces.find((w) => w.mountName === ASSETS_MOUNT);
    if (!ws) throw new Error(`task ${task.taskId} has no ${ASSETS_MOUNT} workspace`);
    const changes = [];
    for (const a of o.assets) {
      const bytes = await a.load();
      const staged = await agent.json<{ stagingKey: string; uploadUrl: string }>('POST', `${t}/assets/stage`, { mountName: ASSETS_MOUNT, path: a.path, size: bytes.byteLength, mime: a.mime });
      if (!staged.uploadUrl.startsWith('/api/')) throw new Error(`unexpected upload URL ${staged.uploadUrl}`);
      await agent.bytes('PUT', staged.uploadUrl, bytes, a.mime);
      changes.push({ path: a.path, stagingKey: staged.stagingKey, sha256: createHash('sha256').update(bytes).digest('hex'), mime: a.mime });
      deps.log(`${ASSETS_MOUNT}: uploaded ${a.path} (${bytes.byteLength} bytes)`);
    }
    await agent.json('POST', `${t}/assets/commit`, { mountName: ASSETS_MOUNT, changes });
    await agent.json('POST', `${t}/workspaces/${enc(ws.taskWorkspaceId)}/freeze`, {});
  } catch (e) {
    // release the lease (otherwise live for an hour) without letting a release error replace `e`
    await agent.json('DELETE', `${t}/lease`).catch((releaseError: unknown) => deps.log(`could not release the lease of task ${task.taskId}: ${message(releaseError)}`));
    throw e;
  }
  await agent.json('DELETE', `${t}/lease`);

  type Proposal = { proposalId: string; proposalHash: string; state: string; lastAttempt?: { state: string; expired?: boolean; code?: string | null; forCurrentHash?: boolean } | null };
  let p = await api.json<Proposal>('POST', `${org}/proposals`, { taskId: task.taskId });
  partial.proposalId = p.proposalId;
  const pp = `${org}/proposals/${enc(p.proposalId)}`;
  if (p.state !== 'prepared') p = await poll(deps, 'brand assets proposal', 10 * 60_000, () => api.json<Proposal>('GET', pp), (v) => v.state === 'prepared');
  await api.json('POST', `${pp}/integrate`);
  // an attempt that expired while queued never runs: stop instead of polling it for 15 minutes
  p = await poll(deps, 'brand assets integration', 15 * 60_000, () => api.json<Proposal>('GET', pp), (v) => !!v.lastAttempt && (v.lastAttempt.state !== 'queued' || v.lastAttempt.expired === true));
  if (p.lastAttempt?.state === 'queued') throw new Error(`brand assets integration expired while queued: no runner took the job (is the integration runner up?); proposal ${p.proposalId}`);
  if (p.lastAttempt?.state !== 'succeeded') throw new Error(`brand assets integration failed: ${p.lastAttempt?.code ?? p.lastAttempt?.state}`);
  await api.json('POST', `${pp}/approvals`, { proposalHash: p.proposalHash });
  const accepted = await api.json<{ acceptedVersionId: string }>('POST', `${pp}/accept`, { idempotencyKey: `seed-${projectId}-${ASSETS_MOUNT}` });
  deps.log(`${ASSETS_MOUNT}: accepted as ${accepted.acceptedVersionId}`);
}

/**
 * The org's `orders` KV namespace (reused when it exists, at most 5 per org) and the deployment's
 * release Worker prefix (`<prefix>-<orgId>-`).
 */
async function ordersKv(api: Api, orgId: string): Promise<{ kvId: string; workerPrefix?: string }> {
  const list = await api.json<{ workerPrefix?: string; resources: Array<{ kind: string; name: string; id: string }> }>('GET', `/api/orgs/${enc(orgId)}/deploy-resources`);
  const found = list.resources.find((r) => r.kind === 'kv' && r.name === KV_NAME);
  const kvId = found ? found.id : (await api.json<{ id: string }>('POST', `/api/orgs/${enc(orgId)}/deploy-resources`, { kind: 'kv', name: KV_NAME })).id;
  return { kvId, ...(list.workerPrefix ? { workerPrefix: list.workerPrefix } : {}) };
}

type ReleaseView = { releaseId: string; state: string; buildState?: string; outputDigest?: string; error?: unknown };

/** `--staging`: the owner publishes `main` to production (staging starts only after it), then staging is `active`. */
async function baselinePublish(api: Api, orgId: string, projectId: string, deps: SeedDeps, partial: SeedPartial): Promise<string> {
  const org = `/api/orgs/${enc(orgId)}`;
  const r = await api.json<{ releaseId: string }>('POST', `${org}/projects/${enc(projectId)}/releases`, {});
  partial.baselineReleaseId = r.releaseId;
  const rel = `${org}/releases/${enc(r.releaseId)}`;
  const built = await poll(deps, 'baseline release build', 25 * 60_000, () => api.json<ReleaseView>('GET', rel), (v) => v.buildState !== 'building');
  if (built.buildState !== 'built') throw new Error(`baseline release build ${built.buildState}: ${JSON.stringify(built.error ?? null)}`);
  await api.json('POST', `${rel}/publish-approvals`, { outputDigest: built.outputDigest });
  let done!: ReleaseView;
  // a deploy may be retried from failed/partial/recovery_required (API.md): one more attempt after a
  // provider failure (a Cloudflare API 504 during the deploy, seen on CI 2026-10-12)
  for (let attempt = 1; attempt <= 2; attempt++) {
    await api.json('POST', `${rel}/deploy`, { idempotencyKey: `seed-baseline-${projectId}${attempt > 1 ? `-${attempt}` : ''}` });
    done = await poll(deps, 'baseline release', 20 * 60_000, () => api.json<ReleaseView>('GET', rel), (v) => ['live', 'failed', 'recovery_required', 'partial'].includes(v.state));
    if (done.state === 'live') break;
    if (attempt === 1) deps.log(`baseline release ${done.state}: ${JSON.stringify(done.error ?? null).slice(0, 300)}; deploying it once more`);
  }
  if (done.state !== 'live') throw new Error(`baseline release ${done.state}: ${JSON.stringify(done.error ?? null)}`);
  await poll(deps, 'staging baseline', 5 * 60_000, () => api.json<StagingView>('GET', `${org}/projects/${enc(projectId)}/staging`), (v) => v.state === 'active');
  deps.log(`baseline ${r.releaseId} live in production; staging active`);
  return r.releaseId;
}

/** Landing failures a fresh task can get past (services/staging.ts REASONS): the deploy (staging rolled back), the build, a stopped build. */
const TRANSIENT_LANDING = /^The staging (deploy failed\.(?! and could not be undone)|build failed\.|build stopped)/;

type StagingView = { state: string; url?: string | null; building?: boolean; landings: Array<{ landingId: string; taskId: string; state: string; reasonCode?: string | null; reason?: string | null }> };

/**
 * `--stage-tasks`: the client creates each demo task, takes its lease and hands it to their agent;
 * each must land before the next starts (the next task checks out from staging, and the rename
 * patch applies on top of the phone field).
 */
async function stageDemoTasks(api: Api, client: Api, orgId: string, projectId: string, deps: SeedDeps, partial: SeedPartial): Promise<StagedTask[]> {
  if (!deps.agentTask) throw new Error('--stage-tasks needs the agent (cforge) runner');
  const staging = `/api/orgs/${enc(orgId)}/projects/${enc(projectId)}/staging`;
  const staged: StagedTask[] = [];
  partial.stagedTasks = [];
  for (const task of DEMO_TASKS) {
    for (let attempt = 1; ; attempt++) {
      const created = await client.json<{ taskId: string }>('POST', `/api/orgs/${enc(orgId)}/projects/${enc(projectId)}/tasks`, { title: task.title, request: task.request, writeMounts: task.mounts, readMounts: [] });
      partial.stagedTasks.push({ key: task.key, taskId: created.taskId });
      const t = `/api/tasks/${enc(created.taskId)}`;
      const ready = await poll(deps, `${task.key} task`, 10 * 60_000, () => client.json<{ state: string }>('GET', t), (v) => v.state !== 'provisioning');
      if (ready.state !== 'ready') throw new Error(`${task.key} task ${created.taskId}: ${ready.state}`);
      const lease = await client.json<{ leaseToken: string }>('POST', `${t}/lease`, { ttlSeconds: 3600 });
      await deps.agentTask({ task, taskId: created.taskId, leaseToken: lease.leaseToken });
      const st = await poll(deps, `${task.key} landing`, 20 * 60_000, () => api.json<StagingView>('GET', staging), (v) => {
        const l = v.landings.find((x) => x.taskId === created.taskId);
        return !!l && ['landed', 'failed', 'rolled_back'].includes(l.state) && !v.building;
      });
      const l = st.landings.find((x) => x.taskId === created.taskId)!;
      if (l.state === 'landed') {
        staged.push({ key: task.key, taskId: created.taskId, landingId: l.landingId });
        deps.log(`${task.key}: "${task.title}" (${created.taskId}) landed in staging as ${l.landingId}`);
        break;
      }
      const why = `${task.key}: landing ${l.landingId} ${l.state}: ${l.reasonCode ?? ''} ${l.reason ?? ''}`.trim();
      // a failed landing is never retried by the platform: a transient provider failure (a Cloudflare
      // API 504 during the staging deploy, seen on CI 2026-10-12) gets one fresh task; the failed card
      // stays on the board (seed a new org for a clean board)
      if (attempt >= 2 || !TRANSIENT_LANDING.test(l.reason ?? '')) throw new Error(why);
      deps.log(`${why}; trying once more with a new task`);
    }
  }
  return staged;
}

/** The client member (reused when the address is already a client of the org). */
async function clientMember(api: Api, orgId: string, email: string): Promise<string> {
  const { members } = await api.json<{ members: Array<{ userId: string; email: string; role: string }> }>('GET', `/api/orgs/${enc(orgId)}/members`);
  const m = members.find((x) => x.email.toLowerCase() === email.toLowerCase());
  if (m && m.role !== 'client') throw new Error(`${email} is already a ${m.role} of ${orgId}; use another address for the client`);
  if (m) return m.userId;
  return (await api.json<{ userId: string }>('POST', `/api/orgs/${enc(orgId)}/members`, { email, role: 'client' })).userId;
}

/** Seed the demo project. Any failure is a `SeedFailure` whose `partial` names what the run left behind. */
export async function seedDemo(o: SeedOptions, deps: SeedDeps): Promise<SeedOutput> {
  const partial: SeedPartial = { orgId: null, orgCreated: false, projectId: null, resourceIds: {}, error: '' };
  try {
    return await seedSteps(o, deps, partial);
  } catch (e) {
    throw new SeedFailure({ ...partial, error: message(e) }, e);
  }
}

async function seedSteps(o: SeedOptions, deps: SeedDeps, partial: SeedPartial): Promise<SeedOutput> {
  const api = createApi({ baseUrl: o.baseUrl, token: o.sessionToken, fetch: deps.fetch });
  const me = await api.json<{ user: { email: string } }>('GET', '/api/me');
  deps.log(`signed in as ${me.user.email}`);
  const orgId = await resolveOrg(api, o, deps, partial);
  const org = `/api/orgs/${enc(orgId)}`;

  const git = {} as Record<GitFixture, string>;
  const remotes = {} as Record<GitFixture, string>;
  for (const f of GIT_FIXTURES) ({ resourceId: git[f], remoteUrl: remotes[f] } = await gitResource(api, orgId, f, o, deps, partial));
  const brandAssets = (await api.json<{ resourceId: string }>('POST', `${org}/resources`, { name: ASSETS_MOUNT, provider: 'r2-assets' })).resourceId;
  partial.resourceIds.brandAssets = brandAssets;

  const { projectId } = await api.json<{ projectId: string }>('POST', `${org}/projects`, { name: o.projectName });
  partial.projectId = projectId;
  for (const f of GIT_FIXTURES) await api.json('POST', `${org}/projects/${enc(projectId)}/mounts`, { mountName: f, resourceId: git[f] });
  await api.json('POST', `${org}/projects/${enc(projectId)}/mounts`, { mountName: ASSETS_MOUNT, resourceId: brandAssets });
  deps.log(`project ${projectId} "${o.projectName}" with mounts ${[...GIT_FIXTURES, ASSETS_MOUNT].join(', ')}`);

  await seedAssets(api, orgId, projectId, o, deps, partial);

  const { kvId, workerPrefix } = await ordersKv(api, orgId);
  partial.kvId = kvId;
  let d1Id: string | undefined;
  if (o.staging) {
    // 200 with the existing database when the org already has it
    d1Id = (await api.json<{ id: string }>('POST', `${org}/deploy-resources`, { kind: 'd1', name: D1_NAME })).id;
    partial.d1Id = d1Id;
  }
  const policyDoc = projectPolicy({ orgId, resourceIds: git, kvId, workersSubdomain: o.workersSubdomain, ...(workerPrefix ? { workerPrefix } : {}), ...(d1Id ? { staging: { d1Id } } : {}) });
  const policy = await api.json<{ policyRevision: number }>('PUT', `${org}/projects/${enc(projectId)}/policy`, policyDoc);
  deps.log(`policy revision ${policy.policyRevision}: quote check and contract, preview and release recipes${d1Id ? ', staging (promotion rules, classifier jev 0.9) and production D1 migrations' : ''}`);

  const clientUserId = await clientMember(api, orgId, o.clientEmail);
  partial.clientUserId = clientUserId;
  // staging: the client may change the git folders through tasks ("Can change": write on them); brand assets stay read
  const clientOps = o.staging ? ['read', 'write'] : ['read'];
  for (const [scope, ops] of [
    [{ kind: 'project', id: projectId }, clientOps],
    ...[git.website, git.api, git.requirements].map((id) => [{ kind: 'resource', id }, clientOps] as const),
    [{ kind: 'resource', id: brandAssets }, ['read']],
  ] as const) {
    await api.json('PUT', `${org}/grants`, { userId: clientUserId, scope, operations: ops });
  }
  deps.log(o.staging ? `client ${o.clientEmail} (${clientUserId}) can change the three git folders through tasks and read the brand assets` : `client ${o.clientEmail} (${clientUserId}) can read the project and its four resources`);

  if (o.staging) {
    const baselineReleaseId = await baselinePublish(api, orgId, projectId, deps, partial);
    let tasks: StagedTask[] = [];
    if (o.stageTasks) {
      const client = api.withToken(o.stageTasks.clientToken);
      const me = await client.json<{ user: { userId: string; email: string } }>('GET', '/api/me');
      if (me.user.email.toLowerCase() !== o.clientEmail.toLowerCase()) throw new Error(`the client session is ${me.user.email}, not the client member ${o.clientEmail}`);
      tasks = await stageDemoTasks(api, client, orgId, projectId, deps, partial);
    }
    const st = await api.json<StagingView>('GET', `${org}/projects/${enc(projectId)}/staging`);
    return {
      orgId,
      projectId,
      resourceIds: { website: git.website, api: git.api, requirements: git.requirements, brandAssets },
      canonicalRemotes: { website: remotes.website, api: remotes.api, requirements: remotes.requirements },
      editionId: null,
      clientUserId,
      staging: { url: st.url ?? null, productionD1Id: d1Id!, baselineReleaseId, tasks },
    };
  }

  const edition = await api.json<{ editionId: string }>('POST', `${org}/projects/${enc(projectId)}/editions`, websiteEditionPolicy('website'));
  partial.editionId = edition.editionId;
  const ed = `${org}/editions/${enc(edition.editionId)}`;
  const build = await api.json<{ buildId: string }>('POST', `${ed}/builds`, {});
  type EditionView = { builds?: Array<{ buildId: string; state: string; error?: string }> };
  const built = await poll(deps, 'edition build', 10 * 60_000, () => api.json<EditionView>('GET', ed), (v) => (v.builds ?? []).some((b) => b.buildId === build.buildId && b.state !== 'queued'));
  const b = built.builds?.find((x) => x.buildId === build.buildId);
  if (b?.state !== 'ready') throw new Error(`edition build failed: ${b?.error ?? b?.state}`);
  await api.json('PUT', `${ed}/grants`, { userId: clientUserId });
  deps.log(`edition ${edition.editionId} built and granted to the client`);

  return {
    orgId,
    projectId,
    resourceIds: { website: git.website, api: git.api, requirements: git.requirements, brandAssets },
    canonicalRemotes: { website: remotes.website, api: remotes.api, requirements: remotes.requirements },
    editionId: edition.editionId,
    clientUserId,
  };
}

// ------------------------------------------------------------------------------------------ CLI

export interface Cli {
  org: { id: string } | { newName: string };
  projectName: string;
  clientEmail: string;
  replace: boolean;
  plan: boolean;
  workersSubdomain?: string;
  out?: string;
  video?: string;
  staging: boolean;
  stageTasks: boolean;
  sessionFile?: string;
  clientSessionFile?: string;
  baseUrl?: string;
  cfApiToken?: string;
  cfAccountId?: string;
}

export function parseCli(argv: string[], env: Record<string, string | undefined>): Cli {
  const { values } = parseArgs({
    args: argv[0] === '--' ? argv.slice(1) : argv,
    options: {
      org: { type: 'string' },
      'new-org': { type: 'string' },
      'project-name': { type: 'string', default: 'Customer Portal' },
      'client-email': { type: 'string' },
      replace: { type: 'boolean', default: false },
      plan: { type: 'boolean', default: false },
      'workers-subdomain': { type: 'string' },
      out: { type: 'string' },
      video: { type: 'string' },
      staging: { type: 'boolean', default: false },
      'stage-tasks': { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (values.org && values['new-org']) throw new Error('pass either --org <id> or --new-org <name>, not both');
  if (values['stage-tasks'] && !values.staging) throw new Error('--stage-tasks needs --staging');
  const clientEmail = values['client-email'] ?? env.CAPTURE_CLIENT_EMAIL;
  if (!clientEmail) throw new Error('--client-email <address> (or CAPTURE_CLIENT_EMAIL) is required: the demo client member');
  const cli: Cli = {
    org: values.org ? { id: values.org } : { newName: values['new-org'] ?? 'Demo Client' },
    projectName: values['project-name'],
    clientEmail,
    replace: values.replace,
    plan: values.plan,
    workersSubdomain: values['workers-subdomain'] ?? env.CAPTURE_WORKERS_SUBDOMAIN,
    out: values.out,
    video: values.video,
    staging: values.staging,
    stageTasks: values['stage-tasks'],
    sessionFile: env.CAPTURE_OWNER_SESSION_FILE,
    clientSessionFile: env.CAPTURE_CLIENT_SESSION_FILE,
    baseUrl: env.CAPTURE_BASE_URL,
    cfApiToken: env.CF_API_TOKEN,
    cfAccountId: env.CF_ACCOUNT_ID,
  };
  if (!cli.plan) {
    const needed = ['CAPTURE_OWNER_SESSION_FILE', 'CF_API_TOKEN', 'CF_ACCOUNT_ID', ...(cli.stageTasks ? ['CAPTURE_CLIENT_SESSION_FILE'] : [])];
    const missing = needed.filter((k) => !env[k]);
    if (missing.length) throw new Error(`missing ${missing.join(', ')} (source scripts/load-dev-vars.sh for the CF_* values; CAPTURE_OWNER_SESSION_FILE and CAPTURE_CLIENT_SESSION_FILE are the cforge session.json files)`);
  }
  return cli;
}

/** `commonforge-worker.<sub>.workers.dev` → `<sub>` (release targets live on the same account by default). */
function subdomainOf(baseUrl: string): string | undefined {
  return /^[^.]+\.([^.]+)\.workers\.dev$/.exec(new URL(baseUrl).hostname)?.[1];
}

function describeBody(c: RecordedCall): string {
  if (c.body === undefined) return '';
  return ` ${JSON.stringify(c.body)}`;
}

/** The plan's stand-in for the Cloudflare account id: the real one is never printed (artifacts-rest.ts redacts it too). */
const PLAN_ACCOUNT_ID = '<CF_ACCOUNT_ID>';

/**
 * `--plan`: run the seeding sequence against the scripted stand-in (seed-demo-plan.ts) and print each
 * call. Nothing is sent and no secret or account id is used. `paths` only label the output.
 */
export async function planSeed(cli: Cli, log: (line: string) => void, paths: { out: string; video: string }): Promise<SeedOutput> {
  const describeUrl = (c: RecordedCall) => (c.url.startsWith('https://api.cloudflare.com/') ? `[Cloudflare] ${decodeURIComponent(new URL(c.url).pathname)}` : c.path);
  const server = createPlanServer({ clientEmail: cli.clientEmail, onCall: (c) => log(`→ ${c.method} ${describeUrl(c)}${describeBody(c)}`) });
  const placeholder = (name: string) => async () => new TextEncoder().encode(`<plan placeholder for ${name}>`);
  const result = await seedDemo(
    {
      baseUrl: cli.baseUrl ?? 'https://commonforge-worker.example.workers.dev',
      sessionToken: 'cfs_plan',
      artifacts: { accountId: PLAN_ACCOUNT_ID, apiToken: 'plan' },
      org: cli.org,
      projectName: cli.projectName,
      clientEmail: cli.clientEmail,
      replace: cli.replace,
      workersSubdomain: cli.workersSubdomain ?? (cli.baseUrl ? subdomainOf(cli.baseUrl) : 'commonforge') ?? '<workers-subdomain>',
      staging: cli.staging,
      ...(cli.stageTasks ? { stageTasks: { clientToken: 'cfs_plan_client' } } : {}),
      assets: [
        { path: 'logo.png', mime: 'image/png', load: placeholder('fixtures/brand-assets/logo.png') },
        { path: 'brand-video.mp4', mime: 'video/mp4', load: placeholder(`${paths.video} (~50 MB)`) },
      ],
    },
    {
      fetch: server.fetch,
      pushFixture: async (p) => {
        log(`→ git push fixtures/${p.fixture} (committed at HEAD) → ${p.remoteUrl} refs/heads/${p.branch} [Artifacts write token in the push environment]`);
        return 'plan';
      },
      sleep: async () => {},
      log: (line) => log(`  ${line}`),
      agentTask: async (a) => log(`→ client agent (lease): cforge checkout ${a.taskId} → ${a.task.key} edit (seed-demo-tasks.ts) → cforge submit --mount ${a.task.mounts.join(' --mount ')}`),
    },
  );
  log(`\n--plan: nothing was sent. ${paths.out} would hold:\n${JSON.stringify(result, null, 2)}`);
  return result;
}

/**
 * `--stage-tasks`: the client's agent, as in scripts/ci-live/staging.ts: its own cforge home with only
 * the lease (apps/demo-agents agentIdentity), checkout from live staging, the demo edit, submit.
 * apps/cli and apps/demo-agents must be built. Workspaces live in a temp dir, removed afterwards.
 */
async function cforgeAgent(repoRoot: string, apiUrl: string, log: (line: string) => void): Promise<NonNullable<SeedDeps['agentTask']>> {
  const dist = join(repoRoot, 'apps/demo-agents/dist/index.js');
  if (!existsSync(dist)) throw new Error('--stage-tasks runs cforge through apps/demo-agents: run `pnpm --filter @commonforge-org/cli --filter @commonforge-org/demo-agents build` first');
  // a path import (no package dependency): video/ stays independent of the workspace apps
  const agents = (await import(pathToFileURL(dist).href)) as {
    agentIdentity(home: string, name: string, apiUrl: string, leaseToken: string): Promise<{ env: Record<string, string> }>;
    cforgeJson<T>(cforge: unknown, argv: readonly string[], opts: { cwd: string; env: Record<string, string> }): Promise<T>;
    subprocessCforge(): unknown;
  };
  const cforge = agents.subprocessCforge();
  return async ({ task, taskId, leaseToken }) => {
    const dir = mkdtempSync(join(tmpdir(), `cf-seed-${task.key}-`));
    try {
      const ws = join(dir, 'ws');
      const ident = await agents.agentIdentity(join(dir, 'home'), 'Client Agent', apiUrl, leaseToken);
      const c = await agents.cforgeJson<{ verified?: boolean }>(cforge, ['checkout', taskId, ws], { cwd: dir, env: ident.env });
      if (!c.verified) throw new Error(`${task.key}: checkout not verified`);
      applyDemoTask(task.key, ws, repoRoot);
      await agents.cforgeJson(cforge, ['submit', ...task.mounts.flatMap((m) => ['--mount', m]), '--commit', task.title, '--tool', 'seed-demo'], { cwd: ws, env: ident.env });
      log(`${task.key}: the client's agent submitted ${task.mounts.join(', ')}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2), process.env);
  const videoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const repoRoot = resolve(videoRoot, '..');
  const out = resolve(cli.out ?? join(videoRoot, 'seed-output.json'));
  const fixtures = (f: string) => `fixtures/${f}`;
  const logo = join(repoRoot, 'fixtures/brand-assets/logo.png');
  const video = resolve(cli.video ?? join(repoRoot, 'fixtures/brand-assets/brand-video.mp4'));
  const log = (line: string) => console.log(line);

  if (cli.plan) {
    try {
      await planSeed(cli, log, { out, video });
    } catch (e) {
      if (e instanceof SeedFailure) console.error(partialLine(e.partial));
      throw e;
    }
    return;
  }

  const readSession = (file: string) => {
    const s = JSON.parse(readFileSync(file, 'utf8')) as { apiUrl?: string; sessionToken?: string };
    if (!s.sessionToken?.startsWith('cfs_')) throw new Error(`${file} holds no cfs_ session (run cforge login)`);
    return s as { apiUrl?: string; sessionToken: string };
  };
  const session = readSession(cli.sessionFile!);
  const clientSession = cli.stageTasks ? readSession(cli.clientSessionFile!) : undefined;
  const baseUrl = cli.baseUrl ?? session.apiUrl;
  if (!baseUrl) throw new Error('set CAPTURE_BASE_URL (the session file names no apiUrl)');
  const workersSubdomain = cli.workersSubdomain ?? subdomainOf(baseUrl);
  if (!workersSubdomain) throw new Error('pass --workers-subdomain <sub> (the release Workers are https://cfapp-<org>-api.<sub>.workers.dev)');
  if (!existsSync(video)) {
    log(`generating ${video} (fixtures/brand-assets/scripts/make-video.sh, needs ffmpeg)`);
    execFileSync(join(repoRoot, 'fixtures/brand-assets/scripts/make-video.sh'), [video, '50'], { stdio: 'inherit' });
  }

  // on failure: the partial line, and what exists in seed-output.partial.json (next to --out)
  const partialOut = out.replace(/(\.json)?$/, '.partial.json');
  const result = await seedDemo(
    {
      baseUrl,
      sessionToken: session.sessionToken,
      artifacts: { accountId: cli.cfAccountId!, apiToken: cli.cfApiToken! },
      org: cli.org,
      projectName: cli.projectName,
      clientEmail: cli.clientEmail,
      replace: cli.replace,
      workersSubdomain,
      staging: cli.staging,
      ...(clientSession ? { stageTasks: { clientToken: clientSession.sessionToken } } : {}),
      assets: [
        { path: 'logo.png', mime: 'image/png', load: async () => new Uint8Array(await readFile(logo)) },
        { path: 'brand-video.mp4', mime: 'video/mp4', load: async () => new Uint8Array(await readFile(video)) },
      ],
    },
    {
      fetch: globalThis.fetch,
      pushFixture: (p) => pushFixture({ repoRoot, ref: 'HEAD', fixturePath: fixtures(p.fixture), remoteUrl: p.remoteUrl, token: p.token, branch: p.branch }),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      log,
      ...(cli.stageTasks ? { agentTask: await cforgeAgent(repoRoot, baseUrl, log) } : {}),
    },
  ).catch((e: unknown) => {
    reportPartial(e, partialOut, (line) => console.error(line));
    throw e;
  });
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  log(`wrote ${out}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e: unknown) => {
    console.error(`seed-demo: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
