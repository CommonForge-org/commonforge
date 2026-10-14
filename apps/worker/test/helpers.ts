/**
 * Route-level test harness: the real Worker app on miniflare (D1, Durable Objects, R2 and queues
 * local) with in-memory doubles injected for Artifacts (remote-only), email and the queue producers.
 */
import { createExecutionContext, createMessageBatch, getQueueResult, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect } from "vitest";
import { createWorker } from "../src/app.js";
import { createServices, type Services } from "../src/context.js";
import { defaultDeps, type Deps } from "../src/deps.js";
import { DeployApiError } from "../src/services/deploy-api.js";
import { CapturingEmailTransport } from "../src/services/email.js";
import { FakeArtifacts, FakeImporter } from "./fakes/artifacts.js";
import { FakeClassifier } from "./fakes/classifier.js";
import { FakeRunner } from "./fakes/runner.js";

export interface ApiResult<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

export interface Harness {
  deps: Deps;
  artifacts: FakeArtifacts;
  importer: FakeImporter;
  email: CapturingEmailTransport;
  /** the risk classifier every provider resolves to (scriptable; records each state it was asked about) */
  classifier: FakeClassifier;
  steps: unknown[];
  runnerJobs: unknown[];
  /** reconcile requests the Worker sent to the outbox queue (wakeups, GC backstop) */
  outbox: unknown[];
  /** the Worker under test (fetch, queue, scheduled) built with `deps` */
  worker: ReturnType<typeof createWorker>;
  /** called synchronously for every runner job enqueued (a fake runner hooks in here) */
  onRunnerJob: ((job: any) => void) | null;
  api<T = any>(method: string, path: string, opts?: { token?: string; body?: unknown; raw?: BodyInit; headers?: Record<string, string> }): Promise<ApiResult<T>>;
  /** Deliver every captured step message to the Worker's queue handler; repeats until empty. */
  drainSteps(maxRounds?: number): Promise<{ acked: number; retried: number }>;
  /** Deliver one batch to the Worker's queue handler; returns which bodies were acked / retried. */
  deliver(queue: string, bodies: unknown[], attempts?: number): Promise<{ acked: unknown[]; retried: Array<{ body: unknown; delaySeconds?: number }> }>;
  signIn(email: string): Promise<string>;
  /** the deploy account as the control plane sees it through the Cloudflare API (Task 22 review) */
  cf: { kv: Map<string, string>; active: Map<string, string[]>; subdomain: string; deleted: string[]; failActive?: boolean };
  /** vars layered over the test env for every request/queue delivery (e.g. `COMMONFORGE_CHAOS`) */
  envOverrides: Record<string, string>;
  /** the env the Worker under test sees */
  env(): Cloudflare.Env;
  /** the same service bundle the app builds per request (for service-level tests) */
  services(): Services;
  /** what the deploy-API fake was asked to do (staging D1/KV through the deploy API) */
  deployApi: {
    created: Array<{ kind: "d1" | "kv"; name: string; id: string }>;
    queries: Array<{ id: string; sql: string }>;
    kvPuts: Array<{ id: string; entries: Array<{ key: string; value: string }> }>;
    deleted: Array<{ kind: "d1" | "kv"; id: string }>;
    /** while set, `d1Query` throws `DeployApiError(status, message)` (a failing migration), only for SQL containing `match` when given */
    failQuery?: { status: number; message: string; match?: string };
  };
}

export function harness(overrides: Partial<Deps> = {}): Harness {
  const artifacts = new FakeArtifacts();
  const importer = new FakeImporter(artifacts);
  const email = new CapturingEmailTransport();
  const classifier = new FakeClassifier();
  const steps: unknown[] = [];
  const runnerJobs: unknown[] = [];
  const outbox: unknown[] = [];
  const cf: Harness["cf"] = { kv: new Map<string, string>(), active: new Map<string, string[]>(), subdomain: "demo", deleted: [] };
  const deployApi: Harness["deployApi"] = { created: [], queries: [], kvPuts: [], deleted: [] };
  const h: Harness = {
    cf,
    deployApi,
    services: () => createServices(h.env(), h.deps),
    deps: undefined as unknown as Deps,
    artifacts,
    importer,
    email,
    classifier,
    steps,
    runnerJobs,
    outbox,
    worker: undefined as unknown as ReturnType<typeof createWorker>,
    onRunnerJob: null,
    envOverrides: {},
    env() {
      return Object.keys(h.envOverrides).length ? ({ ...env, ...h.envOverrides } as Cloudflare.Env) : env;
    },
    async api(method, path, opts = {}) {
      const headers: Record<string, string> = { ...(opts.headers ?? {}) };
      if (opts.token) headers.authorization = `Bearer ${opts.token}`;
      // a distinct client IP per call unless the test sets one (per-IP magic-link limit)
      if (!Object.keys(headers).some((k) => k.toLowerCase() === "cf-connecting-ip")) headers["cf-connecting-ip"] = `192.0.2.${Math.floor(Math.random() * 250) + 1}`;
      let body: BodyInit | undefined = opts.raw;
      if (opts.body !== undefined) {
        headers["content-type"] = "application/json";
        body = JSON.stringify(opts.body);
      }
      const ctx = createExecutionContext();
      const res = await worker.fetch(new Request(`https://worker.test${path}`, { method, headers, ...(body !== undefined ? { body } : {}) }), h.env(), ctx);
      await waitOnExecutionContext(ctx);
      const text = new TextDecoder().decode(await res.arrayBuffer());
      let parsed: unknown = text;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        /* not json */
      }
      return { status: res.status, body: parsed as any, headers: res.headers };
    },
    async drainSteps(maxRounds = 20) {
      let acked = 0;
      let retried = 0;
      let queue = steps.splice(0, steps.length).map((body) => ({ body, attempts: 1 }));
      for (let round = 0; round < maxRounds && queue.length > 0; round++) {
        const msgs = queue.map((q, i) => ({ id: `m${round}-${i}`, timestamp: new Date(), attempts: q.attempts, body: q.body }));
        const batch = createMessageBatch("commonforge-steps", msgs);
        const ctx = createExecutionContext();
        await worker.queue(batch, h.env(), ctx);
        const r = await getQueueResult(batch, ctx);
        acked += r.explicitAcks.length;
        const next: Array<{ body: unknown; attempts: number }> = [];
        for (const id of r.retryMessages.map((m: { msgId: string }) => m.msgId)) {
          retried++;
          const m = msgs.find((x) => x.id === id);
          if (m) next.push({ body: m.body, attempts: m.attempts + 1 });
        }
        // steps enqueued by the handlers themselves join the next round
        queue = [...next, ...steps.splice(0, steps.length).map((body) => ({ body, attempts: 1 }))];
      }
      for (const q of queue) steps.push(q.body);
      return { acked, retried };
    },
    async deliver(queue, bodies, attempts = 1) {
      const msgs = bodies.map((body, i) => ({ id: `d-${crypto.randomUUID()}-${i}`, timestamp: new Date(), attempts, body: structuredClone(body) }));
      const batch = createMessageBatch(queue, msgs);
      const ctx = createExecutionContext();
      await worker.queue(batch, h.env(), ctx);
      const r = await getQueueResult(batch, ctx);
      const byId = new Map(msgs.map((m) => [m.id, m.body]));
      return {
        acked: (r.explicitAcks as string[]).map((id) => byId.get(id)),
        retried: (r.retryMessages as Array<{ msgId: string; delaySeconds?: number }>).map((m) => ({ body: byId.get(m.msgId), ...(m.delaySeconds !== undefined ? { delaySeconds: m.delaySeconds } : {}) })),
      };
    },
    async signIn(addr) {
      // CLI login flow (bearer); the browser cookie flow is covered in auth.test.ts
      const r1 = await h.api("POST", "/api/auth/magic-link", { body: { email: addr, client: "cli" } });
      expect(r1.status).toBe(202);
      const code = email.lastCode(addr.toLowerCase());
      expect(code).toBeTruthy();
      const r2 = await h.api("POST", "/api/auth/cli/verify", { body: { code } });
      expect(r2.status).toBe(200);
      return r2.body.sessionToken as string;
    },
  };
  const deps: Deps = {
    ...defaultDeps,
    email: () => email,
    artifacts: () => artifacts,
    importer: () => importer,
    stepQueue: () => ({ send: async (b) => void steps.push(structuredClone(b)) }),
    runnerQueue: () => ({
      send: async (b) => {
        runnerJobs.push(structuredClone(b));
        h.onRunnerJob?.(structuredClone(b));
      },
    }),
    outboxQueue: () => ({ send: async (b) => void outbox.push(structuredClone(b)) }),
    runnerWait: { pollMs: 5, timeoutMs: 3000 },
    gateWaitMs: 2000,
    deployApi: () => ({
      async createKvNamespace(_accountId: string, title: string) {
        const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
        cf.kv.set(id, title);
        deployApi.created.push({ kind: "kv", name: title, id });
        return { id };
      },
      async createD1Database(_accountId: string, name: string) {
        const id = crypto.randomUUID();
        deployApi.created.push({ kind: "d1", name, id });
        return { id };
      },
      async deleteD1Database(_accountId: string, id: string) {
        deployApi.deleted.push({ kind: "d1", id });
      },
      async d1Query(_accountId: string, id: string, sql: string) {
        if (deployApi.failQuery && (deployApi.failQuery.match === undefined || sql.includes(deployApi.failQuery.match))) throw new DeployApiError(deployApi.failQuery.status, deployApi.failQuery.message);
        deployApi.queries.push({ id, sql });
      },
      async deleteKvNamespace(_accountId: string, id: string) {
        cf.kv.delete(id);
        deployApi.deleted.push({ kind: "kv", id });
      },
      async kvBulkPut(_accountId: string, id: string, entries: Array<{ key: string; value: string }>) {
        deployApi.kvPuts.push({ id, entries: structuredClone(entries) });
      },
      async workersSubdomain() {
        return cf.subdomain;
      },
      async activeVersionIds(_accountId: string, script: string) {
        if (cf.failActive) throw new Error("Cloudflare API unavailable (test)");
        return cf.active.get(script) ?? [];
      },
      async deleteScript(_accountId: string, script: string) {
        cf.active.delete(script);
        cf.deleted.push(script);
      },
    }),
    classifier: (_env, provider) => classifier.forProvider(provider),
    ...overrides,
  };
  h.deps = deps;
  const worker = createWorker(deps);
  h.worker = worker;
  return h;
}

export const uniq = (p: string) => `${p}-${crypto.randomUUID().slice(0, 8)}`;
export const email = (p: string) => `${uniq(p)}@example.test`;

/** Owner + org in one call. */
export async function ownerWithOrg(h: Harness, name = "Demo Client"): Promise<{ token: string; orgId: string; userId: string }> {
  const token = await h.signIn(email("owner"));
  const r = await h.api("POST", "/api/orgs", { token, body: { name } });
  expect(r.status).toBe(201);
  const me = await h.api("GET", "/api/me", { token });
  return { token, orgId: r.body.orgId, userId: me.body.user.userId };
}

/** Add a member with a role and sign them in. */
export async function member(h: Harness, owner: { token: string; orgId: string }, role: string): Promise<{ token: string; userId: string }> {
  const addr = email(role);
  const r = await h.api("POST", `/api/orgs/${owner.orgId}/members`, { token: owner.token, body: { email: addr, role } });
  expect(r.status).toBe(201);
  const token = await h.signIn(addr);
  return { token, userId: r.body.userId };
}

export const canonicalNs = (orgId: string) => `commonforge-dev-${orgId}-canonical`;

/** Create an Artifacts resource, give its canonical repo content, and bind the head. */
export async function codeResource(h: Harness, o: { token: string; orgId: string }, name: string, files: Record<string, string>) {
  const r = await h.api("POST", `/api/orgs/${o.orgId}/resources`, { token: o.token, body: { name, provider: "artifacts" } });
  expect(r.status).toBe(201);
  const rid = r.body.resourceId as string;
  const sha = h.artifacts.makeCommit(files);
  h.artifacts.push(canonicalNs(o.orgId), rid, "main", sha);
  const a = await h.api("POST", `/api/orgs/${o.orgId}/resources/${rid}/adopt-head`, { token: o.token });
  expect(a.status).toBe(200);
  return { resourceId: rid, sha, revisionId: a.body.revisionId as string, repoId: r.body.coords.repoId as string };
}

export async function projectWith(h: Harness, o: { token: string; orgId: string }, mounts: Array<{ mountName: string; resourceId: string; mode?: string; operations?: string[] }>) {
  const p = await h.api("POST", `/api/orgs/${o.orgId}/projects`, { token: o.token, body: { name: "Customer Portal" } });
  expect(p.status).toBe(201);
  for (const m of mounts) {
    const r = await h.api("POST", `/api/orgs/${o.orgId}/projects/${p.body.projectId}/mounts`, { token: o.token, body: m });
    expect(r.status).toBe(201);
  }
  return p.body.projectId as string;
}

/**
 * A new, empty file collection (`r2-assets`) attached to a project. `POST …/folders` makes git
 * folders since folders phase 4; collections are made through the resources API (owners).
 */
export async function fileCollection(h: Harness, o: { token: string; orgId: string }, pid: string, mountName: string): Promise<string> {
  const r = await h.api("POST", `/api/orgs/${o.orgId}/resources`, { token: o.token, body: { name: mountName, provider: "r2-assets" } });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const m = await h.api("POST", `/api/orgs/${o.orgId}/projects/${pid}/mounts`, { token: o.token, body: { mountName, resourceId: r.body.resourceId } });
  expect(m.status, JSON.stringify(m.body)).toBe(201);
  return r.body.resourceId as string;
}

export const tasksNs = (orgId: string) => `commonforge-dev-${orgId}-tasks`;

/** Org with website (write) + api (reference) mounts and a provisioned task. */
export async function provisionedTask(h: Harness) {
  const runner = new FakeRunner(h);
  const o = await ownerWithOrg(h);
  const web = await codeResource(h, o, "website", { "index.html": "v1", "src/quote.ts": "export const q = 1;" });
  const api = await codeResource(h, o, "api", { "src/index.ts": "api v1" });
  const pid = await projectWith(h, o, [
    { mountName: "website", resourceId: web.resourceId },
    { mountName: "api", resourceId: api.resourceId, mode: "pinned-reference" },
  ]);
  const t = await h.api("POST", `/api/orgs/${o.orgId}/projects/${pid}/tasks`, { token: o.token, body: { title: "Add quote breakdown", request: "show the breakdown", writeMounts: ["website"] } });
  expect(t.status).toBe(201);
  expect(t.body.state).toBe("provisioning");
  expect(t.body.workspaces[0].state).toBe("provisioning");
  await h.drainSteps();
  expect(runner.errors).toEqual([]);
  const task = await h.api("GET", `/api/tasks/${t.body.taskId}`, { token: o.token });
  expect(task.body.state).toBe("ready");
  return { runner, o, web, api, pid, taskId: t.body.taskId as string, task: task.body };
}


export const waitUntil = async (cond: () => Promise<boolean>, ms = 3000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** Lease the task, get a write credential, and "git push" a commit on top of the base. */
export async function agentPush(h: Harness, ownerToken: string, taskId: string, files: Record<string, string>) {
  const lease = await h.api("POST", `/api/tasks/${taskId}/lease`, { token: ownerToken, body: {} });
  expect(lease.status).toBe(200);
  const agent = lease.body.leaseToken as string;
  const task = (await h.api("GET", `/api/tasks/${taskId}`, { token: agent })).body;
  const ws = task.workspaces.find((w: any) => w.mountName === "website");
  const cred = await h.api("POST", `/api/tasks/${taskId}/credential`, { token: agent, body: { mountName: "website", access: "write" } });
  expect(cred.status).toBe(200);
  const where = h.artifacts.tokenByPlaintext(cred.body.secret)!;
  expect(where.token.scope).toBe("write");
  const base = h.artifacts.repo(where.ns, where.name).refs.get("main")!;
  const sha = h.artifacts.makeCommit({ ...h.artifacts.files.get(base), ...files }, [base]);
  h.artifacts.push(where.ns, where.name, "main", sha);
  return { agent, ws, sha, cred: cred.body };
}

export async function freezeAndPropose(h: Harness, o: { token: string; orgId: string }, taskId: string, files: Record<string, string>) {
  const { agent, ws, sha, cred } = await agentPush(h, o.token, taskId, files);
  const f = await h.api("POST", `/api/tasks/${taskId}/workspaces/${ws.taskWorkspaceId}/freeze`, { token: agent, body: { expectedSha: sha, tool: "claude" } });
  expect(f.status).toBe(201);
  const p = await h.api("POST", `/api/orgs/${o.orgId}/proposals`, { token: o.token, body: { taskId } });
  expect(p.status).toBe(201);
  return { agent, ws, sha, cred, candidate: f.body, proposal: p.body };
}

export async function prepareAndIntegrate(h: Harness, o: { token: string; orgId: string }, proposalId: string) {
  await h.drainSteps(); // candidate.prepare → runner prepare-candidate
  const prepared = await h.api("GET", `/api/orgs/${o.orgId}/proposals/${proposalId}`, { token: o.token });
  expect(prepared.body.state).toBe("prepared");
  const i = await h.api("POST", `/api/orgs/${o.orgId}/proposals/${proposalId}/integrate`, { token: o.token });
  expect(i.status).toBe(202);
  await waitUntil(async () => (await h.api("GET", `/api/orgs/${o.orgId}/proposals/${proposalId}`, { token: o.token })).body.integration?.forCurrentHash === true);
  return (await h.api("GET", `/api/orgs/${o.orgId}/proposals/${proposalId}`, { token: o.token })).body;
}

