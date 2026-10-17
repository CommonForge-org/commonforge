/** cforge — the CommonForge developer CLI (`@commonforge-org/cli`). */
import { createInterface as createLineReader } from "node:readline";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { handoff, contextCommand, nativeCommand, propose, nativeResults, renew } from "./native.js";
import { checkout } from "./checkout.js";
import { checkpoint } from "./checkpoint.js";
import type { CommandContext } from "./command.js";
import { ConfigStore } from "./config.js";
import { CliError, Output, scrub, type CliIo, type GlobalOptions } from "./context.js";
import { credentialHelper } from "./credential-helper.js";
import { exportCommand } from "./export.js";
import { nodeGitRunner, type GitRunner } from "./git.js";
import { login, logout, whoami } from "./login.js";
import { McpServer } from "./mcp.js";
import { project, task } from "./project.js";
import { status } from "./status.js";
import { submit } from "./submit.js";

export const CLI_NAME = "cforge";
/** Kept equal to package.json "version" (test/main.test.ts checks it). */
export const VERSION = "0.1.0";

const HELP = `cforge — CommonForge developer CLI

Usage: cforge <command> [options]

  login --email <addr> | --code <code>   sign in (CLI code flow); the session is stored 0600 in the config dir
  logout | whoami
  renew --code <replacement> --out <new> renew task authority into a fresh verified checkout
  handoff --code <code>                 exchange one-time task authority (no broad user session)
  results <taskId>                      inspect this attempt’s proposal, evidence and decision history
  propose <taskId>                      integrate submitted candidates, then freeze exact project review
  context <taskId> [--out <workspace>]   inspect and export pinned project understanding
  native <taskId> --command <JSON>       propose knowledge or an exact project change
  project list | show <projectId> | tasks <projectId>
  task create <projectId> --title <t> [--request <text>] [--write <mount>...] | lease <taskId> | release <taskId>
  checkout <taskId> <dir>                materialize a task workspace (verified); git uses the credential helper
  status [taskId]                        the task, its candidates and the local checkout
  checkpoint [--mount <m>] [--commit <msg>]   push refs/commonforge/checkpoints/<n> (recoverable, not frozen)
  submit [--mount <m>] [--commit <msg>]       push, then freeze; prints the candidate id(s)
  export <projectId> [--out <dir>]       download the project's git bundles + manifest
  credential-helper --record <path> get  git credential helper (configured by checkout)
  mcp                                    serve these commands as MCP tools on stdio (for Claude, Codex and other agent apps)

Global options: --json (one JSON document on stdout, for agents), --api-url <url>, --org <org>
Environment: CFORGE_API_URL, CFORGE_ORG, CFORGE_CONFIG_DIR,
  CFORGE_LEASE_TOKEN + CFORGE_LEASE_API_URL (a task lease handed to an agent, and the API it belongs to)
Plain http is accepted only for localhost. Git tracing with GIT_TRACE_REDACT=0 would print tokens.
`;

type Handler = (ctx: CommandContext, args: readonly string[]) => Promise<void | number>;

const COMMANDS: Record<string, Handler> = {
  login,
  logout,
  whoami,
  project,
  task,
  checkout,
  handoff,
  renew,
  context: contextCommand,
  native: nativeCommand,
  propose,
  results: nativeResults,
  status,
  checkpoint,
  submit,
  export: exportCommand,
  "credential-helper": credentialHelper,
};

/**
 * The argv git runs as the credential helper. Under an Electron runtime (an agent app running the
 * MCP server with its own bundled Node, e.g. the Claude Desktop extension) the binary is the app
 * itself, so it is told to act as Node: git runs the helper without the server's environment.
 */
export function helperCommandFor(execPath: string, entry: string, electron: boolean): string[] {
  return electron ? ["/usr/bin/env", "ELECTRON_RUN_AS_NODE=1", execPath, entry] : [execPath, entry];
}

function defaultIo(): CliIo {
  const entry = fileURLToPath(new URL("./index.js", import.meta.url));
  return {
    env: process.env,
    cwd: process.cwd(),
    stdout: (t) => void process.stdout.write(t),
    stderr: (t) => void process.stderr.write(t),
    readStdin: async () => {
      if (process.stdin.isTTY) return "";
      const chunks: Buffer[] = [];
      for await (const c of process.stdin) chunks.push(c as Buffer);
      return Buffer.concat(chunks).toString("utf8");
    },
    prompt: async (q) => {
      if (!process.stdin.isTTY || !process.stderr.isTTY) return null;
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        return (await rl.question(q)).trim() || null;
      } finally {
        rl.close();
      }
    },
    fetch: globalThis.fetch,
    now: () => new Date(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    helperCommand: helperCommandFor(process.execPath, entry, process.versions.electron !== undefined),
  };
}

/** Global flags, read only before a `--` terminator (each command's parser validates them again). */
function globalOptions(all: readonly string[]): GlobalOptions {
  const end = all.indexOf("--");
  const argv = end < 0 ? all : all.slice(0, end);
  const g: GlobalOptions = { json: argv.includes("--json") };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    for (const [flag, key] of [["--api-url", "apiUrl"], ["--org", "org"]] as const) {
      if (a === flag && argv[i + 1] !== undefined) g[key] = argv[i + 1]!;
      else if (a.startsWith(`${flag}=`)) g[key] = a.slice(flag.length + 1);
    }
  }
  return g;
}

export async function run(argv: readonly string[], ioOverrides: Partial<CliIo> = {}, deps: { git?: GitRunner; mcpInput?: AsyncIterable<string> } = {}): Promise<number> {
  const io: CliIo = { ...defaultIo(), ...ioOverrides };
  const global = globalOptions(argv);
  const out = new Output(io, global.json);
  const [name, ...rest] = argv;
  if (!name || name === "--help" || name === "-h" || name === "help") {
    io.stdout(HELP);
    return 0;
  }
  if (name === "--version" || name === "-v" || name === "version") {
    out.result({ name: CLI_NAME, version: VERSION }, `${CLI_NAME} ${VERSION}`);
    return 0;
  }
  if (name === "mcp") return serveMcp(io, deps, rest, deps.mcpInput);
  const handler = COMMANDS[name];
  if (!handler) {
    out.error(new CliError("unknown_command", `unknown command ${JSON.stringify(name)}; run \`cforge --help\``, undefined, 2));
    return 2;
  }
  const ctx: CommandContext = { io, out, store: new ConfigStore(io.env), git: deps.git ?? nodeGitRunner(io), global };
  try {
    const r = await handler(ctx, rest);
    return typeof r === "number" ? r : 0;
  } catch (e) {
    if (e instanceof CliError && e.code === "help") {
      io.stdout(`${e.message}\n`);
      return 0;
    }
    const err = e instanceof CliError ? e : new CliError("internal_error", scrub(e instanceof Error ? e.message : String(e)));
    if (name === "credential-helper") {
      // never break git's protocol stream with a JSON error
      io.stderr(scrub(`cforge credential-helper: ${err.message}\n`));
      io.stdout("quit=1\n");
      return 0;
    }
    out.error(err);
    return err.exitCode;
  }
}

/**
 * `cforge mcp`: each tool call runs one command in-process with the same environment, its output
 * captured; stdout carries only protocol messages.
 */
async function serveMcp(io: CliIo, deps: { git?: GitRunner }, args: readonly string[], lines?: AsyncIterable<string>): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    io.stdout("usage: cforge mcp\nServes cforge as MCP tools on stdin/stdout (JSON-RPC, one message per line). Configure it in your agent app; see the README.\n");
    return 0;
  }
  const global = globalOptions(args);
  const pinned = global.apiUrl ?? io.env.CFORGE_API_URL;
  const server = new McpServer(VERSION, async (argv) => {
    let stdout = "";
    let stderr = "";
    // `cforge mcp --api-url/--org` apply to every tool, as options right after the command name
    const has = (name: string) => argv.some((a) => a === "--" ? false : a.startsWith(`--${name}=`));
    const globals = [...(global.apiUrl && !has("api-url") ? [`--api-url=${global.apiUrl}`] : []), ...(global.org && !has("org") ? [`--org=${global.org}`] : [])];
    const code = await run([argv[0]!, ...globals, ...argv.slice(1)], {
      ...io,
      stdout: (t) => void (stdout += t),
      stderr: (t) => void (stderr += t),
      readStdin: async () => "",
      prompt: async () => null,
    }, deps.git ? { git: deps.git } : {});
    return { code, stdout, stderr };
  }, pinned || undefined);
  io.stderr(`cforge ${VERSION}: MCP server on stdio\n`);
  await server.serve(lines ?? createLineReader({ input: process.stdin, crlfDelay: Infinity }), io.stdout);
  return 0;
}
