import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentCliEnv, claudeArgs, codexArgs, realAgent } from "../src/agent-cli.js";
import { installLogoTool } from "../src/logo-tool.js";
import { assertRunDirOutsideCheckout } from "../src/run-dir.js";
import { checkQuoteContract } from "../src/contract-check.js";
import { dryRunAgent } from "../src/dry-run.js";
import { concurrencyEvidence } from "../src/evidence.js";
import { loadOwnerSession } from "../src/owner-api.js";
import { agent1FeaturePrompt, agent1FixPrompt, agent2ClientPrompt, agent3BrandPrompt, CONFLICT_ANCHOR } from "../src/prompts.js";
import { DEMO_AGENT_COUNT } from "../src/index.js";
import { MAKE_LOGO, REPO } from "./helpers.js";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

describe("prompts", () => {
  it("name the conflict anchor for both website agents and both logo copies for agent 3", () => {
    expect(DEMO_AGENT_COUNT).toBe(3);
    expect(agent1FeaturePrompt().prompt).toContain(CONFLICT_ANCHOR);
    expect(agent2ClientPrompt().prompt).toContain(CONFLICT_ANCHOR);
    const a3 = agent3BrandPrompt("node /opt/tools/brand-logo.mjs");
    expect(a3.prompt).toContain("website/public/logo.png");
    expect(a3.prompt).toContain("brand-assets");
    expect(a3.allowedCommand).toBe("node /opt/tools/brand-logo.mjs --color=#7c3aed");
    expect(a3.prompt).toContain(a3.allowedCommand);
    expect(agent1FixPrompt("quote: $.breakdown is not declared in the contract").prompt).toContain("$.breakdown is not declared");
    // the client agent is never told about the api source
    expect(agent2ClientPrompt().writable).toEqual(["website"]);
  });
});

describe("agent CLI confinement", () => {
  it("claude runs restricted in dontAsk mode with an explicit allowlist; Bash only for one exact command", () => {
    const a = claudeArgs(agent1FeaturePrompt(), { maxBudgetUsd: 2 });
    expect(a).toEqual(expect.arrayContaining(["-p", "--restricted", "--strict-mcp-config", "--no-session-persistence"]));
    expect(a[a.indexOf("--tools") + 1]).toBe("Read,Edit,Write,Glob,Grep");
    const allowed = (args: string[]) => args.slice(args.indexOf("--allowedTools") + 1, args.indexOf("--permission-mode"));
    expect(allowed(a)).toEqual(["Read", "Edit", "Write", "Glob", "Grep"]);
    expect(a[a.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(a[a.indexOf("--permission-prompts") + 1]).toBe("none");
    expect(a[a.indexOf("--model") + 1]).toBe("sonnet");
    expect(a).not.toContain("--dangerously-skip-permissions");
    expect(a).not.toContain("acceptEdits");
    const b = claudeArgs(agent3BrandPrompt("node /opt/t/brand-logo.mjs"), {});
    expect(b[b.indexOf("--tools") + 1]).toBe("Read,Edit,Write,Glob,Grep,Bash");
    expect(allowed(b)).toEqual(["Read", "Edit", "Write", "Glob", "Grep", "Bash(node /opt/t/brand-logo.mjs --color=#7c3aed)"]);
    expect(b.join(" ")).not.toContain(":*");
  });

  it("codex ignores the operator's config and MCP servers, sandboxed to the workspace, never asking", () => {
    const a = codexArgs(agent2ClientPrompt(), "/ws/root", {});
    expect(a.slice(0, 5)).toEqual(["exec", "--sandbox", "workspace-write", "--cd", "/ws/root"]);
    expect(a).toEqual(expect.arrayContaining(["--ignore-user-config", "mcp_servers={}", 'approval_policy="never"', 'shell_environment_policy.inherit="core"', "--ephemeral", "--ignore-rules"]));
    expect(a).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("codex runs with a throwaway CODEX_HOME holding only auth.json, removed afterwards", async () => {
    const dir = tmp("fake-codex-");
    const auth = tmp("codex-auth-");
    writeFileSync(join(auth, "auth.json"), '{"token":"x"}');
    writeFileSync(join(auth, "config.toml"), "[mcp_servers.evil]\ncommand = 'x'\n");
    writeFileSync(join(auth, "hooks.json"), "{}");
    const bin = join(dir, "codex");
    writeFileSync(bin, `#!/bin/sh\necho "home=$CODEX_HOME files=$(ls -A "$CODEX_HOME" | tr '\\n' ' ')openai=\${OPENAI_API_KEY:-none} anthropic=\${ANTHROPIC_API_KEY:-none}"\n`);
    chmodSync(bin, 0o755);
    process.env.OPENAI_API_KEY = "sk-openai";
    process.env.ANTHROPIC_API_KEY = "sk-anthropic";
    try {
      const r = await realAgent("codex", { bin, codexAuthHome: auth })(agent2ClientPrompt(), tmp("ws-"));
      const m = /home=(\S+) files=(.*)openai=(\S+) anthropic=(\S+)/.exec(r.summary)!;
      expect(m[1]).not.toBe(auth);
      expect(m[2]!.trim()).toBe("auth.json");
      expect(existsSync(m[1]!)).toBe(false);
      expect([m[3], m[4]]).toEqual(["sk-openai", "none"]);
    } finally {
      delete process.env.OPENAI_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it("the model process environment is an allowlist", () => {
    const base = { HOME: "/h", PATH: "/bin", LANG: "C", CFORGE_LEASE_TOKEN: "cfl_x", CFORGE_CONFIG_DIR: "/c", CF_API_TOKEN: "t", GITHUB_TOKEN: "g", DATABASE_URL: "pg://", STRIPE_SECRET_KEY: "s", ANTHROPIC_MODEL: "m", OPENAI_API_KEY: "o" };
    expect(agentCliEnv("claude", base)).toEqual({ HOME: "/h", PATH: "/bin", LANG: "C", ANTHROPIC_MODEL: "m" });
    expect(agentCliEnv("codex", base)).toEqual({ HOME: "/h", PATH: "/bin", LANG: "C", OPENAI_API_KEY: "o" });
  });

  it("realAgent starts the CLI in the workspace root with the scrubbed environment", async () => {
    const dir = tmp("fake-claude-");
    const bin = join(dir, "claude");
    writeFileSync(bin, `#!/bin/sh\nprintf '{"result":"cwd=%s lease=%s","total_cost_usd":0.01}' "$PWD" "\${CFORGE_LEASE_TOKEN:-none}"\n`);
    chmodSync(bin, 0o755);
    const root = tmp("ws-");
    process.env.CFORGE_LEASE_TOKEN = "cfl_should_not_leak";
    try {
      const r = await realAgent("claude", { bin, logDir: join(dir, "logs") })(agent2ClientPrompt(), root);
      expect(r.summary).toBe(`cwd=${root} lease=none`);
      expect(r.costUsd).toBe(0.01);
      expect(r.command).toContain("<prompt>");
      expect(readFileSync(r.logFile!, "utf8")).toContain("--- prompt ---");
    } finally {
      delete process.env.CFORGE_LEASE_TOKEN;
    }
  });
});

describe("agent 3's logo wrapper", () => {
  async function setup() {
    const tools = join(tmp("tools-"), "tools");
    const command = await installLogoTool(tools, MAKE_LOGO);
    const root = tmp("ws-");
    mkdirSync(join(root, "website", "public"), { recursive: true });
    const run = (...args: string[]) => spawnSync(process.execPath, [command.slice("node ".length), ...args], { cwd: root, encoding: "utf8" });
    return { tools, command, root, run };
  }

  it("is read-only, lives outside the workspace and always writes website/public/logo.png", async () => {
    const { tools, root, run } = await setup();
    expect(readdirSync(tools).sort()).toEqual(["brand-logo.mjs", "make-logo.mjs"]);
    expect(() => writeFileSync(join(tools, "brand-logo.mjs"), "x")).toThrow();
    const r = run("--color=#7c3aed");
    expect(r.status, r.stderr).toBe(0);
    expect([...readFileSync(join(root, "website", "public", "logo.png")).subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("refuses any other argument: a path, extra args, a malformed colour", async () => {
    const { root, run } = await setup();
    const victim = join(tmp("victim-"), "important.txt");
    writeFileSync(victim, "keep me");
    for (const args of [[victim], [victim, "--color=#7c3aed"], ["--color=#7c3aed", victim], ["--color=#7C3AED"], ["--color=red"], [], ["--color=#7c3aed; rm -rf /"]]) {
      const r = run(...args);
      expect(r.status, args.join(" ")).toBe(2);
    }
    expect(readFileSync(victim, "utf8")).toBe("keep me");
    expect(existsSync(join(root, "website", "public", "logo.png"))).toBe(false);
  });

  it("refuses a symlinked logo or a website/public that leaves the workspace", async () => {
    const { root, run } = await setup();
    const victim = join(tmp("victim-"), "x.png");
    writeFileSync(victim, "keep me");
    symlinkSync(victim, join(root, "website", "public", "logo.png"));
    expect(run("--color=#7c3aed").status).toBe(2);
    expect(readFileSync(victim, "utf8")).toBe("keep me");
    const other = await setup();
    const outside = tmp("outside-");
    const pub = join(other.root, "website", "public");
    spawnSync("rm", ["-r", pub]);
    symlinkSync(outside, pub);
    expect(other.run("--color=#7c3aed").status).toBe(2);
    expect(readdirSync(outside)).toEqual([]);
  });
});

describe("run dir", () => {
  it("is refused inside the repository checkout or any git work tree", async () => {
    await expect(assertRunDirOutsideCheckout(join(REPO, "tmp-run"), REPO)).rejects.toThrow(/inside the repository checkout/);
    const otherRepo = tmp("other-repo-");
    spawnSync("git", ["init", "-q"], { cwd: otherRepo });
    await expect(assertRunDirOutsideCheckout(join(otherRepo, "run"), REPO)).rejects.toThrow(/git work tree/);
    await expect(assertRunDirOutsideCheckout(join(tmp("run-"), "x"), REPO)).resolves.toBeUndefined();
  });
});

describe("contract check and dry-run edits", () => {
  function workspace(): string {
    const root = tmp("contract-");
    for (const m of ["api", "website", "requirements"]) cpSync(join(REPO, "fixtures", m), join(root, m), { recursive: true, filter: (s) => !s.includes("node_modules") && !s.includes("/dist") });
    return root;
  }

  it("the fixtures pass; agent 1's api change fails until the contract declares breakdown", async () => {
    const root = workspace();
    expect((await checkQuoteContract(root)).result).toBe("pass");
    const agent = dryRunAgent(0);
    await agent(agent1FeaturePrompt(), root);
    // the new case sits directly below the (two-line) anchor comment, which stays intact
    expect(readFileSync(join(root, "website", "tests", "quote-view.test.ts"), "utf8")).toContain(
      `  ${CONFLICT_ANCHOR} New presentation cases (for example a\n  // per-seat breakdown or a redesigned total) are added directly below.\n  it("shows the breakdown`,
    );
    const failed = await checkQuoteContract(root);
    expect(failed.result).toBe("fail");
    expect(failed.detail).toContain("$.breakdown is not declared in the contract");
    await agent(agent1FixPrompt(failed.detail), root);
    expect(await checkQuoteContract(root)).toMatchObject({ result: "pass" });
  });

  it("agent 3's scripted run regenerates the logo with the generator and edits R4.2", async () => {
    const root = workspace();
    const before = readFileSync(join(root, "website", "public", "logo.png"));
    await dryRunAgent(0)(agent3BrandPrompt(await installLogoTool(join(tmp("tools-"), "tools"), MAKE_LOGO)), root);
    const after = readFileSync(join(root, "website", "public", "logo.png"));
    expect(after.equals(before)).toBe(false);
    expect(readFileSync(join(root, "requirements", "requirements.md"), "utf8")).toContain("violet (`#7c3aed`)");
    expect(readFileSync(join(root, "website", "src", "styles.css"), "utf8")).toContain("--brand: #7c3aed");
  });
});

describe("concurrency evidence", () => {
  const ev = (seq: number, at: string, action: string, id: string, taskId?: string) => ({ seq, at, projectId: "p", action, subject: { kind: "x", id }, actor: { kind: "user" }, ...(taskId ? { detail: { taskId } } : {}) });

  it("judges the start spread by the API's task.started records, not the orchestrator clock", () => {
    const agents = [
      { agent: "a", role: "", cli: "dry-run", taskIds: ["t1"], launchedAt: "2026-10-06T10:00:00.000Z" },
      { agent: "b", role: "", cli: "dry-run", taskIds: ["t2"], launchedAt: "2026-10-06T10:00:00.000Z" },
    ];
    const events = [
      ev(1, "2026-10-06T10:00:00.100Z", "task.started", "t1"),
      ev(2, "2026-10-06T10:00:01.000Z", "task.candidate_frozen", "c1", "t1"),
      ev(3, "2026-10-06T10:00:03.100Z", "task.started", "t2"),
      ev(4, "2026-10-06T10:00:04.000Z", "task.candidate_frozen", "c2", "t2"),
    ];
    const c = concurrencyEvidence({ mode: "live", apiUrl: "https://x", orgId: "o", projectId: "p", agents, events });
    expect(c.launch).toMatchObject({ clock: "orchestrator", spreadMs: 0, withinTwoSeconds: true });
    expect(c.apiStart).toMatchObject({ firstAt: "2026-10-06T10:00:00.100Z", lastAt: "2026-10-06T10:00:03.100Z", spreadMs: 3000, withinTwoSeconds: false, tasks: 2 });
    expect(c.overlap).toMatchObject({ allConcurrent: false, commonWindow: null, pairs: [{ a: "a", b: "b", overlapMs: 0 }] });
    expect(c.label).toMatch(/^LIVE/);
  });
});

describe("owner session", () => {
  it("is read from the owner's cforge config dir and bound to its API", async () => {
    const dir = tmp("owner-cfg-");
    writeFileSync(join(dir, "session.json"), JSON.stringify({ apiUrl: "https://api.example", sessionToken: "cfs_abcdefgh12345678", expiresAt: "2999-01-01T00:00:00.000Z", user: { userId: "u", email: "e" } })); // gitleaks:allow (fake test token)
    await expect(loadOwnerSession(dir, "https://api.example")).resolves.toBe("cfs_abcdefgh12345678");
    await expect(loadOwnerSession(dir, "https://other.example")).rejects.toThrow(/not https:\/\/other.example/);
  });
});

describe("review C2: the orchestrator's argument list", () => {
  it("ignores a leading `--` (pnpm passes it through) and the optional `run`", async () => {
    const { normalizeArgv } = await import("../src/main.js");
    expect(normalizeArgv(["--", "--api-url", "https://x", "--org", "o"])).toEqual(["--api-url", "https://x", "--org", "o"]);
    expect(normalizeArgv(["run", "--", "--help"])).toEqual(["--help"]);
    expect(normalizeArgv(["--", "run", "--help"])).toEqual(["--help"]);
    expect(normalizeArgv(["--help"])).toEqual(["--help"]);
  });

  it("`pnpm … demo -- --help` really runs (the built CLI through pnpm)", () => {
    const r = spawnSync("pnpm", ["--silent", "--filter", "@commonforge-org/demo-agents", "demo", "--", "--help"], { encoding: "utf8", cwd: join(__dirname, "..") });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout + r.stderr).toContain("--api-url");
  });
});
