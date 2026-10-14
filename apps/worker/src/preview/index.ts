/**
 * `commonforge-preview`: the dedicated preview Worker (Task 22). Deployed with
 * `wrangler deploy -c wrangler.preview.jsonc`; see handler.ts for the routing and the AT-37
 * boundary, and API.md "Previews" for the trust model.
 *
 * `PreviewBox` (one Durable Object + container per preview) runs the preview's api bundle with the
 * runner image's `preview-host.js`: `enableInternet: false`, **no outbound interceptors at all**
 * (so no route to any production service, credential or the Artifacts host), the host process as
 * the unprivileged `cfcheck` user, fixture bindings only (AT-31).
 */
import { DurableObject } from "cloudflare:workers";
import type { PreviewMeta } from "../lib/preview-token.js";
import { previewPrefix } from "../lib/preview-token.js";
import { handlePreviewRequest } from "./handler.js";

export interface PreviewEnv {
  COMMONFORGE_ASSETS: R2Bucket;
  PREVIEW_BOX: DurableObjectNamespace<PreviewBox>;
  COMMONFORGE_PREVIEW_KEY: string;
}

const PORT = 8080;
const HOST = "/opt/commonforge-runner/dist/preview-host.js";
const CHUNK = 48 * 1024; // base64 chars per exec env value (well under the 128 KiB per-string limit)
const META_HEADER = "x-commonforge-preview-meta";
const REL_RE = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

export class PreviewBox extends DurableObject<PreviewEnv> {
  private starting: Promise<void> | null = null;
  private servedPreview: string | null = null;

  private get c(): Container {
    const c = this.ctx.container;
    if (!c) throw new Error("container binding not configured");
    return c;
  }

  private async exec(cmd: string[], opts: { env?: Record<string, string>; user?: string } = {}) {
    const p = await this.c.exec(cmd, { env: { HOME: "/tmp", PATH: "/usr/local/bin:/usr/bin:/bin", ...(opts.env ?? {}) }, ...(opts.user ? { user: opts.user } : {}) });
    const out = await p.output();
    if (out.exitCode !== 0) throw new Error(`${cmd[0]} exited ${out.exitCode}: ${new TextDecoder().decode(out.stderr).slice(0, 300)}`);
    return out;
  }

  /** Copy the bundle from R2 into the container (root-owned, world-readable), chunked through exec env. */
  private async writeBundle(meta: PreviewMeta, name: string): Promise<void> {
    const prefix = `${previewPrefix(meta.orgId, meta.previewId)}bundles/${name}/`;
    let cursor: string | undefined;
    do {
      const page = await this.env.COMMONFORGE_ASSETS.list({ prefix, ...(cursor ? { cursor } : {}) });
      for (const o of page.objects) {
        const rel = o.key.slice(prefix.length);
        if (!REL_RE.test(rel) || rel.split("/").includes("..")) continue;
        const obj = await this.env.COMMONFORGE_ASSETS.get(o.key);
        if (!obj) continue;
        const bytes = new Uint8Array(await obj.arrayBuffer());
        let bin = "";
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        const b64 = btoa(bin);
        const path = `/preview/bundles/${name}/${rel}`;
        await this.exec(["sh", "-c", 'mkdir -p "$(dirname "$P")" && : > "$P" && chmod 0644 "$P"'], { env: { P: path } });
        for (let i = 0; i < b64.length; i += CHUNK) {
          await this.exec(["sh", "-c", 'printf %s "$B" | base64 -d >> "$P"'], { env: { P: path, B: b64.slice(i, i + CHUNK) } });
        }
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }

  private async start(meta: PreviewMeta): Promise<void> {
    let phase = "start";
    try {
      await this.startPhases(meta, (p) => (phase = p));
    } catch (e) {
      throw new Error(`${phase}: ${String((e as Error)?.message ?? e)}`);
    }
  }

  private async startPhases(meta: PreviewMeta, at: (phase: string) => void): Promise<void> {
    if (!this.c.running) {
      // no internet and no interceptors: the preview has no route to anything outside its container
      this.c.start({ image: this.c.images.runner!, enableInternet: false, instance: "standard-1" });
      await this.exec(["true"]);
    }
    at("inactivity-timeout");
    await this.c.setInactivityTimeout(10 * 60_000);
    const name = meta.bundles[0]!;
    at("write-bundle");
    await this.writeBundle(meta, name);
    at("start-host");
    // the host runs as the unprivileged check user; vars are non-secret (fixture bindings are added by the host)
    // (exec's `user` option is refused by the runtime; drop privileges with setpriv like the runner does)
    await this.c.exec(["setpriv", "--reuid=10001", "--regid=10001", "--clear-groups", "--inh-caps=-all", "--", "node", HOST, "--bundle", `/preview/bundles/${name}/index.js`, "--port", String(PORT), "--vars", JSON.stringify(meta.hostVars)], {
      env: { HOME: "/tmp", PATH: "/usr/local/bin:/usr/bin:/bin", NODE_ENV: "production" },
      stdout: "ignore",
      stderr: "ignore",
    });
    at("wait-host");
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        const r = await this.c.getTcpPort(PORT).fetch("http://preview/__fixtures", { signal: AbortSignal.timeout(1_000) });
        await r.body?.cancel();
        if (r.ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error("the preview host did not start");
      await scheduler.wait(200);
    }
    this.servedPreview = meta.previewId;
  }

  /** Internal only (reachable through the PREVIEW_BOX binding, never from the internet). */
  override async fetch(request: Request): Promise<Response> {
    const raw = request.headers.get(META_HEADER);
    if (!raw) return new Response("missing preview meta", { status: 400 });
    const meta = JSON.parse(decodeURIComponent(raw)) as PreviewMeta;
    const headers = new Headers(request.headers);
    headers.delete(META_HEADER);
    return this.serve(meta, new Request(request.url, { method: request.method, headers, ...(request.method === "GET" || request.method === "HEAD" ? {} : { body: await request.arrayBuffer() }) }));
  }

  async serve(meta: PreviewMeta, request: Request): Promise<Response> {
    if (!(meta.expiresAt > Date.now())) return new Response("expired", { status: 404 });
    try {
      if (!this.c.running || this.servedPreview !== meta.previewId) {
        this.starting ??= this.start(meta).finally(() => {
          this.starting = null;
        });
        await this.starting;
      }
      return await this.c.getTcpPort(PORT).fetch(request);
    } catch (e) {
      const msg = String((e as Error)?.message ?? e).slice(0, 300);
      console.error(`preview box ${meta.previewId}: ${msg}`);
      return new Response(`preview api unavailable: ${msg}`, { status: 502 });
    }
  }
}

export default {
  async fetch(request: Request, env: PreviewEnv): Promise<Response> {
    return handlePreviewRequest(request, {
      bucket: env.COMMONFORGE_ASSETS,
      key: env.COMMONFORGE_PREVIEW_KEY,
      // plain DO fetch (the Request travels as an HTTP request; the meta in an internal header)
      box: (orgId, previewId) => ({
        serve: async (meta, req) => {
          const headers = new Headers(req.headers);
          headers.set(META_HEADER, encodeURIComponent(JSON.stringify(meta)));
          return env.PREVIEW_BOX.getByName(`${orgId}:${previewId}`).fetch(new Request(req.url, { method: req.method, headers, ...(req.method === "GET" || req.method === "HEAD" ? {} : { body: await req.arrayBuffer() }) }));
        },
      }),
      now: () => Date.now(),
    });
  },
} satisfies ExportedHandler<PreviewEnv>;
