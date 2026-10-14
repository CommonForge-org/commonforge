/**
 * The Claude Desktop extension (scripts/mcpb.mjs): a valid zip whose manifest runs the bundled CLI
 * as `server/index.js mcp`, lists the server's own tools, and whose server answers over stdio.
 */
import { execFile, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const work = mkdtempSync(join(tmpdir(), "cforge-mcpb-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));
const HAS_UNZIP = spawnSync("unzip", ["-v"]).status === 0;

const node = (args: string[], cwd = APP, input?: string) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = execFile(process.execPath, args, { cwd, encoding: "utf8", timeout: 120_000, env: { PATH: process.env.PATH, HOME: join(work, "home") } }, (error, stdout, stderr) =>
      resolve({ code: error ? 1 : 0, stdout, stderr }),
    );
    if (input !== undefined) child.stdin!.end(input);
  });

describe.skipIf(!HAS_UNZIP)("commonforge.mcpb", () => {
  it("packs the bundled server, its tools and licences; the unpacked server answers", async () => {
    expect((await node([join(APP, "scripts", "bundle.mjs")])).code).toBe(0);
    const file = join(work, "commonforge.mcpb");
    const built = await node([join(APP, "scripts", "mcpb.mjs"), file]);
    expect(built.code, built.stderr).toBe(0);
    expect(spawnSync("unzip", ["-tq", file]).status).toBe(0);
    const dir = join(work, "x");
    expect(spawnSync("unzip", ["-q", file, "-d", dir]).status).toBe(0);

    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    const pkg = JSON.parse(readFileSync(join(APP, "package.json"), "utf8"));
    expect(manifest).toMatchObject({ name: "commonforge", version: pkg.version, server: { type: "node", entry_point: "server/index.js", mcp_config: { command: "node", args: ["${__dirname}/server/index.js", "mcp"] } } });
    expect(manifest.tools.map((t: { name: string }) => t.name)).toContain("create_task");
    expect(readFileSync(join(dir, "server", "index.js"))).toEqual(readFileSync(join(APP, "dist", "index.js")));
    expect(readFileSync(join(dir, "server", "THIRD_PARTY_LICENSES.txt"), "utf8")).toContain("zod");

    const lines = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-ai", version: "1" } } },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ].map((m) => JSON.stringify(m)).join("\n");
    const r = await node([join(dir, "server", "index.js"), "mcp"], work, `${lines}\n`);
    const replies = r.stdout.trim().split("\n").map((l) => JSON.parse(l));
    expect(replies.find((x) => x.id === 2).result.tools.map((t: { name: string }) => t.name)).toEqual(manifest.tools.map((t: { name: string }) => t.name));
  }, 180_000);
});
