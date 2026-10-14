/**
 * The orchestrator with DRY-RUN agents against an in-process fake stack (the CLI's fake API +
 * real bare git repositories behind a token-checking smart-HTTP front), driving the *built*
 * `cforge` binary as a subprocess exactly as a live run does. Proves AT-05 overlap from the
 * API's own timestamps, the contract-failure-then-fix sequence, the AT-07 same-file conflict,
 * the R2 logo change through the lease-only asset path, and that agents only ever hold a lease.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { filesContaining } from "../../cli/test/helpers.js";
import { dryRunAgent } from "../src/dry-run.js";
import { runDemo, type DemoReport } from "../src/orchestrator.js";
import { OwnerApi } from "../src/owner-api.js";
import { subprocessCforge } from "../src/cforge.js";
import type { AgentId } from "../src/prompts.js";
import type { AgentRunner } from "../src/agent-cli.js";
import { ORG, PROJECT, type DemoFake } from "./demo-fake.js";
import { MAKE_LOGO, demoWorld } from "./helpers.js";

let world: DemoFake;
let ownerToken: string;
let runDir: string;
let report: DemoReport;
const logs: string[] = [];

const dryRunners = (workMs: number, flakyAgent2 = false) => {
  const r = { runner: dryRunAgent(workMs), tool: "dry-run" };
  let failures = 0;
  // agent 2's first step dies half-way (after a stray edit): the session resets and retries it
  const flaky: AgentRunner = async (spec, root) => {
    if (failures++ === 0) {
      writeFileSync(join(root, "website", "half-done.txt"), "partial\n");
      throw new Error("model exited 1");
    }
    return r.runner(spec, root);
  };
  return { "agent-1": r, "agent-2": flakyAgent2 ? { runner: flaky, tool: "dry-run" } : r, "agent-3": r } as Record<AgentId, typeof r>;
};

beforeAll(async () => {
  ({ world, ownerToken } = await demoWorld());
  runDir = mkdtempSync(join(tmpdir(), "demo-agents-test-"));
  report = await runDemo({
    mode: "dry-run",
    apiUrl: world.baseUrl,
    orgId: ORG,
    projectId: PROJECT,
    agents: ["agent-1", "agent-2", "agent-3"],
    clientEdition: "task-fallback",
    owner: new OwnerApi(world.baseUrl, ownerToken),
    cforge: subprocessCforge(),
    runners: dryRunners(300, true),
    gate: "api",
    gatePollMs: 20,
    readyPollMs: 20,
    runDir,
    evidenceDir: join(runDir, "evidence"),
    makeLogoScript: MAKE_LOGO,
    log: (l) => logs.push(l),
  });
}, 180_000);

afterAll(async () => {
  await world?.close();
});

describe("demo orchestrator (dry-run agents, fake stack)", () => {
  it("runs every agent to a submitted candidate", () => {
    expect(report.agents.map((a) => [a.agent, a.status, a.error])).toEqual([
      ["agent-1", "done", undefined],
      ["agent-2", "done", undefined],
      ["agent-3", "done", undefined],
    ]);
    expect(report.mode).toBe("dry-run");
    expect(report.label).toMatch(/^DRY-RUN/);
  });

  it("starts all agents within 2 s and records overlapping task.started/candidate_frozen from the API (AT-05)", () => {
    const c = report.concurrency;
    // judged from the API's task.started records of all three tasks (one per agent)
    expect(c.apiStart.tasks).toBe(3);
    expect(c.apiStart.withinTwoSeconds).toBe(true);
    expect(c.apiStart.spreadMs!).toBeLessThan(2000);
    const started = world.events.filter((e) => e.action === "task.started").map((e) => Date.parse(e.at));
    expect(c.apiStart.spreadMs).toBe(Math.max(...started) - Math.min(...started));
    expect(c.source).toContain("/events");
    expect(c.agents).toHaveLength(3);
    for (const a of c.agents) {
      expect(a.startedAt).toBeTruthy();
      expect(a.lastFrozenAt).toBeTruthy();
      expect(Date.parse(a.startedAt!)).toBeLessThan(Date.parse(a.lastFrozenAt!));
    }
    // every start precedes every agent's last freeze: one common window of concurrent activity
    expect(c.overlap.allConcurrent).toBe(true);
    expect(c.overlap.commonWindow!.ms).toBeGreaterThan(0);
    for (const p of c.overlap.pairs) expect(p.overlapMs).toBeGreaterThan(0);
    // the timestamps are the API's own event records
    const apiTimes = new Set(world.events.map((e) => e.at));
    for (const a of c.agents) for (const t of a.tasks) {
      expect(apiTimes.has(t.startedAt!)).toBe(true);
      for (const f of t.frozen) expect(apiTimes.has(f.at)).toBe(true);
    }
    // the file on disk is the same document
    expect(JSON.parse(readFileSync(report.files.concurrency, "utf8"))).toEqual(JSON.parse(JSON.stringify(c)));
  });

  it("agent 1: one Change across api+website fails the contract, then a repair run on requirements passes", () => {
    const seq = report.contractSequence!;
    expect(seq.failedFirst).toBe(true);
    expect(seq.passedAfterFix).toBe(true);
    expect(seq.attempts[0]!.detail).toContain("$.breakdown is not declared in the contract");
    expect(seq.attempts[0]!.proposalId).not.toBe(seq.attempts[1]!.proposalId);
    expect(seq.attempts[1]!.contractChecks).toEqual([{ contractId: "quote", result: "pass" }]);

    const a1 = report.agents.find((a) => a.agent === "agent-1")!;
    expect(a1.phases.map((p) => [p.phase, p.submit.candidates.map((c) => c.mountName).sort()])).toEqual([
      ["feature", ["api", "website"]],
      ["fix-contract", ["requirements"]],
    ]);
    // one task (one Change), three candidates; the passing proposal holds all three
    expect(a1.taskIds).toHaveLength(1);
    const task = world.tasks.get(a1.taskIds[0]!)!;
    expect(task.candidates).toHaveLength(3);
    expect(task.state).toBe("submitted");
    expect(world.proposals.get(seq.attempts[1]!.proposalId!)!.candidates).toHaveLength(3);
    expect(world.events.map((e) => e.action)).toEqual(expect.arrayContaining(["proposal.integration_failed", "proposal.integrated"]));
  });

  it("agents 1 and 2 produce a same-file textual conflict at the anchor (AT-07); other overlaps merge cleanly", () => {
    const web12 = report.conflicts.find((c) => c.mountName === "website" && c.left.agent === "agent-1" && c.right.agent === "agent-2")!;
    expect(web12.result).toBe("textual-conflict");
    expect(web12.conflictPaths).toContain("tests/quote-view.test.ts");
    const others = report.conflicts.filter((c) => c !== web12);
    expect(others.map((c) => `${c.mountName}:${c.left.agent}/${c.right.agent}`).sort()).toEqual(["requirements:agent-1/agent-3", "website:agent-1/agent-3", "website:agent-2/agent-3"]);
    for (const c of others) expect(c.result).toBe("clean");
  });

  it("agent 2 (client-edition stand-in) never receives the api source or the requirements", () => {
    const a2 = report.agents.find((a) => a.agent === "agent-2")!;
    expect(world.created.find((t) => t.taskId === a2.taskIds[0])).toMatchObject({ writeMounts: ["website"], readMounts: [] });
    const ws = join(runDir, "agent-2", "ws");
    expect(readdirSync(ws).sort()).toEqual([".commonforge", "website"]);
    expect(a2.note).toMatch(/stand-in/);
  });

  it("a failed agent step is reset and retried once; the failed attempt's edits are not submitted", () => {
    expect(logs.some((l) => /agent-2: client-edit — attempt 1 failed .*retrying/.test(l))).toBe(true);
    const a2 = report.agents.find((a) => a.agent === "agent-2")!;
    expect(a2.phases[0]!.submit.candidates[0]!.changedPaths.sort()).toEqual(["src/quote-view.ts", "src/styles.css", "tests/quote-view.test.ts"]);
    expect(existsSync(join(runDir, "agent-2", "ws", "website", "half-done.txt"))).toBe(false);
  });

  it("agent 3 replaces both logo copies: website/public/logo.png in Git and brand-assets/logo.png in R2", () => {
    const a3 = report.agents.find((a) => a.agent === "agent-3")!;
    // one task (one Change): website + requirements in Git, brand-assets in R2
    expect(a3.taskIds).toHaveLength(1);
    expect(world.created.find((t) => t.taskId === a3.taskIds[0])).toMatchObject({ writeMounts: ["website", "requirements", "brand-assets"], readMounts: [] });
    expect(world.tasks.get(a3.taskIds[0]!)!.state).toBe("submitted");
    const png = readFileSync(join(runDir, "agent-3", "ws", "website", "public", "logo.png"));
    expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    const sha = createHash("sha256").update(png).digest("hex");
    expect(a3.asset).toMatchObject({ path: "logo.png", sha256: sha, size: png.length });
    const ws = world.assetWorkspaces.get(a3.taskIds[0]!)![0]!;
    expect(ws.state).toBe("frozen");
    expect(ws.entries.get("logo.png")!.sha256).toBe(sha);
    expect(Buffer.from(world.assetObjects.get(sha)!)).toEqual(png);
    const gitCand = world.tasks.get(a3.taskIds[0]!)!.candidates.find((c) => c.changedPaths.includes("public/logo.png"));
    expect(gitCand).toBeTruthy();
    // the committed Git copy is byte-identical to the R2 copy
    const head = report.agents.find((a) => a.agent === "agent-3")!.phases[0]!.submit.candidates.find((c) => c.mountName === "website")!.sha;
    const blob = execFileSync("git", ["show", `${head}:public/logo.png`], { cwd: join(runDir, "agent-3", "ws", "website") });
    expect(createHash("sha256").update(blob).digest("hex")).toBe(sha);
  });

  it("agents 1 and 3 check out the brand-assets R2 mount with their lease alone; agent 2 never gets it", () => {
    const a1 = report.agents.find((a) => a.agent === "agent-1")!;
    expect(world.created.find((t) => t.taskId === a1.taskIds[0])).toMatchObject({ writeMounts: ["api", "website", "requirements"], readMounts: ["brand-assets"] });
    for (const a of ["agent-1", "agent-3"]) {
      // the checked-out R2 copy is the accepted (teal) logo, pinned by the task snapshot
      expect(readFileSync(join(runDir, a, "ws", "brand-assets", "logo.png"), "utf8")).toBe("teal-logo-v1");
    }
    const reads = world.calls.filter((c) => /\/assets\/file$/.test(c.path));
    expect(reads.map((c) => c.path.split("/")[3]).sort()).toEqual([a1.taskIds[0], report.agents.find((a) => a.agent === "agent-3")!.taskIds[0]].sort());
    for (const c of reads) {
      const t = world.tasks.get(c.path.split("/")[3]!)!;
      expect(c.auth).toBe(t.lease!.token);
    }
    expect(existsSync(join(runDir, "agent-2", "ws", "brand-assets"))).toBe(false);
    // no user-only file route was used by anyone
    expect(world.calls.filter((c) => /\/projects\/[^/]+\/file$/.test(c.path))).toEqual([]);
  });

  it("agents hold only their task lease: never the owner session, never a git token on disk", () => {
    const agentCalls = world.calls.filter((c) => /\/(materialization|credential|freeze|assets\/)/.test(c.path));
    expect(agentCalls.length).toBeGreaterThan(10);
    for (const c of agentCalls) expect(c.auth?.startsWith("cfl_"), `${c.method} ${c.path}`).toBe(true);
    // the owner session appears nowhere under the run dir (agent homes, cforge config dirs, workspaces, evidence)
    expect(filesContaining(runDir, [ownerToken])).toEqual([]);
    expect(filesContaining(runDir, [...world.tokens.keys()])).toEqual([]);
    // each agent's cforge config dir holds checkout records only: no session.json
    for (const a of ["agent-1", "agent-2", "agent-3"]) {
      expect(existsSync(join(runDir, a, "home", ".config", "commonforge", "session.json"))).toBe(false);
    }
  });
});

describe("evidence safety", () => {
  it("a dry run refuses to overwrite live evidence", async () => {
    const dir = mkdtempSync(join(tmpdir(), "demo-agents-live-ev-"));
    mkdirSync(join(dir, "evidence"));
    writeFileSync(join(dir, "evidence", "concurrency.json"), JSON.stringify({ mode: "live" }));
    await expect(
      runDemo({ mode: "dry-run", apiUrl: world.baseUrl, orgId: ORG, projectId: PROJECT, agents: ["agent-3"], clientEdition: "off", owner: new OwnerApi(world.baseUrl, ownerToken), cforge: subprocessCforge(), runners: dryRunners(0), gate: "local", runDir: dir, evidenceDir: join(dir, "evidence"), makeLogoScript: MAKE_LOGO, log: () => {} }),
    ).rejects.toThrow(/refusing to overwrite live evidence/);
    expect(world.created.length).toBe(3); // nothing was started
  });
});

describe("client edition through the editions API (Task 21)", () => {
  it("agent 2 edits a downloaded edition (no git, no api) and the client's partial return becomes a proposal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "demo-agents-edition-"));
    const clientToken = world.sessionFor("client@example.com");
    const editionLogs: string[] = [];
    const r = await runDemo({
      mode: "dry-run",
      apiUrl: world.baseUrl,
      orgId: ORG,
      projectId: PROJECT,
      agents: ["agent-2"],
      clientEdition: "edition",
      owner: new OwnerApi(world.baseUrl, ownerToken),
      client: new OwnerApi(world.baseUrl, clientToken),
      cforge: subprocessCforge(),
      runners: dryRunners(0, true),
      gate: "local",
      readyPollMs: 20,
      runDir: dir,
      evidenceDir: join(dir, "evidence"),
      makeLogoScript: MAKE_LOGO,
      log: (l) => editionLogs.push(l),
    });
    const a2 = r.agents.find((a) => a.agent === "agent-2")!;
    expect(a2.status, a2.error).toBe("done");
    expect(a2.edition?.actor).toBe("client");
    expect(a2.edition?.proposalId).toMatch(/^prop-/);
    expect(a2.edition?.changes).toEqual([
      { path: "src/quote-view.ts", kind: "modified" },
      { path: "src/styles.css", kind: "modified" },
      { path: "tests/quote-view.test.ts", kind: "modified" },
    ]);
    expect(a2.edition?.blocked).toEqual([]);
    // the failed first attempt's stray file was reset away, never returned
    expect(editionLogs.some((l) => /agent-2: client-edit — attempt 1 failed .*restoring/.test(l))).toBe(true);
    // the working copy: the edition only — no git, no api, no requirements, no contract test
    const ws = join(dir, "agent-2", "ws");
    expect(readdirSync(ws)).toEqual(["website"]);
    expect(existsSync(join(ws, "website", ".git"))).toBe(false);
    expect(existsSync(join(ws, "website", "tests", "quote-contract.test.ts"))).toBe(false);
    expect(existsSync(join(ws, "website", "half-done.txt"))).toBe(false);
    // the server-side result carries the client's change; the client only ever sent ZIPs
    const ret = world.editionReturns.get(a2.edition!.returnId!)!;
    expect(new TextDecoder().decode(ret.result.get("src/quote-view.ts"))).toContain("quote-note");
    expect(ret.userId).not.toBe(undefined);
    expect(world.calls.filter((c) => c.auth === clientToken).every((c) => !c.path.startsWith("/api/tasks/") && !c.path.startsWith("/git/"))).toBe(true);
    // a leased-agent evidence file is still written; agent 2 (no lease) is not part of AT-05 overlap
    expect(r.concurrency.agents.map((x) => x.agent)).toEqual([]);
  });
});
