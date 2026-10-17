/** Local Artifacts transport compatibility over REAL LocalGitProvider bare repos and smart HTTP. */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPath, hashCanonicalSync, IdSegmentSchema, localRevisionId, parseRevisionId, type ResourceRef } from '@commonforge-org/core';
import { LocalGitProvider } from '@commonforge-org/provider-local-git';
import { ArtifactsProviderError, type ArtifactsCommit, type ArtifactsCreatedRepo, type ArtifactsRepoInfo, type ArtifactsTokenInfo, type ArtifactsTokenMinted, type ArtifactsTransport, type ArtifactsTreeItem } from '@commonforge-org/provider-cloudflare';
import { createGit, RUNNER_IDENTITY_ENV } from './git.js';
interface Repo { ns: string; name: string; resource: ResourceRef; info: ArtifactsRepoInfo; tokens: Array<ArtifactsTokenInfo & { plaintext: string }> }
export class RealLocalArtifacts implements ArtifactsTransport {
  readonly kind = 'rest' as const;
  readonly repos = new Map<string, Repo>();
  readonly git = createGit({ allowFile: true });
  baseUrl = '';
  constructor(readonly provider: LocalGitProvider, readonly stateDir: string) {}
  private repo(ns: string, name: string) { const r = this.repos.get(`${ns}/${name}`); if (!r) throw new ArtifactsProviderError('not_found', 'local repository not found'); return r; }
  private remote(r: Repo) { if (r.resource.coords.kind !== 'local-git') throw new Error('local coords required'); return r.resource.coords.remoteUrl; }
  private path(r: Repo) { return fileURLToPath(this.remote(r)); }
  private pendingPersist: Promise<void> = Promise.resolve();
  private async persist() {
    const serialized = JSON.stringify([...this.repos]);
    const write = this.pendingPersist.then(async () => {
      const temporary = join(this.stateDir, `registry-${randomBytes(8).toString('hex')}.tmp`);
      await writeFile(temporary, serialized, { mode: 0o600 });
      await rename(temporary, join(this.stateDir, 'registry.json'));
    });
    this.pendingPersist = write.catch(() => undefined); return write;
  }
  async load() {
    try { for (const [key, repo] of JSON.parse(await readFile(join(this.stateDir, 'registry.json'), 'utf8')) as Array<[string, Repo]>) this.repos.set(key, repo); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
  async createRepo(ns: string, name: string, opts: { description?: string; defaultBranch?: string } = {}): Promise<ArtifactsCreatedRepo> {
    IdSegmentSchema.parse(ns); IdSegmentSchema.parse(name);
    if (this.repos.has(`${ns}/${name}`)) throw new ArtifactsProviderError('already_exists', 'local repository exists');
    const resource = await this.provider.createCanonicalResource({ organizationId: 'local-adapter', resourceId: `r${hashCanonicalSync({ ns, name }).slice(0, 40)}`, branch: opts.defaultBranch ?? 'main' });
    const info = { id: resource.resourceId, name, defaultBranch: opts.defaultBranch ?? 'main', remote: `${this.baseUrl}/git/${ns}/${name}.git`, source: null, readOnly: false };
    const repo: Repo = { ns, name, resource, info, tokens: [] }; this.repos.set(`${ns}/${name}`, repo);
    const token = await this.createToken(ns, name, 'write', 3600); await this.persist();
    return { ...info, token: token.plaintext };
  }
  async getRepo(ns: string, name: string) { return this.repos.get(`${ns}/${name}`)?.info ?? null; }
  async deleteRepo(ns: string, name: string) {
    const repo = this.repos.get(`${ns}/${name}`); if (!repo) return false;
    // Task-owned state only. Provider registry retains historical identity; no reuse after delete.
    await rm(this.path(repo), { recursive: true, force: true }); this.repos.delete(`${ns}/${name}`); await this.persist(); return true;
  }
  async createToken(ns: string, name: string, scope: 'read' | 'write', ttl: number): Promise<ArtifactsTokenMinted> {
    if (!['read', 'write'].includes(scope) || !Number.isInteger(ttl) || ttl < 60 || ttl > 31536000) throw new Error('invalid token grant');
    const token = { id: `tok-${randomBytes(12).toString('hex')}`, plaintext: `art_v2_x_${randomBytes(32).toString('hex')}`, scope, expiresAt: new Date(Date.now() + ttl * 1000).toISOString(), state: 'active' as const, createdAt: new Date().toISOString() };
    this.repo(ns, name).tokens.push(token); await this.persist(); return token;
  }
  async listTokens(ns: string, name: string) { return this.repo(ns, name).tokens.map(({ plaintext: _secret, ...t }) => ({ ...t, state: t.state === 'active' && Date.parse(t.expiresAt) <= Date.now() ? 'expired' as const : t.state })); }
  async revokeToken(ns: string, name: string, id: string) { const t = this.repo(ns, name).tokens.find(t => t.id === id); if (!t) return false; t.state = 'revoked'; await this.persist(); return true; }
  async log(ns: string, name: string, opts: { ref: string; limit?: number }): Promise<ArtifactsCommit[]> {
    if (opts.ref.startsWith('refs/') || opts.ref.startsWith('-') || /[\x00-\x20]/.test(opts.ref)) return [];
    const r = this.repo(ns, name), found = await this.git.run(['rev-parse', '--verify', '--end-of-options', `${opts.ref}^{commit}`], this.path(r));
    if (found.code !== 0) return [];
    const shas = (await this.git.ok(['rev-list', '--first-parent', `--max-count=${Math.min(opts.limit ?? 20, 1000)}`, found.stdout.trim()], this.path(r))).trim().split('\n').filter(Boolean);
    return (await Promise.all(shas.map(s => this.readCommit(ns, name, s)))).filter((c): c is ArtifactsCommit => c !== null);
  }
  async readCommit(ns: string, name: string, sha: string): Promise<ArtifactsCommit | null> {
    if (!/^[a-f0-9]{40,64}$/.test(sha)) return null;
    const r = await this.git.run(['show', '-s', '--format=%H%x00%T%x00%P%x00%an%x00%ae%x00%cn%x00%ce%x00%at%x00%ct%x00%B', sha], this.path(this.repo(ns, name)));
    if (r.code !== 0) return null;
    const [hash, treeHash, parents, an, ae, cn, ce, at, ct, ...msg] = r.stdout.split('\0');
    return { hash: hash!, treeHash: treeHash!, parents: parents ? parents.split(' ') : [], author: { name: an!, email: ae! }, committer: { name: cn!, email: ce! }, authoredAt: Number(at), committedAt: Number(ct), message: msg.join('\0').trimEnd() };
  }
  async readTree(ns: string, name: string, treeSha: string): Promise<ArtifactsTreeItem[] | null> {
    if (!/^[a-f0-9]{40,64}$/.test(treeSha)) return null;
    const r = await this.git.run(['ls-tree', '-z', treeSha], this.path(this.repo(ns, name))); if (r.code !== 0) return null;
    return r.stdout.split('\0').filter(Boolean).map(s => { const tab = s.indexOf('\t'), [mode, type, hash] = s.slice(0, tab).split(' '); return { name: s.slice(tab + 1), mode: mode === '040000' ? '40000' : mode!, hash: hash!, type: mode === '120000' ? 'symlink' : mode === '160000' ? 'gitlink' : mode === '100755' ? 'exec' : type as 'tree' | 'blob' }; });
  }
  async readFile(ns: string, name: string, ref: string, path: string): Promise<Uint8Array | null> {
    if (!checkPath(path).ok) return null; const [commit] = await this.log(ns, name, { ref, limit: 1 }); if (!commit) return null;
    const repo = this.repo(ns, name); return this.provider.readFile(repo.resource, localRevisionId(repo.resource.resourceId, commit.hash), path);
  }
  async seedScheduling(ns: string, name: string) {
    const repo = this.repo(ns, name), seed = join(this.stateDir, `seed-${randomBytes(8).toString('hex')}`); await mkdir(seed);
    try {
      for (const file of ['worker.mjs', 'build.mjs']) await copyFile(new URL(`../../../fixtures/scheduling/${file}`, import.meta.url), join(seed, file));
      await this.git.ok(['init', '-q', '-b', repo.info.defaultBranch], seed); await this.git.ok(['add', '.'], seed);
      await this.git.ok(['commit', '-q', '-m', 'Synthetic scheduling fixture'], seed, { env: RUNNER_IDENTITY_ENV(new Date().toISOString()) });
      await this.git.ok(['push', '-q', this.remote(repo), `HEAD:refs/heads/${repo.info.defaultBranch}`], seed, { env: await this.provider.serviceGitEnv() });
      return { sha: (await this.git.ok(['rev-parse', 'HEAD'], seed)).trim() };
    } finally { await rm(seed, { recursive: true, force: true }); }
  }
  async candidateData(organizationId: string, resourceId: string, revisionId: string, namespacePrefix: string): Promise<Uint8Array> {
    const revision = parseRevisionId(revisionId);
    if (revision.kind !== 'art') throw new Error('expected Artifacts-compatible revision');
    const repo = [...this.repos.values()].find(r => r.info.id === revision.repoId && r.ns === `${namespacePrefix}-${organizationId}-canonical` && r.name === resourceId);
    if (!repo) throw new Error('source scope mismatch');
    const revisionRef = localRevisionId(repo.resource.resourceId, revision.sha);
    const data = await this.provider.readFile(repo.resource, revisionRef, 'worker.mjs') ?? await this.provider.readFile(repo.resource, revisionRef, 'fixtures/scheduling/worker.mjs');
    if (!data) throw new Error('missing candidate module'); return data;
  }
  async gitHttp(req: IncomingMessage, res: ServerResponse, url: URL) {
    const match = /^\/git\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(url.pathname);
    if (!match) { res.writeHead(404); res.end(); return; }
    const repo = this.repo(match[1]!, match[2]!);
    const secret = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
    const token = repo.tokens.find(t => t.plaintext.length === secret.length && timingSafeEqual(Buffer.from(t.plaintext), Buffer.from(secret)));
    const write = match[3] === 'git-receive-pack' || url.searchParams.get('service') === 'git-receive-pack';
    if (!token || token.state !== 'active' || Date.parse(token.expiresAt) <= Date.now() || (write && token.scope !== 'write')) { res.writeHead(403); res.end('repository access denied'); return; }
    const chunks: Buffer[] = []; let count = 0;
    for await (const chunk of req) { count += (chunk as Buffer).length; if (count > 33554432) { res.writeHead(413); res.end(); return; } chunks.push(chunk as Buffer); }
    const body = Buffer.concat(chunks);
    const child = spawn('git', ['http-backend'], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', HOME: '/nonexistent', GIT_PROJECT_ROOT: dirname(this.path(repo)), PATH_INFO: `/${basename(this.path(repo))}/${match[3]}`, QUERY_STRING: url.searchParams.toString(), REQUEST_METHOD: req.method ?? 'GET', CONTENT_TYPE: req.headers['content-type'] ?? '', CONTENT_LENGTH: String(body.length), REMOTE_USER: 'commonforge-local', GIT_HTTP_EXPORT_ALL: '1', COMMONFORGE_TOKEN: await this.provider.serviceToken() }, stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = []; let bytes = 0; const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
    child.stdout.on('data', (b: Buffer) => { bytes += b.length; if (bytes > 67108864) child.kill('SIGKILL'); else out.push(b); }); child.stderr.resume();
    child.once('error', () => { clearTimeout(timer); if (!res.headersSent) { res.writeHead(503); res.end(); } });
    child.once('close', () => { clearTimeout(timer); if (res.headersSent) return; const result = Buffer.concat(out), split = result.indexOf('\r\n\r\n'); if (split < 0) { res.writeHead(503); res.end(); return; } const lines = result.subarray(0, split).toString().split('\r\n'), headers: Record<string, string> = {}; let status = 200; for (const line of lines) { const i = line.indexOf(':'); if (i < 0) continue; const key = line.slice(0, i).toLowerCase(), value = line.slice(i + 1).trim(); if (key === 'status') status = Number(value.slice(0, 3)); else headers[key] = value; } res.writeHead(status, headers); res.end(result.subarray(split + 4)); });
    child.stdin.on('error', () => undefined); child.stdin.end(body);
  }
}
export async function startArtifactsSidecar(options: { stateDir: string; key: string; port?: number }) {
  const stateDir = resolve(options.stateDir); await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const provider = await LocalGitProvider.open({ root: join(stateDir, 'repos'), namespacePrefix: 'commonforge-sidecar' });
  const artifacts = new RealLocalArtifacts(provider, stateDir); await artifacts.load();
  const server = createServer((req, res) => { void (async () => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.headers.origin) { res.writeHead(403); res.end(); return; }
    if (url.pathname.startsWith('/git/')) return artifacts.gitHttp(req, res, url);
    if (req.headers.authorization !== `Bearer ${options.key}` || req.method !== 'POST' || url.pathname !== '/rpc') { res.writeHead(403); res.end(); return; }
    const chunks: Buffer[] = []; let count = 0; for await (const chunk of req) { count += (chunk as Buffer).length; if (count > 1048576) throw new Error('RPC too large'); chunks.push(chunk as Buffer); }
    const { method, args } = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { method: string; args: unknown[] };
    const allowed = ['createRepo', 'getRepo', 'deleteRepo', 'createToken', 'listTokens', 'revokeToken', 'log', 'readCommit', 'readTree', 'readFile', 'seedScheduling'];
    if (!allowed.includes(method) || !Array.isArray(args) || args.length > 4) throw new Error('unsupported RPC');
    const result = await (artifacts[method as keyof RealLocalArtifacts] as (...args: unknown[]) => Promise<unknown>).apply(artifacts, args);
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ result: result instanceof Uint8Array ? { bytes: Buffer.from(result).toString('base64') } : result }));
  })().catch(e => { if (!res.headersSent) { res.writeHead(e instanceof ArtifactsProviderError ? 409 : 400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code: e instanceof ArtifactsProviderError ? e.code : 'provider_unavailable', message: 'local source operation refused' } })); } }); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 0, '127.0.0.1', resolve); });
  artifacts.baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  // Rebind persisted remotes to this startup's actual local address.
  for (const repo of artifacts.repos.values()) repo.info.remote = `${artifacts.baseUrl}/git/${repo.ns}/${repo.name}.git`;
  return { provider, artifacts, url: artifacts.baseUrl, close: () => new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())) };
}
