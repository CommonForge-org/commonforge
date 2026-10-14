import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pushFixture, revokeToken, withWriteToken } from './seed-demo-artifacts';
import { createPlanServer, PLAN_D1_ID, PLAN_KV_ID, type RecordedCall } from './seed-demo-plan';
import { DEMO_EDITION_NAME, STAGING_PROMOTION, websiteEditionPolicy } from './seed-demo-policy';
import { applyDemoTask, COPY_FROM, COPY_TO, DEMO_TASKS } from './seed-demo-tasks';
import { parseCli, partialLine, planSeed, reportPartial, SeedFailure, seedDemo, type SeedDeps, type SeedOptions } from './seed-demo';

const SESSION = 'cfs_owner-session-secret';
const CF_TOKEN = 'cf-api-token-secret';
const ACCOUNT = '0123456789abcdef0123456789abcdef';
const LOGO = new TextEncoder().encode('logo-bytes');
const VIDEO = new TextEncoder().encode('video-bytes-video-bytes');

function options(over: Partial<SeedOptions> = {}): SeedOptions {
  return {
    baseUrl: 'https://cf.example.workers.dev',
    sessionToken: SESSION,
    artifacts: { accountId: ACCOUNT, apiToken: CF_TOKEN },
    org: { newName: 'Demo Client' },
    projectName: 'Customer Portal',
    clientEmail: 'owner+client@example.com',
    replace: false,
    workersSubdomain: 'demo-sub',
    assets: [
      { path: 'logo.png', mime: 'image/png', load: async () => LOGO },
      { path: 'brand-video.mp4', mime: 'video/mp4', load: async () => VIDEO },
    ],
    ...over,
  };
}

function harness() {
  const server = createPlanServer({ clientEmail: 'owner+client@example.com' });
  const pushes: Array<{ fixture: string; remoteUrl: string; token: string; branch: string }> = [];
  const log: string[] = [];
  const deps: SeedDeps = {
    fetch: server.fetch,
    pushFixture: async (o) => {
      pushes.push(o);
      return `sha-${o.fixture}`;
    },
    sleep: async () => {},
    log: (line) => log.push(line),
  };
  return { server, pushes, log, deps };
}

/** `METHOD /path` of each call, ids replaced so the sequence reads as a protocol. */
function sequence(calls: RecordedCall[]): string[] {
  return calls.map((c) => `${c.method} ${c.path.replace(/\?.*$/, '')}`);
}

const bodiesOf = (calls: RecordedCall[], method: string, re: RegExp) => calls.filter((c) => c.method === method && re.test(c.path)).map((c) => c.body);

describe('seedDemo: fresh org', () => {
  it('sends the documented sequence in order and returns the seed output', async () => {
    const { server, pushes, deps } = harness();
    const out = await seedDemo(options(), deps);
    const o = out.orgId;
    const p = out.projectId;
    const r = out.resourceIds;
    const ns = `cf-${o}-canonical`;
    const cf = `/client/v4/accounts/${ACCOUNT}/artifacts/namespaces/${ns}`;
    const gitResource = (rid: string) => [`POST ${cf}/tokens`, `DELETE ${cf}/tokens/tok-${rid}`, `POST /api/orgs/${o}/resources/${rid}/adopt-head`];
    expect(sequence(server.calls)).toEqual([
      'GET /api/me',
      'GET /api/orgs',
      'POST /api/orgs',
      `POST /api/orgs/${o}/resources`,
      ...gitResource(r.website),
      `POST /api/orgs/${o}/resources`,
      ...gitResource(r.api),
      `POST /api/orgs/${o}/resources`,
      ...gitResource(r.requirements),
      `POST /api/orgs/${o}/resources`,
      `POST /api/orgs/${o}/projects`,
      `POST /api/orgs/${o}/projects/${p}/mounts`,
      `POST /api/orgs/${o}/projects/${p}/mounts`,
      `POST /api/orgs/${o}/projects/${p}/mounts`,
      `POST /api/orgs/${o}/projects/${p}/mounts`,
      // brand assets through the only upload path there is: a task lease (API.md "Tasks")
      `POST /api/orgs/${o}/projects/${p}/tasks`,
      'GET /api/tasks/task-1',
      'POST /api/tasks/task-1/lease',
      'GET /api/tasks/task-1',
      'POST /api/tasks/task-1/assets/stage',
      'PUT /api/tasks/task-1/assets/upload',
      'POST /api/tasks/task-1/assets/stage',
      'PUT /api/tasks/task-1/assets/upload',
      'POST /api/tasks/task-1/assets/commit',
      'POST /api/tasks/task-1/workspaces/tw-1/freeze',
      'DELETE /api/tasks/task-1/lease',
      `POST /api/orgs/${o}/proposals`,
      `POST /api/orgs/${o}/proposals/prop-1/integrate`,
      `GET /api/orgs/${o}/proposals/prop-1`,
      `POST /api/orgs/${o}/proposals/prop-1/approvals`,
      `POST /api/orgs/${o}/proposals/prop-1/accept`,
      `GET /api/orgs/${o}/deploy-resources`,
      `POST /api/orgs/${o}/deploy-resources`,
      `PUT /api/orgs/${o}/projects/${p}/policy`,
      `GET /api/orgs/${o}/members`,
      `POST /api/orgs/${o}/members`,
      `PUT /api/orgs/${o}/grants`,
      `PUT /api/orgs/${o}/grants`,
      `PUT /api/orgs/${o}/grants`,
      `PUT /api/orgs/${o}/grants`,
      `PUT /api/orgs/${o}/grants`,
      `POST /api/orgs/${o}/projects/${p}/editions`,
      `POST /api/orgs/${o}/editions/ed-1/builds`,
      `GET /api/orgs/${o}/editions/ed-1`,
      `PUT /api/orgs/${o}/editions/ed-1/grants`,
    ]);
    expect(out).toEqual({
      orgId: o,
      projectId: p,
      resourceIds: { website: r.website, api: r.api, requirements: r.requirements, brandAssets: r.brandAssets },
      canonicalRemotes: Object.fromEntries((['website', 'api', 'requirements'] as const).map((f) => [f, expect.stringMatching(new RegExp(`/${out.resourceIds[f]}\\.git$`))])),
      editionId: 'ed-1',
      clientUserId: 'u-client',
    });
    // every fixture went to its own canonical repo with its own minted token, on the resource branch
    expect(pushes.map((x) => [x.fixture, x.remoteUrl, x.token, x.branch])).toEqual(
      (['website', 'api', 'requirements'] as const).map((f) => [f, `https://acct.artifacts.example/git/${ns}/${r[f]}.git`, `tok-secret-${r[f]}`, 'main']),
    );
  });

  it('sends the right bodies: resources, mounts, write-token mints, assets, grants and edition', async () => {
    const { server, deps } = harness();
    const out = await seedDemo(options(), deps);
    const c = server.calls;
    expect(bodiesOf(c, 'POST', /^\/api\/orgs$/)).toEqual([{ name: 'Demo Client' }]);
    expect(bodiesOf(c, 'POST', /\/resources$/)).toEqual([
      { name: 'website', provider: 'artifacts' },
      { name: 'api', provider: 'artifacts' },
      { name: 'requirements', provider: 'artifacts' },
      { name: 'brand-assets', provider: 'r2-assets' },
    ]);
    expect(bodiesOf(c, 'POST', /\/tokens$/)).toEqual(
      (['website', 'api', 'requirements'] as const).map((f) => ({ repo: out.resourceIds[f], scope: 'write', ttl: 900 })),
    );
    expect(bodiesOf(c, 'POST', /\/projects$/)).toEqual([{ name: 'Customer Portal' }]);
    expect(bodiesOf(c, 'POST', /\/mounts$/)).toEqual([
      { mountName: 'website', resourceId: out.resourceIds.website },
      { mountName: 'api', resourceId: out.resourceIds.api },
      { mountName: 'requirements', resourceId: out.resourceIds.requirements },
      { mountName: 'brand-assets', resourceId: out.resourceIds.brandAssets },
    ]);
    // readMounts: [] keeps the Worker from adding website/api/requirements as git reference copies
    expect(bodiesOf(c, 'POST', /\/tasks$/)).toEqual([{ title: 'Add brand assets', request: expect.any(String), writeMounts: ['brand-assets'], readMounts: [] }]);
    expect(bodiesOf(c, 'POST', /\/assets\/stage$/)).toEqual([
      { mountName: 'brand-assets', path: 'logo.png', size: LOGO.byteLength, mime: 'image/png' },
      { mountName: 'brand-assets', path: 'brand-video.mp4', size: VIDEO.byteLength, mime: 'video/mp4' },
    ]);
    expect(bodiesOf(c, 'PUT', /\/assets\/upload\?key=stage-[12]$/)).toEqual([{ bytes: LOGO.byteLength }, { bytes: VIDEO.byteLength }]);
    const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
    expect(bodiesOf(c, 'POST', /\/assets\/commit$/)).toEqual([
      {
        mountName: 'brand-assets',
        changes: [
          { path: 'logo.png', stagingKey: 'stage-1', sha256: sha(LOGO), mime: 'image/png' },
          { path: 'brand-video.mp4', stagingKey: 'stage-2', sha256: sha(VIDEO), mime: 'video/mp4' },
        ],
      },
    ]);
    expect(bodiesOf(c, 'POST', /\/freeze$/)).toEqual([{}]);
    expect(bodiesOf(c, 'POST', /\/proposals$/)).toEqual([{ taskId: 'task-1' }]);
    expect(bodiesOf(c, 'POST', /\/approvals$/)).toEqual([{ proposalHash: 'hash-1' }]);
    expect(bodiesOf(c, 'POST', /\/accept$/)).toEqual([{ idempotencyKey: expect.stringMatching(/^seed-[A-Za-z0-9._:-]{8,}$/) }]);
    expect(bodiesOf(c, 'POST', /\/deploy-resources$/)).toEqual([{ kind: 'kv', name: 'orders' }]);
    expect(bodiesOf(c, 'POST', /\/members$/)).toEqual([{ email: 'owner+client@example.com', role: 'client' }]);
    expect(bodiesOf(c, 'PUT', /\/grants$/).filter((_, i, a) => i < a.length - 1)).toEqual([
      { userId: 'u-client', scope: { kind: 'project', id: out.projectId }, operations: ['read'] },
      ...(['website', 'api', 'requirements', 'brandAssets'] as const).map((k) => ({ userId: 'u-client', scope: { kind: 'resource', id: out.resourceIds[k] }, operations: ['read'] })),
    ]);
    expect(bodiesOf(c, 'POST', /\/editions$/)).toEqual([websiteEditionPolicy('website')]);
    expect(bodiesOf(c, 'POST', /\/builds$/)).toEqual([{}]);
    expect(bodiesOf(c, 'PUT', /\/editions\/ed-1\/grants$/)).toEqual([{ userId: 'u-client' }]);
    // the demo agents find the edition by this exact name (apps/demo-agents/src/edition.ts)
    expect(DEMO_EDITION_NAME).toBe('Website pages (client edition)');
  });

  it('sends the policy once, as a whole document: checks, contracts, rules, preview and release', async () => {
    const { server, deps } = harness();
    const out = await seedDemo(options(), deps);
    const puts = bodiesOf(server.calls, 'PUT', /\/policy$/);
    expect(puts).toHaveLength(1);
    const policy = puts[0] as Record<string, unknown>;
    expect(Object.keys(policy).sort()).toEqual(['checks', 'contracts', 'preview', 'release', 'rules']);
    const r = out.resourceIds;
    expect(policy.checks).toEqual([{ checkId: 'quote-contract', mountName: 'website', command: 'pnpm exec vitest run tests/quote-contract.test.ts', timeoutSeconds: 300 }]);
    expect(policy.contracts).toEqual([
      {
        contractId: 'quote',
        version: '1',
        producerResource: r.api,
        consumerResource: r.website,
        schema: { resourceId: r.requirements, path: 'contracts/quote.schema.json' },
        producerOutput: { mountName: 'api', command: 'node scripts/quote-sample.ts' },
      },
    ]);
    expect(policy.rules).toEqual(['GET /quote responses must match requirements/contracts/quote.schema.json', 'Money is integer cents.']);
    const release = policy.release as { targets: Array<{ workerName: string }>; environment: unknown; healthCheck: unknown; recipe: { steps: Array<{ env?: Record<string, string> }> } };
    expect(release.targets.map((t) => t.workerName)).toEqual([`cfapp-${out.orgId}-api`, `cfapp-${out.orgId}-website`]);
    expect(release.environment).toEqual({ api: { vars: { APP_VERSION: '1.0.0' }, kvNamespaces: [{ binding: 'ORDERS', id: PLAN_KV_ID }] } });
    // the real KvBindingSchema (packages/runner-protocol/src/jobs.ts) accepts only 32 hex
    expect(PLAN_KV_ID).toMatch(/^[0-9a-f]{32}$/);
    expect(release.healthCheck).toEqual({ targetId: 'api', path: '/version' });
    expect(release.recipe.steps.some((s) => s.env?.VITE_QUOTE_API_URL === `https://cfapp-${out.orgId}-api.demo-sub.workers.dev`)).toBe(true);
    const preview = policy.preview as { recipe: { output: unknown }; bundles: unknown };
    expect(preview.recipe.output).toEqual({ mountName: 'website', path: 'dist' });
    expect(preview.bundles).toEqual([{ name: 'api', mountName: 'api', path: 'dist' }]);
    // the KV namespace the release binds exists before the policy names it
    const seq = sequence(server.calls);
    expect(seq.indexOf(`POST /api/orgs/${out.orgId}/deploy-resources`)).toBeLessThan(seq.indexOf(`PUT /api/orgs/${out.orgId}/projects/${out.projectId}/policy`));
  });

  it('authenticates owner calls with the session, agent calls with the lease, Cloudflare with the API token, and never logs a secret', async () => {
    const { server, deps, log } = harness();
    await seedDemo(options(), deps);
    const kind = (c: RecordedCall) => {
      const a = c.headers.authorization;
      if (a === `Bearer ${CF_TOKEN}`) return 'cf';
      if (a === 'Bearer cfl_lease-1') return 'lease';
      if (a === `Bearer ${SESSION}`) return 'session';
      return `unexpected ${a}`;
    };
    const seq = sequence(server.calls);
    const kinds = server.calls.map(kind);
    expect(seq.filter((_, i) => kinds[i] === 'lease')).toEqual([
      'GET /api/tasks/task-1',
      'POST /api/tasks/task-1/assets/stage',
      'PUT /api/tasks/task-1/assets/upload',
      'POST /api/tasks/task-1/assets/stage',
      'PUT /api/tasks/task-1/assets/upload',
      'POST /api/tasks/task-1/assets/commit',
      'POST /api/tasks/task-1/workspaces/tw-1/freeze',
      'DELETE /api/tasks/task-1/lease',
    ]);
    expect(server.calls.filter((c, i) => (kinds[i] === 'cf') !== c.url.startsWith('https://api.cloudflare.com/'))).toEqual([]);
    expect(kinds.filter((k) => k.startsWith('unexpected'))).toEqual([]);
    const text = log.join('\n');
    for (const secret of [SESSION, CF_TOKEN, 'cfl_lease-1', 'tok-secret-']) expect(text).not.toContain(secret);
  });
});

describe('seedDemo: idempotency per project name', () => {
  it('refuses to reseed a project that exists in --org, and sends no write', async () => {
    const { server, deps } = harness();
    server.route('GET', /^\/api\/orgs\/o-existing0001\/projects$/, () => ({ projects: [{ projectId: 'p-old000000001', name: 'Customer Portal', createdAt: 'x' }] }));
    await expect(seedDemo(options({ org: { id: 'o-existing0001' } }), deps)).rejects.toThrow(/Customer Portal.*already exists.*p-old000000001.*--replace/s);
    expect(server.calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('refuses when an org of the --new-org name already holds the project; --replace makes a fresh org', async () => {
    const existing = () => {
      const h = harness();
      h.server.route('GET', /^\/api\/orgs$/, () => ({ orgs: [{ orgId: 'o-taken0000001', name: 'Demo Client', role: 'owner' }] }));
      h.server.route('GET', /^\/api\/orgs\/o-taken0000001\/projects$/, () => ({ projects: [{ projectId: 'p-old000000001', name: 'Customer Portal' }] }));
      return h;
    };
    const a = existing();
    await expect(seedDemo(options(), a.deps)).rejects.toThrow(/already exists.*o-taken0000001.*--replace/s);
    expect(a.server.calls.filter((c) => c.method !== 'GET')).toEqual([]);
    const b = existing();
    const out = await seedDemo(options({ replace: true }), b.deps);
    expect(out.orgId).not.toBe('o-taken0000001');
    expect(bodiesOf(b.server.calls, 'POST', /^\/api\/orgs$/)).toEqual([{ name: 'Demo Client' }]);
  });

  it('--replace in --org frees the old project release Workers and reuses the org KV and client member', async () => {
    const { server, deps } = harness();
    const org = 'o-existing0001';
    const oldPolicy = { checks: [{ checkId: 'c', mountName: 'website', command: 'x' }], contracts: [], rules: ['r'], release: { targets: [{ workerName: `cfapp-${org}-api` }] } };
    server.route('GET', new RegExp(`^/api/orgs/${org}/projects$`), () => ({ projects: [{ projectId: 'p-old000000001', name: 'Customer Portal' }] }));
    server.route('GET', new RegExp(`^/api/orgs/${org}/projects/p-old000000001$`), () => ({ projectId: 'p-old000000001', name: 'Customer Portal', mounts: [], policy: oldPolicy }));
    server.route('GET', new RegExp(`^/api/orgs/${org}/deploy-resources$`), () => ({ workerPrefix: `cfapp-${org}-`, resources: [{ kind: 'kv', name: 'orders', id: 'kv-existing' }] }));
    server.route('GET', new RegExp(`^/api/orgs/${org}/members$`), () => ({ members: [{ userId: 'u-old-client', email: 'owner+client@example.com', role: 'client' }] }));
    const out = await seedDemo(options({ org: { id: org }, replace: true }), deps);
    const puts = server.calls.filter((c) => c.method === 'PUT' && c.path.endsWith('/policy'));
    expect(puts.map((c) => c.path)).toEqual([`/api/orgs/${org}/projects/p-old000000001/policy`, `/api/orgs/${org}/projects/${out.projectId}/policy`]);
    expect(puts[0]!.body).toEqual({ checks: oldPolicy.checks, contracts: [], rules: ['r'] });
    expect((puts[1]!.body as { release: { environment: unknown } }).release.environment).toEqual({ api: { vars: { APP_VERSION: '1.0.0' }, kvNamespaces: [{ binding: 'ORDERS', id: 'kv-existing' }] } });
    expect(bodiesOf(server.calls, 'POST', /\/deploy-resources$/)).toEqual([]);
    expect(bodiesOf(server.calls, 'POST', /\/members$/)).toEqual([]);
    expect(out.clientUserId).toBe('u-old-client');
    expect(bodiesOf(server.calls, 'POST', /^\/api\/orgs$/)).toEqual([]);
  });

  it('refuses a client address that is already a member with another role', async () => {
    const { server, deps } = harness();
    server.route('GET', /\/members$/, () => ({ members: [{ userId: 'u-dev', email: 'owner+client@example.com', role: 'developer' }] }));
    await expect(seedDemo(options(), deps)).rejects.toThrow(/owner\+client@example\.com is already a developer/);
  });
});

describe('seedDemo: failures stop the run with the server code', () => {
  it('a failed asset integration stops before policy and members', async () => {
    const { server, deps } = harness();
    server.route('GET', /\/proposals\/prop-1$/, () => ({ proposalId: 'prop-1', proposalHash: 'hash-1', state: 'prepared', lastAttempt: { state: 'failed', code: 'runner_failed', forCurrentHash: true } }));
    await expect(seedDemo(options(), deps)).rejects.toThrow(/brand assets integration failed: runner_failed/);
    expect(server.calls.some((c) => c.path.endsWith('/policy'))).toBe(false);
  });

  it('an API error names the call and the error code, never the token', async () => {
    const { server, deps } = harness();
    server.route('POST', /\/adopt-head$/, () => ({ status: 409, json: { error: { code: 'branch_empty', message: 'the branch has no commits' } } }));
    const err = await seedDemo(options(), deps).then(
      () => new Error('expected the seed to fail'),
      (e: unknown) => e as Error,
    );
    expect(err.message).toMatch(/POST \/api\/orgs\/o-\w+\/resources\/res-\w+\/adopt-head → 409 branch_empty: the branch has no commits/);
    expect(err.message).not.toContain(SESSION);
  });

  it('waits while the brand assets task is provisioning, and takes the lease only once it is ready', async () => {
    const { server, deps } = harness();
    let polls = 0;
    server.route('GET', /^\/api\/tasks\/task-1$/, () => {
      const state = ++polls < 3 ? 'provisioning' : 'ready';
      return { taskId: 'task-1', state, workspaces: [{ taskWorkspaceId: 'tw-1', mountName: 'brand-assets', provider: 'r2-assets', access: 'write', state: 'writable' }] };
    });
    await seedDemo(options(), deps);
    const seq = sequence(server.calls);
    const lease = seq.indexOf('POST /api/tasks/task-1/lease');
    // three session polls (provisioning, provisioning, ready) before the lease, then the agent's own view
    expect(seq.slice(lease - 3, lease)).toEqual(['GET /api/tasks/task-1', 'GET /api/tasks/task-1', 'GET /api/tasks/task-1']);
    expect(server.calls.slice(lease - 3, lease).map((c) => c.headers.authorization)).toEqual(Array(3).fill(`Bearer ${SESSION}`));
    expect(seq[lease - 4]).toMatch(/^POST \/api\/orgs\/[^/]+\/projects\/p-000000000001\/tasks$/);
    expect(polls).toBe(4);
  });

  it('stops when the brand assets task never becomes ready', async () => {
    const { server, deps } = harness();
    server.route('GET', /^\/api\/tasks\/task-1$/, () => ({ taskId: 'task-1', state: 'provisioning', workspaces: [] }));
    await expect(seedDemo(options(), deps)).rejects.toThrow(/brand assets task: still not done after 10 min/);
    expect(server.calls.some((c) => c.path.endsWith('/lease'))).toBe(false);
  });

  it('polls a queued edition build until it settles, and refuses a failed one', async () => {
    const { server, deps } = harness();
    let n = 0;
    server.route('GET', /\/editions\/ed-1$/, () => ({ editionId: 'ed-1', builds: [{ buildId: 'build-1', state: ++n < 3 ? 'queued' : 'failed', error: 'runner down' }] }));
    await expect(seedDemo(options(), deps)).rejects.toThrow(/edition build failed: runner down/);
    expect(n).toBe(3);
  });
});

/** The rejection of a run that must fail. */
async function failure(p: Promise<unknown>): Promise<SeedFailure> {
  const e = await p.then(
    () => new Error('expected the seed to fail'),
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(SeedFailure);
  return e as SeedFailure;
}

describe('seedDemo: a failure names what it left behind', () => {
  it('after the project exists: org, project and every created resource', async () => {
    const { server, deps } = harness();
    server.route('GET', /\/editions\/ed-1$/, () => ({ editionId: 'ed-1', builds: [{ buildId: 'build-1', state: 'failed', error: 'runner down' }] }));
    const err = await failure(seedDemo(options(), deps));
    expect(err.message).toBe('edition build failed: runner down');
    const created = bodiesOf(server.calls, 'POST', /^\/api\/orgs$/);
    expect(created).toHaveLength(1);
    const p = err.partial;
    expect(p).toMatchObject({ orgCreated: true, projectId: 'p-000000000001', taskId: 'task-1', proposalId: 'prop-1', kvId: PLAN_KV_ID, clientUserId: 'u-client', editionId: 'ed-1', error: 'edition build failed: runner down' });
    expect(Object.keys(p.resourceIds)).toEqual(['website', 'api', 'requirements', 'brandAssets']);
    expect(partialLine(p)).toBe(`partial: org=${p.orgId} project=p-000000000001 resources=${Object.values(p.resourceIds).join(',')}`);
  });

  it('before the project exists: the org and the resource whose setup failed', async () => {
    const { server, deps } = harness();
    server.route('POST', /\/adopt-head$/, () => ({ status: 409, json: { error: { code: 'branch_empty', message: 'the branch has no commits' } } }));
    const err = await failure(seedDemo(options(), deps));
    expect(partialLine(err.partial)).toMatch(/^partial: org=o-0+1 project=none resources=res-0+1$/);
    expect(err.partial.resourceIds).toEqual({ website: 'res-0000000000000001' });
  });

  it('a refusal before any write: nothing created, and the --org it was given', async () => {
    const { server, deps } = harness();
    server.route('GET', /^\/api\/orgs\/o-existing0001\/projects$/, () => ({ projects: [{ projectId: 'p-old000000001', name: 'Customer Portal' }] }));
    const err = await failure(seedDemo(options({ org: { id: 'o-existing0001' } }), deps));
    expect(err.partial).toMatchObject({ orgId: 'o-existing0001', orgCreated: false, projectId: null, resourceIds: {} });
    expect(partialLine(err.partial)).toBe('partial: org=o-existing0001 project=none resources=none');
    const fresh = await failure(seedDemo(options(), (() => {
      const h = harness();
      h.server.route('GET', /^\/api\/me$/, () => ({ status: 401, json: { error: { code: 'unauthenticated', message: 'no session' } } }));
      return h.deps;
    })()));
    expect(partialLine(fresh.partial)).toBe('partial: org=none project=none resources=none');
  });

  it('reportPartial prints the line and writes the partial file; other errors write nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'seed-partial-'));
    try {
      const { server, deps } = harness();
      server.route('POST', /\/adopt-head$/, () => ({ status: 409, json: { error: { code: 'branch_empty', message: 'no commits' } } }));
      const err = await failure(seedDemo(options(), deps));
      const lines: string[] = [];
      const file = join(dir, 'seed-output.partial.json');
      reportPartial(err, file, (l) => lines.push(l));
      expect(lines).toEqual([partialLine(err.partial), `wrote ${file}`]);
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(err.partial);
      const other = join(dir, 'other.partial.json');
      reportPartial(new Error('bad args'), other, (l) => lines.push(l));
      expect(existsSync(other)).toBe(false);
      expect(lines).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('seedDemo: the brand assets lease', () => {
  it('is released when an upload fails, and the upload error is the one reported', async () => {
    const { server, deps } = harness();
    server.route('PUT', /\/assets\/upload\?key=stage-2$/, () => ({ status: 413, json: { error: { code: 'too_large', message: 'asset too large' } } }));
    const err = await failure(seedDemo(options(), deps));
    expect(err.message).toMatch(/PUT \/api\/tasks\/task-1\/assets\/upload → 413 too_large/);
    const seq = sequence(server.calls);
    expect(seq.slice(seq.indexOf('POST /api/tasks/task-1/lease'))).toEqual([
      'POST /api/tasks/task-1/lease',
      'GET /api/tasks/task-1',
      'POST /api/tasks/task-1/assets/stage',
      'PUT /api/tasks/task-1/assets/upload',
      'POST /api/tasks/task-1/assets/stage',
      'PUT /api/tasks/task-1/assets/upload',
      'DELETE /api/tasks/task-1/lease',
    ]);
    expect(server.calls.at(-1)!.headers.authorization).toBe('Bearer cfl_lease-1');
    expect(err.partial.taskId).toBe('task-1');
  });

  it('a failed release on that path is logged and does not replace the upload error', async () => {
    const { server, deps, log } = harness();
    server.route('POST', /\/assets\/commit$/, () => ({ status: 409, json: { error: { code: 'manifest_conflict', message: 'parent moved' } } }));
    server.route('DELETE', /^\/api\/tasks\/[^/]+\/lease$/, () => ({ status: 500, json: { error: { code: 'internal', message: 'boom' } } }));
    const err = await failure(seedDemo(options(), deps));
    expect(err.message).toMatch(/assets\/commit → 409 manifest_conflict/);
    expect(log.join('\n')).toMatch(/could not release the lease of task task-1: .*500 internal/);
    expect(log.join('\n')).not.toContain('cfl_lease-1');
  });
});

describe('seedDemo: write token revocation', () => {
  it('a failed push still revokes the token, and a failed revoke does not replace the push error', async () => {
    const { server, deps, log } = harness();
    deps.pushFixture = async () => {
      throw new Error('git push -q failed: remote: permission denied');
    };
    server.route('DELETE', /\/artifacts\/namespaces\/[^/]+\/tokens\/[^/]+$/, () => ({ status: 500, json: { success: false, errors: [{ code: 10000, message: 'internal' }] } }));
    const err = await failure(seedDemo(options(), deps));
    expect(err.message).toBe('git push -q failed: remote: permission denied');
    expect(sequence(server.calls).filter((c) => c.startsWith('DELETE '))).toEqual([expect.stringMatching(/\/tokens\/tok-res-0+1$/)]);
    expect(log.join('\n')).toMatch(/could not revoke the website write token .*500/);
    expect(log.join('\n')).not.toContain('tok-secret-');
    expect(server.calls.some((c) => c.path.endsWith('/adopt-head'))).toBe(false);
    expect(err.partial.resourceIds).toEqual({ website: 'res-0000000000000001' });
  });

  it('a failed revoke after a successful push warns and the seed continues (the token expires in 15 min)', async () => {
    const { server, deps, log } = harness();
    server.route('DELETE', /\/artifacts\/namespaces\/[^/]+\/tokens\/[^/]+$/, () => ({ status: 500, json: { success: false, errors: [{ code: 10000, message: 'internal' }] } }));
    const out = await seedDemo(options(), deps);
    expect(out.editionId).toBe('ed-1');
    expect(server.calls.filter((c) => c.path.endsWith('/adopt-head'))).toHaveLength(3);
    expect(log.join('\n').match(/could not revoke the \w+ write token \(it expires in 15 min\): .*500/g)).toHaveLength(3);
    expect(log.join('\n')).not.toContain('tok-secret-');
  });

  it('withWriteToken: a revoke failure after a successful use is reported, not thrown', async () => {
    const server = createPlanServer();
    server.route('DELETE', /\/tokens\/[^/]+$/, () => ({ status: 500, json: { success: false, errors: [{ code: 1, message: 'boom' }] } }));
    const revokeErrors: unknown[] = [];
    await expect(withWriteToken(server.fetch, { accountId: ACCOUNT, apiToken: CF_TOKEN }, 'ns', 'repo-1', async () => 'sha-1', (e) => revokeErrors.push(e))).resolves.toBe('sha-1');
    expect(revokeErrors).toHaveLength(1);
  });

  it('revokeToken: revoked → true, already gone (404) → false, any other failure throws', async () => {
    const account = { accountId: ACCOUNT, apiToken: CF_TOKEN };
    const at = (status: number) => (async () => new Response(JSON.stringify(status < 300 ? { success: true, result: null } : { success: false, errors: [{ code: 1, message: 'x' }] }), { status })) as unknown as typeof fetch;
    await expect(revokeToken(at(200), account, 'ns', 'tok-1')).resolves.toBe(true);
    await expect(revokeToken(at(404), account, 'ns', 'tok-1')).resolves.toBe(false);
    await expect(revokeToken(at(500), account, 'ns', 'tok-1')).rejects.toThrow(/DELETE \/namespaces\/ns\/tokens\/tok-1 → 500/);
  });

  it('withWriteToken: an expired token (revoke 404) after a failed push keeps the push error and reports nothing', async () => {
    const server = createPlanServer();
    server.route('DELETE', /\/tokens\/[^/]+$/, () => ({ status: 404, json: { success: false, errors: [{ code: 404, message: 'not found' }] } }));
    const revokeErrors: unknown[] = [];
    await expect(
      withWriteToken(server.fetch, { accountId: ACCOUNT, apiToken: CF_TOKEN }, 'ns', 'repo-1', async () => {
        throw new Error('push failed');
      }, (e) => revokeErrors.push(e)),
    ).rejects.toThrow('push failed');
    expect(revokeErrors).toEqual([]);
    expect(sequence(server.calls).map((c) => c.split(' ')[0])).toEqual(['POST', 'DELETE']);
  });
});

describe('seedDemo: integration attempt that expired in the queue', () => {
  it('stops at once with a clear error instead of polling for 15 minutes', async () => {
    const { server, deps } = harness();
    let polls = 0;
    server.route('GET', /\/proposals\/prop-1$/, () => {
      polls++;
      return { proposalId: 'prop-1', proposalHash: 'hash-1', state: 'prepared', lastAttempt: { state: 'queued', expired: true, forCurrentHash: true } };
    });
    const err = await failure(seedDemo(options(), deps));
    expect(err.message).toMatch(/brand assets integration expired while queued/);
    expect(polls).toBe(1);
    expect(server.calls.some((c) => c.path.endsWith('/approvals'))).toBe(false);
  });
});

describe('planSeed (--plan)', () => {
  it('sends nothing and never prints the Cloudflare account id', async () => {
    const lines: string[] = [];
    const cli = parseCli(['--plan', '--client-email', 'c@x.io'], { CF_ACCOUNT_ID: ACCOUNT, CF_API_TOKEN: CF_TOKEN });
    const out = await planSeed(cli, (l) => lines.push(l), { out: '/tmp/seed-output.json', video: '/tmp/brand-video.mp4' });
    const text = lines.join('\n');
    expect(text).not.toContain(ACCOUNT);
    expect(text).not.toContain(CF_TOKEN);
    expect(text).toContain('/accounts/<CF_ACCOUNT_ID>/artifacts/');
    expect(out.projectId).toBe('p-000000000001');
  });
});

describe('pushFixture (real git, temp dirs)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();

  it('pushes the committed fixture tree (never untracked or ignored files) as one fresh commit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'seed-src-'));
    const bare = mkdtempSync(join(tmpdir(), 'seed-remote-'));
    dirs.push(root, bare);
    git(root, 'init', '-q', '-b', 'main');
    mkdirSync(join(root, 'fixtures/website/src'), { recursive: true });
    writeFileSync(join(root, 'fixtures/website/index.html'), '<h1>quote</h1>\n');
    writeFileSync(join(root, 'fixtures/website/src/main.ts'), 'export {};\n');
    writeFileSync(join(root, 'other.txt'), 'not part of the fixture\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'fixtures');
    writeFileSync(join(root, 'fixtures/website/untracked.txt'), 'local only\n');
    git(bare, 'init', '-q', '--bare', '-b', 'main');

    const sha = await pushFixture({ repoRoot: root, ref: 'HEAD', fixturePath: 'fixtures/website', remoteUrl: bare, token: 'tok-secret', branch: 'main' });

    expect(git(bare, 'rev-parse', 'refs/heads/main')).toBe(sha);
    expect(git(bare, 'ls-tree', '-r', '--name-only', 'main').split('\n')).toEqual(['index.html', 'src/main.ts']);
    expect(git(bare, 'rev-list', '--count', 'main')).toBe('1');
  });

  it('fails with git stderr when the fixture path does not exist at the ref', async () => {
    const root = mkdtempSync(join(tmpdir(), 'seed-src-'));
    dirs.push(root);
    git(root, 'init', '-q', '-b', 'main');
    writeFileSync(join(root, 'a.txt'), 'a\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'a');
    await expect(pushFixture({ repoRoot: root, ref: 'HEAD', fixturePath: 'fixtures/nope', remoteUrl: root, token: 'tok-secret', branch: 'main' })).rejects.toThrow(/archive.*fixtures\/nope/s);
  });
});

describe('seedDemo --staging (P42-3)', () => {
  const CLIENT = 'cfs_client-session-secret';

  it('creates the production D1, sends the staging policy, skips the edition and publishes the baseline', async () => {
    const { server, deps } = harness();
    const out = await seedDemo(options({ staging: true }), deps);
    const o = out.orgId;
    const p = out.projectId;
    // the client may change the three git folders through tasks (Can change); the brand assets stay read
    expect(bodiesOf(server.calls, 'PUT', /\/grants$/)).toEqual([
      { userId: out.clientUserId, scope: { kind: 'project', id: p }, operations: ['read', 'write'] },
      ...(['website', 'api', 'requirements'] as const).map((k) => ({ userId: out.clientUserId, scope: { kind: 'resource', id: out.resourceIds[k] }, operations: ['read', 'write'] })),
      { userId: out.clientUserId, scope: { kind: 'resource', id: out.resourceIds.brandAssets }, operations: ['read'] },
    ]);
    const seq = sequence(server.calls);
    const tail = seq.slice(seq.indexOf(`GET /api/orgs/${o}/deploy-resources`));
    expect(tail).toEqual([
      `GET /api/orgs/${o}/deploy-resources`,
      `POST /api/orgs/${o}/deploy-resources`,
      `POST /api/orgs/${o}/deploy-resources`,
      `PUT /api/orgs/${o}/projects/${p}/policy`,
      `GET /api/orgs/${o}/members`,
      `POST /api/orgs/${o}/members`,
      ...Array(5).fill(`PUT /api/orgs/${o}/grants`),
      // the baseline: an owner publish of main; staging starts after it
      `POST /api/orgs/${o}/projects/${p}/releases`,
      `GET /api/orgs/${o}/releases/rel-1`,
      `POST /api/orgs/${o}/releases/rel-1/publish-approvals`,
      `POST /api/orgs/${o}/releases/rel-1/deploy`,
      `GET /api/orgs/${o}/releases/rel-1`,
      `GET /api/orgs/${o}/projects/${p}/staging`,
      `GET /api/orgs/${o}/projects/${p}/staging`,
    ]);
    expect(seq.some((x) => x.includes('/editions'))).toBe(false);
    expect(bodiesOf(server.calls, 'POST', /\/deploy-resources$/)).toEqual([{ kind: 'kv', name: 'orders' }, { kind: 'd1', name: 'contacts' }]);
    expect(bodiesOf(server.calls, 'POST', /\/publish-approvals$/)).toEqual([{ outputDigest: 'digest-1' }]);
    expect(bodiesOf(server.calls, 'POST', /\/deploy$/)).toEqual([{ idempotencyKey: `seed-baseline-${p}` }]);
    expect(out.editionId).toBeNull();
    expect(out.staging).toEqual({ url: 'https://cfapp-staging.example.workers.dev', productionD1Id: PLAN_D1_ID, baselineReleaseId: 'rel-1', tasks: [] });

    const policy = bodiesOf(server.calls, 'PUT', /\/policy$/)[0] as any;
    expect(Object.keys(policy).sort()).toEqual(['checks', 'contracts', 'preview', 'release', 'rules', 'staging']);
    expect(policy.release.environment.api.d1Databases).toEqual([{ binding: 'DB', id: PLAN_D1_ID }]);
    expect(policy.release.migrations).toEqual([{ targetId: 'api', binding: 'DB', dir: 'migrations' }]);
    expect(policy.staging.promotion).toEqual(STAGING_PROMOTION);
    expect(policy.staging.promotion.classifier).toEqual({ provider: 'jev', threshold: 0.9 });
    expect(policy.staging.captureVars).toEqual(['PAYMENT_WEBHOOK_URL', 'EMAIL_WEBHOOK_URL']);
    expect(policy.staging.environment.api.d1).toEqual([{ binding: 'DB', migrationsDir: 'migrations', seed: ['seed/contacts.sql'] }]);
    // staging's website calls the staging api Worker; production's the production one
    const site = (r: any) => r.steps.find((x: any) => x.stepId === 'site-build').env.VITE_QUOTE_API_URL;
    expect(site(policy.staging.recipe)).toBe(`https://cfapp-${o}-api-staging.demo-sub.workers.dev`);
    expect(site(policy.release.recipe)).toBe(`https://cfapp-${o}-api.demo-sub.workers.dev`);
  });

  it('names release Workers with the prefix the deployment reports (cfci- on CI)', async () => {
    const { server, deps } = harness();
    server.route('GET', /^\/api\/orgs\/([^/]+)\/deploy-resources$/, (m) => ({ workerPrefix: `cfci-${m[1]}-`, resources: [] }));
    const out = await seedDemo(options({ staging: true }), deps);
    const policy = bodiesOf(server.calls, 'PUT', /\/policy$/)[0] as any;
    expect(policy.release.targets.map((t: any) => t.workerName)).toEqual([`cfci-${out.orgId}-api`, `cfci-${out.orgId}-website`]);
  });

  it('a failed baseline build stops the run and names the release', async () => {
    const { server, deps } = harness();
    server.route('GET', /^\/api\/orgs\/[^/]+\/releases\/([^/]+)$/, (m) => ({ releaseId: m[1], state: 'failed', buildState: 'failed', error: { code: 'scope_violation' } }));
    const e = await seedDemo(options({ staging: true }), deps).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(SeedFailure);
    expect((e as SeedFailure).message).toMatch(/baseline release build failed: .*scope_violation/);
    expect((e as SeedFailure).partial).toMatchObject({ baselineReleaseId: 'rel-1', d1Id: PLAN_D1_ID });
  });

  it('a baseline deploy that fails is deployed once more; a second failure stops', async () => {
    const run = async (failures: number) => {
      const h = harness();
      let deploys = 0;
      h.server.route('POST', /^\/api\/orgs\/[^/]+\/releases\/([^/]+)\/deploy$/, (m) => {
        deploys++;
        return { status: 202, json: { releaseId: m[1] } };
      });
      h.server.route('GET', /^\/api\/orgs\/[^/]+\/releases\/([^/]+)$/, (m) => ({ releaseId: m[1], buildState: 'built', outputDigest: 'digest-1', state: deploys === 0 ? 'publish_approved' : deploys <= failures ? 'recovery_required' : 'live', error: deploys <= failures ? { code: 'deploy_unverified' } : null }));
      const out = await seedDemo(options({ staging: true }), h.deps).catch((e: unknown) => e);
      return { out, keys: bodiesOf(h.server.calls, 'POST', /\/deploy$/), log: h.log };
    };
    const once = await run(1);
    expect((once.out as any).staging.baselineReleaseId).toBe('rel-1');
    expect(once.keys).toEqual([{ idempotencyKey: 'seed-baseline-p-000000000001' }, { idempotencyKey: 'seed-baseline-p-000000000001-2' }]);
    expect(once.log.some((l) => /baseline release recovery_required: .*deploying it once more/.test(l))).toBe(true);
    const twice = await run(2);
    expect((twice.out as SeedFailure).message).toMatch(/^baseline release recovery_required/);
    expect(twice.keys).toHaveLength(2);
  });

  it('--stage-tasks: the client creates each demo task, its agent submits it, and each lands before the next', async () => {
    const { server, deps } = harness();
    const agent: string[] = [];
    deps.agentTask = async ({ task, taskId, leaseToken }) => {
      agent.push(`${task.key} ${taskId} ${leaseToken}`);
    };
    const out = await seedDemo(options({ staging: true, stageTasks: { clientToken: CLIENT } }), deps);
    expect(agent).toEqual(['copy task-2 cfl_lease-1', 'phone task-3 cfl_lease-1', 'rename task-4 cfl_lease-1']);
    expect(out.staging?.tasks).toEqual([
      { key: 'copy', taskId: 'task-2', landingId: 'land-1' },
      { key: 'phone', taskId: 'task-3', landingId: 'land-2' },
      { key: 'rename', taskId: 'task-4', landingId: 'land-3' },
    ]);
    const tasks = server.calls.filter((c) => c.method === 'POST' && /\/tasks$/.test(c.path)).slice(1);
    expect(tasks.map((c) => c.body)).toEqual(DEMO_TASKS.map((t) => ({ title: t.title, request: t.request, writeMounts: t.mounts, readMounts: [] })));
    // the client's own session creates the tasks and takes the leases; the owner never does
    expect(tasks.every((c) => c.headers.authorization === `Bearer ${CLIENT}`)).toBe(true);
    const leases = server.calls.filter((c) => c.method === 'POST' && /\/lease$/.test(c.path)).slice(1);
    expect(leases.map((c) => [c.path, c.headers.authorization])).toEqual(['task-2', 'task-3', 'task-4'].map((t) => [`/api/tasks/${t}/lease`, `Bearer ${CLIENT}`]));
  });

  it('--stage-tasks: refuses a client session that is not the client member, and stops on a failed landing', async () => {
    const wrong = harness();
    wrong.deps.agentTask = async () => {};
    wrong.server.route('GET', /^\/api\/me$/, (_m, _b, c) => ({ user: { userId: 'u-x', email: c.headers.authorization === `Bearer ${CLIENT}` ? 'someone@example.com' : 'owner@example.com' } }));
    await expect(seedDemo(options({ staging: true, stageTasks: { clientToken: CLIENT } }), wrong.deps)).rejects.toThrow(/client session is someone@example.com, not the client member owner\+client@example.com/);

    const failed = harness();
    failed.deps.agentTask = async () => {};
    failed.server.route('GET', /^\/api\/orgs\/[^/]+\/projects\/[^/]+\/staging$/, () => ({ state: 'active', building: false, landings: [{ landingId: 'land-1', taskId: 'task-2', state: 'failed', reasonCode: 'staging_deploy_failed', reason: 'the staging deploy failed' }] }));
    const e = await seedDemo(options({ staging: true, stageTasks: { clientToken: CLIENT } }), failed.deps).catch((x: unknown) => x);
    expect((e as SeedFailure).message).toMatch(/copy: landing land-1 failed: staging_deploy_failed the staging deploy failed/);
    expect((e as SeedFailure).partial.stagedTasks).toEqual([{ key: 'copy', taskId: 'task-2' }]);
  });

  it('--stage-tasks: a landing whose staging deploy failed gets one fresh task; a second failure stops', async () => {
    const run = async (failing: string[]) => {
      const h = harness();
      h.deps.agentTask = async () => {};
      const tasks: string[] = [];
      h.server.route('POST', /^\/api\/orgs\/[^/]+\/projects\/[^/]+\/tasks$/, () => {
        const id = `task-${tasks.length + 1}`;
        tasks.push(id);
        return { status: 201, json: { taskId: id, state: 'ready', workspaces: [] } };
      });
      h.server.route('GET', /^\/api\/orgs\/[^/]+\/projects\/[^/]+\/staging$/, () => ({
        state: 'active',
        building: false,
        landings: tasks.slice(1).map((taskId) => {
          const fail = failing.includes(taskId);
          return { landingId: `land-${taskId}`, taskId, state: fail ? 'failed' : 'landed', reasonCode: fail ? 'deploy_changed_production' : null, reason: fail ? 'The staging deploy failed. The previous staging is still live.' : null };
        }),
      }));
      const out = await seedDemo(options({ staging: true, stageTasks: { clientToken: CLIENT } }), h.deps).catch((e: unknown) => e);
      return { log: h.log, out };
    };
    const once = await run(['task-2']);
    expect((once.out as any).staging.tasks.map((t: any) => t.taskId)).toEqual(['task-3', 'task-4', 'task-5']);
    expect(once.log.some((l) => /^copy: landing land-task-2 failed: deploy_changed_production .*trying once more with a new task$/.test(l))).toBe(true);
    const twice = await run(['task-2', 'task-3']);
    expect((twice.out as SeedFailure).message).toMatch(/^copy: landing land-task-3 failed: deploy_changed_production/);
    expect((twice.out as SeedFailure).partial.stagedTasks).toEqual([{ key: 'copy', taskId: 'task-2' }, { key: 'copy', taskId: 'task-3' }]);
    // a conflict is not transient: no second task
    const h = harness();
    h.deps.agentTask = async () => {};
    h.server.route('GET', /^\/api\/orgs\/[^/]+\/projects\/[^/]+\/staging$/, () => ({ state: 'active', building: false, landings: [{ landingId: 'land-1', taskId: 'task-2', state: 'failed', reasonCode: 'staging_conflict', reason: 'Conflicts with staging in website/index.html. Start a new task from the current staging.' }] }));
    const e = await seedDemo(options({ staging: true, stageTasks: { clientToken: CLIENT } }), h.deps).catch((x: unknown) => x);
    expect((e as SeedFailure).partial.stagedTasks).toHaveLength(1);
  });

  it('--plan --staging --stage-tasks prints the sequence with the client agent and no secret', async () => {
    const lines: string[] = [];
    const cli = parseCli(['--plan', '--staging', '--stage-tasks', '--client-email', 'c@x.io'], {});
    const out = await planSeed(cli, (l) => lines.push(l), { out: 'seed-output.json', video: 'v.mp4' });
    const text = lines.join('\n');
    expect(text).toContain('{"kind":"d1","name":"contacts"}');
    expect(text).toMatch(/client agent \(lease\): cforge checkout task-4 → rename edit/);
    expect(text).not.toContain('cfs_plan');
    expect(out.staging?.tasks.map((t) => t.key)).toEqual(['copy', 'phone', 'rename']);
  });
});

describe('applyDemoTask (real git, the committed fixtures)', () => {
  const repoRoot = join(__dirname, '..', '..');
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const ws = () => {
    const d = mkdtempSync(join(tmpdir(), 'seed-task-'));
    dirs.push(d);
    for (const m of ['website', 'api']) execFileSync('cp', ['-r', join(repoRoot, 'fixtures', m), join(d, m)]);
    rmSync(join(d, 'api', 'node_modules'), { recursive: true, force: true });
    return d;
  };

  it('copy edits the heading; phone then rename apply in order with their migrations', () => {
    const d = ws();
    applyDemoTask('copy', d, repoRoot);
    const html = readFileSync(join(d, 'website', 'index.html'), 'utf8');
    expect(html).toContain(COPY_TO);
    expect(html).not.toContain(COPY_FROM);
    applyDemoTask('phone', d, repoRoot);
    expect(existsSync(join(d, 'api', 'migrations', '0002_phone.sql'))).toBe(true);
    applyDemoTask('rename', d, repoRoot);
    expect(readFileSync(join(d, 'api', 'migrations', '0003_rename_email.sql'), 'utf8')).toMatch(/RENAME COLUMN/i);
    expect(() => applyDemoTask('copy', d, repoRoot)).toThrow(/heading is not in website\/index.html/);
  });
});

describe('parseCli', () => {
  const env = { CAPTURE_OWNER_SESSION_FILE: '/s.json', CF_API_TOKEN: 't', CF_ACCOUNT_ID: ACCOUNT };

  it('defaults to a new "Demo Client" org and the "Customer Portal" project', () => {
    const cli = parseCli(['--client-email', 'a+client@example.com'], env);
    expect(cli).toMatchObject({ org: { newName: 'Demo Client' }, projectName: 'Customer Portal', clientEmail: 'a+client@example.com', replace: false, plan: false });
  });

  it('takes --org, --project-name, --replace and --plan', () => {
    expect(parseCli(['--org', 'o-0123456789ab', '--project-name', 'Portal 2', '--replace', '--plan', '--client-email', 'c@x.io'], {})).toMatchObject({
      org: { id: 'o-0123456789ab' },
      projectName: 'Portal 2',
      replace: true,
      plan: true,
    });
  });

  it('refuses --org with --new-org, a missing client address, and missing credentials outside --plan', () => {
    expect(() => parseCli(['--org', 'o-0123456789ab', '--new-org', 'X', '--client-email', 'c@x.io'], env)).toThrow(/either --org <id> or --new-org <name>/);
    expect(() => parseCli([], env)).toThrow(/--client-email/);
    expect(() => parseCli(['--client-email', 'c@x.io'], {})).toThrow(/CAPTURE_OWNER_SESSION_FILE.*CF_API_TOKEN.*CF_ACCOUNT_ID/s);
  });

  it('takes --staging and --stage-tasks; --stage-tasks needs --staging and the client session file', () => {
    expect(parseCli(['--staging', '--client-email', 'c@x.io'], env)).toMatchObject({ staging: true, stageTasks: false });
    expect(parseCli(['--client-email', 'c@x.io'], env)).toMatchObject({ staging: false, stageTasks: false });
    expect(() => parseCli(['--stage-tasks', '--client-email', 'c@x.io'], env)).toThrow(/--stage-tasks needs --staging/);
    expect(() => parseCli(['--staging', '--stage-tasks', '--client-email', 'c@x.io'], env)).toThrow(/missing CAPTURE_CLIENT_SESSION_FILE/);
    expect(parseCli(['--staging', '--stage-tasks', '--client-email', 'c@x.io'], { ...env, CAPTURE_CLIENT_SESSION_FILE: '/c.json' })).toMatchObject({ stageTasks: true, clientSessionFile: '/c.json' });
  });
});
