/**
 * Integration-test world: LocalGitProvider repositories as canonical repos and task workspaces,
 * plain bare repos for `-tasks`/`-editions` targets, a fake Worker (credential broker, revoke,
 * results, heads) over real HTTP, and job signing as the Worker would do it.
 */
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  changeId as toChangeId,
  localRevisionId,
  type FrozenCandidate,
  type LocalGitCoords,
  type ResourceRef,
  type RevisionId,
  type TaskWorkspaceHandle,
} from '@commonforge-org/core';
import { LocalGitProvider } from '@commonforge-org/provider-local-git';
import {
  authorizeCredentialRequest,
  deriveEvidenceKey,
  evidenceKeyToWire,
  signJob,
  verifySignedJob,
  type IntegrationJobInput,
  type JobSigningKey,
  type RunnerResult,
  type SignedJob,
} from '@commonforge-org/runner-protocol';
import { brokerCredentials, createGit, createRunner, fsBlobStore, type Git, type Runner, type RunnerOptions } from '../src/index.js';

export const ORG = 'org1';
export const KEY: JobSigningKey = { kid: 'k-test', secret: 'runner-test-job-key-0123456789abcdef-0123' };
const IDENTITY = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@x.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@x.invalid' };

export interface IssuedToken {
  token: string;
  tokenId: string;
  jobId: string;
  repo: string;
  access: 'read' | 'write';
}

export interface FakeWorker {
  url: string;
  brokerUrl: string;
  issued: IssuedToken[];
  revoked: string[];
  results: Array<{ signedJob: SignedJob; result: RunnerResult }>;
  refusals: Array<{ code: string; detail: string }>;
  heads: Record<string, RevisionId | null> | null;
  close(): Promise<void>;
}

async function body(req: import('node:http').IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
}

async function startFakeWorker(serviceToken: string): Promise<FakeWorker> {
  const state: Omit<FakeWorker, 'url' | 'brokerUrl' | 'close'> = { issued: [], revoked: [], results: [], refusals: [], heads: null };
  let n = 0;
  const server: Server = createServer((req, res) => {
    void (async () => {
      const send = (status: number, payload?: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(payload === undefined ? '' : JSON.stringify(payload));
      };
      try {
        const b = (await body(req)) as Record<string, unknown>;
        if (req.url === '/api/runner/credential') {
          const v = await verifySignedJob(b.signedJob, [KEY]);
          if (!v.ok) {
            state.refusals.push({ code: v.code, detail: v.detail });
            return send(403, { code: v.code, detail: v.detail });
          }
          const auth = authorizeCredentialRequest(v.signedJob, { repo: b.repo as never, access: b.access as 'read' | 'write' });
          if (!auth.ok) {
            state.refusals.push({ code: 'scope_violation', detail: auth.reason });
            return send(403, { code: 'scope_violation', detail: auth.reason });
          }
          const token = auth.role === 'canonical' || auth.role === 'reference' ? serviceToken : `art_v2_x_${randomBytes(20).toString('hex')}`;
          const tokenId = `tok-${++n}`;
          state.issued.push({ token, tokenId, jobId: v.signedJob.jobId, repo: auth.coords.repoName, access: auth.access });
          const expiresAt = new Date(Math.min(Date.parse(v.signedJob.expiresAt), Date.now() + 300_000)).toISOString();
          return send(200, { token, tokenId, expiresAt, remoteUrl: auth.coords.remoteUrl });
        }
        if (req.url === '/api/runner/credential/revoke') {
          state.revoked.push(String(b.tokenId));
          return send(200, { revoked: true });
        }
        if (req.url === '/api/runner/results') {
          state.results.push(b as never);
          return send(200, { ok: true });
        }
        if (req.url === '/api/runner/heads') {
          return state.heads ? send(200, { heads: state.heads }) : send(404);
        }
        return send(404);
      } catch (e) {
        return send(500, { detail: String(e) });
      }
    })();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address() as { port: number };
  const url = `http://127.0.0.1:${addr.port}`;
  return Object.assign(state, {
    url,
    brokerUrl: `${url}/api/runner/credential`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  }) as FakeWorker;
}

export interface CanonicalRepo {
  resource: ResourceRef;
  coords: LocalGitCoords;
  /** head sha of main */
  sha: string;
  revision: RevisionId;
}

export class World {
  readonly git: Git = createGit({ allowFile: true });
  #closers: Array<() => Promise<void>> = [];
  #seq = 0;

  private constructor(
    readonly root: string,
    readonly provider: LocalGitProvider,
    readonly worker: FakeWorker,
    readonly serviceEnv: Record<string, string>,
  ) {}

  static async create(): Promise<World> {
    const root = await mkdtemp(join(tmpdir(), 'cf-runner-test-'));
    const provider = await LocalGitProvider.open({ root: join(root, 'repos'), namespacePrefix: 'commonforge-test' });
    const serviceEnv = await provider.serviceGitEnv();
    const worker = await startFakeWorker(serviceEnv.COMMONFORGE_TOKEN!);
    const w = new World(root, provider, worker, serviceEnv);
    w.#closers.push(() => worker.close(), () => rm(root, { recursive: true, force: true }));
    return w;
  }

  async close(): Promise<void> {
    for (const c of this.#closers.reverse()) await c();
  }

  dir(label: string): string {
    return join(this.root, `w-${++this.#seq}-${label}`);
  }

  /** Write files into a fresh working repo and commit; returns the repo path and sha. */
  async workRepo(files: Record<string, string | Uint8Array | null>, message = 'seed'): Promise<{ path: string; sha: string }> {
    const path = this.dir('work');
    await mkdir(path, { recursive: true });
    await this.git.ok(['init', '-q', '-b', 'main'], path);
    const sha = await this.commit(path, files, message);
    return { path, sha };
  }

  async commit(path: string, files: Record<string, string | Uint8Array | null>, message: string, env: Record<string, string> = {}): Promise<string> {
    for (const [p, c] of Object.entries(files)) {
      const abs = join(path, ...p.split('/'));
      if (c === null) await rm(abs, { force: true });
      else {
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, c);
      }
    }
    await this.git.ok(['add', '-A'], path);
    await this.git.ok(['commit', '-q', '--allow-empty', '-m', message], path, { env: { ...IDENTITY, ...env } });
    return (await this.git.ok(['rev-parse', 'HEAD'], path)).trim();
  }

  /** A canonical Resource (LocalGitProvider) whose main holds `files`. */
  async canonical(resourceId: string, files: Record<string, string | Uint8Array | null>): Promise<CanonicalRepo> {
    const seed = await this.workRepo(files);
    return this.canonicalFrom(resourceId, seed.path);
  }

  async canonicalFrom(resourceId: string, source: string): Promise<CanonicalRepo> {
    const resource = await this.provider.createCanonicalResource({ organizationId: ORG, resourceId, source, sourceRef: 'HEAD' });
    const coords = resource.coords as LocalGitCoords;
    const sha = await this.remoteSha(coords, 'refs/heads/main');
    return { resource, coords, sha: sha!, revision: localRevisionId(coords.repoId, sha!) };
  }

  /** Advance canonical main with the service credential (simulates an accepted head / concurrent writer). */
  async advanceCanonical(c: CanonicalRepo, files: Record<string, string | null>, message = 'advance'): Promise<string> {
    const work = this.dir('advance');
    await this.git.ok(['clone', '-q', c.coords.remoteUrl, work], this.root);
    const sha = await this.commit(work, files, message);
    await this.git.ok(['push', '-q', 'origin', 'HEAD:refs/heads/main'], work, { env: this.serviceEnv });
    return sha;
  }

  async remoteSha(coords: { remoteUrl: string }, ref: string): Promise<string | null> {
    const out = await this.git.ok(['ls-remote', coords.remoteUrl, ref], this.root);
    const line = out.split('\n').find((l) => l.endsWith(`\t${ref}`));
    return line ? line.split('\t')[0]! : null;
  }

  /** Contents of `path` at `sha` in a canonical repo (reads the bare repo behind the file:// URL). */
  async showFile(coords: { remoteUrl: string }, sha: string, path: string): Promise<string> {
    return this.git.ok(['--git-dir', fileURLToPath(coords.remoteUrl), 'show', `${sha}:${path}`], this.root);
  }

  /** `git rev-list --parents -n 1`: the parent shas of a commit. */
  async parents(coords: { remoteUrl: string }, sha: string): Promise<string[]> {
    const out = await this.git.ok(['--git-dir', fileURLToPath(coords.remoteUrl), 'rev-list', '--parents', '-n', '1', sha], this.root);
    return out.trim().split(' ').slice(1);
  }

  revisionFor(coords: { repoId: string }, sha: string): RevisionId {
    return localRevisionId(coords.repoId, sha);
  }

  /**
   * Commit the merge of `otherSha` onto `baseSha` (single parent, like a staging build) directly in the bare
   * canonical repo (`otherSha` must already be there, e.g. prepared) and point `ref` at it; returns its sha.
   */
  async mergeOnto(c: CanonicalRepo, baseSha: string, otherSha: string, ref: string): Promise<string> {
    const g = ['--git-dir', fileURLToPath(c.coords.remoteUrl)];
    const mt = (await this.git.ok([...g, 'merge-tree', '--write-tree', `--merge-base=${c.sha}`, baseSha, otherSha], this.root)).trim().split('\n')[0]!;
    const sha = (await this.git.ok([...g, 'commit-tree', mt, '-p', baseSha, '-m', 'staging'], this.root, { env: IDENTITY })).trim();
    await this.git.ok([...g, 'update-ref', ref, sha], this.root);
    return sha;
  }

  async remoteRefs(coords: { remoteUrl: string }): Promise<Record<string, string>> {
    const out = await this.git.ok(['ls-remote', coords.remoteUrl], this.root);
    const refs: Record<string, string> = {};
    for (const l of out.split('\n').filter(Boolean)) {
      const [sha, name] = l.split('\t');
      if (name !== 'HEAD') refs[name!] = sha!;
    }
    return refs;
  }

  /** A plain bare repo in `commonforge-test-<org>-<role>` (no push guard). */
  async bareRepo(role: 'tasks' | 'editions' | 'canonical', name: string): Promise<LocalGitCoords> {
    const namespace = `commonforge-test-${ORG}-${role}`;
    const path = join(this.root, 'plain', namespace, `${name}.git`);
    await mkdir(path, { recursive: true });
    await this.git.ok(['init', '-q', '--bare', '-b', 'main', path], this.root);
    return { kind: 'local-git', namespace, repoName: name, repoId: `${role}-${name}`, remoteUrl: pathToFileURL(path).href };
  }

  /** An agent's frozen candidate: isolated change, push with its credential, freeze. */
  async candidate(c: CanonicalRepo, files: Record<string, string | null>, label: string, base: RevisionId = c.revision): Promise<{ candidate: FrozenCandidate; handle: TaskWorkspaceHandle }> {
    const handle = await this.provider.createIsolatedChange({
      resource: c.resource,
      baseRevision: base,
      taskId: `task-${label}`,
      organizationId: ORG,
      changeId: toChangeId(`change-${label}`),
      purpose: 'agent-task',
    });
    const cred = await this.provider.issueWorkspaceCredential(handle, {
      principal: { kind: 'agent', id: `agent-${label}` },
      operations: ['read', 'write'],
      ttlSeconds: 3600,
      leaseGeneration: 1,
    });
    const env = LocalGitProvider.credentialGitEnv(cred);
    const work = this.dir(`agent-${label}`);
    await this.git.ok(['clone', '-q', cred.remoteUrl, work], this.root, { env });
    const sha = await this.commit(work, files, `agent ${label}`);
    await this.git.ok(['push', '-q', 'origin', 'HEAD:refs/heads/main'], work, { env });
    const candidate = await this.provider.freezeCandidate(handle, { expectedSha: sha, submitter: { kind: 'agent', id: `agent-${label}` } });
    return { candidate, handle };
  }

  async sign(job: IntegrationJobInput, options: { jobId?: string; lifetimeSeconds?: number; issuedAt?: Date; key?: JobSigningKey } = {}): Promise<SignedJob> {
    const issued = options.issuedAt ?? new Date();
    return signJob(
      {
        job: job as never,
        jobId: options.jobId ?? `job-${randomBytes(6).toString('hex')}`,
        issuedAt: issued.toISOString(),
        expiresAt: new Date(issued.getTime() + (options.lifetimeSeconds ?? 900) * 1000).toISOString(),
        credentialBroker: this.worker.brokerUrl,
      },
      options.key ?? KEY,
    );
  }

  async delivery(job: IntegrationJobInput, options: Parameters<World['sign']>[1] = {}): Promise<{ signedJob: SignedJob; evidenceKey: ReturnType<typeof evidenceKeyToWire> }> {
    const signedJob = await this.sign(job, options);
    return { signedJob, evidenceKey: evidenceKeyToWire(await deriveEvidenceKey(KEY, signedJob.jobId)) };
  }

  runner(overrides: Partial<RunnerOptions> = {}): Runner {
    return createRunner({
      workDir: join(this.root, 'runner-work'),
      credentials: brokerCredentials({ brokerForLocalGit: true }),
      jobKeyring: [KEY],
      blobStore: fsBlobStore(join(this.root, 'blobs')),
      push: { baseDelayMs: 5 },
      log: () => undefined,
      // local LocalGitProvider repositories and test-owned check content
      git: { allowFile: true },
      commands: { unsafeSameUid: true },
      trustedWorkerOrigin: this.worker.url,
      ...overrides,
    });
  }

  blobPath(key: string): string {
    return join(this.root, 'blobs', key);
  }

  /** Every token the fake broker issued must be revoked and never appear in `text`. */
  assertTokensHygiene(text: string): void {
    for (const t of this.worker.issued) {
      if (text.includes(t.token)) throw new Error(`token ${t.tokenId} leaked`);
      if (!this.worker.revoked.includes(t.tokenId)) throw new Error(`token ${t.tokenId} not revoked`);
    }
  }
}
