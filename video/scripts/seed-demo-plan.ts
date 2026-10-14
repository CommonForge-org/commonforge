/**
 * A scripted stand-in for the CommonForge Worker and the Cloudflare Artifacts REST API. It answers
 * every call the seeder makes with deterministic ids and records each request (method, path,
 * headers, parsed body). `--plan` runs the real seeding sequence against it and prints the calls,
 * so nothing is sent anywhere; the unit tests use it as their fake `fetch` and override routes.
 *
 * Caution: this one hand-written fake is both the test double and the `--plan` stand-in, so the two
 * agree with each other by construction and neither can catch drift from the real Worker or
 * Cloudflare API. Its replies follow apps/worker/API.md and the Worker's schemas (ids keep the real
 * formats where the seeder passes them on, such as the 32-hex KV namespace id that
 * `KvBindingSchema` in packages/runner-protocol/src/jobs.ts requires), but only a live seed
 * proves the sequence. Update it together with the API.
 */

/** The `orders` KV namespace id the fake creates: 32 lower-case hex, as `KvBindingSchema` requires. */
export const PLAN_KV_ID = '0f0e0d0c0b0a09080706050403020100';

export interface RecordedCall {
  method: string;
  url: string;
  /** pathname + search */
  path: string;
  /** lower-cased header names */
  headers: Record<string, string>;
  /** parsed JSON, `{ bytes: n }` for a binary body, undefined for none */
  body: unknown;
}

export interface Reply {
  status: number;
  json: unknown;
}

type Handler = (m: RegExpMatchArray, body: unknown, call: RecordedCall) => unknown;

export interface PlanServer {
  fetch: typeof fetch;
  calls: RecordedCall[];
  /** Answer `method` + path pattern with `handler` (checked before the defaults). A `{status, json}` result sets the status. */
  route(method: string, pattern: RegExp, handler: Handler): void;
}

const isReply = (v: unknown): v is Reply => typeof v === 'object' && v !== null && 'status' in v && 'json' in v && typeof (v as Reply).status === 'number';

/** The production D1 id the fake creates (`--staging`). */
export const PLAN_D1_ID = '00000000-0000-4000-8000-0000000000d1';

/**
 * `clientEmail`: the address `GET /api/me` answers for a client session (a bearer `cfs_…client…`,
 * `--stage-tasks`); every other session is the owner.
 */
export function createPlanServer(o: { onCall?: (call: RecordedCall) => void; clientEmail?: string } = {}): PlanServer {
  const calls: RecordedCall[] = [];
  const overrides: Array<[string, RegExp, Handler]> = [];
  let resources = 0;
  let stages = 0;
  let orgs = 0;
  let tasks = 0;
  /** tasks created after the first (the brand assets task): `--stage-tasks` demo tasks, landed at once */
  const landed: string[] = [];

  const task = (id: string) => ({ taskId: id, state: 'ready', workspaces: [{ taskWorkspaceId: 'tw-1', mountName: 'brand-assets', provider: 'r2-assets', access: 'write', state: 'writable' }] });
  const defaults: Array<[string, RegExp, Handler]> = [
    ['GET', /^\/api\/me$/, (_m, _b, c) => (/^Bearer cfs_\S*client/.test(c.headers.authorization ?? '') ? { user: { userId: 'u-client', email: o.clientEmail ?? 'client@example.com' }, memberships: [] } : { user: { userId: 'u-owner', email: 'owner@example.com' }, memberships: [] })],
    ['GET', /^\/api\/orgs$/, () => ({ orgs: [] })],
    ['POST', /^\/api\/orgs$/, (_m, b) => ({ status: 201, json: { orgId: `o-${(++orgs).toString(16).padStart(12, '0')}`, name: (b as { name: string }).name, role: 'owner' } })],
    ['GET', /^\/api\/orgs\/[^/]+\/projects$/, () => ({ projects: [] })],
    ['POST', /^\/api\/orgs\/([^/]+)\/resources$/, (m, b) => {
      const { name, provider } = b as { name: string; provider: string };
      const resourceId = `res-${(++resources).toString(16).padStart(16, '0')}`;
      const ns = `cf-${m[1]}-canonical`;
      const coords = provider === 'artifacts' ? { kind: 'artifacts', namespace: ns, repoName: resourceId, repoId: `repo-${resourceId}`, remoteUrl: `https://acct.artifacts.example/git/${ns}/${resourceId}.git` } : { kind: 'r2-assets' };
      return { status: 201, json: { resourceId, name, provider, state: provider === 'artifacts' ? 'empty' : 'active', branch: 'main', coords } };
    }],
    ['POST', /\/artifacts\/namespaces\/[^/]+\/tokens$/, (_m, b) => ({ success: true, result: { id: `tok-${(b as { repo: string }).repo}`, plaintext: `tok-secret-${(b as { repo: string }).repo}`, scope: 'write', expires_at: '2099-01-01T00:00:00.000Z' } })],
    ['DELETE', /\/artifacts\/namespaces\/[^/]+\/tokens\/[^/]+$/, () => ({ success: true, result: null })],
    ['POST', /^\/api\/orgs\/[^/]+\/resources\/([^/]+)\/adopt-head$/, (m) => ({ resourceId: m[1], revisionId: `art:repo-${m[1]}:sha` })],
    ['POST', /^\/api\/orgs\/[^/]+\/projects$/, (_m, b) => ({ status: 201, json: { projectId: 'p-000000000001', name: (b as { name: string }).name } })],
    ['GET', /^\/api\/orgs\/[^/]+\/projects\/([^/]+)$/, (m) => ({ projectId: m[1], name: 'Customer Portal', mounts: [], policy: {} })],
    ['POST', /^\/api\/orgs\/[^/]+\/projects\/[^/]+\/mounts$/, (_m, b) => ({ status: 201, json: b })],
    ['POST', /^\/api\/orgs\/[^/]+\/projects\/[^/]+\/tasks$/, () => {
      const id = `task-${++tasks}`;
      if (tasks > 1) landed.push(id);
      return { status: 201, json: task(id) };
    }],
    ['GET', /^\/api\/tasks\/([^/]+)$/, (m) => task(m[1] ?? 'task-1')],
    ['POST', /^\/api\/tasks\/([^/]+)\/lease$/, (m) => ({ taskId: m[1], leaseToken: 'cfl_lease-1', leaseGeneration: 1, expiresAt: '2099-01-01T00:00:00.000Z' })],
    ['POST', /^\/api\/tasks\/([^/]+)\/assets\/stage$/, (m) => {
      const key = `stage-${++stages}`;
      return { stagingKey: key, uploadUrl: `/api/tasks/${m[1]}/assets/upload?key=${key}` };
    }],
    ['PUT', /^\/api\/tasks\/[^/]+\/assets\/upload\?key=(.+)$/, (m, b) => ({ status: 201, json: { stagingKey: m[1], size: (b as { bytes: number }).bytes } })],
    ['POST', /^\/api\/tasks\/[^/]+\/assets\/commit$/, () => ({ taskWorkspaceId: 'tw-1', manifestId: 'm-2', parentManifestId: 'm-1', entries: 2 })],
    ['POST', /^\/api\/tasks\/[^/]+\/workspaces\/([^/]+)\/freeze$/, (m) => ({ taskWorkspaceId: m[1], state: 'frozen', manifestId: 'm-2' })],
    ['DELETE', /^\/api\/tasks\/[^/]+\/lease$/, () => ({ ok: true })],
    ['POST', /^\/api\/orgs\/[^/]+\/proposals$/, () => ({ status: 201, json: { proposalId: 'prop-1', proposalHash: 'hash-1', state: 'prepared' } })],
    ['POST', /^\/api\/orgs\/[^/]+\/proposals\/([^/]+)\/integrate$/, (m) => ({ status: 202, json: { proposalId: m[1], jobId: 'job-1', state: 'queued' } })],
    ['GET', /^\/api\/orgs\/[^/]+\/proposals\/([^/]+)$/, (m) => ({ proposalId: m[1], proposalHash: 'hash-1', state: 'prepared', lastAttempt: { state: 'succeeded', forCurrentHash: true } })],
    ['POST', /^\/api\/orgs\/[^/]+\/proposals\/[^/]+\/approvals$/, () => ({ status: 201, json: { approvalId: 'appr-1' } })],
    ['POST', /^\/api\/orgs\/[^/]+\/proposals\/([^/]+)\/accept$/, (m) => ({ proposalId: m[1], acceptedVersionId: 'av-1', replayed: false })],
    ['GET', /^\/api\/orgs\/([^/]+)\/deploy-resources$/, (m) => ({ workerPrefix: `cfapp-${m[1]}-`, resources: [] })],
    ['POST', /^\/api\/orgs\/[^/]+\/deploy-resources$/, (_m, b) => {
      const { kind, name } = b as { kind: string; name: string };
      return { status: 201, json: { kind, name, id: kind === 'd1' ? PLAN_D1_ID : PLAN_KV_ID, title: kind, created: true } };
    }],
    ['POST', /^\/api\/orgs\/[^/]+\/projects\/[^/]+\/releases$/, () => ({ status: 202, json: { releaseId: 'rel-1', state: 'preparing', buildState: 'building', created: true } })],
    ['GET', /^\/api\/orgs\/[^/]+\/releases\/([^/]+)$/, (m) => ({ releaseId: m[1], state: 'live', buildState: 'built', outputDigest: 'digest-1' })],
    ['POST', /^\/api\/orgs\/[^/]+\/releases\/([^/]+)\/publish-approvals$/, (m, b) => ({ status: 201, json: { approvalId: 'pa-1', releaseId: m[1], ...(b as object) } })],
    ['POST', /^\/api\/orgs\/[^/]+\/releases\/([^/]+)\/deploy$/, (m) => ({ status: 202, json: { releaseId: m[1], jobId: 'job-deploy-1', attempt: 1, replayed: false } })],
    ['GET', /^\/api\/orgs\/[^/]+\/projects\/[^/]+\/staging$/, () => ({
      enabled: true,
      state: 'active',
      url: 'https://cfapp-staging.example.workers.dev',
      building: false,
      landings: landed.map((taskId, i) => ({ landingId: `land-${i + 1}`, taskId, state: 'landed', reasonCode: null, reason: null })).reverse(),
    })],
    ['PUT', /^\/api\/orgs\/[^/]+\/projects\/([^/]+)\/policy$/, (m, b) => ({ projectId: m[1], policyRevision: 1, policy: b })],
    ['GET', /^\/api\/orgs\/[^/]+\/members$/, () => ({ members: [{ userId: 'u-owner', email: 'owner@example.com', role: 'owner' }] })],
    ['POST', /^\/api\/orgs\/[^/]+\/members$/, (_m, b) => ({ status: 201, json: { userId: 'u-client', ...(b as object) } })],
    ['PUT', /^\/api\/orgs\/[^/]+\/grants$/, (_m, b) => b],
    ['POST', /^\/api\/orgs\/[^/]+\/projects\/[^/]+\/editions$/, (_m, b) => ({ status: 201, json: { editionId: 'ed-1', name: (b as { name: string }).name, state: 'draft' } })],
    ['POST', /^\/api\/orgs\/[^/]+\/editions\/([^/]+)\/builds$/, (m) => ({ status: 202, json: { editionId: m[1], buildId: 'build-1', state: 'queued', sourceReleaseId: null } })],
    ['GET', /^\/api\/orgs\/[^/]+\/editions\/([^/]+)$/, (m) => ({ editionId: m[1], state: 'ready', builds: [{ buildId: 'build-1', state: 'ready' }] })],
    ['PUT', /^\/api\/orgs\/[^/]+\/editions\/[^/]+\/grants$/, (_m, b) => b],
  ];

  const fake = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    let body: unknown;
    if (init.body instanceof Uint8Array) body = { bytes: init.body.byteLength };
    else if (typeof init.body === 'string') body = headers['content-type'] === 'application/json' ? JSON.parse(init.body) : init.body;
    const path = url.pathname + url.search;
    const call: RecordedCall = { method, url: url.href, path, headers, body };
    calls.push(call);
    o.onCall?.(call);
    // Cloudflare REST calls are matched on the pathname, Worker calls on pathname + search
    for (const [m, re, handler] of [...overrides, ...defaults]) {
      if (m !== method) continue;
      const hit = path.match(re) ?? url.pathname.match(re);
      if (!hit) continue;
      const out = handler(hit, body, call);
      const reply = isReply(out) ? out : { status: 200, json: out };
      return new Response(JSON.stringify(reply.json), { status: reply.status, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ error: { code: 'not_found', message: `plan server has no route for ${method} ${url.pathname}` } }), { status: 404 });
  };
  return {
    fetch: fake as typeof fetch,
    calls,
    route: (method, pattern, handler) => overrides.push([method, pattern, handler]),
  };
}
