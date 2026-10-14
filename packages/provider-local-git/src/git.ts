/**
 * The provider's own git process runner (Node `child_process`).
 *
 * Isolation (same defaults as the conformance `nodeGitRunner`): global and system git config are
 * ignored (`GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`), every inherited `GIT_*`
 * variable is dropped (a caller running inside a git hook must not redirect us to another
 * repository), as is `COMMONFORGE_TOKEN` (the provider never pushes as anyone). Output is kept
 * as bytes so blobs survive unchanged.
 */
import { spawn } from 'node:child_process';

export interface GitExecResult {
  code: number;
  stdout: Uint8Array;
  stderr: string;
}

export interface GitExecOptions {
  /** bytes written to stdin */
  input?: string | Uint8Array;
  /** extra environment for this call (merged last) */
  env?: Record<string, string>;
}

export type GitExec = (args: readonly string[], cwd: string, options?: GitExecOptions) => Promise<GitExecResult>;

export const ISOLATED_GIT_ENV: Readonly<Record<string, string>> = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  LC_ALL: 'C',
};

function baseEnv(extra: Record<string, string> | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('GIT_') || k === 'COMMONFORGE_TOKEN') continue;
    env[k] = v;
  }
  return { ...env, ...ISOLATED_GIT_ENV, ...extra };
}

export interface NodeGitExecOptions {
  /** git executable (default `git`) */
  binary?: string;
  /** extra environment for every call (e.g. `GIT_SSH_COMMAND` for importing a source) */
  env?: Record<string, string>;
  /** per-call timeout in ms (default 10 minutes) */
  timeoutMs?: number;
}

export function createGitExec(options: NodeGitExecOptions = {}): GitExec {
  const binary = options.binary ?? 'git';
  const timeout = options.timeoutMs ?? 600_000;
  return (args, cwd, callOptions = {}) =>
    new Promise<GitExecResult>((resolve) => {
      const child = spawn(binary, [...args], {
        cwd,
        env: baseEnv({ ...options.env, ...callOptions.env }),
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout,
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let settled = false;
      const finish = (r: GitExecResult) => {
        if (settled) return;
        settled = true;
        resolve(r);
      };
      child.stdout.on('data', (d: Buffer) => out.push(d));
      child.stderr.on('data', (d: Buffer) => err.push(d));
      child.on('error', (e) => finish({ code: 127, stdout: new Uint8Array(), stderr: e.message }));
      child.on('close', (code, signal) => {
        const stderr = Buffer.concat(err).toString('utf8');
        finish({ code: code ?? (signal ? 128 : 1), stdout: new Uint8Array(Buffer.concat(out)), stderr: signal ? `${stderr}killed by ${signal}` : stderr });
      });
      child.stdin.on('error', () => undefined); // git may exit before reading stdin
      child.stdin.end(callOptions.input === undefined ? undefined : typeof callOptions.input === 'string' ? Buffer.from(callOptions.input, 'utf8') : Buffer.from(callOptions.input));
    });
}

const decoder = new TextDecoder();
export const utf8 = (b: Uint8Array): string => decoder.decode(b);
