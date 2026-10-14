/**
 * REST transport (Node runner/CLI, or a Worker without a binding for the namespace).
 * Endpoints verified live in spikes/artifacts-behavior and Task 12 probes (2026-10-06).
 */
import { ArtifactsProviderError, redactSecrets } from './errors.js';
import type {
  ArtifactsCommit,
  ArtifactsCreatedRepo,
  ArtifactsRepoInfo,
  ArtifactsTokenInfo,
  ArtifactsTokenMinted,
  ArtifactsTransport,
  ArtifactsTreeItem,
} from './artifacts-transport.js';

export interface RestArtifactsTransportOptions {
  accountId: string;
  /** Cloudflare API token with Artifacts: Edit. Secret: never logged, redacted from every error. */
  apiToken: string;
  /** default `https://api.cloudflare.com/client/v4` */
  apiBase?: string;
  fetch?: typeof fetch;
  /** backoff before each retry of a transient `403 10004` (default 250 ms, then 1 s); tests pass zeros */
  accessDeniedRetryDelaysMs?: readonly number[];
}

/**
 * Artifacts REST intermittently answers `403` with envelope code `10004` ("Access denied") to a
 * valid token for a few seconds (seen live on the CI deployment, Task 23 B5 / review I2). The
 * request is retried, then classified `provider_unavailable` (503), never a permanent error.
 */
export const ACCESS_DENIED_CODE = 10004;

interface Envelope<T> {
  success?: boolean;
  result?: T;
  errors?: Array<{ code?: number; message?: string }>;
  result_info?: { page?: number; per_page?: number; total_pages?: number; count?: number };
}

interface RawRepo {
  id: string;
  name: string;
  default_branch?: string;
  remote: string;
  source?: string | null;
  read_only?: boolean;
  token?: string;
}

const enc = encodeURIComponent;

export class RestArtifactsTransport implements ArtifactsTransport {
  readonly kind = 'rest' as const;
  readonly #accountId: string;
  readonly #apiToken: string;
  readonly #apiBase: string;
  readonly #fetch: typeof fetch;
  readonly #deniedDelays: readonly number[];

  constructor(opts: RestArtifactsTransportOptions) {
    if (!/^[0-9a-f]{32}$/.test(opts.accountId)) throw new ArtifactsProviderError('invalid_input', 'accountId must be 32 hex chars');
    if (!opts.apiToken) throw new ArtifactsProviderError('invalid_input', 'apiToken is required');
    this.#accountId = opts.accountId;
    this.#apiToken = opts.apiToken;
    this.#apiBase = (opts.apiBase ?? 'https://api.cloudflare.com/client/v4').replace(/\/+$/, '');
    this.#fetch = opts.fetch ?? ((input, init) => fetch(input, init));
    this.#deniedDelays = opts.accessDeniedRetryDelaysMs ?? [250, 1000];
  }

  #url(namespace: string, path: string): string {
    return `${this.#apiBase}/accounts/${this.#accountId}/artifacts/namespaces/${enc(namespace)}${path}`;
  }

  #redact(s: string): string {
    return redactSecrets(s, [this.#apiToken, this.#accountId]);
  }

  async #request(method: string, namespace: string, path: string, body?: unknown): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.#fetch(this.#url(namespace, path), {
          method,
          headers: {
            Authorization: `Bearer ${this.#apiToken}`,
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch (e) {
        throw new ArtifactsProviderError('provider_unavailable', `${method} ${path}: network error: ${this.#redact(String(e))}`);
      }
      // a 403 means nothing was done (also for the token-mint POST), so every method may retry
      if (res.status !== 403 || attempt >= this.#deniedDelays.length || !(await isAccessDenied(res))) return res;
      await res.body?.cancel();
      await new Promise((r) => setTimeout(r, this.#deniedDelays[attempt]));
    }
  }

  async #fail(method: string, path: string, res: Response, parsed?: Envelope<unknown>): Promise<never> {
    let detail = '';
    let codes: number[] = [];
    try {
      const env = parsed ?? ((await res.json()) as Envelope<unknown>);
      codes = (env.errors ?? []).map((e) => e.code ?? 0);
      detail = (env.errors ?? []).map((e) => `${e.code ?? '?'} ${e.message ?? ''}`.trim()).join('; ');
    } catch {
      detail = res.statusText;
    }
    const msg = this.#redact(`${method} ${path} → ${res.status}${detail ? `: ${detail}` : ''}`);
    // 5xx and 429 (rate limit: 2,000 req/10 s per namespace) are retryable; 2xx with success:false is not.
    // a 403 10004 still there after #request's retries is the transient platform denial (I2)
    const denied = res.status === 403 && codes.includes(ACCESS_DENIED_CODE);
    if (denied) console.warn(`artifacts: ${this.#redact(`${method} ${path}`)} still answers 403 10004 after retries; treating it as unavailable`);
    const retryable = res.status >= 500 || res.status === 429 || denied;
    const code = retryable ? 'provider_unavailable' : res.status === 404 ? 'not_found' : res.status === 409 ? 'already_exists' : 'provider_error';
    const retryAfter = res.headers.get('retry-after');
    throw new ArtifactsProviderError(code, msg, { errorCodes: codes, ...(retryAfter ? { retryAfter } : {}) }, denied ? 503 : res.status);
  }

  async #json<T>(method: string, namespace: string, path: string, body?: unknown, opts: { nullOn404?: boolean } = {}): Promise<{ result: T; env: Envelope<T> } | null> {
    const res = await this.#request(method, namespace, path, body);
    if (res.status === 404 && opts.nullOn404) {
      await res.body?.cancel();
      return null;
    }
    if (!res.ok) return this.#fail(method, path, res);
    let env: Envelope<T>;
    try {
      env = (await res.json()) as Envelope<T>;
    } catch {
      throw new ArtifactsProviderError('provider_error', this.#redact(`${method} ${path} → ${res.status}: response is not JSON`), {}, res.status);
    }
    if (env.success === false) return this.#fail(method, path, res, env);
    return { result: env.result as T, env };
  }

  async createRepo(namespace: string, name: string, opts: { description?: string; defaultBranch?: string } = {}): Promise<ArtifactsCreatedRepo> {
    const r = await this.#json<RawRepo>('POST', namespace, '/repos', {
      name,
      default_branch: opts.defaultBranch ?? 'main',
      ...(opts.description ? { description: opts.description } : {}),
    });
    const raw = r!.result;
    if (!raw.token) throw new ArtifactsProviderError('provider_error', 'create returned no token');
    return { ...toRepoInfo(raw), token: raw.token };
  }

  async getRepo(namespace: string, name: string): Promise<ArtifactsRepoInfo | null> {
    const r = await this.#json<RawRepo>('GET', namespace, `/repos/${enc(name)}`, undefined, { nullOn404: true });
    return r ? toRepoInfo(r.result) : null;
  }

  async deleteRepo(namespace: string, name: string): Promise<boolean> {
    const path = `/repos/${enc(name)}`;
    const res = await this.#request('DELETE', namespace, path);
    if (res.status === 404) {
      await res.body?.cancel();
      return false;
    }
    if (!res.ok) return this.#fail('DELETE', path, res);
    await res.body?.cancel();
    return true;
  }

  async createToken(namespace: string, repo: string, scope: 'read' | 'write', ttlSeconds: number): Promise<ArtifactsTokenMinted> {
    const r = await this.#json<{ id: string; plaintext: string; scope: 'read' | 'write'; expires_at: string }>('POST', namespace, '/tokens', {
      repo,
      scope,
      ttl: ttlSeconds,
    });
    const t = r!.result;
    return { id: t.id, plaintext: t.plaintext, scope: t.scope, expiresAt: t.expires_at };
  }

  async listTokens(namespace: string, repo: string): Promise<ArtifactsTokenInfo[]> {
    const out: ArtifactsTokenInfo[] = [];
    const perPage = 100;
    for (let page = 1; page <= 100; page++) {
      const r = await this.#json<Array<{ id: string; scope: 'read' | 'write'; state: 'active' | 'expired' | 'revoked'; expires_at: string; created_at?: string }>>(
        'GET',
        namespace,
        `/repos/${enc(repo)}/tokens?state=all&per_page=${perPage}&page=${page}`,
      );
      const items = r!.result ?? [];
      for (const t of items) out.push({ id: t.id, scope: t.scope, state: t.state, expiresAt: t.expires_at, ...(t.created_at ? { createdAt: t.created_at } : {}) });
      const totalPages = r!.env.result_info?.total_pages;
      if (items.length < perPage || (totalPages !== undefined && page >= totalPages)) break;
    }
    return out;
  }

  async revokeToken(namespace: string, _repo: string, tokenId: string): Promise<boolean> {
    const path = `/tokens/${enc(tokenId)}`;
    const res = await this.#request('DELETE', namespace, path);
    if (res.status === 404) {
      await res.body?.cancel();
      return false;
    }
    if (!res.ok) return this.#fail('DELETE', path, res);
    await res.body?.cancel();
    return true;
  }

  async log(namespace: string, repo: string, opts: { ref: string; limit?: number }): Promise<ArtifactsCommit[]> {
    const r = await this.#json<ArtifactsCommit[]>(
      'GET',
      namespace,
      `/repos/${enc(repo)}/log?ref=${enc(opts.ref)}&limit=${opts.limit ?? 1}`,
      undefined,
      { nullOn404: true },
    );
    return r?.result ?? [];
  }

  async readCommit(namespace: string, repo: string, sha: string): Promise<ArtifactsCommit | null> {
    const r = await this.#json<ArtifactsCommit>('GET', namespace, `/repos/${enc(repo)}/commit/${enc(sha)}`, undefined, { nullOn404: true });
    return r?.result ?? null;
  }

  async readTree(namespace: string, repo: string, treeSha: string): Promise<ArtifactsTreeItem[] | null> {
    const r = await this.#json<ArtifactsTreeItem[]>('GET', namespace, `/repos/${enc(repo)}/tree/${enc(treeSha)}`, undefined, { nullOn404: true });
    return r?.result ?? null;
  }

  async readFile(namespace: string, repo: string, ref: string, path: string): Promise<Uint8Array | null> {
    const p = `/repos/${enc(repo)}/file?ref=${enc(ref)}&path=${enc(path)}`;
    const res = await this.#request('GET', namespace, p);
    if (res.status === 404) {
      await res.body?.cancel();
      return null;
    }
    if (!res.ok) return this.#fail('GET', p, res);
    return new Uint8Array(await res.arrayBuffer());
  }
}

function toRepoInfo(raw: RawRepo): ArtifactsRepoInfo {
  return {
    id: raw.id,
    name: raw.name,
    defaultBranch: raw.default_branch ?? 'main',
    remote: raw.remote,
    source: raw.source ?? null,
    readOnly: raw.read_only ?? false,
  };
}

async function isAccessDenied(res: Response): Promise<boolean> {
  try {
    const env = (await res.clone().json()) as Envelope<unknown>;
    return (env.errors ?? []).some((e) => e.code === ACCESS_DENIED_CODE);
  } catch {
    return false;
  }
}
