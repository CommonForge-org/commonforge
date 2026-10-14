/**
 * The checks runner: allowlisted validation commands executed in an isolated child process.
 *
 * Isolation (plan §F, review I-3/M-9):
 * - the command string is parsed without a shell (whitespace-separated words; any shell
 *   metacharacter, quote or escape refuses the command) and must match an allowlisted pattern;
 * - the child gets a fresh, minimal environment: PATH, a per-job HOME/TMPDIR, `CI=1` and the
 *   configured non-secret extras. It never inherits the runner's environment, so no repository
 *   token, broker credential or evidence key can reach it (tokens only ever exist in the env of
 *   the individual git processes that need them, and no git process runs while checks run);
 * - it runs in a separate checkout (an exported tree without `.git`), never in a repository the
 *   runner pushes from, in its own process group, killed on timeout;
 * - stdout/stderr are captured up to a cap and redacted before they leave the runner.
 *
 * Commands still execute candidate code (that is what tests are); the allowlist bounds the entry
 * points, the isolation bounds what that code can reach. Evidence is signed by the parent after
 * the child exits.
 */
import { spawn } from 'node:child_process';
import { checkPath } from '@commonforge-org/core';

/**
 * One allowlisted command shape. Words are literals, or placeholders:
 * - `{name}`: one identifier-like word (`[A-Za-z0-9][A-Za-z0-9:_.@/-]*`, no `..`);
 * - `{path}`: a normalized relative path inside the mount;
 * - `{args*}`: any number of further safe words (`[A-Za-z0-9_@%+=:,./-]`, no `..` segment).
 */
export type CommandPattern = readonly string[];

export const DEFAULT_COMMAND_ALLOWLIST: readonly CommandPattern[] = [
  ['pnpm', 'install', '{args*}'],
  ['pnpm', 'test', '{args*}'],
  ['pnpm', 'run', '{name}', '{args*}'],
  ['pnpm', 'exec', '{name}', '{args*}'],
  ['pnpm', '{name}'],
  ['npm', 'ci', '{args*}'],
  ['npm', 'install', '{args*}'],
  ['npm', 'test', '{args*}'],
  ['npm', 'run', '{name}', '{args*}'],
  ['npx', 'vitest', '{args*}'],
  ['npx', 'tsc', '{args*}'],
  ['node', '{path}', '{args*}'],
];

const METACHAR_RE = /[;&|<>`$(){}[\]*?!~#'"\\\n\r\t\0]/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9:_.@/-]*$/;
const ARG_RE = /^[A-Za-z0-9_@%+=:,./-]+$/;
const noDotDot = (w: string) => !w.split(/[/=]/).includes('..');

export type ParsedCommand = { ok: true; argv: string[] } | { ok: false; reason: string };

/** Split and match a command against the allowlist. Never invokes a shell. */
export function parseAllowedCommand(command: string, allowlist: readonly CommandPattern[] = DEFAULT_COMMAND_ALLOWLIST): ParsedCommand {
  if (METACHAR_RE.test(command)) {
    return { ok: false, reason: 'shell metacharacters are not allowed' };
  }
  const argv = command.trim().split(/ +/).filter(Boolean);
  if (argv.length === 0) return { ok: false, reason: 'empty command' };
  for (const pattern of allowlist) if (matches(argv, pattern)) return { ok: true, argv };
  return { ok: false, reason: `command is not on the runner allowlist: ${argv.slice(0, 3).join(' ')}` };
}

function matches(argv: readonly string[], pattern: CommandPattern): boolean {
  let i = 0;
  for (const p of pattern) {
    if (p === '{args*}') {
      return argv.slice(i).every((w) => ARG_RE.test(w) && noDotDot(w));
    }
    const w = argv[i];
    if (w === undefined) return false;
    if (p === '{name}') {
      if (!NAME_RE.test(w) || !noDotDot(w)) return false;
    } else if (p === '{path}') {
      const r = checkPath(w);
      if (!r.ok || !ARG_RE.test(w)) return false;
    } else if (p !== w) {
      return false;
    }
    i++;
  }
  return i === argv.length;
}

export interface IsolatedRunRequest {
  argv: readonly string[];
  cwd: string;
  /** the complete environment of the child (see {@link checkEnvironment}) */
  env: Record<string, string>;
  timeoutMs: number;
  /** captured bytes per stream (default 256 KiB; the tail is kept) */
  maxOutputBytes?: number;
  /** run as this uid/gid (runner started as root; checks then cannot read the runner's /proc) */
  uid?: number;
  gid?: number;
  /**
   * `none`: run in a fresh network namespace with no interfaces but loopback (`unshare --net`,
   * then `setpriv` drops to uid/gid). Needs root with CAP_SYS_ADMIN and a uid; see
   * {@link probeNetworkIsolation}.
   */
  network?: 'inherit' | 'none';
}

/** argv that runs `argv` with no network as uid/gid (unshare + setpriv from util-linux). */
export function noNetworkArgv(argv: readonly string[], uid: number, gid: number): string[] {
  return ['unshare', '--net', '--', 'setpriv', `--reuid=${uid}`, `--regid=${gid}`, '--clear-groups', '--inh-caps=-all', '--', ...argv];
}

/** True when `unshare --net` works here (root with CAP_SYS_ADMIN). */
export async function probeNetworkIsolation(): Promise<boolean> {
  return new Promise((resolve) => {
    const c = spawn('unshare', ['--net', '--', 'true'], { stdio: 'ignore' });
    c.on('error', () => resolve(false));
    c.on('close', (code) => resolve(code === 0));
  });
}

export interface IsolatedRunResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  /** stdout was larger than the cap */
  truncated: boolean;
  startedAt: Date;
  endedAt: Date;
}

/**
 * The child's whole environment. `extra` must be non-secret configuration; the runner refuses
 * extras that look like secrets before calling this.
 */
export function checkEnvironment(base: { path: string; home: string; tmp: string }, extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...extra,
    PATH: base.path,
    HOME: base.home,
    TMPDIR: base.tmp,
    LANG: 'C.UTF-8',
    CI: '1',
    NO_COLOR: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
}

class Tail {
  #chunks: Buffer[] = [];
  #size = 0;
  truncated = false;
  constructor(readonly cap: number) {}
  push(b: Buffer) {
    this.#chunks.push(b);
    this.#size += b.length;
    while (this.#size > this.cap && this.#chunks.length > 1) {
      this.#size -= this.#chunks.shift()!.length;
      this.truncated = true;
    }
  }
  text(): string {
    const all = Buffer.concat(this.#chunks);
    if (all.length > this.cap) {
      this.truncated = true;
      return all.subarray(all.length - this.cap).toString('utf8');
    }
    return all.toString('utf8');
  }
}

/** Run argv in its own process group with a clean environment; kill the group on timeout. */
export function runIsolated(req: IsolatedRunRequest): Promise<IsolatedRunResult> {
  const cap = req.maxOutputBytes ?? 256 * 1024;
  return new Promise((resolve) => {
    const startedAt = new Date();
    const out = new Tail(cap);
    const err = new Tail(cap);
    let timedOut = false;
    let settled = false;
    const noNet = req.network === 'none';
    if (noNet && req.uid === undefined) throw new Error('network isolation needs a check uid');
    const argv = noNet ? noNetworkArgv(req.argv, req.uid!, req.gid ?? req.uid!) : [...req.argv];
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: req.cwd,
      env: req.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      // with network isolation the wrapper starts as root and setpriv drops the uid
      ...(!noNet && req.uid !== undefined ? { uid: req.uid } : {}),
      ...(!noNet && req.gid !== undefined ? { gid: req.gid } : {}),
    });
    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, req.timeoutMs);
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    const finish = (exitCode: number | null, signal: string | null, extra = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // reap anything the command left running in its group
      killGroup();
      const stdout = out.text();
      resolve({ exitCode, signal, timedOut, stdout, stderr: err.text() + extra, truncated: out.truncated, startedAt, endedAt: new Date() });
    };
    child.on('error', (e) => finish(127, null, `\n${String(e)}`));
    child.on('close', (code, signal) => finish(code, signal));
  });
}
