/**
 * Real agent sessions: `claude -p` (Claude Code) or `codex exec` (Codex CLI), non-interactive,
 * started in the task workspace root with a fixed prompt. Exact flags are in README.md.
 *
 * - claude (default): `--restricted` (no Bash/code-running tools or WebFetch unless `--tools`
 *   names them, user/project/local settings ignored, file tools confined to the working directory),
 *   `--permission-mode dontAsk` with an explicit `--allowedTools` list (anything not listed is
 *   denied: no mode-level auto-approval of filesystem shell commands), `--permission-prompts none`,
 *   `--strict-mcp-config` (no MCP servers), `--no-session-persistence`, `--max-budget-usd`.
 *   Agent 3 additionally gets `Bash` and exactly one allowed command, matched without a wildcard.
 * - codex (opt-in, `--allow-codex`): `--sandbox workspace-write` (writes only under `--cd`, no
 *   network), `--ignore-user-config`, `-c mcp_servers={}`, `-c approval_policy="never"`,
 *   `-c shell_environment_policy.inherit="core"`, `--ephemeral`, `--ignore-rules`, and a throwaway
 *   0700 `CODEX_HOME` holding only a copy of `auth.json` (no config, hooks, plugins or MCP servers
 *   from the operator's ~/.codex). Its sandbox still does not confine *reads*.
 * - Environment: an allowlist (locale, terminal, temp, proxy/CA settings, HOME for the model login,
 *   plus `ANTHROPIC_*`/`CLAUDE_*` for claude or `OPENAI_*` for codex). The model process never gets
 *   the owner session, a lease, or any other credential variable of the operator's shell.
 */
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { PhaseSpec } from "./prompts.js";
import { runProc, tail } from "./proc.js";

export type AgentCliName = "claude" | "codex";

export interface AgentRun {
  cli: AgentCliName | "dry-run";
  command: string[];
  exitCode: number;
  durationMs: number;
  summary: string;
  costUsd?: number;
  logFile?: string;
}

/** Runs one phase of an agent in `root` (the workspace root); edits land in the mounts. */
export type AgentRunner = (spec: PhaseSpec, root: string) => Promise<AgentRun>;

const BASE_ENV = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LANGUAGE|LC_[A-Z_]+|TERM|COLORTERM|NO_COLOR|TZ|TMPDIR|XDG_[A-Z_]+|HTTPS?_PROXY|https?_proxy|NO_PROXY|no_proxy|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS)$/;
const CLI_ENV: Record<AgentCliName, RegExp> = { claude: /^(ANTHROPIC_|CLAUDE_)/, codex: /^OPENAI_/ };

/** Allowlisted environment for a model process (review M-3). */
export function agentCliEnv(cli: AgentCliName, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && (BASE_ENV.test(k) || CLI_ENV[cli].test(k))) env[k] = v;
  return env;
}

export interface CliOptions {
  model?: string;
  maxBudgetUsd?: number;
  /** per agent step (default 5 min) */
  timeoutMs?: number;
  /** override the executable (tests) */
  bin?: string;
  logDir?: string;
  /** codex: where the operator's codex login lives (default $CODEX_HOME or ~/.codex); only auth.json is copied */
  codexAuthHome?: string;
}

export const DEFAULT_MODEL = "sonnet";
export const DEFAULT_STEP_TIMEOUT_MS = 5 * 60_000;
const FILE_TOOLS = ["Read", "Edit", "Write", "Glob", "Grep"];

export function claudeArgs(spec: PhaseSpec, o: CliOptions): string[] {
  const tools = [...FILE_TOOLS, ...(spec.allowedCommand ? ["Bash"] : [])];
  const allowed = [...FILE_TOOLS, ...(spec.allowedCommand ? [`Bash(${spec.allowedCommand})`] : [])];
  return [
    "-p",
    spec.prompt,
    "--restricted",
    "--tools",
    tools.join(","),
    "--allowedTools",
    ...allowed,
    "--permission-mode",
    "dontAsk",
    "--permission-prompts",
    "none",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--output-format",
    "json",
    "--max-budget-usd",
    String(o.maxBudgetUsd ?? 3),
    "--model",
    o.model ?? DEFAULT_MODEL,
  ];
}

export function codexArgs(spec: PhaseSpec, root: string, o: CliOptions): string[] {
  return [
    "exec",
    "--sandbox",
    "workspace-write",
    "--cd",
    root,
    "--skip-git-repo-check",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--color",
    "never",
    "-c",
    "mcp_servers={}",
    "-c",
    'approval_policy="never"',
    "-c",
    'shell_environment_policy.inherit="core"',
    ...(o.model ? ["--model", o.model] : []),
    spec.prompt,
  ];
}

/** A throwaway 0700 CODEX_HOME with only the operator's auth.json (no config, hooks, plugins, MCP). */
export async function isolatedCodexHome(authHome: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cf-codex-home-"));
  await chmod(dir, 0o700);
  await copyFile(join(authHome, "auth.json"), join(dir, "auth.json"));
  await chmod(join(dir, "auth.json"), 0o600);
  return dir;
}

export function realAgent(cli: AgentCliName, o: CliOptions = {}): AgentRunner {
  return async (spec, root) => {
    const args = cli === "claude" ? claudeArgs(spec, o) : codexArgs(spec, root, o);
    const bin = o.bin ?? cli;
    const env = agentCliEnv(cli);
    let codexHome: string | null = null;
    if (cli === "codex") {
      codexHome = await isolatedCodexHome(o.codexAuthHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex"));
      env.CODEX_HOME = codexHome;
    }
    let r;
    try {
      r = await runProc(bin, args, { cwd: root, env, timeoutMs: o.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS });
    } finally {
      if (codexHome) await rm(codexHome, { recursive: true, force: true });
    }
    let summary = tail(r.stdout.trim(), 1500);
    let costUsd: number | undefined;
    if (cli === "claude") {
      try {
        const doc = JSON.parse(r.stdout) as { result?: string; total_cost_usd?: number };
        summary = tail(doc.result ?? summary, 1500);
        costUsd = doc.total_cost_usd;
      } catch {
        /* not JSON (crash): keep the raw tail */
      }
    }
    const command = [bin, ...args.map((a) => (a === spec.prompt ? "<prompt>" : a))];
    let logFile: string | undefined;
    if (o.logDir) {
      await mkdir(o.logDir, { recursive: true });
      logFile = join(o.logDir, `${spec.agentId}-${spec.phase}-${Date.now()}.log`);
      await writeFile(logFile, `$ ${command.join(" ")}\n\n--- prompt ---\n${spec.prompt}\n\n--- stdout ---\n${r.stdout}\n\n--- stderr ---\n${r.stderr}\n`);
    }
    if (r.code !== 0 || r.timedOut) throw Object.assign(new Error(`${cli} ${spec.agentId}:${spec.phase} ${r.timedOut ? "timed out" : `exited ${r.code}`}: ${tail(r.stderr || r.stdout, 800)}`), { command });
    return { cli, command, exitCode: r.code, durationMs: r.durationMs, summary, ...(costUsd !== undefined ? { costUsd } : {}), ...(logFile ? { logFile } : {}) };
  };
}
