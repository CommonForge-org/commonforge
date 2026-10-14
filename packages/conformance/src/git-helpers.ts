/**
 * Git and temp-repository helpers for conformance suites and provider tests (Node only).
 *
 * Every git call goes through a {@link GitRunner} (the same port as runner-protocol's
 * `MaterializeIo.git`), so a provider can hand in a runner that authenticates (for example an
 * `http.extraHeader` set through `GIT_CONFIG_*` environment) without the helpers knowing about it.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { formatRevisionId, type RepoCoords, type RevisionId } from '@commonforge-org/core';
import type { GitResult } from '@commonforge-org/runner-protocol';
import { createNodeIo } from '@commonforge-org/runner-protocol/node';

/** Run `git <args>` in `cwd`; resolves with the exit code instead of throwing. */
export type GitRunner = (args: readonly string[], cwd: string) => Promise<GitResult>;

export class GitCommandError extends Error {
  readonly args: readonly string[];
  readonly exitCode: number;
  readonly stderr: string;

  constructor(args: readonly string[], result: GitResult) {
    super(`git ${args.join(' ')} exited ${result.code}: ${result.stderr.trim()}`);
    this.name = 'GitCommandError';
    this.args = args;
    this.exitCode = result.code;
    this.stderr = result.stderr;
  }
}

/**
 * Environment that isolates git from the developer's machine: no global or system config, so a
 * global `core.hooksPath`, `core.autocrlf`, signing or credential helper cannot change results.
 * Repository-local config (e.g. a server-side hooks path) still applies.
 */
export const ISOLATED_GIT_ENV: Readonly<Record<string, string>> = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

/**
 * A plain Node git runner (`child_process`) isolated by {@link ISOLATED_GIT_ENV}; `env` is merged
 * on top (e.g. `GIT_CONFIG_COUNT/KEY_n/VALUE_n` for an auth header).
 */
export function nodeGitRunner(env?: Record<string, string>): GitRunner {
  const io = createNodeIo({ env: { ...ISOLATED_GIT_ENV, ...env } });
  return (args, cwd) => io.git(args, cwd);
}

/** The git blob object id of `bytes` (sha1 for 40-hex repositories, sha256 for 64-hex). */
export async function gitBlobOid(bytes: Uint8Array, algorithm: 'sha1' | 'sha256' = 'sha1'): Promise<string> {
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const data = new Uint8Array(header.length + bytes.length);
  data.set(header, 0);
  data.set(bytes, header.length);
  const digest = await crypto.subtle.digest(algorithm === 'sha1' ? 'SHA-1' : 'SHA-256', data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Identity and signing settings so commits work regardless of the user's global git config. */
export const COMMIT_CONFIG: readonly string[] = [
  '-c',
  'user.name=CommonForge Conformance',
  '-c',
  'user.email=conformance@commonforge.invalid',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'tag.gpgsign=false',
];

/** Run git and return stdout; throw {@link GitCommandError} on a non-zero exit. */
export async function gitOk(git: GitRunner, args: readonly string[], cwd: string): Promise<string> {
  const r = await git(args, cwd);
  if (r.code !== 0) throw new GitCommandError(args, r);
  return r.stdout;
}

/** `git rev-parse <rev>` (trimmed). */
export async function revParse(git: GitRunner, cwd: string, rev: string): Promise<string> {
  return (await gitOk(git, ['rev-parse', '--verify', `${rev}`], cwd)).trim();
}

/** The sha `ref` has on `remote` (`git ls-remote`), or null when it does not exist. */
export async function lsRemote(git: GitRunner, cwd: string, remote: string, ref: string): Promise<string | null> {
  const out = await gitOk(git, ['ls-remote', remote, ref], cwd);
  for (const line of out.split('\n')) {
    const [sha, name] = line.split('\t');
    if (name === ref && sha) return sha;
  }
  return null;
}

/** A fresh directory under the OS temp dir. */
export function createTempDir(prefix = 'cf-conformance-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function removeDir(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

/** `file://` URL for a local repository path. */
export function fileUrl(path: string): string {
  return pathToFileURL(path).href;
}

/** `art:<repoId>:<sha>` or `local:<repoId>:<sha>` for a commit of the repository at `coords`. */
export function revisionForCoords(coords: RepoCoords, sha: string): RevisionId {
  return formatRevisionId(coords.kind === 'artifacts' ? { kind: 'art', repoId: coords.repoId, sha } : { kind: 'local', repoId: coords.repoId, sha });
}

/** File contents keyed by `/`-separated relative path; `null` deletes the file. */
export type FileChanges = Record<string, string | Uint8Array | null>;

/** Apply {@link FileChanges} to a working tree (creates parent directories). */
export async function writeFiles(dir: string, files: FileChanges): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const abs = join(dir, ...path.split('/'));
    if (content === null) {
      await rm(abs, { force: true });
    } else {
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content);
    }
  }
}

/** Read a file from a working tree, or null when it does not exist. */
export async function readWorkFile(dir: string, path: string): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await readFile(join(dir, ...path.split('/'))));
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') return null;
    throw e;
  }
}

/** `git init` a non-bare working repository on `branch` (default `main`). */
export async function initWorkRepo(git: GitRunner, dir: string, branch = 'main'): Promise<void> {
  await mkdir(dir, { recursive: true });
  await gitOk(git, ['init', '-q', '-b', branch], dir);
}

/** `git init --bare` on `branch` (default `main`). */
export async function initBareRepo(git: GitRunner, dir: string, branch = 'main'): Promise<void> {
  await mkdir(dir, { recursive: true });
  await gitOk(git, ['init', '-q', '--bare', '-b', branch], dir);
}

/** Stage everything and commit; returns the new commit sha. `allowEmpty` permits no-change commits. */
export async function commitAll(git: GitRunner, dir: string, message: string, options: { allowEmpty?: boolean } = {}): Promise<string> {
  await gitOk(git, ['add', '-A'], dir);
  await gitOk(git, [...COMMIT_CONFIG, 'commit', '-q', ...(options.allowEmpty ? ['--allow-empty'] : []), '-m', message], dir);
  return revParse(git, dir, 'HEAD');
}

/** Write `files` and commit them; returns the new commit sha. */
export async function commitFiles(git: GitRunner, dir: string, files: FileChanges, message: string): Promise<string> {
  await writeFiles(dir, files);
  return commitAll(git, dir, message);
}

/** Clone `remote` into `dir` (non-bare, nothing checked out beyond the default). */
export async function cloneRepo(git: GitRunner, remote: string, dir: string, options: { bare?: boolean } = {}): Promise<void> {
  await mkdir(dirname(dir), { recursive: true });
  await gitOk(git, ['clone', '-q', ...(options.bare ? ['--bare'] : []), remote, dir], dirname(dir));
}

export interface PushOptions {
  /** `--force-with-lease=<dst>:<sha>`; `null` = the ref must not exist yet */
  expectedSha?: string | null;
  /**
   * add `--atomic` (default false). Artifacts refuses `--atomic` ("receiving end does not support
   * --atomic push"), so portable code pushes one lease-guarded ref per push.
   */
  atomic?: boolean;
}

/** `git push <remote> <src>:<dst>` (one ref); resolves with the raw result (a refusal is not an exception). */
export function pushRef(git: GitRunner, cwd: string, remote: string, src: string, dst: string, options: PushOptions = {}): Promise<GitResult> {
  const args = ['push', '--porcelain'];
  if (options.atomic ?? false) args.push('--atomic');
  if (options.expectedSha !== undefined) args.push(`--force-with-lease=${dst}:${options.expectedSha ?? ''}`);
  args.push(remote, `${src}:${dst}`);
  return git(args, cwd);
}

export interface SeedRepo {
  /** non-bare working repository whose `main` is `sha` */
  path: string;
  url: string;
  sha: string;
  /** git tree oid of `sha` */
  treeId: string;
  branch: 'main';
}

/** Create a working repository with one commit holding `files` on `main`. */
export async function createSeedRepo(git: GitRunner, dir: string, files: FileChanges, message = 'seed'): Promise<SeedRepo> {
  await initWorkRepo(git, dir, 'main');
  const sha = await commitFiles(git, dir, files, message);
  const treeId = await revParse(git, dir, `${sha}^{tree}`);
  return { path: dir, url: fileUrl(dir), sha, treeId, branch: 'main' };
}

/**
 * An agent's working copy of a task fork: clone, edit, commit, push to the fork's `main`.
 * `git` is the agent's (credentialed) runner.
 */
export class AgentCheckout {
  constructor(
    readonly git: GitRunner,
    /** an existing working repository whose `origin` is the task fork */
    readonly dir: string,
  ) {}

  static async clone(git: GitRunner, remote: string, dir: string): Promise<AgentCheckout> {
    await cloneRepo(git, remote, dir);
    return new AgentCheckout(git, dir);
  }

  /** Write `files` and commit; returns the sha. */
  commit(files: FileChanges, message: string): Promise<string> {
    return commitFiles(this.git, this.dir, files, message);
  }

  /** Push HEAD to `refs/heads/main` (fast-forward); resolves with the raw result. */
  push(ref = 'refs/heads/main'): Promise<GitResult> {
    return this.git(['push', '--porcelain', 'origin', `HEAD:${ref}`], this.dir);
  }
}
