/**
 * Git plumbing for the CLI: a runner that never carries tokens (credentials come only from the
 * `cforge credential-helper` configured per remote URL), the helper configuration itself, and a
 * one-ref push with busy retry (Artifacts allows one push per repository at a time).
 */
import { execFile } from "node:child_process";
import { CliError, scrub, type CliIo } from "./context.js";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type GitRunner = (args: readonly string[], cwd: string, env?: Record<string, string>) => Promise<GitResult>;

/** Variables that would redirect git away from the cwd repository. */
const STRIPPED_GIT_ENV = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_NAMESPACE"];

export function gitEnv(base: CliIo["env"], extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !STRIPPED_GIT_ENV.includes(k)) env[k] = v;
  return { ...env, GIT_TERMINAL_PROMPT: "0", ...extra };
}

export function nodeGitRunner(io: CliIo): GitRunner {
  return (args, cwd, extra) =>
    new Promise<GitResult>((resolve) => {
      execFile("git", [...args], { cwd, env: gitEnv(io.env, extra), encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 600_000 }, (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr || (error && !stderr ? error.message : "")) });
      });
    });
}

/** Never run hooks or fsmonitor from a materialized repository. */
export const SAFE_GIT = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"];

export async function gitOk(git: GitRunner, args: readonly string[], cwd: string, env?: Record<string, string>): Promise<string> {
  const r = await git([...SAFE_GIT, ...args], cwd, env);
  if (r.code !== 0) throw new CliError("git_failed", scrub(`git ${args.filter((a) => !a.startsWith("-")).slice(0, 2).join(" ")} failed: ${r.stderr.trim() || r.stdout.trim()}`));
  return r.stdout.trim();
}

// ------------------------------------------------------------------------------ helper config

function shellQuote(s: string): string {
  return /^[A-Za-z0-9_\-./:=@%+,]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The `credential.<url>.helper` value. Git runs a helper that starts with an absolute path through
 * the shell with `get|store|erase` appended, so the first word must stay an unquoted absolute path
 * (spaces backslash-escaped); the rest is shell-quoted. Never a `!` helper (verifyMaterialization
 * treats those as unsafe), never a token: the helper gets the absolute path of the checkout record,
 * so it finds the task, its remotes and the lease without depending on the caller's environment.
 *
 * Limitation (inherent to git): a helper configured *after* the local config — `git -c
 * credential.helper=…`, `GIT_CONFIG_*`, `config.worktree` — is still appended after ours, and git
 * would hand it the (short-lived) token on `store`. Do not set persisting helpers that way.
 */
export function helperValue(helperCommand: readonly string[], recordPath: string): string {
  const [exe, ...rest] = helperCommand;
  if (!exe || !exe.startsWith("/")) throw new CliError("helper_unavailable", "the credential helper needs an absolute executable path");
  const first = exe.replace(/([^A-Za-z0-9_\-./])/g, "\\$1");
  return [first, ...[...rest, "credential-helper", "--record", recordPath].map(shellQuote)].join(" ");
}

/**
 * Config entries scoping the helper to one remote URL: an empty `helper` first resets every helper
 * inherited from system/global config (so e.g. a global `store` helper never receives a token),
 * then ours; `useHttpPath` makes git pass the repository path so the helper can match it.
 */
export function helperConfigEntries(remoteUrl: string, helperCommand: readonly string[], recordPath: string): Array<[string, string]> {
  return [
    [`credential.${remoteUrl}.helper`, ""],
    [`credential.${remoteUrl}.helper`, helperValue(helperCommand, recordPath)],
    [`credential.${remoteUrl}.useHttpPath`, "true"],
  ];
}

/**
 * A mount's git-lfs wiring (folders phase 4, P4-7): `lfs.url` from the plan (so folders without a
 * `.lfsconfig` work too), `lfs.fetchexclude = *` (files stay pointers: a checkout never downloads
 * LFS objects) and the helper scoped to the LFS URL, which answers it with the task lease.
 */
export function lfsConfigEntries(lfsUrl: string, helperCommand: readonly string[], recordPath: string): Array<[string, string]> {
  return [["lfs.url", lfsUrl], ["lfs.fetchexclude", "*"], ...helperConfigEntries(lfsUrl, helperCommand, recordPath)];
}

/** The same entries as `GIT_CONFIG_COUNT/KEY/VALUE` (for `git clone`, before a local config exists). */
export function helperConfigEnv(entries: Array<[string, string]>): Record<string, string> {
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(entries.length) };
  entries.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k;
    env[`GIT_CONFIG_VALUE_${i}`] = v;
  });
  return env;
}

/** Write the helper entries into a mount's local `.git/config` (replacing earlier ones). */
export async function installHelperConfig(git: GitRunner, dir: string, entries: Array<[string, string]>): Promise<void> {
  const keys = [...new Set(entries.map(([k]) => k))];
  for (const k of keys) {
    const r = await git([...SAFE_GIT, "config", "--local", "--unset-all", k], dir);
    if (r.code !== 0 && r.code !== 5) throw new CliError("git_failed", scrub(`git config --unset-all ${k}: ${r.stderr.trim()}`));
  }
  for (const [k, v] of entries) await gitOk(git, ["config", "--local", "--add", k, v], dir);
}

// --------------------------------------------------------------------------------------- push

const BUSY_RE = /receive_pack_busy|receive-pack busy|remote end hung up|hung up unexpectedly|early EOF|HTTP (?:409|429|5\d\d)|returned error: (?:409|429|5\d\d)|Connection reset|timed out|could not lock|cannot lock ref/i;

export async function lsRemote(git: GitRunner, dir: string, ref: string): Promise<string | null> {
  const out = await gitOk(git, ["ls-remote", "--", "origin", ref], dir);
  for (const line of out.split("\n")) {
    const [sha, name] = line.split("\t");
    if (name === ref && sha) return sha;
  }
  return null;
}

export interface PushOptions {
  git: GitRunner;
  dir: string;
  sha: string;
  ref: string;
  /** lease: the sha the ref must hold, `null` = must not exist, `undefined` = plain fast-forward push */
  expected?: string | null;
  attempts?: number;
  sleep: (ms: number) => Promise<void>;
  baseDelayMs?: number;
}

export type PushResult = { status: "pushed" | "already"; attempts: number } | { status: "rejected"; detail: string; observed: string | null };

/**
 * Push exactly one ref (`<sha>:<ref>`, never `--atomic`, never `--mirror`). A busy/transient
 * failure is retried with jittered backoff; a push that landed although the response was lost is
 * detected with `ls-remote`.
 */
export async function pushOneRef(o: PushOptions): Promise<PushResult> {
  const attempts = o.attempts ?? 6;
  const base = o.baseDelayMs ?? 300;
  let detail = "";
  for (let i = 1; i <= attempts; i++) {
    const lease = o.expected === undefined ? [] : [`--force-with-lease=${o.ref}:${o.expected ?? ""}`];
    const r = await o.git([...SAFE_GIT, "push", "--porcelain", "--no-verify", ...lease, "--", "origin", `${o.sha}:${o.ref}`], o.dir);
    if (r.code === 0) return { status: "pushed", attempts: i };
    detail = scrub(`${r.stdout}\n${r.stderr}`.trim());
    let observed: string | null = null;
    try {
      observed = await lsRemote(o.git, o.dir, o.ref);
    } catch {
      observed = null;
    }
    if (observed === o.sha) return { status: "already", attempts: i };
    if (!BUSY_RE.test(detail)) return { status: "rejected", detail, observed };
    if (i < attempts) await o.sleep(Math.round(base * 2 ** (i - 1) * (0.5 + Math.random())));
  }
  return { status: "rejected", detail, observed: null };
}
