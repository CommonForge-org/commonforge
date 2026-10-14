// LFS spike Worker (folders-and-uploads phase 1). Deployed as `commonforge-spike-lfs`.
//
// Routes (all but GET / need `Authorization: Bearer <SPIKE_TOKEN>`; /lfs/* also accepts Basic with that password):
//   POST   /repos/:name                          create-or-reuse Artifacts repo lfs-<name> -> { remote, token }
//   GET    /repos                                list repo names in the namespace (teardown)
//   DELETE /repos/:name                          delete Artifacts repo lfs-<name> (teardown; only lfs-* names)
//   POST   /lfs/:repo/info/lfs/objects/batch     Git LFS batch API with presigned R2 URLs (key lfs/<repo>/<oid>)
//   POST   /lfs/:repo/verify                     LFS verify action (binding head())
//   POST   /mp/create?key=                       R2 multipart: -> { uploadId }
//   PUT    /mp/part?key=&uploadId=&n=            -> { etag } (body <= 50 MiB)
//   POST   /mp/complete?key=&uploadId=           { parts } -> { size }
//   POST   /mp/abort?key=&uploadId=
//   POST   /exec                                 { script, env? } -> { exitCode, stdout, stderr, ms }
//   POST   /presign-test                         { key, method: PUT|GET, expiresSeconds } -> { url } (spike-only; key under lfs/)
//   GET    /head?key=                            { size, etag } | 404
//   DELETE /objects?prefix=lfs/...               teardown
//   GET    /                                     page.html (multipart upload test page)
import { DurableObject } from "cloudflare:workers";
import { presign } from "./presign.ts";
// @ts-ignore wrangler bundles .html as a text module
import page from "./page.html";

interface Env {
  RUNNER: DurableObjectNamespace<LfsRunner>;
  ARTIFACTS: any; // Artifacts namespace binding (commonforge-spike-lfs)
  BUCKET: R2Bucket;
  ACCOUNT_ID: string;
  BUCKET_NAME: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  SPIKE_TOKEN: string;
}

const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const OID_RE = /^[0-9a-f]{64}$/;
const MAX_PART = 52_428_800; // 50 MiB
const MAX_OUTPUT = 64 * 1024;
const PRESIGN_TTL_S = 900;
const ARTIFACTS_TOKEN_TTL_S = 3600;
const LFS_JSON = "application/vnd.git-lfs+json";

// ---------------------------------------------------------------------------
// Container Durable Object (plumbing copied from spikes/sandbox-runner/worker.ts).

export class LfsRunner extends DurableObject<Env> {
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

  private async ensureStarted(): Promise<void> {
    if (this.c.running) return;
    // Internet on (the container reaches this Worker and R2); standard-1, never the lite default.
    this.c.start({ image: this.c.images.runner, enableInternet: true, instance: "standard-1" } as any);
    await this.c.setInactivityTimeout(10 * 60_000);
    // exec() waits for a container that is still starting: first `true` = ready.
    await (await this.c.exec(["true"])).output();
  }

  async run(script: string, env: Record<string, string>) {
    await this.ensureStarted();
    const t0 = Date.now();
    const p = await this.c.exec(["bash", "-c", script], { env: { HOME: "/root", ...env } });
    const out = await p.output();
    const dec = new TextDecoder();
    return { exitCode: out.exitCode, stdout: dec.decode(out.stdout), stderr: dec.decode(out.stderr), ms: Date.now() - t0 };
  }
}

// ---------------------------------------------------------------------------

function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  return ea.byteLength === eb.byteLength && crypto.subtle.timingSafeEqual(ea, eb);
}

function authorized(request: Request, env: Env, allowBasic: boolean): boolean {
  if (!env.SPIKE_TOKEN) return false;
  const h = request.headers.get("authorization") ?? "";
  if (h.startsWith("Bearer ")) return safeEqual(h.slice(7), env.SPIKE_TOKEN);
  if (allowBasic && h.startsWith("Basic ")) {
    try {
      const decoded = atob(h.slice(6));
      const i = decoded.indexOf(":");
      return i >= 0 && safeEqual(decoded.slice(i + 1), env.SPIKE_TOKEN);
    } catch {
      return false;
    }
  }
  return false;
}

function redact(s: string, env: Env, extra: string[] = []): string {
  for (const secret of [env.R2_SECRET_ACCESS_KEY, env.R2_ACCESS_KEY_ID, env.SPIKE_TOKEN, ...extra]) {
    if (secret) s = s.split(secret).join("[redacted]");
  }
  return s;
}

const clip = (s: string) => (s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n[truncated at ${MAX_OUTPUT} bytes]` : s);

const lfsJson = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": LFS_JSON } });

const isNotFound = (e: any) => e?.code === "NOT_FOUND" || /not.?found/i.test(String(e?.message ?? ""));

// ---------------------------------------------------------------------------

async function repoRoute(env: Env, name: string): Promise<Response> {
  if (!NAME_RE.test(name)) return new Response("bad name", { status: 400 });
  const repoName = `lfs-${name}`;
  let repo: any;
  let info: any;
  try {
    repo = await env.ARTIFACTS.get(repoName);
    info = await repo.info();
  } catch (e) {
    if (!isNotFound(e)) throw e;
    await env.ARTIFACTS.create(repoName, { setDefaultBranch: "main" });
    repo = await env.ARTIFACTS.get(repoName);
    info = await repo.info();
  }
  const tok = await repo.createToken("write", ARTIFACTS_TOKEN_TTL_S);
  return Response.json({ repo: repoName, remote: info.remote as string, token: tok.plaintext as string, expiresAt: tok.expiresAt });
}

async function lfsBatch(request: Request, env: Env, origin: string, repo: string): Promise<Response> {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return lfsJson({ message: "bad json" }, 400);
  }
  const op = body?.operation;
  if ((op !== "upload" && op !== "download") || !Array.isArray(body.objects)) return lfsJson({ message: "bad batch request" }, 422);
  const authz = request.headers.get("authorization") ?? "";
  const objects = [];
  for (const o of body.objects as Array<{ oid: string; size: number }>) {
    if (!OID_RE.test(o?.oid ?? "") || !Number.isInteger(o.size) || o.size < 0) {
      objects.push({ oid: o?.oid, size: o?.size, error: { code: 422, message: "bad oid or size" } });
      continue;
    }
    const key = `lfs/${repo}/${o.oid}`;
    const head = await env.BUCKET.head(key);
    const common = { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY, accountId: env.ACCOUNT_ID, bucket: env.BUCKET_NAME, key, expiresSeconds: PRESIGN_TTL_S };
    if (op === "download") {
      if (!head) {
        objects.push({ oid: o.oid, size: o.size, error: { code: 404, message: "object not found" } });
        continue;
      }
      const href = await presign({ ...common, method: "GET" });
      objects.push({ oid: o.oid, size: o.size, authenticated: true, actions: { download: { href, expires_in: PRESIGN_TTL_S } } });
    } else if (head && head.size === o.size) {
      objects.push({ oid: o.oid, size: o.size }); // already stored: no actions, per the LFS spec
    } else {
      const href = await presign({ ...common, method: "PUT" });
      objects.push({
        oid: o.oid,
        size: o.size,
        authenticated: true,
        actions: {
          upload: { href, expires_in: PRESIGN_TTL_S },
          verify: { href: `${origin}/lfs/${repo}/verify`, header: { Authorization: authz }, expires_in: PRESIGN_TTL_S },
        },
      });
    }
  }
  return lfsJson({ transfer: "basic", hash_algo: "sha256", objects });
}

async function lfsVerify(request: Request, env: Env, repo: string): Promise<Response> {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return lfsJson({ message: "bad json" }, 400);
  }
  if (!OID_RE.test(body?.oid ?? "")) return lfsJson({ message: "bad oid" }, 422);
  const head = await env.BUCKET.head(`lfs/${repo}/${body.oid}`);
  return head && head.size === body.size ? lfsJson({}) : lfsJson({ message: "missing or size mismatch" }, 422);
}

async function multipart(request: Request, env: Env, url: URL, action: string): Promise<Response> {
  const key = url.searchParams.get("key");
  if (!key) return new Response("key required", { status: 400 });
  if (action === "create" && request.method === "POST") {
    const mp = await env.BUCKET.createMultipartUpload(key);
    return Response.json({ uploadId: mp.uploadId });
  }
  const uploadId = url.searchParams.get("uploadId");
  if (!uploadId) return new Response("uploadId required", { status: 400 });
  const mp = env.BUCKET.resumeMultipartUpload(key, uploadId);
  if (action === "part" && request.method === "PUT") {
    const n = Number(url.searchParams.get("n"));
    if (!Number.isInteger(n) || n < 1 || n > 10_000) return new Response("bad part number", { status: 400 });
    const len = request.headers.get("content-length");
    if (len !== null && Number(len) > MAX_PART) return new Response("part too large", { status: 413 });
    let body: ReadableStream | ArrayBuffer | null = request.body;
    if (len === null) {
      body = await request.arrayBuffer(); // no length header: buffer so we can still enforce the cap
      if (body.byteLength > MAX_PART) return new Response("part too large", { status: 413 });
    }
    const part = await mp.uploadPart(n, body ?? new ArrayBuffer(0));
    return Response.json({ etag: part.etag });
  }
  if (action === "complete" && request.method === "POST") {
    const { parts } = (await request.json()) as { parts: R2UploadedPart[] };
    const obj = await mp.complete(parts);
    return Response.json({ size: obj.size });
  }
  if (action === "abort" && request.method === "POST") {
    await mp.abort();
    return new Response(null, { status: 204 });
  }
  return new Response("not found", { status: 404 });
}

async function deleteObjects(env: Env, prefix: string): Promise<number> {
  let deleted = 0;
  let cursor: string | undefined;
  do {
    const l = await env.BUCKET.list({ prefix, cursor, limit: 1000 });
    const keys = l.objects.map((o) => o.key);
    if (keys.length) await env.BUCKET.delete(keys);
    deleted += keys.length;
    cursor = l.truncated ? l.cursor : undefined;
  } while (cursor);
  return deleted;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/" && request.method === "GET") {
      return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    const lfs = /^\/lfs\/([a-z0-9-]+)\/(info\/lfs\/objects\/batch|verify)$/.exec(path);
    if (!authorized(request, env, !!lfs)) {
      const h: Record<string, string> = {};
      if (lfs) {
        h["LFS-Authenticate"] = 'Basic realm="spike"';
        h["WWW-Authenticate"] = 'Basic realm="spike"';
      }
      return new Response("unauthorized", { status: 401, headers: h });
    }

    try {
      if (lfs && request.method === "POST") {
        return lfs[2] === "verify" ? await lfsVerify(request, env, lfs[1]!) : await lfsBatch(request, env, url.origin, lfs[1]!);
      }

      const repo = /^\/repos\/([^/]+)$/.exec(path);
      if (repo && request.method === "POST") return await repoRoute(env, repo[1]!);
      if (repo && request.method === "DELETE") {
        // Teardown: the name is the suffix, so only lfs-* repos can be deleted.
        if (!NAME_RE.test(repo[1]!)) return new Response("bad name", { status: 400 });
        const repoName = `lfs-${repo[1]}`;
        try {
          return Response.json({ repo: repoName, deleted: await env.ARTIFACTS.delete(repoName) });
        } catch (e) {
          if (isNotFound(e)) return Response.json({ repo: repoName, deleted: false, notFound: true });
          throw e;
        }
      }
      if (path === "/repos" && request.method === "GET") {
        const names: string[] = [];
        let cursor: string | undefined;
        do {
          const l = await env.ARTIFACTS.list({ limit: 100, cursor });
          for (const r of l.repos) names.push(r.name);
          cursor = l.cursor && l.repos.length ? l.cursor : undefined;
        } while (cursor);
        return Response.json({ repos: names });
      }

      const mp = /^\/mp\/(create|part|complete|abort)$/.exec(path);
      if (mp) return await multipart(request, env, url, mp[1]!);

      if (path === "/exec" && request.method === "POST") {
        const body: any = await request.json();
        if (typeof body?.script !== "string") return new Response("script required", { status: 400 });
        const execEnv: Record<string, string> = body.env && typeof body.env === "object" ? body.env : {};
        const r = await env.RUNNER.getByName("main").run(body.script, execEnv);
        // Redact the Worker's secrets plus any (long enough) value the caller passed in env.
        const extra = Object.values(execEnv).filter((v) => typeof v === "string" && v.length >= 12);
        return Response.json({ exitCode: r.exitCode, stdout: clip(redact(r.stdout, env, extra)), stderr: clip(redact(r.stderr, env, extra)), ms: r.ms });
      }

      if (path === "/presign-test" && request.method === "POST") {
        // Spike-only: lets run.mjs mint short-lived / arbitrary-key URLs for the negative checks (q2).
        const b: any = await request.json();
        const okKey = typeof b?.key === "string" && b.key.startsWith("lfs/") && !b.key.includes("..");
        const okTtl = Number.isInteger(b?.expiresSeconds) && b.expiresSeconds >= 1 && b.expiresSeconds <= 604_800;
        if (!okKey || !okTtl || (b.method !== "PUT" && b.method !== "GET")) return new Response("bad request: key under lfs/, method PUT|GET, expiresSeconds 1..604800", { status: 400 });
        const url = await presign({ accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY, accountId: env.ACCOUNT_ID, bucket: env.BUCKET_NAME, key: b.key, method: b.method, expiresSeconds: b.expiresSeconds });
        return Response.json({ url });
      }

      if (path === "/head" && request.method === "GET") {
        const key = url.searchParams.get("key");
        if (!key) return new Response("key required", { status: 400 });
        const h = await env.BUCKET.head(key);
        return h ? Response.json({ size: h.size, etag: h.etag }) : new Response("not found", { status: 404 });
      }

      if (path === "/objects" && request.method === "DELETE") {
        const prefix = url.searchParams.get("prefix") ?? "";
        if (!prefix.startsWith("lfs/")) return new Response("prefix must start with lfs/", { status: 400 });
        return Response.json({ deleted: await deleteObjects(env, prefix) });
      }
    } catch (e) {
      return Response.json({ error: redact(String((e as Error)?.stack ?? e), env) }, { status: 500 });
    }

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
