/**
 * The npm package as published: `npm pack` (its prepack builds the bundle), install the tarball
 * into an empty directory outside the workspace, and run the installed `cforge` bin. Nothing from
 * the monorepo (workspace packages, zod) may be needed at runtime.
 */
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const work = mkdtempSync(join(tmpdir(), "cforge-pack-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

function run(file: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { cwd, env, encoding: "utf8", timeout: 120_000 }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr });
    });
  });
}

/** npm with a private cache and no user/global config: offline, no telemetry, no writes outside `work`. */
function npmEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: join(work, "home") };
  Object.assign(env, {
    npm_config_cache: join(work, "npm-cache"),
    npm_config_userconfig: join(work, "npmrc"),
    npm_config_globalconfig: join(work, "npmrc-global"),
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
  });
  return env;
}

describe("npm package", () => {
  it("packs a self-contained bin that runs outside the workspace", async () => {
    const env = npmEnv();
    const pack = await run("npm", ["pack", "--json", "--pack-destination", work], APP, env);
    expect(pack.code, pack.stderr).toBe(0);
    const [info] = JSON.parse(pack.stdout.slice(pack.stdout.indexOf("["))) as Array<{ filename: string; files: Array<{ path: string }> }>;
    expect(info!.files.map((f) => f.path).sort()).toEqual(["LICENSE", "README.md", "dist/THIRD_PARTY_LICENSES.txt", "dist/index.js", "package.json"]);

    const prefix = join(work, "install");
    const install = await run("npm", ["install", "--offline", "--no-save", "--prefix", prefix, join(work, info!.filename)], work, env);
    expect(install.code, install.stderr).toBe(0);
    // no runtime dependencies were installed alongside it
    expect(readdirSync(join(prefix, "node_modules")).filter((n) => !n.startsWith("."))).toEqual(["@commonforge-org"]);
    expect(readdirSync(join(prefix, "node_modules", "@commonforge-org"))).toEqual(["cli"]);

    const bin = join(prefix, "node_modules", ".bin", "cforge");
    const cleanEnv = { PATH: process.env.PATH, HOME: join(work, "home"), CFORGE_CONFIG_DIR: join(work, "cfg") };
    const version = await run(bin, ["--version", "--json"], work, cleanEnv);
    expect(version.code, version.stderr).toBe(0);
    expect(JSON.parse(version.stdout)).toEqual({ name: "cforge", version: "0.1.0" });
    const help = await run(bin, ["--help"], work, cleanEnv);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("Usage: cforge <command>");
    // zod is inlined: a schema-validating command path runs (bad code → a clean CLI error, not a module error)
    const login = await run(bin, ["login", "--code", "nope", "--json"], work, cleanEnv);
    expect(JSON.parse(login.stdout).error.code).toBe("invalid_code");

    // the MCP server the Claude Desktop extension and `npx … mcp` run: stdout carries only protocol lines
    const mcp = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
      const child = spawn(bin, ["mcp"], { cwd: work, env: cleanEnv });
      let stdout = "";
      child.stdout.on("data", (d: Buffer) => void (stdout += d.toString("utf8")));
      child.on("close", (code) => resolve({ code, stdout }));
      child.stdin.end(
        [
          { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } },
          { jsonrpc: "2.0", method: "notifications/initialized" },
          { jsonrpc: "2.0", id: 2, method: "tools/list" },
          { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "who_am_i", arguments: {} } },
        ].map((m) => JSON.stringify(m)).join("\n") + "\n",
      );
    });
    expect(mcp.code).toBe(0);
    const replies = mcp.stdout.trim().split("\n").map((l) => JSON.parse(l) as { id: number; result: Record<string, any> });
    expect(replies.map((r) => r.id).sort()).toEqual([1, 2, 3]);
    expect(replies.find((r) => r.id === 1)!.result.protocolVersion).toBe("2025-06-18");
    expect(replies.find((r) => r.id === 2)!.result.tools.map((t: { name: string }) => t.name)).toContain("create_task");
    expect(replies.find((r) => r.id === 3)!.result).toMatchObject({ isError: true, structuredContent: { error: { code: "login_required" } } });
  }, 180_000);
});
