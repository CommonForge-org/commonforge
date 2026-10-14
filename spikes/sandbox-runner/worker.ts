// Task 3 (S3) spike: Sandbox git runner + preview. Deployed as `commonforge-spike-sandbox`.
//
// Routes (workers.dev):
//   POST /broker                 SignedJob -> short-lived Artifacts write token (credential broker)
//   POST /broker/revoke          { signedJob, tokenId } -> revoke
//   POST /run?name=&mode=env|egress&instance=&preview=1   SignedJob -> runs the git job in a container
//   POST /share/<name>?ttl=<s>   (admin bearer) -> per-candidate preview link with expiry
//   GET  /p/<name>/<token>/...   token-gated preview, forwarded to the container's static server
//   DELETE /sandbox/<name>       (admin bearer) -> destroy the container
//
// Never returns or logs token plaintext (see `redact`).
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import {
  GIT_JOB_SCRIPT,
  candidateRefs,
  parseScriptOutput,
  redact,
  verifyJob,
} from "../shared/signed-job.mjs";

interface Env {
  RUNNER: DurableObjectNamespace<SpikeRunner>;
  ARTIFACTS: any; // Artifacts namespace binding (commonforge-spike)
  SPIKE_JOB_KEY: string; // stub HMAC key (spike only)
  SPIKE_ADMIN_TOKEN: string; // wrangler secret, gates /share and DELETE
}

const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PREVIEW_PORT = 8080;
const TOKEN_TTL_S = 300;

// ---------------------------------------------------------------------------
// Credential broker (shared by both runners; the sandbox path calls it in-process)

async function brokerIssue(env: Env, signedJob: any) {
  const v = await verifyJob(signedJob, env.SPIKE_JOB_KEY);
  if (!v.ok) return v;
  const job = signedJob.job;
  if (job.kind !== "prepare-candidate") {
    return { ok: false, code: "scope_violation", detail: `spike broker only serves prepare-candidate` };
  }
  if (job.canonical.namespace !== "commonforge-spike") {
    return { ok: false, code: "scope_violation", detail: "namespace not served by this broker" };
  }
  const t0 = Date.now();
  const repo = await env.ARTIFACTS.get(job.canonical.repoName);
  const info = await repo.info();
  // Cap the token at min(job expiry, TOKEN_TTL_S); Artifacts min TTL is 60 s.
  const remaining = Math.floor((Date.parse(signedJob.expiresAt) - Date.now()) / 1000);
  const ttl = Math.max(60, Math.min(TOKEN_TTL_S, remaining));
  const tok = await repo.createToken("write", ttl);
  return {
    ok: true,
    token: tok.plaintext as string,
    tokenId: tok.id as string,
    expiresAt: tok.expiresAt as string,
    remote: info.remote as string,
    brokerMs: Date.now() - t0,
  };
}

async function brokerRevoke(env: Env, signedJob: any, tokenId: string) {
  const v = await verifyJob(signedJob, env.SPIKE_JOB_KEY, 0); // revoke allowed after expiry
  if (!v.ok) return v;
  const repo = await env.ARTIFACTS.get(signedJob.job.canonical.repoName);
  const t0 = Date.now();
  const revoked = await repo.revokeToken(tokenId);
  return { ok: true, revoked, revokeMs: Date.now() - t0 };
}

// ---------------------------------------------------------------------------
// Egress gateway: the container's git talks plain HTTPS to the Artifacts host
// with NO credentials; this entrypoint (per-job props) adds the bearer header.

type GatewayProps = { host: string; repoPath: string; token: string; allowPush: boolean };

export class ArtifactsGitGateway extends WorkerEntrypoint<Env, GatewayProps> {
  override async fetch(request: Request): Promise<Response> {
    const p = this.ctx.props as GatewayProps | undefined;
    if (!p?.token) return new Response("gateway has no props", { status: 500 });
    const url = new URL(request.url);
    const svc = url.searchParams.get("service");
    const base = p.repoPath; // /git/<ns>/<repo>.git
    const allowed =
      url.hostname === p.host &&
      ((request.method === "GET" &&
        url.pathname === `${base}/info/refs` &&
        (svc === "git-upload-pack" || (p.allowPush && svc === "git-receive-pack"))) ||
        (request.method === "POST" &&
          (url.pathname === `${base}/git-upload-pack` ||
            (p.allowPush && url.pathname === `${base}/git-receive-pack`))));
    if (!allowed) return new Response("Forbidden by spike gateway", { status: 403 });
    const headers = new Headers(request.headers);
    headers.set("Authorization", `Bearer ${p.token}`);
    url.protocol = "https:";
    return fetch(new Request(url, { method: request.method, headers, body: request.body, redirect: "manual" }));
  }
}

// ---------------------------------------------------------------------------
// Durable Object that owns one container (one per candidate / preview name).

export class SpikeRunner extends DurableObject<Env> {
  private ready = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const c = ctx.container;
    if (c?.running) void ctx.blockConcurrencyWhile(() => c.setInactivityTimeout(10 * 60_000));
  }

  private get c(): Container {
    const c = this.ctx.container;
    if (!c) throw new Error("container binding not configured");
    return c;
  }

  /** Starts the container if needed; returns cold-start ms (null if already warm). */
  private async ensureStarted(enableInternet: boolean, instance?: string): Promise<{ coldStartMs: number | null; startToExecMs?: number }> {
    if (this.c.running) return { coldStartMs: null };
    const t0 = Date.now();
    const opts: any = { image: this.c.images.runner, enableInternet };
    if (instance) opts.instance = instance;
    this.c.start(opts);
    await this.c.setInactivityTimeout(10 * 60_000);
    // exec() waits for a container that is still starting: first `true` = ready.
    const p = await this.c.exec(["true"]);
    await p.output();
    this.ready = false;
    return { coldStartMs: Date.now() - t0 };
  }

  private async sh(script: string, env: Record<string, string>) {
    const t0 = Date.now();
    const p = await this.c.exec(["bash", "-c", script], { env: { HOME: "/root", ...env } });
    const out = await p.output();
    const dec = new TextDecoder();
    return {
      exitCode: out.exitCode,
      stdout: dec.decode(out.stdout),
      stderr: dec.decode(out.stderr),
      wallMs: Date.now() - t0,
    };
  }

  async runJob(signedJob: any, opts: { mode: "env" | "egress"; instance?: string; runTag: string; preview: boolean }) {
    const tAll = Date.now();
    const timings: Record<string, number | null | undefined> = {};

    const cred: any = await brokerIssue(this.env, signedJob);
    if (!cred.ok) return { jobId: signedJob?.jobId, ok: false, code: cred.code, detail: cred.detail };
    timings.brokerMs = cred.brokerMs;
    const remoteUrl = new URL(cred.remote);

    try {
      if (opts.mode === "egress") {
        // Register before start so git's very first request is covered.
        const gw = (this.ctx as any).exports.ArtifactsGitGateway({
          props: { host: remoteUrl.hostname, repoPath: remoteUrl.pathname, token: cred.token, allowPush: true } satisfies GatewayProps,
        });
        const ti = Date.now();
        await this.c.interceptOutboundHttps(remoteUrl.hostname, gw);
        timings.interceptMs = Date.now() - ti;
      }
      const start = await this.ensureStarted(opts.mode === "env", opts.instance);
      timings.coldStartMs = start.coldStartMs;

      // Measure bare exec round-trip on the (now) warm container.
      const te = Date.now();
      await (await this.c.exec(["true"])).output();
      timings.execRoundTripMs = Date.now() - te;

      const job = signedJob.job;
      const refs = candidateRefs(job, opts.runTag);
      const env: Record<string, string> = {
        REMOTE: cred.remote,
        WORKDIR: "/workspace/repo",
        RUN_TAG: opts.runTag,
        RUNNER: `sandbox-${opts.mode}`,
        JOB_ID: signedJob.jobId,
        CANONICAL_REF: refs.canonicalRef,
        RETENTION_REF: refs.retentionRef,
      };
      if (opts.mode === "env") env.T = cred.token; // per-exec env only; not in image, not in start() env
      else env.GIT_SSL_CAINFO = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";

      const r = await this.sh(GIT_JOB_SCRIPT, env);
      const parsed = parseScriptOutput(r.stdout);
      Object.assign(timings, Object.fromEntries(Object.entries(parsed.phases).map(([k, v]) => [`${k}Ms`, v])));
      timings.gitScriptWallMs = r.wallMs;

      // Did the token leak into the container's environment or files?
      // The needle is passed as an argv (not env), so the checking processes'
      // own /proc/*/environ cannot contain it.
      const lp = await this.c.exec(
        ["bash", "-c", 'grep -lsF -- "$1" /proc/[0-9]*/environ /workspace/repo/.git/config /root/.gitconfig 2>/dev/null; true', "_", cred.token.split("?")[0].slice(-16)],
        { env: { HOME: "/root" } },
      );
      const leak = { stdout: new TextDecoder().decode((await lp.output()).stdout) };

      if (r.exitCode !== 0 || !parsed.sha) {
        return {
          jobId: signedJob.jobId,
          ok: false,
          code: "provider_unavailable",
          detail: redact(`git job exit ${r.exitCode}: ${r.stderr}${r.stdout}`, cred.token),
          timings,
        };
      }

      // Confirm via the binding that Artifacts sees the pushed commit.
      const tv = Date.now();
      const repo = await this.env.ARTIFACTS.get(job.canonical.repoName);
      const commit = await repo.readCommit(parsed.sha);
      timings.verifyReadCommitMs = Date.now() - tv;

      let preview: any = null;
      if (opts.preview) preview = await this.startPreview();

      timings.totalMs = Date.now() - tAll;
      return {
        jobId: signedJob.jobId,
        ok: true,
        receipt: { candidateId: job.candidate.candidateId, canonicalRef: refs.canonicalRef, retentionRef: refs.retentionRef, sha: parsed.sha },
        verifiedByBinding: !!commit && commit.hash === parsed.sha,
        tokenInContainer: leak.stdout.trim() ? leak.stdout.trim().split("\n") : [],
        mode: opts.mode,
        instance: opts.instance ?? "default",
        timings,
        preview,
      };
    } finally {
      const rv: any = await brokerRevoke(this.env, signedJob, cred.tokenId);
      timings.revokeMs = rv.revokeMs;
    }
  }

  async startPreview() {
    const t0 = Date.now();
    // Background process: do not await output(); it lives as long as the container.
    await this.c.exec(["node", "/opt/spike/static-server.mjs", "/workspace/repo", String(PREVIEW_PORT)], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const deadline = Date.now() + 30_000;
    this.ready = false;
    while (!this.ready && Date.now() < deadline) {
      try {
        const res = await this.c.getTcpPort(PREVIEW_PORT).fetch("http://container/", { signal: AbortSignal.timeout(1_000) });
        await res.body?.cancel();
        this.ready = true;
      } catch {
        await scheduler.wait(250);
      }
    }
    return { ready: this.ready, serverReadyMs: Date.now() - t0 };
  }

  async share(ttlMs: number): Promise<{ token: string; expiresAt: number }> {
    const token = crypto.randomUUID().replaceAll("-", "");
    const expiresAt = Date.now() + ttlMs;
    await this.ctx.storage.put(`share:${token}`, expiresAt);
    return { token, expiresAt };
  }

  async isShared(token: string): Promise<boolean> {
    const key = `share:${token}`;
    const exp = await this.ctx.storage.get<number>(key);
    if (exp !== undefined && exp <= Date.now()) {
      await this.ctx.storage.delete(key);
      return false;
    }
    return exp !== undefined;
  }

  /** Admin probe (spike only): run a command in the running container. */
  async probe(cmd: string[]) {
    if (!this.ctx.container?.running) return { error: "not running" };
    const t0 = Date.now();
    const p = await this.c.exec(cmd, { env: { HOME: "/root" } });
    const out = await p.output();
    const dec = new TextDecoder();
    return { exitCode: out.exitCode, stdout: redact(dec.decode(out.stdout)), stderr: redact(dec.decode(out.stderr)), ms: Date.now() - t0 };
  }

  async status() {
    return { running: this.ctx.container?.running ?? false, info: this.ctx.container?.running ? await this.c.inspect() : null };
  }

  async stop() {
    if (this.ctx.container?.running) await this.ctx.container.destroy();
    this.ready = false;
    await this.ctx.storage.deleteAll();
  }

  override async fetch(request: Request): Promise<Response> {
    if (!this.ctx.container?.running) return new Response("preview not running", { status: 503 });
    try {
      return await this.c.getTcpPort(PREVIEW_PORT).fetch(request);
    } catch (e) {
      return new Response(`preview not responding: ${String(e)}`, { status: 502 });
    }
  }
}

// ---------------------------------------------------------------------------

function isAdmin(request: Request, env: Env) {
  const h = request.headers.get("authorization") ?? "";
  return env.SPIKE_ADMIN_TOKEN && h === `Bearer ${env.SPIKE_ADMIN_TOKEN}`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/broker" && request.method === "POST") {
      const r: any = await brokerIssue(env, await request.json());
      return Response.json(r, { status: r.ok ? 200 : 403 });
    }
    if (url.pathname === "/broker/revoke" && request.method === "POST") {
      const body: any = await request.json();
      const r: any = await brokerRevoke(env, body.signedJob, body.tokenId);
      return Response.json(r, { status: r.ok ? 200 : 403 });
    }

    if (url.pathname === "/run" && request.method === "POST") {
      const name = url.searchParams.get("name") ?? "cand-spike-0001";
      if (!NAME_RE.test(name)) return new Response("bad name", { status: 400 });
      const mode = url.searchParams.get("mode") === "egress" ? "egress" : "env";
      const instance = url.searchParams.get("instance") ?? undefined;
      const runTag = `${mode}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`;
      const signedJob = await request.json();
      const stub = env.RUNNER.getByName(name);
      try {
        const r = await stub.runJob(signedJob, { mode, instance, runTag, preview: url.searchParams.get("preview") === "1" });
        return Response.json(r, { status: (r as any).ok ? 200 : 422 });
      } catch (e) {
        return Response.json({ ok: false, code: "provider_unavailable", detail: redact(String((e as Error)?.stack ?? e)) }, { status: 500 });
      }
    }

    const share = /^\/share\/([a-z0-9-]+)$/.exec(url.pathname);
    if (share && request.method === "POST") {
      if (!isAdmin(request, env)) return new Response("unauthorized", { status: 401 });
      const ttl = Number(url.searchParams.get("ttl") ?? "3600");
      const { token, expiresAt } = await env.RUNNER.getByName(share[1]!).share(ttl * 1000);
      return Response.json({ url: `${url.origin}/p/${share[1]}/${token}/`, expiresAt: new Date(expiresAt).toISOString() });
    }

    const probe = /^\/sandbox\/([a-z0-9-]+)\/exec$/.exec(url.pathname);
    if (probe && request.method === "POST") {
      if (!isAdmin(request, env)) return new Response("unauthorized", { status: 401 });
      const body: any = await request.json();
      return Response.json(await env.RUNNER.getByName(probe[1]!).probe(body.cmd));
    }

    const status = /^\/sandbox\/([a-z0-9-]+)$/.exec(url.pathname);
    if (status) {
      if (!isAdmin(request, env)) return new Response("unauthorized", { status: 401 });
      const stub = env.RUNNER.getByName(status[1]!);
      if (request.method === "DELETE") {
        await stub.stop();
        return new Response(null, { status: 204 });
      }
      return Response.json(await stub.status());
    }

    const p = /^\/p\/([a-z0-9-]+)\/([a-f0-9]{32})(\/.*)?$/.exec(url.pathname);
    if (p) {
      const stub = env.RUNNER.getByName(p[1]!);
      if (!(await stub.isShared(p[2]!))) return new Response("Not found", { status: 404 });
      if (!p[3]) return Response.redirect(`${url.origin}${url.pathname}/`, 308);
      return stub.fetch(new Request(`http://container${p[3]}${url.search}`, request));
    }

    return new Response("commonforge-spike-sandbox: see spikes/sandbox-runner/worker.ts", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
