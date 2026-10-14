/**
 * In-memory Artifacts control plane for unit tests. Commits are synthetic; `push` stands in for a
 * git push done by an agent or the runner (the provider itself never writes).
 */
import { ArtifactsProviderError } from '../src/errors.js';
import type {
  ArtifactsCommit,
  ArtifactsCreatedRepo,
  ArtifactsRepoInfo,
  ArtifactsTokenInfo,
  ArtifactsTokenMinted,
  ArtifactsTransport,
  ArtifactsTreeItem,
} from '../src/artifacts-transport.js';

export const ACCOUNT = '0123456789abcdef0123456789abcdef';

export interface FakeRepo {
  info: ArtifactsRepoInfo;
  refs: Map<string, string>;
  tokens: Array<ArtifactsTokenInfo & { plaintext: string; ttl: number }>;
}

let counter = 0;
const hex = (n: number, seed: string) => {
  let h = 0;
  for (const ch of `${seed}:${n}`) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return (h.toString(16).padStart(8, '0') + n.toString(16).padStart(8, '0')).repeat(3).slice(0, 40);
};

export class FakeArtifacts implements ArtifactsTransport {
  readonly kind = 'rest' as const;
  readonly repos = new Map<string, FakeRepo>();
  /** object store shared by all repos (sha → commit); `objectsIn` tracks reachability per repo */
  readonly commits = new Map<string, ArtifactsCommit>();
  readonly trees = new Map<string, ArtifactsTreeItem[]>();
  readonly blobs = new Map<string, Uint8Array>();
  readonly objectsIn = new Map<string, Set<string>>();
  readonly calls: Array<{ op: string; args: unknown[] }> = [];
  /** test hooks */
  failCreate: Array<'5xx-created' | '5xx-not-created'> = [];
  /** number of upcoming getRepo calls that fail with 5xx (only for `failGetName` when set) */
  failGet = 0;
  failGetName?: string;
  /** called before createRepo does anything (inject a concurrent creator) */
  beforeCreate?: (ns: string, name: string) => void;
  /** called after listTokens computed its snapshot (inject concurrent mints) */
  afterListTokens?: (repoKey: string) => void;
  onRevoke?: (repoKey: string) => void;
  onLog?: (repoKey: string, n: number) => string | undefined;
  #logCount = new Map<string, number>();

  static key(ns: string, name: string) {
    return `${ns}/${name}`;
  }

  repo(ns: string, name: string): FakeRepo {
    const r = this.repos.get(FakeArtifacts.key(ns, name));
    if (!r) throw new Error(`fake: no repo ${ns}/${name}`);
    return r;
  }

  /** Seed a repo directly (test setup). */
  addRepo(ns: string, name: string, defaultBranch = 'main'): FakeRepo {
    const r: FakeRepo = {
      info: { id: `id${++counter}x${name.replace(/[^A-Za-z0-9]/g, '').slice(0, 20)}`, name, defaultBranch, remote: `https://${ACCOUNT}.artifacts.cloudflare.net/git/${ns}/${name}.git`, source: null, readOnly: false },
      refs: new Map(),
      tokens: [],
    };
    this.repos.set(FakeArtifacts.key(ns, name), r);
    this.objectsIn.set(FakeArtifacts.key(ns, name), new Set());
    return r;
  }

  /** Make a commit object with the given files (flat; one level of dirs) and return its sha. */
  makeCommit(files: Record<string, string>, parents: string[] = [], seed = 'c'): string {
    const n = ++counter;
    const root: ArtifactsTreeItem[] = [];
    const dirs = new Map<string, ArtifactsTreeItem[]>();
    for (const [path, content] of Object.entries(files)) {
      const blob = hex(n * 1000 + root.length + dirs.size, `${seed}blob${path}${content}`);
      this.blobs.set(blob, new TextEncoder().encode(content));
      const [first, ...rest] = path.split('/');
      if (rest.length) {
        const d = dirs.get(first!) ?? [];
        d.push({ name: rest.join('/'), mode: '100644', hash: blob, type: 'blob' });
        dirs.set(first!, d);
      } else root.push({ name: first!, mode: '100644', hash: blob, type: 'blob' });
    }
    for (const [name, items] of dirs) {
      const t = hex(n * 1000 + 500 + root.length, `${seed}tree${name}${JSON.stringify(items)}`);
      this.trees.set(t, items);
      root.push({ name, mode: '40000', hash: t, type: 'tree' });
    }
    const treeHash = hex(n, `${seed}root${JSON.stringify(root)}`);
    this.trees.set(treeHash, root);
    const sha = hex(n, `${seed}commit`);
    this.commits.set(sha, { hash: sha, treeHash, message: seed, parents, author: { name: 't', email: 't@t' }, committer: { name: 't', email: 't@t' }, authoredAt: 0, committedAt: 0 });
    return sha;
  }

  /** Stand-in for `git push <sha>:refs/heads/<branch>`. */
  push(ns: string, name: string, branch: string, sha: string) {
    this.repo(ns, name).refs.set(branch, sha);
    this.objectsIn.get(FakeArtifacts.key(ns, name))!.add(sha);
  }

  activeTokens(ns: string, name: string) {
    return this.repo(ns, name).tokens.filter((t) => t.state === 'active');
  }

  async createRepo(ns: string, name: string, opts: { description?: string; defaultBranch?: string } = {}): Promise<ArtifactsCreatedRepo> {
    this.calls.push({ op: 'createRepo', args: [ns, name, opts] });
    this.beforeCreate?.(ns, name);
    const mode = this.failCreate.shift();
    if (mode === '5xx-not-created') throw new ArtifactsProviderError('provider_unavailable', 'fake 500', {}, 500);
    if (this.repos.has(FakeArtifacts.key(ns, name))) throw new ArtifactsProviderError('already_exists', 'exists', {}, 409);
    const r = this.addRepo(ns, name, opts.defaultBranch ?? 'main');
    const tok = this.#mint(r, 'write', 86_400);
    if (mode === '5xx-created') throw new ArtifactsProviderError('provider_unavailable', 'fake 500 after create', {}, 500);
    return { ...r.info, token: tok.plaintext };
  }

  async getRepo(ns: string, name: string) {
    this.calls.push({ op: 'getRepo', args: [ns, name] });
    if (this.failGet > 0 && (this.failGetName === undefined || this.failGetName === name)) {
      this.failGet--;
      throw new ArtifactsProviderError('provider_unavailable', 'fake 500 on get', {}, 500);
    }
    return this.repos.get(FakeArtifacts.key(ns, name))?.info ?? null;
  }

  async deleteRepo(ns: string, name: string) {
    this.calls.push({ op: 'deleteRepo', args: [ns, name] });
    return this.repos.delete(FakeArtifacts.key(ns, name));
  }

  /** Mint directly (a concurrent caller), bypassing the call log. */
  mint(ns: string, name: string, scope: 'read' | 'write', ttl = 3600, createdAt?: string) {
    const t = this.#mint(this.repo(ns, name), scope, ttl);
    if (createdAt) this.repo(ns, name).tokens.find((x) => x.id === t.id)!.createdAt = createdAt;
    return t;
  }

  #mint(r: FakeRepo, scope: 'read' | 'write', ttl: number): ArtifactsTokenMinted {
    const id = `tok${++counter}`;
    const plaintext = `art_v2_x_${hex(counter, 'secret')}?expires=1`;
    const expiresAt = new Date(Date.UTC(2026, 9, 6) + ttl * 1000).toISOString();
    r.tokens.push({ id, scope, state: 'active', expiresAt, plaintext, ttl, createdAt: new Date(Date.UTC(2026, 9, 6, 12)).toISOString() });
    return { id, plaintext, scope, expiresAt };
  }

  async createToken(ns: string, repo: string, scope: 'read' | 'write', ttl: number) {
    this.calls.push({ op: 'createToken', args: [ns, repo, scope, ttl] });
    const r = this.repos.get(FakeArtifacts.key(ns, repo));
    if (!r) throw new ArtifactsProviderError('not_found', 'no repo');
    return this.#mint(r, scope, ttl);
  }

  async listTokens(ns: string, repo: string) {
    this.calls.push({ op: 'listTokens', args: [ns, repo] });
    const snapshot = this.repo(ns, repo).tokens.map(({ id, scope, state, expiresAt, createdAt }) => ({ id, scope, state, expiresAt, ...(createdAt ? { createdAt } : {}) }));
    this.afterListTokens?.(FakeArtifacts.key(ns, repo));
    return snapshot;
  }

  async revokeToken(ns: string, repo: string, id: string) {
    this.calls.push({ op: 'revokeToken', args: [ns, repo, id] });
    const r = this.repos.get(FakeArtifacts.key(ns, repo));
    const t = r?.tokens.find((x) => x.id === id && x.state === 'active');
    if (!t) return false;
    t.state = 'revoked';
    this.onRevoke?.(FakeArtifacts.key(ns, repo));
    return true;
  }

  async log(ns: string, repo: string, opts: { ref: string; limit?: number }) {
    this.calls.push({ op: 'log', args: [ns, repo, opts] });
    const key = FakeArtifacts.key(ns, repo);
    const n = (this.#logCount.get(key) ?? 0) + 1;
    this.#logCount.set(key, n);
    const override = this.onLog?.(key, n);
    const r = this.repos.get(key);
    if (!r) return [];
    if (opts.ref.startsWith('refs/')) return []; // spike A5
    const sha = override ?? r.refs.get(opts.ref) ?? (this.objectsIn.get(key)!.has(opts.ref) ? opts.ref : undefined);
    const c = sha ? this.commits.get(sha) : undefined;
    return c ? [c] : [];
  }

  async readCommit(ns: string, repo: string, sha: string) {
    this.calls.push({ op: 'readCommit', args: [ns, repo, sha] });
    const key = FakeArtifacts.key(ns, repo);
    if (!this.repos.has(key) || !this.objectsIn.get(key)!.has(sha)) return null;
    return this.commits.get(sha) ?? null;
  }

  async readTree(_ns: string, _repo: string, sha: string) {
    return this.trees.get(sha) ?? null;
  }

  async readFile(ns: string, repo: string, ref: string, path: string) {
    const key = FakeArtifacts.key(ns, repo);
    const sha = this.repos.get(key)?.refs.get(ref) ?? ref;
    if (!this.objectsIn.get(key)?.has(sha)) return null;
    let items = this.trees.get(this.commits.get(sha)!.treeHash)!;
    const segs = path.split('/');
    for (let i = 0; i < segs.length; i++) {
      const it = items.find((x) => x.name === (i === segs.length - 1 ? segs[i] : segs[i]));
      if (!it) {
        // flat dir entries store "rest" names
        const rest = items.find((x) => x.name === segs.slice(i).join('/'));
        return rest ? this.blobs.get(rest.hash) ?? null : null;
      }
      if (it.type === 'tree') items = this.trees.get(it.hash)!;
      else return i === segs.length - 1 ? this.blobs.get(it.hash) ?? null : null;
    }
    return null;
  }
}
