/**
 * `commonforge-runner`: the Sandbox integration runner (Task 22; plan §0.3 A3, §C.2). Deployed
 * with `wrangler deploy -c wrangler.runner.jsonc`. It consumes `commonforge-runner-jobs` and runs
 * each signed job in a fresh container (`RunnerBox`, one Durable Object + container per job,
 * instance `standard-1`, destroyed afterwards) with the runner image (`apps/runner/Dockerfile`).
 *
 * Egress mode: the container has no internet (`enableInternet: false`) and never holds a token.
 * Before the container starts, the box asks the control plane's broker (service binding
 * `CONTROL`, presenting the SignedJob) for the job's repository tokens, and for `release-deploy`
 * jobs the account deploy token, and registers per-job outbound interceptors (gateway.ts) that
 * inject them. Every token is revoked when the job ends; the gateways refuse everything after the
 * job's expiry.
 */
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { deployPrefix } from "../services/deploy-targets.js";
import { jobAllowedPushRefs, jobRepoAccess, sameRepoIdentity, SignedJobSchema, type SignedJob } from "@commonforge-org/runner-protocol";
import {
  RUNNER_KEY_HEADER,
  checkNetworkFor,
  runnerKeyOk,
  uploadBindingsProblem,
  controlPathAllowed,
  decideCloudflareApi,
  decideGitRequest,
  decideNpmRequest,
  guardReceivePack,
  NPM_HOST,
  type ArtifactsGatewayProps,
  type CloudflareApiProps,
  type GatewayRepo,
  type NpmGatewayProps,
} from "./gateway.js";

export interface RunnerEnv {
  /** release Worker names are `<prefix>-<orgId>-<name>` (same value as on the control plane; default cfapp) */
  COMMONFORGE_DEPLOY_WORKER_PREFIX?: string;
  RUNNER_BOX: DurableObjectNamespace<RunnerBox>;
  /** service binding to the control plane (`commonforge-worker`) */
  CONTROL: Fetcher;
  /** the control plane's public URL (= the origin of every job's credentialBroker) */
  COMMONFORGE_WORKER_URL: string;
  /** the preview Worker's URL (receipts only; tokens are minted by the control plane) */
  COMMONFORGE_PREVIEW_URL: string;
}

const CA = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
/** must equal apps/runner/src/main.ts EGRESS_PLACEHOLDER_TOKEN */
const PLACEHOLDER = "commonforge-egress-injected-deploy-token";
const CHUNK = 48 * 1024;
const RECIPE_KINDS = new Set(["integrate", "preview-build", "release-build"]);

function forbidden(reason: string): Response {
  return new Response(`refused by the CommonForge egress gateway: ${reason}\n`, { status: 403, headers: { "content-type": "text/plain" } });
}

/** Artifacts git host: the job's repositories only, token injected, receive-pack refs checked. */
export class ArtifactsGateway extends WorkerEntrypoint<RunnerEnv, ArtifactsGatewayProps> {
  override async fetch(request: Request): Promise<Response> {
    const props = this.ctx.props;
    const url = new URL(request.url);
    const d = decideGitRequest(props, request.method, url, Date.now(), request.headers.get(RUNNER_KEY_HEADER));
    if (!d.ok) return forbidden(d.reason);
    let body: ReadableStream<Uint8Array> | null = request.body;
    if (d.service === "receive-pack" && d.rpc) {
      const g = await guardReceivePack(request.body, d.repo);
      if (!g.ok) return forbidden(g.reason);
      body = g.body;
    }
    const headers = new Headers(request.headers);
    headers.delete(RUNNER_KEY_HEADER);
    headers.set("authorization", `Bearer ${d.repo.token}`);
    url.protocol = "https:";
    return fetch(url, { method: request.method, headers, body, redirect: "manual", ...(body ? { duplex: "half" } : {}) } as RequestInit);
  }
}

/** Control plane: result/evidence/heads/blob calls only, through the service binding; never the broker. */
export class ControlGateway extends WorkerEntrypoint<RunnerEnv, { jobId: string; expiresAt: number; runnerKey: string }> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (!controlPathAllowed(request.method, url.pathname)) return forbidden(`${request.method} ${url.pathname} is not a runner call this container may make`);
    // review I-3: results and blobs come from the runner process only, never from a check/recipe step
    if (!runnerKeyOk(this.ctx.props.runnerKey, request.headers.get(RUNNER_KEY_HEADER))) return forbidden("only the runner process may call the control plane");
    const headers = new Headers(request.headers);
    headers.delete("authorization");
    headers.delete(RUNNER_KEY_HEADER);
    return this.env.CONTROL.fetch(new Request(`${this.env.COMMONFORGE_WORKER_URL.replace(/\/+$/, "")}${url.pathname}${url.search}`, { method: request.method, headers, body: request.body, ...(request.body ? { duplex: "half" } : {}) } as RequestInit));
  }
}

/**
 * npm registry: anonymous reads only (installs for recipe/check steps). pnpm 12 (a native binary)
 * does not trust the containers' interception CA, so installs use the registry over plain HTTP
 * inside the container (`PNPM_CONFIG_REGISTRY=http://registry.npmjs.org/`); this gateway fetches
 * upstream over HTTPS and rewrites tarball URLs in metadata to the same plain-HTTP host.
 */
export class NpmGateway extends WorkerEntrypoint<RunnerEnv, NpmGatewayProps> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const d = decideNpmRequest(this.ctx.props, request.method, url, request.headers.get("authorization"), Date.now());
    if (!d.ok) return forbidden(d.reason);
    const headers = new Headers(request.headers);
    headers.delete("authorization");
    headers.delete("cookie");
    headers.delete("accept-encoding");
    const plain = url.protocol === "http:";
    url.protocol = "https:";
    const res = await fetch(url, { method: request.method, headers, redirect: "manual" });
    if (!plain || !(res.headers.get("content-type") ?? "").includes("json")) return res;
    const body = (await res.text()).replaceAll(`https://${NPM_HOST}/`, `http://${NPM_HOST}/`);
    const out = new Headers(res.headers);
    out.delete("content-length");
    out.delete("content-encoding");
    out.delete("etag");
    return new Response(body, { status: res.status, headers: out });
  }
}

/** Cloudflare API: release-deploy only, the job's Workers only, deploy token swapped in here. */
export class CloudflareApiGateway extends WorkerEntrypoint<RunnerEnv, CloudflareApiProps> {
  override async fetch(request: Request): Promise<Response> {
    const props = this.ctx.props;
    const url = new URL(request.url);
    const d = decideCloudflareApi(props, request.method, url, request.headers.get("authorization"), Date.now());
    if (!d.ok) {
      console.warn(`cloudflare api refused for ${props.jobId}: ${d.reason}`);
      return new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: `refused by the CommonForge egress gateway: ${d.reason}` }] }), { status: 403, headers: { "content-type": "application/json" } });
    }
    const headers = new Headers(request.headers);
    console.log(`cloudflare api ${props.jobId}: ${request.method} ${url.pathname.replace(/accounts\/[0-9a-f]+/, "accounts/…")}`);
    if (d.inject) headers.set("authorization", `Bearer ${props.token}`);
    url.protocol = "https:";
    // review C-1: an upload may bind only plain vars and the job's own KV namespaces
    let body: ArrayBuffer | null = null;
    if (request.method === "PUT" || request.method === "POST" || request.method === "PATCH") {
      body = await request.arrayBuffer();
      const problem = await uploadBindingsProblem(request.headers.get("content-type") ?? "", body, props.allowedKvIds, props.allowedD1Ids ?? []);
      if (problem) {
        console.warn(`cloudflare api refused for ${props.jobId}: ${problem}`);
        return new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: `refused by the CommonForge egress gateway: ${problem}` }] }), { status: 403, headers: { "content-type": "application/json" } });
      }
    }
    return fetch(url, { method: request.method, headers, body, redirect: "manual" });
  }
}

interface MintedToken {
  tokenId: string;
}

export interface BoxRunResult {
  jobId: string;
  kind: string;
  exitCode: number | null;
  ok: boolean | null;
  code?: string;
  /** whether `unshare --net` works in this container (CAP_SYS_ADMIN), measured per job */
  networkNamespaces: boolean | null;
  /** how this job's check/recipe commands were networked */
  checkNetwork?: "none" | "inherit";
  stderrTail: string;
  ms: number;
}

/** One job, one container. */
export class RunnerBox extends DurableObject<RunnerEnv> {
  private get c(): Container {
    const c = this.ctx.container;
    if (!c) throw new Error("container binding not configured");
    return c;
  }

  private async control(path: string, body: unknown): Promise<Response> {
    return this.env.CONTROL.fetch(new Request(`${this.env.COMMONFORGE_WORKER_URL.replace(/\/+$/, "")}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  }

  private async sh(script: string, env: Record<string, string>): Promise<number> {
    const p = await this.c.exec(["sh", "-c", script], { env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/root", ...env } });
    return (await p.output()).exitCode;
  }

  async run(delivery: { signedJob: unknown }): Promise<BoxRunResult> {
    const t0 = Date.now();
    const parsed = SignedJobSchema.safeParse(delivery?.signedJob);
    if (!parsed.success) return { jobId: "invalid", kind: "invalid", exitCode: null, ok: null, networkNamespaces: null, stderrTail: "malformed signed job", ms: 0 };
    const sj: SignedJob = parsed.data;
    const expiresAt = Date.parse(sj.expiresAt);
    const base = { jobId: sj.jobId, kind: sj.job.kind };
    if (Date.now() >= expiresAt) return { ...base, exitCode: null, ok: null, networkNamespaces: null, stderrTail: "job expired before it ran", ms: 0 };

    const minted: MintedToken[] = [];
    const randomKey = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
    // review I-3: a per-job key only the root runner process holds (root-only file below)
    const runnerKey = randomKey();
    // integrate: the runner installs check dependencies itself before the (offline) checks; the npm
    // gateway then serves only requests carrying this per-job key (it grants registry reads only)
    const npmKey = sj.job.kind === "integrate" ? randomKey() : undefined;
    try {
      // 1. repository tokens from the broker (it verifies the SignedJob; ttl <= job expiry)
      const repos: GatewayRepo[] = [];
      let host: string | null = null;
      const pushes = jobAllowedPushRefs(sj.job);
      for (const a of jobRepoAccess(sj.job)) {
        if (a.coords.kind !== "artifacts") continue;
        const res = await this.control("/api/runner/credential", { signedJob: sj, repo: a.coords, access: a.access });
        if (!res.ok) throw new Error(`broker refused ${a.access} on ${a.coords.namespace}/${a.coords.repoName}: HTTP ${res.status}`);
        const cred = (await res.json()) as { token: string; tokenId: string; remoteUrl: string };
        minted.push({ tokenId: cred.tokenId });
        const u = new URL(cred.remoteUrl);
        if (host && host !== u.hostname) throw new Error("repositories on more than one git host");
        host = u.hostname;
        repos.push({
          path: u.pathname.replace(/\/+$/, ""),
          token: cred.token,
          write: a.access === "write",
          pushes: pushes.filter((p) => sameRepoIdentity(p.coords, a.coords)).map((p) => ({ ref: p.ref, lease: p.lease, ...(p.expectedSha !== undefined ? { expectedSha: p.expectedSha } : {}) })),
        });
      }
      // 2. interceptors (registered before start, so the first request is covered)
      const exportsNs = (this.ctx as unknown as { exports: Record<string, (o: { props: unknown }) => Fetcher> }).exports;
      if (host) await this.c.interceptOutboundHttps(host, exportsNs.ArtifactsGateway!({ props: { jobId: sj.jobId, expiresAt, host, repos, runnerKey } satisfies ArtifactsGatewayProps }));
      const workerHost = new URL(this.env.COMMONFORGE_WORKER_URL).hostname;
      await this.c.interceptOutboundHttps(workerHost, exportsNs.ControlGateway!({ props: { jobId: sj.jobId, expiresAt, runnerKey } }));
      if (RECIPE_KINDS.has(sj.job.kind)) {
        const npmProps: NpmGatewayProps = { expiresAt, ...(npmKey ? { npmKey } : {}) };
        await this.c.interceptOutboundHttps(NPM_HOST, exportsNs.NpmGateway!({ props: npmProps }));
        await this.c.interceptOutboundHttp(NPM_HOST, exportsNs.NpmGateway!({ props: npmProps }));
      }
      if (sj.job.kind === "release-deploy") {
        // review C-1 (defence in depth): only Workers inside the org's namespace, never the platform's
        // review m-e: org ids are server-generated o-<12 hex>; anything else is refused
        const org = /^org\/(o-[0-9a-f]{12})\/releases\//.exec(sj.job.outputPrefix)?.[1];
        if (!org) throw new Error("release-deploy job without an org-scoped output prefix");
        const workerPrefix = `${deployPrefix(this.env)}-${org}-`;
        const bad = sj.job.targets.find((t) => t.workerName.startsWith("commonforge") || !t.workerName.startsWith(workerPrefix));
        if (bad) throw new Error(`release target ${bad.workerName} is outside ${workerPrefix}*`);
        const allowedKvIds = sj.job.targets.flatMap((t) => t.config.kvNamespaces.map((k) => k.id));
        const allowedD1Ids = sj.job.targets.flatMap((t) => (t.config.d1Databases ?? []).map((d) => d.id));
        const res = await this.control("/api/runner/deploy-credential", { signedJob: sj });
        if (!res.ok) throw new Error(`deploy credential refused: HTTP ${res.status}`);
        const { token } = (await res.json()) as { token: string };
        await this.c.interceptOutboundHttps(
          "api.cloudflare.com",
          exportsNs.CloudflareApiGateway!({ props: { jobId: sj.jobId, expiresAt, accountId: sj.job.accountId, workerNames: sj.job.targets.map((t) => t.workerName), workerPrefix, allowedKvIds, allowedD1Ids, token, placeholder: PLACEHOLDER } satisfies CloudflareApiProps }),
        );
      }

      // 3. container: no internet, standard-1 (lite is too slow for repeated work, spike S3)
      this.c.start({ image: this.c.images.runner!, enableInternet: false, instance: "standard-1" });
      await (await this.c.exec(["true"])).output();
      await this.c.setInactivityTimeout(5 * 60_000);
      // verified live (Task 22): the Sandbox runtime permits `unshare --net` (CAP_SYS_ADMIN)
      const netns = (await (await this.c.exec(["unshare", "--net", "--", "true"])).output()).exitCode === 0;
      // Jobs that can write a repository run their checks with NO network at all, so the injected
      // bearer is only ever used by the runner's own traffic (README requirement 4). Their check
      // dependencies are installed by the runner beforehand, as the check uid, from each mount's
      // lockfile, through the npm gateway with the per-job npm key (install.ts). Read-only build
      // jobs (preview-build, release-build) keep the gateway-limited network for their install steps:
      // it reaches the npm registry (read), the job's own repositories (read only) and the
      // SignedJob-authenticated runner endpoints (the job is a root-only file the checks cannot read).
      // Every integrate job counts too, including an assets-only one that writes no repository
      // (follow-up Task 23): its checks run repository code like any integrate (`checkNetworkFor`).
      const checkNetwork = checkNetworkFor(sj.job, netns);

      // 4. the delivery as a root-only file (the SignedJob is a bearer for its own job while open)
      const json = JSON.stringify({ signedJob: sj });
      const bytes = new TextEncoder().encode(json);
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const b64 = btoa(bin);
      await this.sh('umask 077 && : > /workspace/jobs/delivery.json && printf %s "$K" > /workspace/jobs/runner-key', { K: runnerKey });
      if (npmKey) await this.sh('umask 077 && printf %s "$K" > /workspace/jobs/npm-key', { K: npmKey });
      for (let i = 0; i < b64.length; i += CHUNK) await this.sh('printf %s "$B" | base64 -d >> /workspace/jobs/delivery.json', { B: b64.slice(i, i + CHUNK) });

      // 5. run it (exec passes no image ENV: everything explicit)
      const env: Record<string, string> = {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        HOME: "/root",
        NODE_ENV: "production",
        NODE_EXTRA_CA_CERTS: CA,
        WRANGLER_SEND_METRICS: "false",
        COMMONFORGE_RUNNER_WORK_DIR: "/workspace/jobs/work",
        COMMONFORGE_RUNNER_CREDENTIALS: "egress",
        COMMONFORGE_RUNNER_CA: CA,
        COMMONFORGE_RUNNER_KIND: "sandbox",
        COMMONFORGE_RUNNER_CHECKS_DIR: "/workspace/checks",
        COMMONFORGE_RUNNER_CHECK_UID: "10001",
        COMMONFORGE_RUNNER_CHECK_GID: "10001",
        COMMONFORGE_RUNNER_CHECK_NETWORK: checkNetwork,
        COMMONFORGE_RUNNER_WRANGLER: "/usr/local/bin/wrangler",
        // review I-3: the runner adds this key to its own git and control-plane requests only
        COMMONFORGE_RUNNER_EGRESS_KEY_FILE: "/workspace/jobs/runner-key",
        // integrate: the registry key of the runner's own dependency install (apps/runner/src/install.ts)
        ...(npmKey ? { COMMONFORGE_RUNNER_NPM_KEY_FILE: "/workspace/jobs/npm-key" } : {}),
        // non-secret env for check/recipe commands: installs go through the npm gateway over plain HTTP
        COMMONFORGE_RUNNER_CHECK_ENV: JSON.stringify({ PNPM_CONFIG_REGISTRY: `http://${NPM_HOST}/`, NPM_CONFIG_REGISTRY: `http://${NPM_HOST}/`, NODE_EXTRA_CA_CERTS: CA }),
        COMMONFORGE_PREVIEW_BASE_URL: `${this.env.COMMONFORGE_PREVIEW_URL.replace(/\/+$/, "")}/p`,
      };
      const proc = await this.c.exec(["commonforge-runner", "run", "/workspace/jobs/delivery.json", "--worker-url", this.env.COMMONFORGE_WORKER_URL, "--runner-id", `sandbox-${sj.jobId}`], { env });
      const out = await proc.output();
      const stdout = new TextDecoder().decode(out.stdout);
      const stderr = new TextDecoder().decode(out.stderr);
      let ok: boolean | null = null;
      let code: string | undefined;
      try {
        const r = JSON.parse(stdout) as { ok?: boolean; code?: string };
        ok = r.ok ?? null;
        code = r.code;
      } catch {
        /* no JSON result */
      }
      return { ...base, exitCode: out.exitCode, ok, ...(code ? { code } : {}), networkNamespaces: netns, checkNetwork, stderrTail: stderr.slice(-4000), ms: Date.now() - t0 };
    } finally {
      for (const t of minted) {
        await this.control("/api/runner/credential/revoke", { signedJob: sj, tokenId: t.tokenId }).catch(() => undefined);
      }
      if (this.ctx.container?.running) await this.ctx.container.destroy().catch(() => undefined);
    }
  }
}

/** Post a failure result for a job that will never report one (no secret involved: the SignedJob authenticates). */
async function reportLost(env: RunnerEnv, signedJob: unknown, detail: string): Promise<void> {
  const jobId = (signedJob as { jobId?: string })?.jobId;
  if (!jobId) return;
  try {
    const res = await env.CONTROL.fetch(
      new Request(`${env.COMMONFORGE_WORKER_URL.replace(/\/+$/, "")}/api/runner/results`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ signedJob, result: { jobId, ok: false, code: "provider_unavailable", detail } }),
      }),
    );
    await res.body?.cancel();
  } catch (e) {
    console.error(`could not report lost job ${jobId}: ${(e as Error)?.message ?? e}`);
  }
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true, service: "commonforge-runner" });
    return new Response("commonforge-runner: queue consumer only\n", { status: 404 });
  },
  /** `commonforge-runner-jobs` consumer: one container per job; retried while the job is still valid. */
  async queue(batch: MessageBatch, env: RunnerEnv): Promise<void> {
    for (const m of batch.messages) {
      const body = m.body as { signedJob?: { jobId?: string; expiresAt?: string } };
      const jobId = body?.signedJob?.jobId;
      const exp = Date.parse(body?.signedJob?.expiresAt ?? "");
      if (!jobId || !Number.isFinite(exp) || Date.now() >= exp) {
        m.ack();
        continue;
      }
      try {
        const r = await env.RUNNER_BOX.getByName(jobId).run(body as { signedJob: unknown });
        console.log(JSON.stringify({ runnerBox: { ...r, stderrTail: r.stderrTail.slice(-1500) } }));
        // the runner died before reporting: report the failure ourselves (review R-1; a result the
        // runner did post wins: the control plane applies one result per job)
        if (r.ok === null) await reportLost(env, body.signedJob, `the runner ended without a result (exit ${r.exitCode ?? "none"})`);
        m.ack();
      } catch (e) {
        console.error(`runner box ${jobId} failed: ${(e as Error)?.message ?? e}`);
        if (m.attempts < 3) m.retry({ delaySeconds: 15 });
        else {
          await reportLost(env, body.signedJob, `the Sandbox gave up after ${m.attempts} attempts: ${String((e as Error)?.message ?? e).slice(0, 300)}`);
          m.ack();
        }
      }
    }
  },
} satisfies ExportedHandler<RunnerEnv>;
