/**
 * In-memory Artifacts control plane (test double for the remote-only binding/REST API).
 * Commits are synthetic; `push` stands in for a `git push` done by an agent or the runner.
 */
import { ArtifactsProviderError } from "@commonforge-org/provider-cloudflare";
import type {
  ArtifactsCommit,
  ArtifactsCreatedRepo,
  ArtifactsRepoInfo,
  ArtifactsTokenInfo,
  ArtifactsTokenMinted,
  ArtifactsTransport,
  ArtifactsTreeItem,
} from "@commonforge-org/provider-cloudflare";
import { sha256HexSync } from "@commonforge-org/core";
import { createHash } from "node:crypto";
import { ImportError, type ArtifactsImporter } from "../../src/services/artifacts.js";

export const ACCOUNT = "0123456789abcdef0123456789abcdef";

export interface FakeRepo {
  info: ArtifactsRepoInfo;
  refs: Map<string, string>;
  tokens: Array<ArtifactsTokenInfo & { plaintext: string; ttl: number }>;
}

let counter = 0;
const sha = (seed: string) => sha256HexSync(`${seed}:${++counter}`).slice(0, 40);

export class FakeArtifacts implements ArtifactsTransport {
  readonly kind = "rest" as const;
  readonly repos = new Map<string, FakeRepo>();
  readonly commits = new Map<string, ArtifactsCommit>();
  readonly trees = new Map<string, ArtifactsTreeItem[]>();
  readonly blobs = new Map<string, Uint8Array>();
  readonly objectsIn = new Map<string, Set<string>>();
  readonly calls: Array<{ op: string; args: unknown[] }> = [];
  /** commit → flat file map (for tests and the fake runner) */
  readonly files = new Map<string, Record<string, string>>();

  static key(ns: string, name: string) {
    return `${ns}/${name}`;
  }

  repo(ns: string, name: string): FakeRepo {
    const r = this.repos.get(FakeArtifacts.key(ns, name));
    if (!r) throw new Error(`fake: no repo ${ns}/${name}`);
    return r;
  }

  findRepo(ns: string, name: string): FakeRepo | undefined {
    return this.repos.get(FakeArtifacts.key(ns, name));
  }

  addRepo(ns: string, name: string, defaultBranch = "main"): FakeRepo {
    const r: FakeRepo = {
      info: { id: `id${++counter}x${name.replace(/[^A-Za-z0-9]/g, "").slice(0, 20)}`, name, defaultBranch, remote: `https://${ACCOUNT}.artifacts.cloudflare.net/git/${ns}/${name}.git`, source: null, readOnly: false },
      refs: new Map(),
      tokens: [],
    };
    this.repos.set(FakeArtifacts.key(ns, name), r);
    this.objectsIn.set(FakeArtifacts.key(ns, name), new Set());
    return r;
  }

  /** Make a commit with nested files; returns its sha. */
  makeCommit(files: Record<string, string>, parents: string[] = []): string {
    const build = (entries: Array<[string, string]>): string => {
      const items: ArtifactsTreeItem[] = [];
      const dirs = new Map<string, Array<[string, string]>>();
      for (const [path, content] of entries) {
        const i = path.indexOf("/");
        if (i < 0) {
          // the real git blob id (the Files tab recognises LFS pointers by it; plan phase 3, P3-2)
          const bytes = new TextEncoder().encode(content);
          const blob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
          this.blobs.set(blob, bytes);
          items.push({ name: path, mode: "100644", hash: blob, type: "blob" });
        } else {
          const d = dirs.get(path.slice(0, i)) ?? [];
          d.push([path.slice(i + 1), content]);
          dirs.set(path.slice(0, i), d);
        }
      }
      for (const [name, sub] of dirs) items.push({ name, mode: "40000", hash: build(sub), type: "tree" });
      items.sort((a, b) => (a.name < b.name ? -1 : 1));
      const t = sha256HexSync(`tree:${JSON.stringify(items)}`).slice(0, 40);
      this.trees.set(t, items);
      return t;
    };
    const treeHash = build(Object.entries(files));
    const s = sha("commit");
    this.commits.set(s, { hash: s, treeHash, message: "c", parents, author: { name: "t", email: "t@t" }, committer: { name: "t", email: "t@t" }, authoredAt: 0, committedAt: 0 });
    this.files.set(s, { ...files });
    return s;
  }

  /** Stand-in for `git push <sha>:refs/heads/<branch>` (also makes `extra` objects reachable). */
  push(ns: string, name: string, branch: string, s: string, extra: string[] = []) {
    this.repo(ns, name).refs.set(branch, s);
    const objs = this.objectsIn.get(FakeArtifacts.key(ns, name))!;
    objs.add(s);
    for (const e of extra) objs.add(e);
    for (const p of this.commits.get(s)?.parents ?? []) objs.add(p);
  }

  /** Make `s` reachable in a repo without moving a branch (e.g. pushed to a custom ref). */
  addObject(ns: string, name: string, s: string) {
    this.objectsIn.get(FakeArtifacts.key(ns, name))!.add(s);
    for (const p of this.commits.get(s)?.parents ?? []) this.objectsIn.get(FakeArtifacts.key(ns, name))!.add(p);
  }

  activeTokens(ns: string, name: string) {
    return this.repo(ns, name).tokens.filter((t) => t.state === "active");
  }

  tokenByPlaintext(plaintext: string): { ns: string; name: string; token: FakeRepo["tokens"][number] } | null {
    for (const [key, r] of this.repos) {
      const t = r.tokens.find((x) => x.plaintext === plaintext);
      if (t) {
        const i = key.lastIndexOf("/");
        return { ns: key.slice(0, i), name: key.slice(i + 1), token: t };
      }
    }
    return null;
  }

  #mint(r: FakeRepo, scope: "read" | "write", ttl: number): ArtifactsTokenMinted {
    const id = `tok${++counter}`;
    const plaintext = `art_v2_x_${sha256HexSync(`secret${counter}`).slice(0, 32)}`;
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
    r.tokens.push({ id, scope, state: "active", expiresAt, plaintext, ttl, createdAt: new Date().toISOString() });
    return { id, plaintext, scope, expiresAt };
  }

  async createRepo(ns: string, name: string, opts: { description?: string; defaultBranch?: string } = {}): Promise<ArtifactsCreatedRepo> {
    this.calls.push({ op: "createRepo", args: [ns, name] });
    if (this.repos.has(FakeArtifacts.key(ns, name))) throw new ArtifactsProviderError("already_exists", "exists", {}, 409);
    const r = this.addRepo(ns, name, opts.defaultBranch ?? "main");
    const tok = this.#mint(r, "write", 86_400);
    return { ...r.info, token: tok.plaintext };
  }

  async getRepo(ns: string, name: string) {
    this.calls.push({ op: "getRepo", args: [ns, name] });
    return this.repos.get(FakeArtifacts.key(ns, name))?.info ?? null;
  }

  async deleteRepo(ns: string, name: string) {
    this.calls.push({ op: "deleteRepo", args: [ns, name] });
    return this.repos.delete(FakeArtifacts.key(ns, name));
  }

  async createToken(ns: string, repo: string, scope: "read" | "write", ttl: number) {
    this.calls.push({ op: "createToken", args: [ns, repo, scope, ttl] });
    const r = this.repos.get(FakeArtifacts.key(ns, repo));
    if (!r) throw new ArtifactsProviderError("not_found", "no repo");
    return this.#mint(r, scope, ttl);
  }

  async listTokens(ns: string, repo: string) {
    // like the REST API: listing the tokens of a deleted repository is a 404
    if (!this.findRepo(ns, repo)) throw new ArtifactsProviderError("not_found", `GET /repos/${repo}/tokens → 404: Repository not found`, undefined, 404);
    return this.repo(ns, repo).tokens.map(({ id, scope, state, expiresAt, createdAt }) => ({ id, scope, state, expiresAt, ...(createdAt ? { createdAt } : {}) }));
  }

  async revokeToken(ns: string, repo: string, id: string) {
    this.calls.push({ op: "revokeToken", args: [ns, repo, id] });
    const t = this.repos.get(FakeArtifacts.key(ns, repo))?.tokens.find((x) => x.id === id && x.state === "active");
    if (!t) return false;
    t.state = "revoked";
    return true;
  }

  async log(ns: string, repo: string, opts: { ref: string; limit?: number }) {
    const key = FakeArtifacts.key(ns, repo);
    const r = this.repos.get(key);
    if (!r || opts.ref.startsWith("refs/")) return [];
    const s = r.refs.get(opts.ref) ?? (this.objectsIn.get(key)!.has(opts.ref) ? opts.ref : undefined);
    const c = s ? this.commits.get(s) : undefined;
    return c ? [c] : [];
  }

  async readCommit(ns: string, repo: string, s: string) {
    const key = FakeArtifacts.key(ns, repo);
    if (!this.repos.has(key) || !this.objectsIn.get(key)!.has(s)) return null;
    return this.commits.get(s) ?? null;
  }

  async readTree(_ns: string, _repo: string, s: string) {
    return this.trees.get(s) ?? null;
  }

  async readFile(ns: string, repo: string, ref: string, path: string) {
    const [c] = await this.log(ns, repo, { ref });
    if (!c) return null;
    const content = this.files.get(c.hash)?.[path];
    return content === undefined ? null : new TextEncoder().encode(content);
  }
}

/** Fake public-HTTPS importer: `remotes` maps url → { branch → files }. */
export class FakeImporter implements ArtifactsImporter {
  readonly remotes = new Map<string, Record<string, Record<string, string>>>();
  /** errors to throw on the next calls, in order */
  readonly failNext: ImportError[] = [];
  readonly calls: Array<{ ns: string; name: string; url: string; branch: string; depth?: number }> = [];
  constructor(private readonly fake: FakeArtifacts) {}

  async importRepo(ns: string, name: string, source: { url: string; branch: string; depth?: number }): Promise<ArtifactsCreatedRepo> {
    this.calls.push({ ns, name, ...source });
    const err = this.failNext.shift();
    if (err) throw err;
    const branches = this.remotes.get(source.url);
    const files = branches?.[source.branch];
    if (!files) throw new ImportError("import_refused", "only public repositories can be imported");
    if (this.fake.findRepo(ns, name)) throw new ImportError("already_exists", "repo already exists");
    // Artifacts misreports default_branch as "main" (spike A6); the fake does too.
    const r = this.fake.addRepo(ns, name, "main");
    const s = this.fake.makeCommit(files);
    this.fake.push(ns, name, source.branch, s);
    const tok = await this.fake.createToken(ns, name, "write", 86_400);
    return { ...r.info, token: tok.plaintext };
  }
}
