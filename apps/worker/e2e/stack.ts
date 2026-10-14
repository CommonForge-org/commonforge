/**
 * Local e2e stack (Task 23): the real control-plane Worker under `wrangler dev -c wrangler.e2e.jsonc`
 * serving the real web bundle, for apps/web/e2e/local-stack.spec.ts.
 *
 * Real here: the Hono app and every route, D1, the OrgLedger and OpsGate Durable Objects (SQLite),
 * R2 (miniflare), the step / outbox / runner queues and their consumers, magic-link sign-in in
 * `log` mode (the link is read from the Worker log), CSRF and cookie sessions, the static assets.
 *
 * Faked, because they are remote services with no local simulator (docs/LIMITATIONS.md):
 * - **Cloudflare Artifacts** (control plane + git smart-HTTP): the in-memory `FakeArtifacts` used by
 *   the Worker tests. "git push" is `POST /__e2e/git/push`, gated by a real write token the broker
 *   minted (the agent's credential), so the agent still goes through lease → credential.
 * - **The integration runner** (Sandbox container + git): `FakeRunner`, driven by the local
 *   `commonforge-runner-jobs` queue. It talks to the Worker exactly like the real runner (signed jobs,
 *   credential broker, evidence keys, blobs, results), in-process.
 * - **The Cloudflare API for releases** (KV creation, workers.dev subdomain, active versions) and the
 *   release `/version` health check: in-memory, fed by the fake runner's deploys.
 *
 * Test-only routes live under `/__e2e/` in this file only (never in src/), and need the
 * `x-commonforge-e2e` header to equal the `COMMONFORGE_E2E_KEY` var of wrangler.e2e.jsonc.
 */
import { createWorker } from "../src/app.js";
import { defaultDeps, type Deps } from "../src/deps.js";
import type { Env } from "../src/env.js";
import { FakeArtifacts, FakeImporter } from "../test/fakes/artifacts.js";
import { FakeRunner, type FakeRunnerOptions } from "../test/fakes/runner.js";
import type { Harness } from "../test/helpers.js";
import { isLocalWorker } from "../src/chaos.js";

export { OpsGate, OrgLedger } from "../src/index.js";

type E2EEnv = Env & { COMMONFORGE_E2E_KEY?: string };

const artifacts = new FakeArtifacts();
const importer = new FakeImporter(artifacts);
const cf: Harness["cf"] = { kv: new Map(), active: new Map(), subdomain: "demo", deleted: [] };
/** what each "deployed" release Worker answers on /version (fed by the fake runner) */
const live = new Map<string, Record<string, string>>();

const deps: Deps = {
  ...defaultDeps,
  artifacts: () => artifacts,
  importer: () => importer,
  runnerWait: { pollMs: 100, timeoutMs: 30_000 },
  healthFetch: async (url) => {
    const name = /^https:\/\/([a-z0-9-]+)\.demo\.workers\.dev\/version$/.exec(url)?.[1];
    const vars = name ? live.get(name) : undefined;
    if (!vars) return new Response("no such worker", { status: 404 });
    return Response.json({ name, version: vars.APP_VERSION, release: vars.COMMONFORGE_RELEASE_ID ?? null });
  },
  deployApi: () => ({
    async createKvNamespace(_accountId: string, title: string) {
      const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
      cf.kv.set(id, title);
      return { id };
    },
    async workersSubdomain() {
      return cf.subdomain;
    },
    async activeVersionIds(_accountId: string, script: string) {
      return cf.active.get(script) ?? [];
    },
    async deleteScript(_accountId: string, script: string) {
      cf.active.delete(script);
      cf.deleted.push(script);
    },
    // staging data is not exercised by the e2e stack
    async createD1Database() {
      return { id: crypto.randomUUID() };
    },
    async deleteD1Database() {},
    async d1Query() {},
    async deleteKvNamespace() {},
    async kvBulkPut() {},
  }),
};

const worker = createWorker(deps);

/** The Worker env (the same bindings for every invocation); the fake runner calls the Worker in-process. */
let currentEnv: E2EEnv | null = null;

const runnerHarness = {
  artifacts,
  cf,
  onRunnerJob: null,
  async api(method: string, path: string, opts: { token?: string; body?: unknown; raw?: BodyInit; headers?: Record<string, string> } = {}) {
    if (!currentEnv) throw new Error("fake runner called outside an invocation");
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    let body: BodyInit | undefined = opts.raw;
    if (opts.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(opts.body);
    }
    const base = currentEnv.COMMONFORGE_PUBLIC_URL.replace(/\/+$/, "");
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => undefined, props: {} } as unknown as ExecutionContext;
    const res = await worker.fetch(new Request(`${base}${path}`, { method, headers, ...(body !== undefined ? { body } : {}) }), currentEnv, ctx);
    await Promise.allSettled(pending);
    const text = new TextDecoder().decode(await res.arrayBuffer());
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* not json */
    }
    return { status: res.status, body: parsed as any, headers: res.headers };
  },
} as unknown as Harness;

const runner = new FakeRunner(runnerHarness, { onDeploy: (name, vars) => live.set(name, vars) });
const baseRunnerOpts = { ...runner.opts };

const json = (body: unknown, status = 200) => Response.json(body, { status });

async function e2eRoute(request: Request, env: E2EEnv): Promise<Response> {
  const key = env.COMMONFORGE_E2E_KEY;
  if (!key || request.headers.get("x-commonforge-e2e") !== key) return json({ error: { code: "forbidden", message: "e2e key required" } }, 403);
  const url = new URL(request.url);
  const body = request.method === "POST" ? ((await request.json()) as Record<string, any>) : {};
  switch (`${request.method} ${url.pathname}`) {
    // Seed a canonical repo the way an import or the first push would.
    case "POST /__e2e/git/seed": {
      const { namespace, repo, files } = body as { namespace: string; repo: string; files: Record<string, string> };
      const r = artifacts.findRepo(namespace, repo);
      if (!r) return json({ error: { code: "not_found", message: `${namespace}/${repo}` } }, 404);
      const parent = r.refs.get("main");
      const sha = artifacts.makeCommit(files, parent ? [parent] : []);
      artifacts.push(namespace, repo, "main", sha);
      return json({ sha });
    }
    // An agent's `git push`: allowed only with an active write token for that repository.
    case "POST /__e2e/git/push": {
      const { secret, files } = body as { secret: string; files: Record<string, string | null> };
      const where = artifacts.tokenByPlaintext(secret);
      if (!where || where.token.state !== "active" || where.token.scope !== "write" || Date.parse(where.token.expiresAt) < Date.now()) return json({ error: { code: "push_refused", message: "no active write token" } }, 403);
      const repo = artifacts.repo(where.ns, where.name);
      const base = repo.refs.get("main")!;
      const next: Record<string, string> = { ...artifacts.files.get(base) };
      for (const [p, c] of Object.entries(files)) {
        if (c === null) delete next[p];
        else next[p] = c;
      }
      const sha = artifacts.makeCommit(next, [base]);
      artifacts.push(where.ns, where.name, "main", sha);
      return json({ sha, namespace: where.ns, repo: where.name });
    }
    // A public repository the fake importer can import (URL intake): its branches' files.
    case "POST /__e2e/importer/remote": {
      const { url, branch, files } = body as { url: string; branch: string; files: Record<string, string> };
      importer.remotes.set(url, { ...(importer.remotes.get(url) ?? {}), [branch]: files });
      return json({ ok: true });
    }
    case "GET /__e2e/git/ref": {
      const r = artifacts.findRepo(url.searchParams.get("namespace") ?? "", url.searchParams.get("repo") ?? "");
      return json({ sha: r?.refs.get(url.searchParams.get("branch") ?? "main") ?? null });
    }
    case "GET /__e2e/git/files": {
      const sha = url.searchParams.get("sha") ?? "";
      return json({ files: artifacts.files.get(sha) ?? null });
    }
    // Steer the fake runner (e.g. a contract failure for the next integrations).
    case "POST /__e2e/runner": {
      runner.opts = { ...baseRunnerOpts, ...(body as FakeRunnerOptions) };
      return json({ ok: true });
    }
    case "GET /__e2e/runner": {
      return json({ handled: runner.handled.map((j) => ({ jobId: j.jobId, kind: j.job.kind })), errors: runner.errors.map((e) => String(e)), live: Object.fromEntries(live) });
    }
    default:
      return json({ error: { code: "not_found", message: url.pathname } }, 404);
  }
}

/** e2e queue name → the production name the src consumers switch on (wrangler.e2e.jsonc). */
const QUEUE_NAMES: Record<string, string> = {
  "commonforge-e2e-outbox": "commonforge-outbox",
  "commonforge-e2e-steps": "commonforge-steps",
  "commonforge-e2e-runner-jobs": "commonforge-runner-jobs",
};

/** The fakes and /__e2e/ routes must never run on a deployed Worker. */
function refuseUnlessLocal(env: E2EEnv): void {
  if (!isLocalWorker(env)) throw new Error("the e2e stack runs only on a local Worker (COMMONFORGE_PUBLIC_URL must be local)");
}

export default {
  async fetch(request: Request<unknown, IncomingRequestCfProperties>, env: E2EEnv, ctx: ExecutionContext): Promise<Response> {
    if (!isLocalWorker(env)) return new Response("the e2e stack runs only locally", { status: 503 });
    if (new URL(request.url).pathname.startsWith("/__e2e/")) return e2eRoute(request, env);
    return worker.fetch(request, env, ctx);
  },
  async queue(raw: MessageBatch, env: E2EEnv, ctx: ExecutionContext): Promise<void> {
    refuseUnlessLocal(env);
    const name = QUEUE_NAMES[raw.queue];
    if (!name) throw new Error(`e2e stack: unexpected queue ${raw.queue}`);
    const batch: MessageBatch = { queue: name, messages: raw.messages, ackAll: () => raw.ackAll(), retryAll: (o?: QueueRetryOptions) => raw.retryAll(o) } as MessageBatch;
    if (batch.queue === "commonforge-runner-jobs") {
      currentEnv = env;
      for (const m of batch.messages) {
        try {
          await runner.run((m.body as { signedJob: Parameters<FakeRunner["run"]>[0] }).signedJob);
        } catch (e) {
          runner.errors.push(e);
          console.error(`[e2e runner] ${e instanceof Error ? e.message : String(e)}`);
        }
        m.ack();
      }
      return;
    }
    return worker.queue(batch, env, ctx);
  },
  async scheduled(controller: ScheduledController, env: E2EEnv, ctx: ExecutionContext): Promise<void> {
    refuseUnlessLocal(env);
    return worker.scheduled(controller, env, ctx);
  },
} satisfies ExportedHandler<E2EEnv>;
