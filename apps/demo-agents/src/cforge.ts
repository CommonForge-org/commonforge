/**
 * Running the `cforge` CLI (apps/cli) on behalf of an agent. The agent's cforge process gets a
 * private config dir and HOME and only the task lease (`CFORGE_LEASE_TOKEN` bound to
 * `CFORGE_LEASE_API_URL`): never the owner's CLI session.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runProc, tail, type ProcResult } from "./proc.js";

export type CforgeRunner = (argv: readonly string[], opts: { cwd: string; env: Record<string, string> }) => Promise<ProcResult>;

/** `apps/cli/dist/index.js` (the bundled bin) of the workspace dependency `@commonforge-org/cli`. */
export function cforgeBin(): string {
  const pkg = createRequire(import.meta.url).resolve("@commonforge-org/cli/package.json");
  return join(dirname(pkg), "dist", "index.js");
}

/** cforge as a child process (`node <cli>/dist/index.js …`), with exactly the given environment. */
export function subprocessCforge(bin = cforgeBin()): CforgeRunner {
  return (argv, opts) => runProc(process.execPath, [bin, ...argv], { cwd: opts.cwd, env: opts.env, timeoutMs: 15 * 60_000 });
}

export interface AgentIdentity {
  /** agent home: `.gitconfig` with the agent identity; `.config/commonforge` is its private cforge config dir */
  home: string;
  configDir: string;
  env: Record<string, string>;
}

/**
 * Prepare an agent's cforge environment. Only these variables reach the agent's cforge (and the
 * git and credential-helper processes it starts): PATH, HOME, the private config dir, the API URL
 * and the lease. No session, no Cloudflare credentials.
 */
export async function agentIdentity(home: string, name: string, apiUrl: string, leaseToken: string): Promise<AgentIdentity> {
  const configDir = join(home, ".config", "commonforge");
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await writeFile(join(home, ".gitconfig"), `[user]\n\tname = ${name}\n\temail = ${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}@agents.commonforge.invalid\n[init]\n\tdefaultBranch = main\n`);
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    CFORGE_CONFIG_DIR: configDir,
    CFORGE_API_URL: apiUrl,
    CFORGE_LEASE_TOKEN: leaseToken,
    CFORGE_LEASE_API_URL: apiUrl,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    LANG: "C.UTF-8",
  };
  return { home, configDir, env };
}

export class CforgeError extends Error {
  constructor(
    readonly command: string,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/** Run `cforge … --json` and parse its single JSON document; a non-zero exit becomes a CforgeError. */
export async function cforgeJson<T>(cforge: CforgeRunner, argv: readonly string[], opts: { cwd: string; env: Record<string, string> }): Promise<T> {
  const r = await cforge([...argv, "--json"], opts);
  const line = r.stdout.trim().split("\n").filter(Boolean).pop() ?? "";
  let doc: unknown = null;
  try {
    doc = JSON.parse(line);
  } catch {
    /* not JSON */
  }
  const err = (doc as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
  if (r.code !== 0 || err || doc === null) {
    throw new CforgeError(argv[0] ?? "cforge", err?.code ?? `exit_${r.code}`, `cforge ${argv[0]} failed: ${err?.message ?? tail(r.stderr || r.stdout, 800)}`, err?.details);
  }
  return doc as T;
}

export const packageRoot = () => join(dirname(fileURLToPath(import.meta.url)), "..");
