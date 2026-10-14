/**
 * Populating an empty canonical Artifacts repo for the demo seeder: mint a short-lived write token
 * with the account's Artifacts API token (the REST calls of
 * packages/provider-cloudflare/src/artifacts-rest.ts `createToken` / `revokeToken`), push one
 * fixture directory as a single fresh commit, revoke the token (`withWriteToken`).
 *
 * Tokens never reach argv, a config file or a log: git gets the write token only through the
 * environment of the one push process, as `http.<remoteUrl>.extraHeader` (as apps/runner does).
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface ArtifactsAccount {
  accountId: string;
  /** Cloudflare API token with Artifacts: Edit. Secret. */
  apiToken: string;
  /** default `https://api.cloudflare.com/client/v4` */
  apiBase?: string;
}

interface Envelope<T> {
  success?: boolean;
  result?: T;
  errors?: Array<{ code?: number; message?: string }>;
}

/** A failed Artifacts REST call; the message names the method, path, status and Cloudflare's errors, never a token. */
export class ArtifactsRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ArtifactsRequestError';
  }
}

async function cfRequest<T>(fetchImpl: typeof fetch, a: ArtifactsAccount, method: string, path: string, body?: unknown): Promise<T | undefined> {
  const base = (a.apiBase ?? 'https://api.cloudflare.com/client/v4').replace(/\/+$/, '');
  const res = await fetchImpl(`${base}/accounts/${a.accountId}/artifacts${path}`, {
    method,
    headers: { authorization: `Bearer ${a.apiToken}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let env: Envelope<T> = {};
  try {
    env = (await res.json()) as Envelope<T>;
  } catch {
    /* empty or not JSON */
  }
  if (!res.ok || env.success === false) {
    const detail = (env.errors ?? []).map((e) => `${e.code ?? '?'} ${e.message ?? ''}`.trim()).join('; ');
    throw new ArtifactsRequestError(res.status, `Artifacts ${method} ${path} → ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  return env.result;
}

const enc = encodeURIComponent;

/** A write token on one canonical repo (`scope: "write"`, `ttl` seconds). */
export async function mintWriteToken(fetchImpl: typeof fetch, a: ArtifactsAccount, namespace: string, repo: string, ttlSeconds = 900): Promise<{ id: string; secret: string }> {
  const t = await cfRequest<{ id: string; plaintext: string }>(fetchImpl, a, 'POST', `/namespaces/${enc(namespace)}/tokens`, { repo, scope: 'write', ttl: ttlSeconds });
  if (!t?.id || !t.plaintext) throw new Error(`Artifacts token mint for ${namespace}/${repo} returned no token`);
  return { id: t.id, secret: t.plaintext };
}

/** Revoke a token: `true` when revoked, `false` on a 404 (already expired or revoked), as artifacts-rest.ts `revokeToken`. */
export async function revokeToken(fetchImpl: typeof fetch, a: ArtifactsAccount, namespace: string, tokenId: string): Promise<boolean> {
  try {
    await cfRequest(fetchImpl, a, 'DELETE', `/namespaces/${enc(namespace)}/tokens/${enc(tokenId)}`);
    return true;
  } catch (e) {
    if (e instanceof ArtifactsRequestError && e.status === 404) return false;
    throw e;
  }
}

/**
 * Mint a write token on `repo`, run `use` with its secret, then revoke it. A revoke failure goes to
 * `onRevokeError` and never stops the run, whether `use` failed (its error is kept) or succeeded
 * (its result is returned): the token expires on its own after its 15-minute ttl. A 404 (already
 * expired or revoked) is not a failure.
 */
export async function withWriteToken<T>(
  fetchImpl: typeof fetch,
  a: ArtifactsAccount,
  namespace: string,
  repo: string,
  use: (secret: string) => Promise<T>,
  onRevokeError: (e: unknown) => void,
): Promise<T> {
  const token = await mintWriteToken(fetchImpl, a, namespace, repo);
  let result: T;
  try {
    result = await use(token.secret);
  } catch (e) {
    try {
      await revokeToken(fetchImpl, a, namespace, token.id);
    } catch (revokeError) {
      onRevokeError(revokeError);
    }
    throw e;
  }
  try {
    await revokeToken(fetchImpl, a, namespace, token.id);
  } catch (revokeError) {
    onRevokeError(revokeError);
  }
  return result;
}

function run(cmd: string, args: string[], o: { cwd?: string; env?: Record<string, string>; input?: Buffer } = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { cwd: o.cwd, env: o.env, encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} ${args.join(' ')} failed: ${stderr.toString('utf8').trim() || err.message}`));
      else resolve(stdout);
    });
    if (o.input) child.stdin?.end(o.input);
  });
}

/**
 * Push `<repoRoot>/<fixturePath>` as committed at `ref` (tracked files only: never untracked,
 * ignored or generated files) to `remoteUrl` as one parentless commit on `branch`. Returns its sha.
 */
export async function pushFixture(o: { repoRoot: string; ref: string; fixturePath: string; remoteUrl: string; token: string; branch: string }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cf-seed-'));
  // no user or system git config, no prompts, no hooks, no signing, no stored credentials
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: dir,
    LANG: 'C',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'CommonForge Demo Seeder',
    GIT_AUTHOR_EMAIL: 'seeder@commonforge.invalid',
    GIT_COMMITTER_NAME: 'CommonForge Demo Seeder',
    GIT_COMMITTER_EMAIL: 'seeder@commonforge.invalid',
  };
  const git = (args: string[], extra: Record<string, string> = {}, input?: Buffer) =>
    run('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, env: { ...env, ...extra }, ...(input ? { input } : {}) });
  try {
    const tar = await run('git', ['-C', o.repoRoot, 'archive', '--format=tar', `${o.ref}:${o.fixturePath}`], { env });
    await run('tar', ['-x', '-f', '-', '-C', dir], { input: tar });
    await git(['init', '-q', '-b', o.branch]);
    await git(['add', '-A']);
    await git(['commit', '-q', '-m', `Initial content from ${o.fixturePath}`]);
    const auth = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `http.${o.remoteUrl}.extraHeader`, GIT_CONFIG_VALUE_0: `Authorization: Bearer ${o.token}` };
    await git(['push', '-q', o.remoteUrl, `HEAD:refs/heads/${o.branch}`], auth);
    return (await git(['rev-parse', 'HEAD'])).toString('utf8').trim();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
