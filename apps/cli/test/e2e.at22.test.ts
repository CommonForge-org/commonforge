/**
 * AT-22 (Git interoperability) end to end, with the built `cforge` binary as a subprocess:
 * standard git clone / fetch / push work in an assigned workspace through `cforge
 * credential-helper`, which git invokes for real over HTTP.
 *
 * Path chosen (controller note): `wrangler dev --remote` needs live Artifacts, so the control
 * plane is the in-process fake (test/fake-commonforge.ts, following apps/worker/API.md) served on
 * 127.0.0.1, with real bare repositories behind a smart-HTTP git front (`git http-backend`) that
 * enforces Artifacts-like auth: a broker-minted token as the basic-auth password, scoped to one
 * repository and to read or write, revoked on freeze; 503 "receive-pack busy" can be injected.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeCommonForge, PROJECT, cleanGitEnv } from "./fake-commonforge.js";
import { filesContaining } from "./helpers.js";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(APP, "dist", "index.js");

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function exec(file: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }): Promise<Run> {
  return new Promise((resolve) => {
    execFile(file, args, { cwd: opts.cwd, env: opts.env, encoding: "utf8", timeout: 120_000 }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr });
    });
  });
}

let world: FakeCommonForge;
let home: string;
let env: NodeJS.ProcessEnv;
let taskId: string;
let ws: string;
const outputs: string[] = [];

async function cforge(args: string[], cwd = home): Promise<Run> {
  const r = await exec(process.execPath, [BIN, ...args], { cwd, env });
  outputs.push(r.stdout, r.stderr);
  return r;
}
async function gitIn(cwd: string, ...args: string[]): Promise<Run> {
  const r = await exec("git", args, { cwd, env });
  outputs.push(r.stdout, r.stderr);
  return r;
}
const okJson = (r: Run) => {
  if (r.code !== 0) throw new Error(`exit ${r.code}\n${r.stdout}\n${r.stderr}`);
  return JSON.parse(r.stdout);
};

beforeAll(async () => {
  // the helper git runs is the built (bundled) binary
  const build = await exec(process.execPath, [join(APP, "scripts", "bundle.mjs")], { cwd: APP, env: process.env });
  if (build.code !== 0) throw new Error(`build failed: ${build.stdout}${build.stderr}`);
  world = new FakeCommonForge();
  await world.listen();
  world.addResource("api", { "src/quote.ts": "export const quote = 1;\n", "test/quote.test.ts": "// test\n" });
  world.addResource("website", { "index.html": "<h1>portal</h1>\n" });
  taskId = world.createTask("Return the quote in cents", ["api"]).taskId;

  home = mkdtempSync(join(tmpdir(), "cforge-e2e-"));
  // A global `store` helper: our per-URL config must reset it, so no token ever lands in ~/.git-credentials.
  writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Agent A\n\temail = agent-a@example.com\n[credential]\n\thelper = store\n");
  env = { ...cleanGitEnv(), HOME: home, XDG_CONFIG_HOME: join(home, ".config"), CFORGE_API_URL: world.baseUrl, GIT_TERMINAL_PROMPT: "0" };
  delete env.GIT_AUTHOR_NAME;
  delete env.GIT_AUTHOR_EMAIL;
  delete env.GIT_COMMITTER_NAME;
  delete env.GIT_COMMITTER_EMAIL;
  delete env.GIT_CONFIG_GLOBAL; // the test home's own .gitconfig applies
  ws = join(home, "ws");
}, 120_000);

afterAll(async () => {
  await world?.close();
});

describe("AT-22: standard git in an assigned workspace via cforge", { timeout: 60_000 }, () => {
  it("login → checkout over HTTP with the credential helper (no token on disk)", async () => {
    okJson(await cforge(["login", "--email", "dev@example.com", "--json"]));
    const code = [...world.codes.keys()].pop()!;
    const login = okJson(await cforge(["login", "--code", code, "--json"]));
    expect(login.status).toBe("logged_in");

    const co = okJson(await cforge(["checkout", taskId, "ws", "--json"]));
    expect(co).toMatchObject({ taskId, workspaceRoot: ws, verified: true });
    // git first got 401, then asked the helper, which asked the broker; basic auth x-token:<token>
    const clones = world.gitRequests.filter((g) => g.service === "git-upload-pack");
    expect(clones.some((g) => g.status === 401 && g.password === null)).toBe(true);
    const authed = clones.filter((g) => g.status === 200);
    expect(authed.length).toBeGreaterThan(0);
    for (const g of authed) {
      expect(g.username).toBe("x-token");
      expect(world.tokens.has(g.password!)).toBe(true);
    }
    // the reference mount got a read token, the writable mount a write token
    const creds = world.calls.filter((c) => c.path.endsWith("/credential")).map((c) => c.body);
    expect(creds).toEqual(expect.arrayContaining([{ mountName: "api", access: "write" }, { mountName: "website", access: "read" }]));
    expect(existsSync(join(home, ".git-credentials"))).toBe(false);
  });

  it("plain git fetch / commit / push work in the mount; the helper is asked per request", async () => {
    const api = join(ws, "api");
    const before = world.calls.filter((c) => c.path.endsWith("/credential")).length;
    expect((await gitIn(api, "fetch", "origin")).code).toBe(0);
    writeFileSync(join(api, "src/quote.ts"), "export const quote = 100; // cents\n");
    expect((await gitIn(api, "commit", "-qam", "quote in cents")).code).toBe(0);
    const scratch = await gitIn(api, "push", "origin", "HEAD:refs/heads/agent-scratch");
    expect(scratch.code, scratch.stderr).toBe(0);
    expect(world.calls.filter((c) => c.path.endsWith("/credential")).length).toBeGreaterThanOrEqual(before + 2);
    // the reference mount is read-only locally
    const ro = await gitIn(join(ws, "website"), "push", "origin", "HEAD:refs/heads/x");
    expect(ro.code).not.toBe(0);
  });

  it("cforge checkpoint pushes refs/commonforge/checkpoints/<n>, retrying a busy repository", async () => {
    world.busyPushes = 1;
    const r = okJson(await cforge(["checkpoint", "--json"], join(ws, "api")));
    expect(r.checkpoints[0]).toMatchObject({ mountName: "api", ref: "refs/commonforge/checkpoints/1", status: "pushed" });
    const t = world.tasks.get(taskId)!;
    expect(world.taskRepoHead(t.workspaces.find((w) => w.mountName === "api")!, "refs/commonforge/checkpoints/1")).toBe(r.checkpoints[0].sha);
    expect(world.gitRequests.some((g) => g.status === 503)).toBe(true);
    expect(world.busyPushes).toBe(0);
  });

  it("the helper refuses repositories that are not the task's remotes", async () => {
    const res = [...world.resources.keys()][0]!;
    const canonical = `${world.baseUrl}/git/cf-o1-canonical/${res}.git`;
    const before = world.calls.filter((c) => c.path.endsWith("/credential")).length;
    // git does not even consult the helper for other URLs (URL-scoped config) and cannot prompt
    const clone = await gitIn(home, "clone", "-q", canonical, "canon");
    expect(clone.code).not.toBe(0);
    // asked directly, the helper answers quit=1 without calling the broker
    const direct = await new Promise<Run>((resolve) => {
      const dir = join(home, ".config", "commonforge", "checkouts");
      const record = join(dir, readdirSync(dir)[0]!);
      // a bare environment: the helper finds the record and lease from --record alone
      const child = execFile(process.execPath, [BIN, "credential-helper", "--record", record, "get"], { env: { PATH: env.PATH }, encoding: "utf8" }, (error, stdout, stderr) =>
        resolve({ code: error ? 1 : 0, stdout, stderr }),
      );
      child.stdin!.end(`protocol=http\nhost=${new URL(world.baseUrl).host}\npath=git/cf-o1-canonical/${res}.git\n\n`);
    });
    expect(direct.stdout).toBe("quit=1\n");
    expect(direct.stderr).toMatch(/not a remote of/);
    expect(world.calls.filter((c) => c.path.endsWith("/credential")).length).toBe(before);
  });

  it("cforge submit pushes then freezes; afterwards the workspace refuses pushes", async () => {
    const api = join(ws, "api");
    const head = (await gitIn(api, "rev-parse", "HEAD")).stdout.trim();
    const r = okJson(await cforge(["submit", "--tool", "e2e", "--json"], api));
    const t = world.tasks.get(taskId)!;
    const wsApi = t.workspaces.find((w) => w.mountName === "api")!;
    expect(r.candidates).toEqual([expect.objectContaining({ mountName: "api", candidateId: `cand:${wsApi.taskWorkspaceId}:${head}`, sha: head, changedPaths: ["src/quote.ts"] })]);
    expect(world.taskRepoHead(wsApi)).toBe(head);
    expect(wsApi.state).toBe("frozen");
    expect(world.liveTokens().filter((x) => x.scope === "write")).toEqual([]);

    // the task is submitted: the broker mints nothing more (task_not_running), so git gets no token
    const fetch = await gitIn(api, "fetch", "origin");
    expect(fetch.code).not.toBe(0);
    expect(fetch.stderr).toContain("task_not_running");
    writeFileSync(join(api, "late.txt"), "late\n");
    await gitIn(api, "add", "late.txt");
    await gitIn(api, "commit", "-qm", "late");
    const late = await gitIn(api, "push", "origin", "HEAD:refs/heads/main");
    expect(late.code).not.toBe(0);
    expect(world.taskRepoHead(wsApi)).toBe(head);

    const st = okJson(await cforge(["status", "--json"], api));
    expect(st.task).toMatchObject({ state: "submitted", candidates: [expect.objectContaining({ sha: head })] });
  });

  it("cforge export downloads bundles that clone with plain git", async () => {
    const r = okJson(await cforge(["export", PROJECT, "--out", "export", "--json"]));
    const bundle = r.files.find((f: { kind: string }) => f.kind === "git-bundle").path;
    expect((await gitIn(home, "clone", "-q", join(home, "export", bundle), "restored")).code).toBe(0);
    expect(JSON.parse(readFileSync(join(home, "export", "manifest.json"), "utf8")).exportId).toBe(r.exportId);
  });

  it("no git token was ever written to disk, git config or CLI output", async () => {
    const gitTokens = [...world.tokens.keys()];
    expect(gitTokens.length).toBeGreaterThan(3);
    expect(filesContaining(home, gitTokens)).toEqual([]);
    expect(existsSync(join(home, ".git-credentials"))).toBe(false);
    // bearers live only in the 0600 config dir, never in the workspace
    const bearers = world.secrets().filter((s) => s.startsWith("cfs_") || s.startsWith("cfl_"));
    expect(filesContaining(ws, bearers)).toEqual([]);
    for (const o of outputs) for (const s of [...gitTokens, ...bearers]) expect(o).not.toContain(s);
  });
});
