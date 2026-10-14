/**
 * Node implementation of the materialization io port (runner, CLI, tests). Uses `child_process`
 * and `fs`; not Worker-safe, hence the separate `./node` subpath export.
 */
import { execFile } from 'node:child_process';
import { lstat, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import type { AssetObjectRequest, FileStat, GitResult, MaterializeIo } from '../io.js';

export interface NodeIoOptions {
  /** extra environment for git (e.g. GIT_CONFIG_* for a credential helper); never put tokens in args */
  env?: Record<string, string>;
  /** git executable (default `git`) */
  gitBinary?: string;
  /** git timeout in ms (default 10 minutes) */
  gitTimeoutMs?: number;
  /** asset object fetcher (via the capability broker) */
  fetchObject?: (request: AssetObjectRequest) => Promise<Uint8Array>;
}

/** Variables that would redirect git away from the cwd repository. */
const STRIPPED_GIT_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_NAMESPACE'];

function gitEnv(extra: Record<string, string> | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of STRIPPED_GIT_ENV) delete env[k];
  return { ...env, GIT_TERMINAL_PROMPT: '0', ...extra };
}

function isNotFound(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === 'ENOENT';
}

export function createNodeIo(options: NodeIoOptions = {}): MaterializeIo {
  const env = gitEnv(options.env);
  const io: MaterializeIo = {
    git(args, cwd) {
      return new Promise<GitResult>((resolve) => {
        execFile(
          options.gitBinary ?? 'git',
          [...args],
          { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: options.gitTimeoutMs ?? 600_000 },
          (error, stdout, stderr) => {
            const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
            resolve({ code, stdout: String(stdout), stderr: String(stderr || (error && !stderr ? error.message : '')) });
          },
        );
      });
    },
    async lstat(path): Promise<FileStat | null> {
      try {
        const st = await lstat(path);
        const type = st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other';
        return { type, size: st.size };
      } catch (e) {
        if (isNotFound(e)) return null;
        throw e;
      }
    },
    readdir: (path) => readdir(path),
    realpath: (path) => realpath(path),
    async readFile(path) {
      try {
        return new Uint8Array(await readFile(path));
      } catch (e) {
        if (isNotFound(e)) return null;
        throw e;
      }
    },
    async writeFile(path, data) {
      // 'wx' = O_CREAT|O_EXCL: never overwrites and never follows a planted symlink.
      await writeFile(path, data, { flag: 'wx' });
    },
    async mkdir(path, opts) {
      await mkdir(path, { recursive: opts?.recursive ?? false });
    },
  };
  if (options.fetchObject) io.fetchObject = options.fetchObject;
  return io;
}
