#!/usr/bin/env node
/**
 * Private-preview host for a built Worker bundle (Task 22, plan §F "Preview production-data
 * access", AT-31). Runs inside the preview container (`enableInternet: false`, no outbound
 * interceptors), as the unprivileged check user:
 *
 *   node preview-host.js --bundle /preview/bundles/api/index.js --port 8080 [--vars '{"APP_VERSION":"1.0.0"}']
 *
 * - The bundle's `fetch(request, env, ctx)` gets **fixture bindings only**: `ORDERS` is an
 *   in-memory KV fixture, `PAYMENT_WEBHOOK_URL`/`EMAIL_WEBHOOK_URL` point at an in-process fixture
 *   sink. No production binding, secret or credential exists in this process.
 * - Outbound allowlist: `fetch` is replaced; only the fixture sink (`http://fixtures.invalid/…`)
 *   answers, every other destination is refused (and counted). The container has no network
 *   route either, so this is defence in depth.
 * - `GET /__fixtures` reports the fixture counters (orders written, payments, emails, blocked
 *   outbound) so a reviewer or test can see where side effects went.
 * - Incoming `cookie` and `authorization` headers are dropped before the bundle sees the request.
 *
 * This is a "dev mode" host: Node's WHATWG `Request`/`Response` stand in for workerd. P0 shortcut
 * (recorded in API.md): a bundle that needs Workers-only runtime APIs would not run here.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';

export const FIXTURE_ORIGIN = 'http://fixtures.invalid';

export interface FixtureCounters {
  ordersWritten: number;
  kvWrites: number;
  payments: number;
  emails: number;
  blockedOutbound: number;
  blockedDestinations: string[];
}

export interface WorkerModule {
  fetch(request: Request, env: Record<string, unknown>, ctx: { waitUntil(p: Promise<unknown>): void; passThroughOnException(): void }): Response | Promise<Response>;
}

/** In-memory KV fixture (the subset Workers code commonly uses). */
export function memoryKv(counters: FixtureCounters) {
  const data = new Map<string, string>();
  return {
    data,
    async get(key: string, type?: string) {
      const v = data.get(key);
      if (v === undefined) return null;
      return type === 'json' ? (JSON.parse(v) as unknown) : v;
    },
    async put(key: string, value: string) {
      counters.kvWrites++;
      if (key.startsWith('order:')) counters.ordersWritten++;
      data.set(key, String(value));
    },
    async delete(key: string) {
      data.delete(key);
    },
    async list(options: { prefix?: string } = {}) {
      const keys = [...data.keys()].filter((k) => k.startsWith(options.prefix ?? '')).sort().map((name) => ({ name }));
      return { keys, list_complete: true };
    },
  };
}

/** A fetch that answers only the fixture sink; everything else is refused. */
export function fixtureFetch(counters: FixtureCounters): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === FIXTURE_ORIGIN) {
      if (url.pathname.startsWith('/payments')) counters.payments++;
      else if (url.pathname.startsWith('/email')) counters.emails++;
      return Response.json({ ok: true, fixture: true }, { status: 200 });
    }
    counters.blockedOutbound++;
    if (counters.blockedDestinations.length < 20) counters.blockedDestinations.push(url.origin);
    void init;
    throw new TypeError(`preview outbound blocked: ${url.origin} is not on the preview allowlist`);
  }) as typeof fetch;
}

export interface PreviewHostOptions {
  worker: WorkerModule;
  vars?: Record<string, string>;
}

export interface PreviewHost {
  counters: FixtureCounters;
  env: Record<string, unknown>;
  handle(request: Request): Promise<Response>;
}

/** The host logic (transport-free, so tests can drive it without sockets). */
export function createPreviewHost(options: PreviewHostOptions): PreviewHost {
  const counters: FixtureCounters = { ordersWritten: 0, kvWrites: 0, payments: 0, emails: 0, blockedOutbound: 0, blockedDestinations: [] };
  // fixture bindings ONLY: vars are non-secret strings; resources are fixtures
  const env: Record<string, unknown> = {
    ...(options.vars ?? {}),
    COMMONFORGE_PREVIEW: '1',
    ORDERS: memoryKv(counters),
    PAYMENT_WEBHOOK_URL: `${FIXTURE_ORIGIN}/payments`,
    EMAIL_WEBHOOK_URL: `${FIXTURE_ORIGIN}/email`,
  };
  globalThis.fetch = fixtureFetch(counters);
  const ctx = { waitUntil: (p: Promise<unknown>) => void p.catch(() => undefined), passThroughOnException: () => undefined };
  return {
    counters,
    env,
    async handle(request) {
      const url = new URL(request.url);
      if (url.pathname === '/__fixtures') return Response.json({ fixture: true, counters });
      const headers = new Headers(request.headers);
      headers.delete('cookie');
      headers.delete('authorization');
      const clean = new Request(request.url, {
        method: request.method,
        headers,
        ...(request.method === 'GET' || request.method === 'HEAD' ? {} : { body: await request.arrayBuffer() }),
      });
      try {
        return await options.worker.fetch(clean, env, ctx);
      } catch (e) {
        return Response.json({ error: 'preview_worker_exception', message: String((e as Error)?.message ?? e).slice(0, 500) }, { status: 500 });
      }
    },
  };
}

async function toRequest(req: IncomingMessage): Promise<Request> {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) for (const x of v) headers.append(k, x);
    else if (v !== undefined) headers.set(k, v);
  }
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
  return new Request(`http://preview${req.url ?? '/'}`, { method: req.method ?? 'GET', headers, ...(body && req.method !== 'GET' && req.method !== 'HEAD' ? { body } : {}) });
}

async function send(res: ServerResponse, r: Response): Promise<void> {
  const headers: Record<string, string> = {};
  r.headers.forEach((v, k) => {
    if (k !== 'set-cookie' && k !== 'service-worker-allowed' && k !== 'clear-site-data') headers[k] = v; // never cookies or Service Worker scope (review I-1)
  });
  res.writeHead(r.status, headers);
  res.end(Buffer.from(await r.arrayBuffer()));
}

export function serve(host: PreviewHost, port: number): Server {
  const server = createServer((req, res) => {
    void toRequest(req)
      .then((r) => host.handle(r))
      .then((r) => send(res, r))
      .catch((e: Error) => {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(`preview host error: ${e.message}`);
      });
  });
  server.listen(port, '0.0.0.0');
  return server;
}

async function main(argv: string[]): Promise<void> {
  const arg = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const bundle = arg('--bundle');
  if (!bundle) throw new Error('usage: preview-host --bundle <file.js> [--port 8080] [--vars JSON]');
  const port = Number(arg('--port') ?? 8080);
  const varsRaw = arg('--vars');
  const vars = varsRaw ? (JSON.parse(varsRaw) as Record<string, string>) : {};
  for (const [k, v] of Object.entries(vars)) if (typeof v !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k)) throw new Error(`invalid var ${k}`);
  const mod = (await import(pathToFileURL(bundle).href)) as { default?: WorkerModule };
  if (!mod.default || typeof mod.default.fetch !== 'function') throw new Error('the bundle has no default export with fetch()');
  serve(createPreviewHost({ worker: mod.default, vars }), port);
  process.stdout.write(`preview host listening on ${port}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    process.stderr.write(`preview host: ${(e as Error).message}\n`);
    process.exitCode = 2;
  });
}
