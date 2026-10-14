/**
 * Workers binding transport (`env.ARTIFACTS`). A binding is bound to exactly one namespace
 * (`artifacts: [{ binding, namespace }]` in wrangler config), so this transport takes a map or a
 * resolver from namespace to binding. A namespace without a binding is refused with
 * `binding_missing`; use the REST transport for those.
 *
 * The structural interfaces below are the subset of `Artifacts` / `ArtifactsRepo` from
 * `@cloudflare/workers-types` that the provider uses (the conformance is checked at compile time
 * in test/artifacts-binding.test.ts), so the package's public types do not depend on the
 * workers-types globals.
 */
import { ArtifactsProviderError } from './errors.js';
import type {
  ArtifactsCommit,
  ArtifactsCreatedRepo,
  ArtifactsRepoInfo,
  ArtifactsTokenInfo,
  ArtifactsTokenMinted,
  ArtifactsTransport,
  ArtifactsTreeItem,
} from './artifacts-transport.js';

interface BlobLike {
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface ArtifactsRepoBindingLike {
  createToken(scope?: 'write' | 'read', ttl?: number): Promise<{ id: string; plaintext: string; scope: 'read' | 'write'; expiresAt: string }>;
  listTokens(): Promise<{ tokens: Array<{ id: string; scope: 'read' | 'write'; state: 'active' | 'expired' | 'revoked'; expiresAt: string; createdAt: string }> }>;
  revokeToken(tokenOrId: string): Promise<boolean>;
  info(): Promise<{ id: string; name: string; defaultBranch: string; remote: string; source: string | null; readOnly: boolean }>;
  readTree(hash: string): Promise<ArtifactsTreeItem[] | null>;
  readCommit(hash: string): Promise<ArtifactsCommit | null>;
  readFile(args: { ref: string; path: string }): Promise<BlobLike | null>;
  log(opts?: { ref?: string; limit?: number; offset?: number }): Promise<ArtifactsCommit[]>;
}

export interface ArtifactsBindingLike {
  create(
    name: string,
    opts?: { readOnly?: boolean; description?: string; setDefaultBranch?: string },
  ): Promise<{ id: string; name: string; defaultBranch: string; remote: string; token: string }>;
  get(name: string): Promise<ArtifactsRepoBindingLike>;
  delete(name: string): Promise<boolean>;
}

export type ArtifactsBindingResolver =
  | Readonly<Record<string, ArtifactsBindingLike>>
  | ((namespace: string) => ArtifactsBindingLike | undefined);

/** `ArtifactsError.code` values that mean "retry after lookup". */
const TRANSIENT = new Set(['INTERNAL_ERROR', 'CREATE_IN_PROGRESS', 'FORK_IN_PROGRESS', 'IMPORT_IN_PROGRESS', 'UPSTREAM_UNAVAILABLE']);

function errCode(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null && 'code' in e && typeof (e as { code: unknown }).code === 'string'
    ? (e as { code: string }).code
    : undefined;
}

function mapError(op: string, e: unknown): ArtifactsProviderError {
  if (e instanceof ArtifactsProviderError) return e;
  const code = errCode(e);
  const msg = `${op}: ${code ?? 'error'}: ${e instanceof Error ? e.message : String(e)}`;
  if (code === 'NOT_FOUND') return new ArtifactsProviderError('not_found', msg);
  if (code === 'ALREADY_EXISTS') return new ArtifactsProviderError('already_exists', msg);
  if (code && TRANSIENT.has(code)) return new ArtifactsProviderError('provider_unavailable', msg, { bindingCode: code });
  if (code === 'INVALID_INPUT' || code === 'INVALID_REPO_NAME' || code === 'INVALID_TTL') return new ArtifactsProviderError('invalid_input', msg);
  return new ArtifactsProviderError('provider_error', msg);
}

function dispose(stub: unknown): void {
  const sym = (Symbol as unknown as { dispose?: symbol }).dispose;
  if (!sym || typeof stub !== 'object' || stub === null) return;
  const fn = (stub as Record<symbol, unknown>)[sym];
  if (typeof fn === 'function') {
    try {
      (fn as () => void).call(stub);
    } catch {
      /* already released */
    }
  }
}

export class BindingArtifactsTransport implements ArtifactsTransport {
  readonly kind = 'binding' as const;
  readonly #resolve: (namespace: string) => ArtifactsBindingLike | undefined;

  constructor(bindings: ArtifactsBindingResolver) {
    this.#resolve = typeof bindings === 'function' ? bindings : (ns) => (Object.hasOwn(bindings, ns) ? bindings[ns] : undefined);
  }

  #ns(namespace: string): ArtifactsBindingLike {
    const b = this.#resolve(namespace);
    if (!b) throw new ArtifactsProviderError('binding_missing', `no Artifacts binding for namespace ${namespace}`, { namespace });
    return b;
  }

  /** Run `fn` with a repo stub; `null` when the repo does not exist. The stub is always disposed. */
  async #withRepo<T>(namespace: string, name: string, op: string, fn: (repo: ArtifactsRepoBindingLike) => Promise<T>): Promise<T | null> {
    const ns = this.#ns(namespace);
    let repo: ArtifactsRepoBindingLike;
    try {
      repo = await ns.get(name);
    } catch (e) {
      if (errCode(e) === 'NOT_FOUND') return null;
      throw mapError(`${op} get ${name}`, e);
    }
    try {
      return await fn(repo);
    } catch (e) {
      if (errCode(e) === 'NOT_FOUND') return null;
      throw mapError(`${op} ${name}`, e);
    } finally {
      dispose(repo);
    }
  }

  async #requireRepo<T>(namespace: string, name: string, op: string, fn: (repo: ArtifactsRepoBindingLike) => Promise<T>): Promise<T> {
    const r = await this.#withRepo(namespace, name, op, async (repo) => ({ v: await fn(repo) }));
    if (r === null) throw new ArtifactsProviderError('not_found', `${op}: repo ${name} not found in ${namespace}`);
    return r.v;
  }

  async createRepo(namespace: string, name: string, opts: { description?: string; defaultBranch?: string } = {}): Promise<ArtifactsCreatedRepo> {
    try {
      const r = await this.#ns(namespace).create(name, {
        setDefaultBranch: opts.defaultBranch ?? 'main',
        ...(opts.description ? { description: opts.description } : {}),
      });
      return { id: r.id, name: r.name, defaultBranch: r.defaultBranch, remote: r.remote, source: null, readOnly: false, token: r.token };
    } catch (e) {
      throw mapError(`create ${name}`, e);
    }
  }

  async getRepo(namespace: string, name: string): Promise<ArtifactsRepoInfo | null> {
    return this.#withRepo(namespace, name, 'info', async (repo) => {
      const i = await repo.info();
      return { id: i.id, name: i.name, defaultBranch: i.defaultBranch, remote: i.remote, source: i.source, readOnly: i.readOnly };
    });
  }

  async deleteRepo(namespace: string, name: string): Promise<boolean> {
    try {
      return await this.#ns(namespace).delete(name);
    } catch (e) {
      if (errCode(e) === 'NOT_FOUND') return false;
      throw mapError(`delete ${name}`, e);
    }
  }

  async createToken(namespace: string, repo: string, scope: 'read' | 'write', ttlSeconds: number): Promise<ArtifactsTokenMinted> {
    return this.#requireRepo(namespace, repo, 'createToken', async (r) => {
      const t = await r.createToken(scope, ttlSeconds);
      return { id: t.id, plaintext: t.plaintext, scope: t.scope, expiresAt: t.expiresAt };
    });
  }

  async listTokens(namespace: string, repo: string): Promise<ArtifactsTokenInfo[]> {
    return this.#requireRepo(namespace, repo, 'listTokens', async (r) =>
      (await r.listTokens()).tokens.map((t) => ({ id: t.id, scope: t.scope, state: t.state, expiresAt: t.expiresAt, createdAt: t.createdAt })),
    );
  }

  async revokeToken(namespace: string, repo: string, tokenId: string): Promise<boolean> {
    return (await this.#withRepo(namespace, repo, 'revokeToken', (r) => r.revokeToken(tokenId))) ?? false;
  }

  async log(namespace: string, repo: string, opts: { ref: string; limit?: number }): Promise<ArtifactsCommit[]> {
    return (await this.#withRepo(namespace, repo, 'log', (r) => r.log({ ref: opts.ref, limit: opts.limit ?? 1 }))) ?? [];
  }

  async readCommit(namespace: string, repo: string, sha: string): Promise<ArtifactsCommit | null> {
    return this.#withRepo(namespace, repo, 'readCommit', (r) => r.readCommit(sha));
  }

  async readTree(namespace: string, repo: string, treeSha: string): Promise<ArtifactsTreeItem[] | null> {
    return this.#withRepo(namespace, repo, 'readTree', (r) => r.readTree(treeSha));
  }

  async readFile(namespace: string, repo: string, ref: string, path: string): Promise<Uint8Array | null> {
    return this.#withRepo(namespace, repo, 'readFile', async (r) => {
      const blob = await r.readFile({ ref, path });
      return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
    });
  }
}
