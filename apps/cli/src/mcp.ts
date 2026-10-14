/**
 * `cforge mcp`: a Model Context Protocol server on stdio (newline-delimited JSON-RPC 2.0), so an
 * agent app (Claude Desktop, Claude Code, Codex) can sign in, list projects and tasks, create a
 * task, check it out and submit it without a terminal.
 *
 * Each tool runs the matching cforge command in-process with `--json` and returns its JSON. The
 * tools add no permission of their own: the Worker checks every request as it does for the CLI,
 * and the session and leases live in the same 0600 config dir. Nothing a tool prints reaches
 * stdout except the protocol messages (command output is captured and scrubbed).
 */
import { isAbsolute } from "node:path";
import { normalizeApiUrl } from "./api.js";
import { CliError, scrub } from "./context.js";

/** What a tool call needs from the CLI: run one command with `--json`, capturing its output. */
export type InvokeCli = (argv: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

export const MCP_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;

const INSTRUCTIONS = `CommonForge tools for working on a website or app project an agency manages.
Start with sign_in if a tool answers login_required: the person gets a one-time code from the CommonForge app (Account page, or the task's Give to agent).
To ask for a change: list_projects, then create_task with a title and the request in plain words. The project's owner decides which folders a task can change.
To do the work (needs local files and git): checkout_task into an empty folder, edit only inside it, then submit_task. save_progress keeps work safe without handing it in.`;

interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties: false };
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  /**
   * The command it runs: options as `--name=value` (a value may start with "-", e.g. a markdown
   * list), and the positionals after `--`, so no argument can be read as an option.
   */
  argv: (a: Record<string, string>) => Cmd;
}

const ORG = { type: "string", description: "Organization id (o-…). Only needed when you belong to several." };
const text = (description: string) => ({ type: "string", description });
const folder = text("Absolute path of the task's local folder (the one passed to checkout_task).");

/** `--api-url` from a pasted `cforge login … --api-url <url>` command, or the origin of an emailed link. */
export function apiUrlFromCode(input: string): string | undefined {
  const s = input.trim();
  if (!/^https?:\/\//i.test(s) && !s.startsWith("cforge")) return undefined;
  const flag = /--api-url[=\s]+["']?([^\s"']+)/.exec(s);
  if (flag) return flag[1];
  if (/^https?:\/\//i.test(s)) {
    try {
      return new URL(s).origin;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

interface Cmd {
  command: string;
  options?: string[];
  args?: string[];
}

const opt = (name: string, value: string) => `--${name}=${value}`;

function orgArgs(a: Record<string, string>): string[] {
  return a.org ? [opt("org", a.org)] : [];
}

/** `[command, --json, options…, --, positionals…]` */
export function commandLine(c: Cmd): string[] {
  return [c.command, "--json", ...(c.options ?? []), "--", ...(c.args ?? [])];
}

function absolute(path: string | undefined, what: string): string {
  if (!path || !isAbsolute(path)) throw new CliError("invalid_arguments", `${what} must be an absolute path`, undefined, 2);
  return path;
}

export const TOOLS: ToolDef[] = [
  {
    name: "sign_in",
    title: "Sign in to CommonForge",
    description: "Sign in with a one-time code from the CommonForge app. Accepts the bare code (cfm_…), the emailed link, or the whole `cforge login …` command. The code works once and expires after 15 minutes.",
    inputSchema: { type: "object", properties: { code: text("The one-time code, link or login command."), api_url: text("The CommonForge address, e.g. https://forge.example.com. Read from the code's link or command when left out.") }, required: ["code"], additionalProperties: false },
    annotations: { idempotentHint: false, openWorldHint: true },
    argv: (a) => {
      // the Account page's "Sign in to CommonForge: cforge login …" message: that line's command
      const code = /cforge\s+login\b[^\r\n]*/.exec(a.code ?? "")?.[0]?.trim() ?? a.code ?? "";
      const api = a.api_url ?? apiUrlFromCode(code);
      return { command: "login", options: [opt("code", code), ...(api ? [opt("api-url", api)] : [])] };
    },
  },
  {
    name: "who_am_i",
    title: "Who am I",
    description: "The signed-in person and their organizations and roles.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
    argv: () => ({ command: "whoami" }),
  },
  {
    name: "list_projects",
    title: "List projects",
    description: "The projects you can see in your organization.",
    inputSchema: { type: "object", properties: { org: ORG }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
    argv: (a) => ({ command: "project", options: orgArgs(a), args: ["list"] }),
  },
  {
    name: "list_tasks",
    title: "List tasks",
    description: "A project's tasks with their state. Clients see the tasks they created.",
    inputSchema: { type: "object", properties: { project_id: text("Project id (p-…), from list_projects."), org: ORG }, required: ["project_id"], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
    argv: (a) => ({ command: "project", options: orgArgs(a), args: ["tasks", a.project_id ?? ""] }),
  },
  {
    name: "create_task",
    title: "Create a task",
    description: "Ask for a change. Give a short title and the request in plain words; the project's settings decide which folders the task can change.",
    inputSchema: {
      type: "object",
      properties: { project_id: text("Project id (p-…), from list_projects."), title: text("A short title, e.g. Holiday opening hours."), request: text("What should change, in plain words."), org: ORG },
      required: ["project_id", "title"],
      additionalProperties: false,
    },
    annotations: { idempotentHint: false, openWorldHint: true },
    argv: (a) => ({ command: "task", options: [opt("title", a.title ?? ""), ...(a.request ? [opt("request", a.request)] : []), ...orgArgs(a)], args: ["create", a.project_id ?? ""] }),
  },
  {
    name: "get_task",
    title: "Task status",
    description: "A task's state, who has it checked out, and what was submitted.",
    inputSchema: { type: "object", properties: { task_id: text("Task id (task-…).") }, required: ["task_id"], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
    argv: (a) => ({ command: "status", args: [a.task_id ?? ""] }),
  },
  {
    name: "checkout_task",
    title: "Check out a task",
    description: "Download the task's files into an empty local folder and take the task, so you can change them. Only the folders the task may change are writable.",
    inputSchema: { type: "object", properties: { task_id: text("Task id (task-…)."), folder: text("Absolute path of an empty or new folder to put the files in.") }, required: ["task_id", "folder"], additionalProperties: false },
    annotations: { idempotentHint: false, openWorldHint: true },
    argv: (a) => ({ command: "checkout", args: [a.task_id ?? "", absolute(a.folder, "folder")] }),
  },
  {
    name: "save_progress",
    title: "Save progress",
    description: "Commit and upload the work so far without handing it in. It can be picked up again from any computer.",
    inputSchema: { type: "object", properties: { folder, message: text("What changed so far.") }, required: ["folder"], additionalProperties: false },
    annotations: { idempotentHint: false, openWorldHint: true },
    argv: (a) => ({ command: "checkpoint", options: [opt("workspace", absolute(a.folder, "folder")), opt("commit", a.message || "Work in progress")] }),
  },
  {
    name: "submit_task",
    title: "Submit the work",
    description: "Commit everything changed in the task's folder and hand it in for review. Run it once, when the work is done.",
    inputSchema: { type: "object", properties: { folder, message: text("A one-line summary of the change.") }, required: ["folder"], additionalProperties: false },
    annotations: { idempotentHint: false, openWorldHint: true },
    argv: (a) => ({ command: "submit", options: [opt("workspace", absolute(a.folder, "folder")), opt("commit", a.message || "Changes for this task"), opt("tool", "mcp")] }),
  },
];

type Id = string | number | null;
interface Request {
  jsonrpc?: string;
  id?: Id;
  method?: string;
  params?: Record<string, unknown>;
}

const rpcError = (id: Id, code: number, message: string) => ({ jsonrpc: "2.0" as const, id, error: { code, message } });

/** A JSON-RPC error answered instead of a result (e.g. -32602 for an unknown tool). */
class RpcFailure extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/** The `--api-url=` a command carries, if any. */
function apiUrlOption(cmd: Cmd): string | undefined {
  return cmd.options?.find((o) => o.startsWith("--api-url="))?.slice("--api-url=".length);
}

function sameApi(a: string, b: string): boolean {
  try {
    return normalizeApiUrl(a) === normalizeApiUrl(b);
  } catch {
    return false;
  }
}

export class McpServer {
  constructor(
    readonly version: string,
    readonly invoke: InvokeCli,
    /** the address the server was started for (`cforge mcp --api-url`, `CFORGE_API_URL`): sign_in keeps to it */
    readonly pinnedApiUrl?: string,
  ) {}

  /** One message (or a batch) in, the response out (null for notifications). */
  async handle(raw: string): Promise<object | null> {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return rpcError(null, -32700, "parse error");
    }
    if (Array.isArray(msg)) {
      if (msg.length === 0) return rpcError(null, -32600, "invalid request");
      const replies = (await Promise.all(msg.map((m) => this.#one(m)))).filter((r) => r !== null);
      return replies.length ? replies : null;
    }
    return this.#one(msg);
  }

  async #one(raw: unknown): Promise<object | null> {
    const msg = raw as Request;
    if (!msg || typeof msg !== "object" || Array.isArray(msg) || typeof msg.method !== "string") return rpcError(msg?.id ?? null, -32600, "invalid request");
    const isNotification = msg.id === undefined;
    if (isNotification) return null;
    const id = msg.id as Id;
    switch (msg.method) {
      case "initialize": {
        const asked = msg.params?.protocolVersion;
        const protocolVersion = (MCP_PROTOCOL_VERSIONS as readonly unknown[]).includes(asked) ? (asked as string) : MCP_PROTOCOL_VERSIONS[0];
        return { jsonrpc: "2.0", id, result: { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "commonforge", title: "CommonForge", version: this.version }, instructions: INSTRUCTIONS } };
      }
      case "ping":
        return { jsonrpc: "2.0", id, result: {} };
      case "tools/list":
        return { jsonrpc: "2.0", id, result: { tools: TOOLS.map(({ argv: _argv, ...t }) => t) } };
      case "tools/call":
        try {
          return { jsonrpc: "2.0", id, result: await this.call(msg.params ?? {}) };
        } catch (e) {
          if (e instanceof RpcFailure) return rpcError(id, e.code, e.message);
          throw e;
        }
      default:
        return rpcError(id, -32601, `method not found: ${msg.method}`);
    }
  }

  async call(params: Record<string, unknown>): Promise<{ content: Array<{ type: "text"; text: string }>; structuredContent?: Record<string, unknown>; isError: boolean }> {
    const tool = TOOLS.find((t) => t.name === params.name);
    const fail = (code: string, message: string) => {
      const body = { error: { code, message } };
      return { content: [{ type: "text" as const, text: JSON.stringify(body) }], structuredContent: body, isError: true };
    };
    if (!tool) throw new RpcFailure(-32602, `unknown tool ${JSON.stringify(params.name)}`);
    const input = (params.arguments ?? {}) as Record<string, unknown>;
    const args: Record<string, string> = {};
    for (const [k, v] of Object.entries(input)) if (typeof v === "string") args[k] = v;
    for (const k of tool.inputSchema.required ?? []) if (!args[k]?.trim()) return fail("invalid_arguments", `${k} is required`);
    let cmd: Cmd;
    try {
      cmd = tool.argv(args);
    } catch (e) {
      return fail(e instanceof CliError ? e.code : "invalid_arguments", (e as Error).message);
    }
    if (tool.name === "sign_in") {
      const refused = await this.#refuseSwitch(cmd);
      if (refused) return fail("signed_in_elsewhere", refused);
    }
    const r = await this.invoke(commandLine(cmd));
    const out = scrub(r.stdout.trim());
    let parsed: unknown = null;
    try {
      parsed = out ? JSON.parse(out.split("\n").pop()!) : null;
    } catch {
      /* not JSON: returned as text */
    }
    const structured = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
    if (r.code !== 0 && !structured) return fail("command_failed", scrub(r.stderr.trim()) || `${tool.name} failed`);
    return { content: [{ type: "text", text: out || scrub(r.stderr.trim()) }], ...(structured ? { structuredContent: structured } : {}), isError: r.code !== 0 };
  }

  /**
   * sign_in may not move a live sign-in to another address: text the agent read could otherwise
   * point every later call (and the terminal cforge) at a server of its choosing. To switch, the
   * person signs out of the current one first (Account page there, or `cforge logout`).
   */
  async #refuseSwitch(cmd: Cmd): Promise<string | null> {
    const wanted = apiUrlOption(cmd);
    if (!wanted) return null;
    if (this.pinnedApiUrl && !sameApi(wanted, this.pinnedApiUrl)) return `this CommonForge connection is set up for ${this.pinnedApiUrl}, not ${wanted}`;
    const me = await this.invoke(commandLine({ command: "whoami" }));
    if (me.code !== 0) return null;
    let current: string | undefined;
    try {
      current = (JSON.parse(me.stdout.trim().split("\n").pop() ?? "") as { apiUrl?: string }).apiUrl;
    } catch {
      return null;
    }
    if (!current || sameApi(current, wanted)) return null;
    return `already signed in to ${current}. To use ${wanted} instead, sign out of ${current} first (its Account page, or \`cforge logout\`), then sign in again.`;
  }

  /** Serve until the input ends. Requests run concurrently; each response is one line. */
  async serve(lines: AsyncIterable<string>, write: (line: string) => void): Promise<void> {
    const pending = new Set<Promise<void>>();
    for await (const line of lines) {
      if (!line.trim()) continue;
      const p = this.handle(line)
        .then((res) => {
          if (res) write(`${JSON.stringify(res)}\n`);
        })
        .catch((e: unknown) => {
          let id: Id = null;
          try {
            id = (JSON.parse(line) as Request).id ?? null;
          } catch {
            /* keep null */
          }
          write(`${JSON.stringify(rpcError(id, -32603, scrub(e instanceof Error ? e.message : String(e))))}\n`);
        })
        .finally(() => pending.delete(p));
      pending.add(p);
    }
    await Promise.all(pending);
  }
}
