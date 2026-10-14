/**
 * checkout / checkpoint / submit / status against the fake API with file:// task repositories
 * (git needs no credential for file://; the HTTP + credential-helper path is the AT-22 E2E).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nodeGitRunner, type GitRunner } from "../src/git.js";
import { git, ORG } from "./fake-commonforge.js";
import { filesContaining, harness, loginAs, type Harness } from "./helpers.js";

const HAS_GIT_LFS = (() => {
  try {
    execFileSync("git", ["lfs", "version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

let h: Harness;
let taskId: string;
let root: string;

beforeEach(async () => {
  h = harness();
  h.world.addResource("api", { "src/quote.ts": "export const quote = 1;\n" });
  h.world.addResource("website", { "index.html": "<h1>hi</h1>\n" });
  await loginAs(h);
  taskId = h.world.createTask("Change the quote", ["api"], "Return cents").taskId;
  root = join(h.home, "work");
});
afterEach(() => h.world.close());

async function checkout() {
  const r = await h.cli(["checkout", taskId, "work", "--json"]);
  if (r.code !== 0) throw new Error(r.stdout + r.stderr);
  return r.json();
}

function commitIn(mount: string, file: string, content: string, msg = "change") {
  writeFileSync(join(root, mount, file), content);
  git(["add", "-A"], join(root, mount));
  git(["commit", "-q", "-m", msg], join(root, mount));
  return git(["rev-parse", "HEAD"], join(root, mount));
}

describe("cforge checkout", () => {
  it("takes a lease, materializes the plan, installs the helper config and verifies", async () => {
    const out = await checkout();
    expect(out).toMatchObject({ taskId, workspaceRoot: root, verified: true, lease: { source: "config", leaseGeneration: 1, reused: false } });
    expect(out.mounts.map((m: { mountName: string; writable: boolean }) => [m.mountName, m.writable])).toEqual([
      ["api", true],
      ["website", false],
    ]);
    expect(readdirSync(root).sort()).toEqual([".commonforge", "api", "website"]);
    expect(readFileSync(join(root, ".commonforge/PROJECT-CONTEXT.md"), "utf8")).toContain("Return cents");
    const t = h.world.tasks.get(taskId)!;
    expect(git(["rev-parse", "HEAD"], join(root, "api"))).toBe(t.workspaces[0]!.baseSha);
    // reference copy: cloned from the -tasks copy, never canonical, and not pushable
    const webUrl = git(["config", "--get", "remote.origin.url"], join(root, "website"));
    expect(webUrl).toContain("/cf-o1-tasks/");
    expect(git(["config", "--get", "remote.origin.pushurl"], join(root, "website"))).toBe("commonforge-read-only://push-refused");
    // the helper is configured for the reference copy (credential: helper); never a token
    const helpers = git(["config", "--null", "--get-all", `credential.${webUrl}.helper`], join(root, "website")).split("\0").slice(0, -1);
    const records = readdirSync(join(h.configDir, "checkouts"));
    expect(records).toHaveLength(1);
    const recordPath = join(h.configDir, "checkouts", records[0]!);
    expect(helpers).toEqual(["", `${process.execPath} /opt/cforge/dist/index.js credential-helper --record ${recordPath}`]);
    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    expect(record.mounts.map((m: { mountName: string }) => m.mountName)).toEqual(["api", "website"]);
    // no secret anywhere in the workspace or the checkout record
    expect(filesContaining(root, ["cfl_", "cfs_", "art_v1_", ...h.world.secrets()])).toEqual([]);
    expect(filesContaining(join(h.configDir, "checkouts"), h.world.secrets())).toEqual([]);
  });

  it("reads the materialization plan with the lease it took, not the session (a client's session cannot read plans)", async () => {
    await checkout();
    const plan = h.world.calls.filter((c) => /\/materialization$/.test(c.path));
    expect(plan).toHaveLength(1);
    expect(plan[0]!.auth).toBe(h.world.tasks.get(taskId)!.lease!.token);
    expect(plan[0]!.auth).toMatch(/^cfl_/);
  });

  it("refuses a non-empty directory and reports verify problems as errors", async () => {
    mkdirSync(join(root), { recursive: true });
    writeFileSync(join(root, "junk"), "x");
    const r = await h.cli(["checkout", taskId, "work", "--json"]);
    expect(r.json().error.code).toBe("workspace_not_empty");
  });

  it("refuses a plan for another root, leaving no directory or record behind", async () => {
    h.world.overrides.set("GET /api/tasks/[^/]+/materialization", () => ({ status: 200, body: { workspaceRoot: "/elsewhere", mounts: [], contextFiles: [] } }));
    const r = await h.cli(["checkout", taskId, "work", "--json"]);
    expect(r.json().error.code).toBe("invalid_plan");
    expect(existsSync(root)).toBe(false);
    expect(existsSync(join(h.configDir, "checkouts")) ? readdirSync(join(h.configDir, "checkouts")) : []).toEqual([]);
  });

  it("I-1 regression: a helper whose path contains /store/ (e.g. Nix) passes verification", async () => {
    const r = await h.cli(["checkout", taskId, "work", "--json"], { helperCommand: ["/nix/store/abc123-nodejs-22/bin/node", "/nix/store/def456-cforge/dist/index.js"] });
    expect(r.code, r.stdout).toBe(0);
    expect(r.json().verified).toBe(true);
    const url = git(["config", "--get", "remote.origin.url"], join(root, "website"));
    expect(git(["config", "--get-all", `credential.${url}.helper`], join(root, "website"))).toContain("/nix/store/abc123-nodejs-22/bin/node /nix/store/def456-cforge/dist/index.js credential-helper --record ");
  });

  it("I-2: a stored lease that was taken over is detected, replaced, and never reused", async () => {
    const first = await checkout();
    expect(first.lease).toMatchObject({ leaseGeneration: 1, reused: false });
    // the same developer takes the lease elsewhere (another machine / agent): generation 2
    const t = h.world.tasks.get(taskId)!;
    const other = await h.world.fetch(`${h.world.baseUrl}/api/tasks/${taskId}/lease`, { method: "POST", headers: { authorization: `Bearer ${h.world.sessionFor("dev@example.com")}`, "content-type": "application/json" }, body: "{}" });
    expect(other.status).toBe(200);
    expect(t.lease!.generation).toBe(2);

    // status with the dead stored lease falls back to the session, with the --force hint
    const st = await h.cli(["status", "--json"], { cwd: root });
    expect(st.code).toBe(0);
    expect(st.stderr).toContain(`cforge task lease ${taskId} --force`);

    // a second checkout notices the stale lease and takes a new one (generation 3)
    const second = await h.cli(["checkout", taskId, "work2", "--json"]);
    expect(second.code, second.stdout).toBe(0);
    expect(second.json().lease).toMatchObject({ leaseGeneration: 3, reused: false, replacedStale: true });
    // and a still-current stored lease is reused after the server confirms it
    const third = await h.cli(["task", "lease", taskId, "--json"]);
    expect(third.json()).toMatchObject({ leaseGeneration: 3, reused: true });
  });

  it("lease_held: someone else's live checkout is explained, with until when, and nothing is written", async () => {
    h.world.memberships = [{ orgId: ORG, name: "Demo Org", role: "developer" }];
    const other = await h.world.fetch(`${h.world.baseUrl}/api/tasks/${taskId}/lease`, { method: "POST", headers: { authorization: `Bearer ${h.world.sessionFor("other@example.com")}`, "content-type": "application/json" }, body: "{}" });
    expect(other.status).toBe(200);
    const until = new Date(h.world.tasks.get(taskId)!.lease!.expiresAt).toISOString();
    const r = await h.cli(["checkout", taskId, "work"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toBe(`cforge: someone else has task ${taskId} checked out (until ${until}). Wait for their lease to end or ask them to submit; an owner of the organization can take it over. (lease_held)\n`);
    expect(existsSync(root)).toBe(false);
    const j = await h.cli(["task", "lease", taskId, "--json"]);
    expect(j.json().error).toMatchObject({ code: "lease_held", details: { status: 409, leaseExpiresAt: until } });
  });

  it("a second checkout of the same task does not break the first", async () => {
    await checkout();
    const r2 = await h.cli(["checkout", taskId, "work2", "--json"]);
    expect(r2.code, r2.stdout).toBe(0);
    expect(readdirSync(join(h.configDir, "checkouts"))).toHaveLength(2);
    commitIn("api", "src/quote.ts", "export const quote = 7;\n");
    const cp = await h.cli(["checkpoint", "--json"], { cwd: join(root, "api") });
    expect(cp.code, cp.stdout).toBe(0);
    const cp2 = await h.cli(["checkpoint", "--json"], { cwd: join(h.home, "work2", "api") });
    expect(cp2.code, cp2.stdout).toBe(0);
  });

  it("waits while a task created through the API is still provisioning", async () => {
    const created = await h.cli(["task", "create", "p-000000000001", "--title", "New", "--write", "api", "--json"]);
    expect(created.json().state).toBe("provisioning");
    const id = created.json().taskId;
    // the Worker refuses a lease while provisioning
    const early = await h.cli(["task", "lease", id, "--json"]);
    expect(early.json().error.code).toBe("task_not_ready");
    const r = await h.cli(["checkout", id, "fresh", "--json"]);
    expect(r.code, r.stdout).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.json().verified).toBe(true);
  });

  it("gives up clearly when provisioning does not finish within --wait", async () => {
    const t = h.world.createTask("slow", ["api"], "", 1000);
    const r = await h.cli(["checkout", t.taskId, "slow", "--wait", "0", "--json"]);
    expect(r.json().error).toMatchObject({ code: "task_not_ready" });
    expect(r.json().error.message).toMatch(/still provisioning/);
  });

  it("validates --lease-ttl against the Worker's bounds", async () => {
    const r = await h.cli(["checkout", taskId, "work", "--lease-ttl", "60", "--json"]);
    expect(r.code).toBe(2);
    expect(r.json().error.code).toBe("invalid_arguments");
  });
});

describe("cforge checkout wires git-lfs (folders phase 4, P4-7)", () => {
  const POINTER = "version https://git-lfs.github.com/spec/v1\noid sha256:" + "4".repeat(64) + "\nsize 12\n";
  /** A smudge filter standing in for git-lfs: logs the LFS-related environment, passes content through. */
  function fakeLfsFilter(): string {
    const log = join(h.home, "smudge.log");
    const script = join(h.home, "smudge.sh");
    writeFileSync(script, `#!/bin/sh\nenv | grep -E '^(GIT_LFS_SKIP_SMUDGE|GIT_CONFIG_(COUNT|KEY_[0-9]+|VALUE_[0-9]+))=' | sort >> '${log}'\ncat\n`, { mode: 0o755 });
    writeFileSync(join(h.home, ".gitconfig"), `${readFileSync(join(h.home, ".gitconfig"), "utf8")}[filter "lfs"]\n\tsmudge = ${script}\n`);
    return log;
  }
  const localConfig = (mount: string, key: string) => {
    try {
      return git(["config", "--local", "--null", "--get-all", key], join(root, mount)).split("\0").filter((x, i, a) => i < a.length - 1 || x !== "");
    } catch {
      return [];
    }
  };

  it("sets lfs.url, lfs.fetchexclude and the helper for the LFS URL; the clone skips smudge and keeps pointers", async () => {
    const media = h.world.addResource("media", { ".gitattributes": "*.bin filter=lfs diff=lfs merge=lfs -text\n", "a.bin": POINTER });
    taskId = h.world.createTask("Add a video", ["media"]).taskId;
    const log = fakeLfsFilter();
    await checkout();
    const lfsUrl = `${h.world.baseUrl}/api/lfs/${ORG}/${media.resourceId}/info/lfs`;
    const records = readdirSync(join(h.configDir, "checkouts"));
    const recordPath = join(h.configDir, "checkouts", records[0]!);
    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    expect(record.mounts.find((m: { mountName: string }) => m.mountName === "media").lfsUrl).toBe(lfsUrl);
    // the pointer stays a pointer
    expect(readFileSync(join(root, "media", "a.bin"), "utf8")).toBe(POINTER);
    // the clone ran with GIT_LFS_SKIP_SMUDGE=1 and the helper entries for the LFS URL
    const env = readFileSync(log, "utf8");
    expect(env).toContain("GIT_LFS_SKIP_SMUDGE=1\n");
    const keys = env.split("\n").filter((l) => /^GIT_CONFIG_KEY_\d+=/.test(l)).map((l) => l.slice(l.indexOf("=") + 1));
    expect(keys).toContain(`credential.${lfsUrl}.helper`);
    expect(keys).toContain(`credential.${lfsUrl}.useHttpPath`);
    // local config: lfs.url, fetchexclude, the helper (reset + ours) with useHttpPath; never a token
    const helper = `${process.execPath} /opt/cforge/dist/index.js credential-helper --record ${recordPath}`;
    expect(localConfig("media", "lfs.url")).toEqual([lfsUrl]);
    expect(localConfig("media", "lfs.fetchexclude")).toEqual(["*"]);
    expect(localConfig("media", `credential.${lfsUrl}.helper`)).toEqual(["", helper]);
    expect(localConfig("media", `credential.${lfsUrl}.useHttpPath`)).toEqual(["true"]);
    // every git mount gets its own folder's LFS URL
    const api = [...h.world.resources.values()].find((r) => r.mountName === "api")!;
    expect(localConfig("api", "lfs.url")).toEqual([`${h.world.baseUrl}/api/lfs/${ORG}/${api.resourceId}/info/lfs`]);
    expect(filesContaining(root, ["cfl_", "cfs_", "art_v1_", ...h.world.secrets()])).toEqual([]);
  });

  it("a plan LFS URL on another origin than the API gets none of it, with a warning", async () => {
    h.world.lfsUrlFor = (rid) => `https://lfs.elsewhere.example/api/lfs/${ORG}/${rid}/info/lfs`;
    const r = await h.cli(["checkout", taskId, "work", "--json"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.stderr).toMatch(/warning: .*api.*LFS URL .*lfs\.elsewhere\.example/);
    const records = readdirSync(join(h.configDir, "checkouts"));
    const record = JSON.parse(readFileSync(join(h.configDir, "checkouts", records[0]!), "utf8"));
    for (const m of record.mounts) expect(m).not.toHaveProperty("lfsUrl");
    for (const mount of ["api", "website"]) {
      expect(localConfig(mount, "lfs.url")).toEqual([]);
      expect(localConfig(mount, "lfs.fetchexclude")).toEqual([]);
      expect(git(["config", "--local", "--list"], join(root, mount))).not.toContain("lfs.elsewhere.example");
    }
  });

  it("a plan LFS URL over plain http to a non-loopback host is refused by the plan schema", async () => {
    h.world.lfsUrlFor = (rid) => `http://api.fake.test/api/lfs/${ORG}/${rid}/info/lfs`;
    const r = await h.cli(["checkout", taskId, "work", "--json"]);
    expect(r.json().error.code).toBe("invalid_plan");
  });

  it.skipIf(!HAS_GIT_LFS)("with real git-lfs: the pointer stays a pointer and `git lfs env` shows the endpoint", async () => {
    const media = h.world.addResource("media", { ".gitattributes": "*.bin filter=lfs diff=lfs merge=lfs -text\n", "a.bin": POINTER });
    taskId = h.world.createTask("Add a video", ["media"]).taskId;
    execFileSync("git", ["lfs", "install", "--skip-repo"], { env: { ...h.env }, cwd: h.home, stdio: "ignore" });
    await checkout();
    expect(readFileSync(join(root, "media", "a.bin"), "utf8")).toBe(POINTER);
    const env = execFileSync("git", ["lfs", "env"], { env: { ...h.env }, cwd: join(root, "media"), encoding: "utf8" });
    expect(env).toContain(`Endpoint=${h.world.baseUrl}/api/lfs/${ORG}/${media.resourceId}/info/lfs`);
  });

  it("a plan without LFS URLs checks out as before", async () => {
    h.world.lfsUrlFor = () => null;
    await checkout();
    expect(localConfig("api", "lfs.url")).toEqual([]);
  });
});

describe("cforge checkpoint", () => {
  it("pushes refs/commonforge/checkpoints/<n>, one ref per push, and is idempotent per commit", async () => {
    await checkout();
    const t = h.world.tasks.get(taskId)!;
    const ws = t.workspaces[0]!;
    const sha1 = commitIn("api", "src/quote.ts", "export const quote = 2;\n");
    const r1 = await h.cli(["checkpoint", "--json"], { cwd: join(root, "api", "src") });
    expect(r1.json()).toEqual({ taskId, checkpoints: [{ mountName: "api", ref: "refs/commonforge/checkpoints/1", sha: sha1, status: "pushed", committed: false }] });
    expect(h.world.taskRepoHead(ws, "refs/commonforge/checkpoints/1")).toBe(sha1);
    expect(h.world.taskRepoHead(ws)).toBe(ws.baseSha); // the branch did not move: nothing submitted

    const again = await h.cli(["checkpoint", "--json"], { cwd: root });
    expect(again.json().checkpoints[0]).toMatchObject({ ref: "refs/commonforge/checkpoints/1", status: "already" });

    writeFileSync(join(root, "api", "new.txt"), "n\n");
    const r2 = await h.cli(["checkpoint", "--commit", "wip", "--json"], { cwd: root });
    expect(r2.json().checkpoints[0]).toMatchObject({ ref: "refs/commonforge/checkpoints/2", status: "pushed", committed: true });
    expect(h.world.taskRepoHead(ws, "refs/commonforge/checkpoints/2")).toBe(git(["rev-parse", "HEAD"], join(root, "api")));
  });

  it("retries a busy push and never uses --atomic", async () => {
    await checkout();
    commitIn("api", "src/quote.ts", "export const quote = 3;\n");
    const real = nodeGitRunner({ env: { ...h.env } } as never);
    const pushes: string[][] = [];
    let busy = 2;
    const flaky: GitRunner = async (args, cwd, env) => {
      if (args.includes("push")) {
        pushes.push([...args]);
        if (busy-- > 0) return { code: 128, stdout: "", stderr: "error: RPC failed; HTTP 503 curl 22 The requested URL returned error: 503\nartifacts_git_receive_pack_busy" };
      }
      return real(args, cwd, env);
    };
    const r = await h.cli(["checkpoint", "--json"], { cwd: root, git: flaky });
    expect(r.json().checkpoints[0]).toMatchObject({ status: "pushed", ref: "refs/commonforge/checkpoints/1" });
    expect(pushes).toHaveLength(3);
    for (const p of pushes) {
      expect(p).not.toContain("--atomic");
      expect(p.filter((a) => a.includes(":")).filter((a) => !a.startsWith("-") && !a.startsWith("core."))).toHaveLength(1);
      expect(p).toContain("--force-with-lease=refs/commonforge/checkpoints/1:");
    }
  });

  it("refuses outside a workspace and on read-only mounts", async () => {
    expect((await h.cli(["checkpoint", "--json"], { cwd: h.home })).json().error.code).toBe("not_in_workspace");
    await checkout();
    expect((await h.cli(["checkpoint", "--json"], { cwd: join(root, "website") })).json().error.code).toBe("invalid_mount");
  });
});

describe("cforge submit", () => {
  it("pushes the branch then freezes through the API with the lease, printing the candidate id", async () => {
    await checkout();
    const t = h.world.tasks.get(taskId)!;
    const sha = commitIn("api", "src/quote.ts", "export const quote = 100;\n");
    const r = await h.cli(["submit", "--json"], { cwd: root });
    expect(r.code).toBe(0);
    const out = r.json();
    expect(out.candidates).toEqual([{ mountName: "api", candidateId: `cand:${t.workspaces[0]!.taskWorkspaceId}:${sha}`, taskWorkspaceId: t.workspaces[0]!.taskWorkspaceId, sha, changedPaths: ["src/quote.ts"], state: "frozen" }]);
    expect(out.skipped).toEqual([]);
    expect(h.world.taskRepoHead(t.workspaces[0]!)).toBe(sha);
    const freeze = h.world.calls.find((c) => c.path.endsWith("/freeze"))!;
    expect(freeze.body).toEqual({ expectedSha: sha, tool: "cforge" });
    expect(freeze.auth).toMatch(/^cfl_/);
    expect(t.state).toBe("submitted");

    const human = await h.cli(["status"], { cwd: join(root, "api") });
    expect(human.stdout).toContain("submitted");
    expect(human.stdout).toContain(`candidate cand:${t.workspaces[0]!.taskWorkspaceId}:${sha}`);
  });

  it("refuses when nothing was committed, and with --commit commits first", async () => {
    await checkout();
    expect((await h.cli(["submit", "--json"], { cwd: root })).json().error.code).toBe("nothing_to_submit");
    expect(h.world.calls.some((c) => c.path.endsWith("/freeze"))).toBe(false);
    writeFileSync(join(root, "api", "src", "quote.ts"), "export const quote = 5;\n");
    const r = await h.cli(["submit", "--commit", "quote in cents", "--tool", "claude", "--json"], { cwd: root });
    expect(r.json().candidates[0].changedPaths).toEqual(["src/quote.ts"]);
    expect(git(["log", "-1", "--format=%s"], join(root, "api"))).toBe("quote in cents");
  });

  it("takes the web hand-off's --commit=<message> form (the shell has already removed the quotes)", async () => {
    await checkout();
    writeFileSync(join(root, "api", "src", "quote.ts"), "export const quote = 6;\n");
    const r = await h.cli(["submit", `--commit=Finish task ${taskId}`, "--json"], { cwd: root });
    expect(r.code, r.stdout).toBe(0);
    expect(git(["log", "-1", "--format=%s"], join(root, "api"))).toBe(`Finish task ${taskId}`);
  });

  it("surfaces candidate_moved from the freeze", async () => {
    await checkout();
    commitIn("api", "src/quote.ts", "x\n");
    h.world.overrides.set("POST /api/tasks/[^/]+/workspaces/[^/]+/freeze", () => ({ status: 409, body: { error: { code: "candidate_moved", message: "HEAD moved" } } }));
    const r = await h.cli(["submit", "--json"], { cwd: root });
    expect(r.code).toBe(1);
    expect(r.json().error.code).toBe("candidate_moved");
  });
});

describe("cforge submit with several writable mounts", () => {
  it("reports what was already frozen when a later freeze fails", async () => {
    const t = h.world.createTask("two", ["api", "website"]);
    taskId = t.taskId;
    await checkout();
    commitIn("api", "src/quote.ts", "a\n");
    commitIn("website", "index.html", "b\n");
    const webWs = t.workspaces.find((w) => w.mountName === "website")!.taskWorkspaceId;
    h.world.overrides.set(`POST /api/tasks/[^/]+/workspaces/${webWs}/freeze`, () => ({ status: 503, body: { error: { code: "provider_unavailable", message: "try again" } } }));
    const r = await h.cli(["submit", "--json"], { cwd: root });
    expect(r.code).toBe(1);
    const e = r.json().error;
    expect(e.code).toBe("provider_unavailable");
    expect(e.details.failedMount).toBe("website");
    expect(e.details.frozen).toEqual([expect.objectContaining({ mountName: "api", state: "frozen" })]);
    expect(e.message).toContain("api (cand:");
  });
});

describe("cforge checkout with an asset mount", () => {
  const assetCalls = () => h.world.calls.filter((c) => /\/assets\/file$/.test(c.path));

  it("downloads the pinned manifest's objects with the stored lease (not the session) and verifies them", async () => {
    h.world.addAssetResource("brand", { "logo.png": "PNG-bytes", "video/intro.mp4": "MP4-bytes" });
    taskId = h.world.createTask("assets", ["api"]).taskId;
    const out = await checkout();
    expect(out.mounts.find((m: { mountName: string }) => m.mountName === "brand")).toMatchObject({ kind: "assets", writable: false });
    expect(readFileSync(join(root, "brand", "video/intro.mp4"), "utf8")).toBe("MP4-bytes");
    const calls = assetCalls();
    expect(calls.map((c) => [c.path, c.query.get("mount"), c.query.get("path"), c.query.has("revision")])).toEqual([
      [`/api/tasks/${taskId}/assets/file`, "brand", "logo.png", false],
      [`/api/tasks/${taskId}/assets/file`, "brand", "video/intro.mp4", false],
    ]);
    const lease = h.world.tasks.get(taskId)!.lease!.token;
    for (const c of calls) expect(c.auth).toBe(lease);
    // the user-only project file route is never used
    expect(h.world.calls.filter((c) => c.path.endsWith("/file") && !c.path.includes("/assets/"))).toEqual([]);
  });

  it("checks out with CFORGE_LEASE_TOKEN alone (no session at all)", async () => {
    h.world.addAssetResource("brand", { "logo.png": "PNG" });
    const t = h.world.createTask("assets", ["api"]);
    t.state = "running";
    t.lease = { token: "cfl_agentlease0123456789abcdef", generation: 1, expiresAt: Date.now() + 3_600_000, holder: "u" };
    await h.cli(["logout"]);
    const from = h.world.calls.length;
    const r = await h.cli(["checkout", t.taskId, "work", "--json"], { env: { CFORGE_LEASE_TOKEN: t.lease.token, CFORGE_LEASE_API_URL: h.world.baseUrl } });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.json()).toMatchObject({ verified: true, lease: { source: "env" } });
    expect(readFileSync(join(root, "brand", "logo.png"), "utf8")).toBe("PNG");
    expect(assetCalls().map((c) => c.auth)).toEqual([t.lease.token]);
    expect(h.world.calls.slice(from).map((c) => c.auth)).toEqual(h.world.calls.slice(from).map(() => t.lease!.token));
  });

  it("with a lease, a refused asset read fails the checkout: no silent fallback to the developer session", async () => {
    h.world.addAssetResource("brand", { "logo.png": "PNG" });
    const t = h.world.createTask("assets", ["api"]);
    t.state = "running";
    t.lease = { token: "cfl_agentlease0123456789abcdef", generation: 1, expiresAt: Date.now() + 3_600_000, holder: "u" };
    // the developer is still logged in; the lease route answers 401 (lease replaced or expired)
    h.world.overrides.set("GET /api/tasks/[^/]+/assets/file", () => ({ status: 401, body: { error: { code: "unauthenticated", message: "authentication required" } } }));
    const from = h.world.calls.length;
    const r = await h.cli(["checkout", t.taskId, "work", "--json"], { env: { CFORGE_LEASE_TOKEN: t.lease.token, CFORGE_LEASE_API_URL: h.world.baseUrl } });
    expect(r.code).toBe(1);
    expect(r.json().error.code).toBe("unauthenticated");
    expect(assetCalls().map((c) => c.auth)).toEqual([t.lease.token]);
    expect(h.world.calls.slice(from).filter((c) => c.auth?.startsWith("cfs_"))).toEqual([]);
    expect(existsSync(root)).toBe(false);
  });

  it("refuses an object served from another manifest than the plan's", async () => {
    h.world.addAssetResource("brand", { "logo.png": "PNG" });
    taskId = h.world.createTask("assets", ["api"]).taskId;
    h.world.overrides.set("GET /api/tasks/[^/]+/assets/file", () => ({ status: 200, headers: { "x-commonforge-revision": "r2m:am_other" }, raw: new TextEncoder().encode("PNG") }));
    const r = await h.cli(["checkout", taskId, "work", "--json"]);
    expect(r.json().error.code).toBe("asset_revision_mismatch");
    expect(existsSync(root)).toBe(false);
  });
});

describe("fake asset route mirrors the Worker's refusals", () => {
  it("lease of this task only, running, snapshot asset mounts, manifest paths", async () => {
    h.world.addAssetResource("brand", { "logo.png": "PNG" });
    const a = h.world.createTask("a", ["api"]);
    const b = h.world.createTask("b", ["api"]);
    for (const [t, tok] of [[a, "cfl_aaaaaaaaaaaaaaaaaaaaaaaa"], [b, "cfl_bbbbbbbbbbbbbbbbbbbbbbbb"]] as const) {
      t.state = "running";
      t.lease = { token: tok, generation: 1, expiresAt: Date.now() + 3_600_000, holder: "u" };
    }
    const get = async (taskId: string, q: Record<string, string>, auth: string | null) => {
      const r = await h.world.handle("GET", new URL(`${h.world.baseUrl}/api/tasks/${taskId}/assets/file?${new URLSearchParams(q)}`), auth ? `Bearer ${auth}` : null, null);
      return [r.status, (r.body as { error?: { code: string } } | undefined)?.error?.code ?? "ok"];
    };
    const session = h.world.sessionFor("dev@example.com");
    expect(await get(a.taskId, { mount: "brand", path: "logo.png" }, a.lease!.token)).toEqual([200, "ok"]);
    expect(await get(a.taskId, { mount: "brand", path: "logo.png" }, session)).toEqual([403, "lease_required"]);
    expect(await get(a.taskId, { mount: "brand", path: "logo.png" }, null)).toEqual([401, "unauthenticated"]);
    expect(await get(a.taskId, { mount: "brand", path: "logo.png" }, b.lease!.token)).toEqual([404, "not_found"]);
    expect(await get(a.taskId, { mount: "brand", path: "other.png" }, a.lease!.token)).toEqual([404, "not_found"]);
    expect(await get(a.taskId, { mount: "brand", path: "../logo.png" }, a.lease!.token)).toEqual([400, "invalid_path"]);
    expect(await get(a.taskId, { mount: "website", path: "index.html" }, a.lease!.token)).toEqual([400, "not_assets"]);
    a.lease!.expiresAt = Date.now() - 1;
    expect(await get(a.taskId, { mount: "brand", path: "logo.png" }, a.lease!.token)).toEqual([401, "unauthenticated"]);
    b.state = "submitted";
    expect(await get(b.taskId, { mount: "brand", path: "logo.png" }, b.lease!.token)).toEqual([409, "task_not_running"]);
  });
});

describe("cforge status", () => {
  it("shows the server task and the local checkout (JSON)", async () => {
    await checkout();
    writeFileSync(join(root, "api", "dirty.txt"), "d");
    const r = await h.cli(["status", "--json"], { cwd: join(root, "api") });
    const out = r.json();
    expect(out.task).toMatchObject({ taskId, state: "running", lease: { generation: 1 } });
    expect(out.localLease).toMatchObject({ leaseGeneration: 1 });
    expect(out.workspace.mounts.find((m: { mountName: string }) => m.mountName === "api")).toMatchObject({ writable: true, committedSinceBase: false, uncommittedChanges: 1 });
    expect(r.stdout).not.toMatch(/cfl_|cfs_/);
  });

  it("accepts an explicit task id outside a workspace", async () => {
    const r = await h.cli(["status", taskId, "--json"]);
    expect(r.json()).toMatchObject({ task: { taskId, state: "ready" }, workspace: null });
  });
});
