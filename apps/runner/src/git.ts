/**
 * Git execution for the runner (Node child processes, never a shell).
 *
 * - Every call runs with a minimal environment (no inherited variables beyond PATH), with global
 *   and system config disabled, hooks and fsmonitor off, symlinks checked out as plain files, and
 *   only the transports the runner needs (`file`, `https`, plus `http` when explicitly allowed).
 * - Credentials arrive only through the per-call `env` built by `credentials.ts`
 *   (`http.<url>.extraHeader` via `GIT_CONFIG_*`, or `COMMONFORGE_TOKEN` for local-git), never
 *   in argv, never in a config file.
 * - Pushes update exactly one ref with `--force-with-lease=<ref>:<expected>` (never `--atomic`:
 *   Artifacts refuses it), retry `receive-pack busy` with jittered backoff, and re-check with
 *   `ls-remote` so a retried push that already landed counts as success.
 */
import { spawn } from 'node:child_process';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GitBytesResult {
  code: number;
  stdout: Uint8Array;
  stderr: string;
}

export interface GitCallOptions {
  /** extra environment (credentials); merged over the minimal base */
  env?: Readonly<Record<string, string>>;
  /** bytes written to stdin */
  input?: string | Uint8Array;
  timeoutMs?: number;
}

export interface GitConfig {
  /** git executable (default `git`) */
  binary?: string;
  /** PATH for git (default: the runner's PATH) */
  path?: string;
  /** HOME for git (default `/nonexistent`: nothing is read from a home directory) */
  home?: string;
  /** allow plain `http://` remotes (dev servers only) */
  allowHttp?: boolean;
  /** allow `file://` remotes (LocalGitProvider tests and local dev only) */
  allowFile?: boolean;
  /** default per-call timeout (default 10 min) */
  timeoutMs?: number;
}

export interface Git {
  run(args: readonly string[], cwd: string, options?: GitCallOptions): Promise<GitResult>;
  runBytes(args: readonly string[], cwd: string, options?: GitCallOptions): Promise<GitBytesResult>;
  /** run and return stdout; throws {@link GitError} on a non-zero exit */
  ok(args: readonly string[], cwd: string, options?: GitCallOptions): Promise<string>;
}

export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly result: { code: number; stderr: string },
  ) {
    super(`git ${args[0] ?? ''} exited ${result.code}: ${result.stderr.trim().slice(0, 2000)}`);
    this.name = 'GitError';
  }
}

/** Fixed identity and signing settings for commits the runner creates. */
export const RUNNER_IDENTITY_ENV = (when: string): Record<string, string> => ({
  GIT_AUTHOR_NAME: 'CommonForge Runner',
  GIT_AUTHOR_EMAIL: 'runner@commonforge.invalid',
  GIT_COMMITTER_NAME: 'CommonForge Runner',
  GIT_COMMITTER_EMAIL: 'runner@commonforge.invalid',
  GIT_AUTHOR_DATE: when,
  GIT_COMMITTER_DATE: when,
});

export function createGit(config: GitConfig = {}): Git {
  const hardening = [
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.fsmonitor=false',
    '-c', 'core.symlinks=false',
    '-c', 'credential.helper=',
    '-c', 'commit.gpgsign=false',
    '-c', 'tag.gpgsign=false',
    '-c', 'protocol.allow=never',
    '-c', 'protocol.https.allow=always',
    ...(config.allowFile ? ['-c', 'protocol.file.allow=always'] : []),
    ...(config.allowHttp ? ['-c', 'protocol.http.allow=always'] : []),
  ];
  const baseEnv: Record<string, string> = {
    PATH: config.path ?? process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: config.home ?? '/nonexistent',
    LANG: 'C',
    LC_ALL: 'C',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    GIT_PROTOCOL_FROM_USER: '0',
  };

  const exec = (args: readonly string[], cwd: string, options: GitCallOptions = {}): Promise<GitBytesResult> =>
    new Promise((resolve) => {
      const child = spawn(config.binary ?? 'git', [...hardening, ...args], {
        cwd,
        env: { ...baseEnv, ...options.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        // own process group, so a timeout also kills remote helpers and index-pack (review M-3)
        detached: true,
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let settled = false;
      const timer = setTimeout(() => {
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }, options.timeoutMs ?? config.timeoutMs ?? 600_000);
      child.stdout.on('data', (d: Buffer) => out.push(d));
      child.stderr.on('data', (d: Buffer) => err.push(d));
      const finish = (code: number, extra = '') => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code, stdout: new Uint8Array(Buffer.concat(out)), stderr: Buffer.concat(err).toString('utf8') + extra });
      };
      child.on('error', (e) => finish(127, String(e)));
      child.on('close', (code, signal) => finish(code ?? 128, signal ? `\nkilled by ${signal}` : ''));
      child.stdin.on('error', () => undefined);
      if (options.input !== undefined) child.stdin.end(options.input);
      else child.stdin.end();
    });

  const git: Git = {
    async run(args, cwd, options) {
      const r = await exec(args, cwd, options);
      return { code: r.code, stdout: Buffer.from(r.stdout).toString('utf8'), stderr: r.stderr };
    },
    runBytes: exec,
    async ok(args, cwd, options) {
      const r = await git.run(args, cwd, options);
      if (r.code !== 0) throw new GitError(args, r);
      return r.stdout;
    },
  };
  return git;
}

// =============================================================================================
// Repository operations
// =============================================================================================

export async function initBare(git: Git, dir: string): Promise<void> {
  await git.ok(['init', '-q', '--bare', '-b', 'main', dir], '/');
}

/** sha of `ref` on `remote`, or null when absent. Throws {@link GitError} when the remote is unreachable. */
export async function lsRemote(git: Git, cwd: string, remote: string, ref: string, env?: Record<string, string>): Promise<string | null> {
  const out = await git.ok(['ls-remote', '--', remote, ref], cwd, { env });
  for (const line of out.split('\n')) {
    const [sha, name] = line.split('\t');
    if (name === ref && sha) return sha;
  }
  return null;
}

export async function hasCommit(git: Git, dir: string, sha: string): Promise<boolean> {
  return (await git.run(['cat-file', '-e', `${sha}^{commit}`], dir)).code === 0;
}

/**
 * Fetch commits by sha (objects plus history) into a bare scratch repo. Falls back to fetching
 * the given refspecs when the server refuses a want-by-sha. Untrusted objects are fsck-checked.
 */
export async function fetchShas(
  git: Git,
  dir: string,
  remote: string,
  shas: readonly string[],
  env?: Record<string, string>,
  fallbackRefspecs: readonly string[] = ['+refs/heads/*:refs/fetched/heads/*', '+refs/commonforge/*:refs/fetched/commonforge/*'],
): Promise<{ ok: boolean; stderr: string }> {
  const missing: string[] = [];
  for (const s of shas) if (!(await hasCommit(git, dir, s))) missing.push(s);
  if (missing.length === 0) return { ok: true, stderr: '' };
  const r = await git.run(['-c', 'fetch.fsckObjects=true', 'fetch', '-q', '--no-tags', '--no-write-fetch-head', '--', remote, ...missing], dir, { env });
  let stderr = r.stderr;
  if (r.code !== 0) {
    const f = await git.run(['-c', 'fetch.fsckObjects=true', 'fetch', '-q', '--no-tags', '--no-write-fetch-head', '--', remote, ...fallbackRefspecs], dir, { env });
    stderr += f.stderr;
  }
  for (const s of missing) if (!(await hasCommit(git, dir, s))) return { ok: false, stderr };
  return { ok: true, stderr };
}

/** Fetch a single ref into a local ref of the same name; returns the fetched sha or null. */
export async function fetchRef(git: Git, dir: string, remote: string, ref: string, env?: Record<string, string>): Promise<string | null> {
  const r = await git.run(['-c', 'fetch.fsckObjects=true', 'fetch', '-q', '--no-tags', '--no-write-fetch-head', '--', remote, `+${ref}:${ref}`], dir, { env });
  if (r.code !== 0) return null;
  return (await git.ok(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], dir)).trim();
}

const BUSY_RE = /receive_pack_busy|receive-pack busy|remote end hung up|hung up unexpectedly|early EOF|HTTP (?:409|429|5\d\d)|returned error: (?:409|429|5\d\d)|Connection reset|timed out|could not lock|cannot lock ref/i;
const LEASE_RE = /stale info|stale ref|fetch first|non-fast-forward|\[rejected\]|already exists|failed to update ref|atomic transaction aborted/i;

export type PushOutcome =
  | { status: 'pushed' }
  | { status: 'already' }
  | { status: 'lease_failed'; observed: string | null; detail: string }
  | { status: 'failed'; observed: string | null; detail: string };

export interface PushRequest {
  git: Git;
  /** repository holding `sha` */
  dir: string;
  remote: string;
  env?: Record<string, string>;
  sha: string;
  ref: string;
  /** lease: sha the ref must hold, null = must not exist, 'observed' = whatever ls-remote shows first */
  expected: string | null | 'observed';
  attempts?: number;
  baseDelayMs?: number;
  /** called before every attempt (e.g. throws when the job expired) */
  beforeAttempt?: () => void | Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * One-ref lease-guarded push with busy retry and ls-remote re-check:
 * - success, or the ref already holds `sha` (an earlier attempt landed) → `pushed`/`already`;
 * - the ref holds something other than the lease → `lease_failed` (not retried);
 * - a transient failure (busy, 5xx, hang-up) with the ref unmoved → retried, then `failed`.
 */
export async function pushWithLease(p: PushRequest): Promise<PushOutcome> {
  const attempts = p.attempts ?? 5;
  const base = p.baseDelayMs ?? 250;
  const sleep = p.sleep ?? defaultSleep;
  let detail = '';
  let observed: string | null = null;
  for (let i = 0; i < attempts; i++) {
    await p.beforeAttempt?.();
    let lease: string | null;
    if (p.expected === 'observed') {
      try {
        lease = await lsRemote(p.git, p.dir, p.remote, p.ref, p.env);
      } catch (e) {
        detail = String((e as Error).message);
        await sleep(base * 2 ** i * (0.5 + Math.random()));
        continue;
      }
      if (lease === p.sha) return { status: 'already' };
    } else {
      lease = p.expected;
    }
    const r = await p.git.run(['push', '--porcelain', '--no-verify', `--force-with-lease=${p.ref}:${lease ?? ''}`, '--', p.remote, `${p.sha}:${p.ref}`], p.dir, { env: p.env });
    if (r.code === 0) return { status: 'pushed' };
    detail = `${r.stdout}\n${r.stderr}`.trim();
    try {
      observed = await lsRemote(p.git, p.dir, p.remote, p.ref, p.env);
    } catch (e) {
      detail += `\nls-remote: ${(e as Error).message}`;
      await sleep(base * 2 ** i * (0.5 + Math.random()));
      continue;
    }
    if (observed === p.sha) return { status: 'already' };
    if (observed !== lease && (LEASE_RE.test(detail) || p.expected !== 'observed')) {
      if (p.expected === 'observed') continue; // someone else rebuilt it meanwhile: re-observe
      return { status: 'lease_failed', observed, detail };
    }
    if (!BUSY_RE.test(detail) && !LEASE_RE.test(detail)) return { status: 'failed', observed, detail };
    await sleep(base * 2 ** i * (0.5 + Math.random()));
  }
  return { status: 'failed', observed, detail };
}

/** `git ls-tree -r -z` entries of a commit. */
export interface TreeFile {
  mode: string;
  type: 'blob' | 'commit' | 'tree';
  oid: string;
  path: string;
}

export async function lsTree(git: Git, dir: string, rev: string): Promise<TreeFile[]> {
  const out = await git.ok(['ls-tree', '-r', '-z', '--full-tree', '--end-of-options', rev], dir);
  const files: TreeFile[] = [];
  for (const rec of out.split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    const [mode, type, oid] = rec.slice(0, tab).split(' ');
    files.push({ mode: mode!, type: type as TreeFile['type'], oid: oid!, path: rec.slice(tab + 1) });
  }
  return files;
}

/** Simple in-process mutex keyed by string (serializes pushes per repository). */
export class KeyedMutex {
  readonly #tails = new Map<string, Promise<unknown>>();
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#tails.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.#tails.set(key, tail);
    try {
      return await next;
    } finally {
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    }
  }
}
