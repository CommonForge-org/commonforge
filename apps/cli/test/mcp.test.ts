/**
 * `cforge mcp`: the JSON-RPC surface and each tool end to end against the fake API (sign in with a
 * one-time code, create a task without folders, check it out, submit), in-process.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { apiUrlFromCode, TOOLS } from "../src/mcp.js";
import { PROJECT } from "./fake-commonforge.js";
import { EMAIL, harness, type Harness } from "./helpers.js";

let h: Harness;

beforeEach(() => {
  h = harness();
  h.world.addResource("api", { "src/quote.ts": "export const quote = 1;\n" });
});
afterEach(() => h.world.close());

let nextId = 1;
const msg = (method: string, params?: unknown) => JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, ...(params !== undefined ? { params } : {}) });
const call = (name: string, args: Record<string, unknown> = {}) => msg("tools/call", { name, arguments: args });

/** Run `cforge mcp` over the given lines; replies by id. */
async function mcp(lines: string[]): Promise<Map<number | null, any>> {
  const r = await h.cli(["mcp"], { mcpInput: lines });
  expect(r.code).toBe(0);
  const replies = r.stdout.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return new Map(replies.map((x: any) => [x.id, x]));
}

/** One tool call; its result. */
async function tool(name: string, args: Record<string, unknown> = {}) {
  const line = call(name, args);
  const id = JSON.parse(line).id;
  return (await mcp([line])).get(id).result as { isError: boolean; structuredContent?: any; content: Array<{ text: string }> };
}

async function emailedCode(): Promise<string> {
  expect((await h.cli(["login", "--email", EMAIL, "--json"])).code).toBe(0);
  return [...h.world.codes.keys()].pop()!;
}

describe("protocol", () => {
  it("initializes, lists the tools, answers ping, and skips notifications", async () => {
    nextId = 1;
    const replies = await mcp([
      msg("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      msg("tools/list"),
      msg("ping"),
      msg("resources/list"),
      "not json",
    ]);
    expect(replies.get(1).result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "commonforge", version: "0.1.0" } });
    expect(replies.get(1).result.instructions).toContain("sign_in");
    const tools = replies.get(2).result.tools;
    expect(tools.map((t: { name: string }) => t.name)).toEqual(["sign_in", "who_am_i", "list_projects", "list_tasks", "create_task", "get_task", "checkout_task", "save_progress", "submit_task"]);
    for (const t of tools) {
      expect(t.inputSchema.type).toBe("object");
      expect(t).not.toHaveProperty("argv");
    }
    expect(replies.get(3).result).toEqual({});
    expect(replies.get(4).error.code).toBe(-32601);
    expect(replies.get(null).error.code).toBe(-32700);
    expect(replies.size).toBe(5); // the notification has no reply
  });

  it("offers its newest protocol version to a client asking for an unknown one", async () => {
    const line = msg("initialize", { protocolVersion: "1999-01-01" });
    const r = (await mcp([line])).get(JSON.parse(line).id);
    expect(r.result.protocolVersion).toBe("2025-11-25");
  });

  it("answers an unknown tool with -32602, and a batch with one reply per request", async () => {
    const unknown = call("drop_database");
    expect((await mcp([unknown])).get(JSON.parse(unknown).id).error.code).toBe(-32602);
    const a = JSON.parse(msg("ping"));
    const b = JSON.parse(call("who_am_i"));
    const r = await h.cli(["mcp"], { mcpInput: [JSON.stringify([a, { jsonrpc: "2.0", method: "notifications/initialized" }, b])] });
    const batch = JSON.parse(r.stdout.trim());
    expect(batch.map((x: { id: number }) => x.id).sort()).toEqual([a.id, b.id].sort());
  });

  it("reports login_required as a tool error, not a protocol error", async () => {
    const r = await tool("list_projects");
    expect(r.isError).toBe(true);
    expect(r.structuredContent.error.code).toBe("login_required");
  });

  it("rejects an unknown tool, a missing argument and a relative folder before calling the API", async () => {
    expect((await tool("create_task", { project_id: PROJECT })).structuredContent.error).toMatchObject({ code: "invalid_arguments", message: "title is required" });
    expect((await tool("checkout_task", { task_id: "task-1", folder: "work" })).structuredContent.error).toMatchObject({ code: "invalid_arguments", message: "folder must be an absolute path" });
    expect(h.world.calls).toEqual([]);
  });
});

describe("tools", () => {
  it("signs in with the pasted login command, never echoing the session", async () => {
    const code = await emailedCode();
    const r = await tool("sign_in", { code: `cforge login --api-url ${h.world.baseUrl} --code ${code}` });
    expect(r.isError).toBe(false);
    expect(r.structuredContent).toMatchObject({ status: "logged_in", user: { email: EMAIL } });
    expect(r.content[0]!.text).not.toMatch(/cfs_/);
    const me = await tool("who_am_i");
    expect(me.structuredContent.user.email).toBe(EMAIL);
  });

  it("signs in with the Account page's message", async () => {
    const code = await emailedCode();
    const r = await tool("sign_in", { code: `Sign in to CommonForge: cforge login --api-url ${h.world.baseUrl} --code ${code}` });
    expect(r.isError, r.content[0]!.text).toBe(false);
    expect(r.structuredContent.apiUrl).toBe(h.world.baseUrl);
  });

  it("reads only the command's line of a pasted message", async () => {
    const code = await emailedCode();
    const r = await tool("sign_in", { code: `Sign in to CommonForge: cforge login --api-url ${h.world.baseUrl} --code ${code}\nThanks!` });
    expect(r.isError, r.content[0]!.text).toBe(false);
  });

  it("will not move a live sign-in to another address", async () => {
    await tool("sign_in", { code: await emailedCode() });
    const code = await emailedCode();
    const evil = `cforge login --api-url https://evil.example.com --code ${code}`;
    // started for one address (CFORGE_API_URL, as the harness runs it): only that one
    const pinned = await tool("sign_in", { code: evil });
    expect(pinned.structuredContent.error).toMatchObject({ code: "signed_in_elsewhere", message: `this CommonForge connection is set up for ${h.world.baseUrl}, not https://evil.example.com` });
    // not started for one: the live sign-in's address
    const line = call("sign_in", { code: evil });
    const r = (await h.cli(["mcp"], { mcpInput: [line], env: { CFORGE_API_URL: "" } })).stdout;
    const free = JSON.parse(r.trim()).result;
    expect(free.structuredContent.error.code).toBe("signed_in_elsewhere");
    expect(free.structuredContent.error.message).toContain(`already signed in to ${h.world.baseUrl}`);
    expect(h.world.calls.some((c) => c.path === "/api/auth/cli/verify" && (c.body as { code?: string })?.code === code)).toBe(false);
    // the same address is fine (a new code after the old session)
    expect((await tool("sign_in", { code: `cforge login --api-url ${h.world.baseUrl} --code ${code}` })).isError).toBe(false);
  });

  it("a used code is refused", async () => {
    const code = await emailedCode();
    expect((await tool("sign_in", { code })).isError).toBe(false);
    const again = await tool("sign_in", { code });
    expect(again.isError).toBe(true);
  });

  it("creates a task without choosing folders, checks it out, and submits it", async () => {
    await tool("sign_in", { code: await emailedCode() });
    expect((await tool("list_projects")).structuredContent.projects.map((p: { projectId: string }) => p.projectId)).toContain(PROJECT);

    // text that starts with "-" (a markdown list) is a value, never an option
    const request = "- return cents\n- --print-token is just text";
    const created = await tool("create_task", { project_id: PROJECT, title: "-Change the quote", request });
    expect(created.isError, created.content[0]!.text).toBe(false);
    const taskId = created.structuredContent.taskId as string;
    const post = h.world.calls.find((c) => c.method === "POST" && c.path.endsWith(`/projects/${PROJECT}/tasks`))!;
    expect(post.body).toEqual({ title: "-Change the quote", request });
    // a project id that looks like an option stays a positional
    expect((await tool("list_tasks", { project_id: "--api-url=https://evil.example.com" })).isError).toBe(true);
    expect(h.world.calls.some((c) => c.path.includes("/projects/--api-url"))).toBe(true); // sent to this server, as an id
    expect((await tool("list_tasks", { project_id: PROJECT })).structuredContent.tasks.map((t: { taskId: string }) => t.taskId)).toContain(taskId);

    const folder = join(h.home, "work");
    const out = await tool("checkout_task", { task_id: taskId, folder });
    expect(out.isError, out.content[0]!.text).toBe(false);
    expect(out.structuredContent).toMatchObject({ taskId, workspaceRoot: folder, verified: true });
    expect(out.content[0]!.text).not.toMatch(/cfl_/);

    writeFileSync(join(folder, "api", "src", "quote.ts"), "export const quote = 100;\n");
    const saved = await tool("save_progress", { folder, message: "cents" });
    expect(saved.isError, saved.content[0]!.text).toBe(false);
    const done = await tool("submit_task", { folder, message: "-q quote in cents" });
    expect(done.isError, done.content[0]!.text).toBe(false);
    expect(done.structuredContent.candidates).toHaveLength(1);
    expect(h.world.calls.find((c) => c.path.endsWith("/freeze"))!.body).toMatchObject({ tool: "mcp" });

    const status = await tool("get_task", { task_id: taskId });
    expect(status.structuredContent.task.candidates).toHaveLength(1);
  });
});

describe("apiUrlFromCode", () => {
  it("reads --api-url from a pasted command and the origin from a link", () => {
    expect(apiUrlFromCode("cforge login --api-url https://forge.example.com --code cfm_x")).toBe("https://forge.example.com");
    expect(apiUrlFromCode("cforge login --api-url=https://forge.example.com --code cfm_x")).toBe("https://forge.example.com");
    expect(apiUrlFromCode("https://forge.example.com/auth/cli?code=cfm_x")).toBe("https://forge.example.com");
    expect(apiUrlFromCode("cfm_abcdefghijklmnopqrstuvwxyz")).toBeUndefined();
  });

  it("every tool's required arguments are declared properties", () => {
    for (const t of TOOLS) for (const k of t.inputSchema.required ?? []) expect(t.inputSchema.properties).toHaveProperty(k);
  });
});
