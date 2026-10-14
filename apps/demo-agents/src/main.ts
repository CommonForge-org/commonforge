#!/usr/bin/env node
/** `demo-agents` command line: run the three-agent demo against a CommonForge API. */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { DEFAULT_MODEL, DEFAULT_STEP_TIMEOUT_MS, realAgent, type AgentCliName, type AgentRunner } from "./agent-cli.js";
import { packageRoot, subprocessCforge } from "./cforge.js";
import { dryRunAgent } from "./dry-run.js";
import { runDemo, type ClientEditionMode } from "./orchestrator.js";
import { OwnerApi, loadOwnerSession, ownerConfigDir } from "./owner-api.js";
import type { AgentId } from "./prompts.js";
import { assertRunDirOutsideCheckout } from "./run-dir.js";

const HELP = `demo-agents — three concurrent agent sessions against CommonForge (Task 19)

Usage: demo-agents [run] [options]

  --project <id>            project to work in (env DEMO_PROJECT_ID)              [required]
  --api-url <url>           CommonForge API (env CFORGE_API_URL)                  [required]
  --org <org>               organization (env CFORGE_ORG)                         [required]
  --agents <list>           agents to run, e.g. 1,3 (default 1,3; 2 needs --client-edition)
  --client-edition <mode>   agent 2: off (default) | edition (Task 21 API) | task-fallback
  --client-config-dir <dir> edition mode: cforge config dir of the *client's* \`cforge login\`
                            (the owner publishes and grants the edition; the client starts
                            the update, downloads the ZIP and sends it back). Without it the
                            owner plays the client.
  --gate <api|local>        agent 1's contract gate: api = proposal + trusted integration
                            (default), local = contract check on the workspace (rehearsal)
  --cli <map>               agent CLI per agent, e.g. 1=claude,3=codex (default claude)
  --allow-codex             required for any codex agent: codex's sandbox does not confine
                            reads (see README "Security")
  --model <name>            model for the agent CLIs (default sonnet)
  --budget-usd <n>          claude --max-budget-usd per step (default 3)
  --step-timeout-min <n>    timeout per agent step (default 5)
  --retries <n>             extra attempts per failed agent step (default 1)
  --dry-run                 DRY-RUN: scripted edits replace the agent CLI (CI / rehearsal);
                            the evidence is labelled and is not live throughput evidence
  --dry-run-work-ms <n>     simulated think time per dry-run phase (default 1500)
  --run-dir <dir>           where agent homes and workspaces go (default: a new dir under
                            $TMPDIR; refused inside the repo checkout or any git work tree)
  --evidence-dir <dir>      where concurrency.json / demo-run.json go (default <repo>/evidence,
                            or <repo>/evidence/dry-run for --dry-run; a dry run never
                            overwrites live evidence)

The owner session comes from \`cforge login\` (CFORGE_CONFIG_DIR or the default cforge config
dir). Agents never see it: each gets its own config dir and only its task lease.
`;

/**
 * The argument list without a leading `--` (review C2: `pnpm … demo -- --api-url …` passes the
 * literal `--` through to the script, which parseArgs would read as "positionals follow") and
 * without the optional `run` subcommand.
 */
export function normalizeArgv(argv: readonly string[]): string[] {
  let a = [...argv];
  if (a[0] === "--") a = a.slice(1);
  if (a[0] === "run") a = a.slice(1);
  if (a[0] === "--") a = a.slice(1);
  return a;
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = normalizeArgv(argv);
  const { values } = parseArgs({
    args: [...args],
    options: {
      project: { type: "string" },
      "api-url": { type: "string" },
      org: { type: "string" },
      agents: { type: "string" },
      "client-edition": { type: "string" },
      "client-config-dir": { type: "string" },
      gate: { type: "string" },
      cli: { type: "string" },
      model: { type: "string" },
      "allow-codex": { type: "boolean" },
      "step-timeout-min": { type: "string" },
      retries: { type: "string" },
      "budget-usd": { type: "string" },
      "dry-run": { type: "boolean" },
      "dry-run-work-ms": { type: "string" },
      "run-dir": { type: "string" },
      "evidence-dir": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const apiUrl = values["api-url"] ?? process.env.CFORGE_API_URL;
  const orgId = values.org ?? process.env.CFORGE_ORG;
  const projectId = values.project ?? process.env.DEMO_PROJECT_ID;
  if (!apiUrl || !orgId || !projectId) {
    process.stderr.write(`demo-agents: --api-url, --org and --project are required\n\n${HELP}`);
    return 2;
  }
  const clientEdition = (values["client-edition"] ?? "off") as ClientEditionMode;
  if (!["off", "edition", "task-fallback"].includes(clientEdition)) throw new Error(`--client-edition must be off, edition or task-fallback`);
  const agents = (values.agents ?? (clientEdition === "off" ? "1,3" : "1,2,3")).split(",").map((s) => `agent-${s.trim().replace(/^agent-/, "")}` as AgentId);
  for (const a of agents) if (!["agent-1", "agent-2", "agent-3"].includes(a)) throw new Error(`unknown agent ${a}`);
  const gate = (values.gate ?? "api") as "api" | "local";
  if (gate !== "api" && gate !== "local") throw new Error("--gate must be api or local");

  const clis = new Map<string, AgentCliName>();
  for (const pair of (values.cli ?? "").split(",").filter(Boolean)) {
    const [k, v] = pair.split("=");
    if (v !== "claude" && v !== "codex") throw new Error(`--cli: ${pair}: use claude or codex`);
    clis.set(`agent-${k}`, v);
  }
  if ([...clis.values()].includes("codex") && values["allow-codex"] !== true) throw new Error("codex agents need --allow-codex: its sandbox confines writes and network but not reads (README \"Security\")");
  if ([...clis.values()].includes("codex")) process.stderr.write("demo-agents: WARNING: codex runs with an isolated CODEX_HOME and no MCP servers, but its sandbox does not confine reads.\n");
  const dry = values["dry-run"] === true;
  const dryRunner = dryRunAgent(Number(values["dry-run-work-ms"] ?? 1500));
  const repo = join(packageRoot(), "..", "..");
  const runDir = resolve(values["run-dir"] ?? (await mkdtemp(join(tmpdir(), "commonforge-demo-"))));
  await assertRunDirOutsideCheckout(runDir, repo);
  const runners = {} as Record<AgentId, { runner: AgentRunner; tool: string }>;
  for (const a of ["agent-1", "agent-2", "agent-3"] as AgentId[]) {
    const cli = clis.get(a) ?? "claude";
    runners[a] = dry
      ? { runner: dryRunner, tool: "dry-run" }
      : { runner: realAgent(cli, { model: values.model ?? DEFAULT_MODEL, maxBudgetUsd: Number(values["budget-usd"] ?? 3), timeoutMs: values["step-timeout-min"] ? Number(values["step-timeout-min"]) * 60_000 : DEFAULT_STEP_TIMEOUT_MS, logDir: join(runDir, "logs") }), tool: cli === "claude" ? "claude-code" : "codex" };
  }

  const owner = new OwnerApi(apiUrl, await loadOwnerSession(ownerConfigDir(), apiUrl));
  const clientDir = values["client-config-dir"];
  const client = clientDir ? new OwnerApi(apiUrl, await loadOwnerSession(resolve(clientDir), apiUrl)) : undefined;
  const report = await runDemo({
    mode: dry ? "dry-run" : "live",
    apiUrl: owner.apiUrl,
    orgId,
    projectId,
    agents,
    clientEdition,
    owner,
    ...(client ? { client } : {}),
    cforge: subprocessCforge(),
    runners,
    gate,
    runDir,
    evidenceDir: resolve(values["evidence-dir"] ?? (dry ? join(repo, "evidence", "dry-run") : join(repo, "evidence"))),
    stepRetries: Number(values.retries ?? 1),
    makeLogoScript: join(repo, "fixtures", "brand-assets", "scripts", "make-logo.mjs"),
  });
  const failed = report.agents.filter((a) => a.status === "failed");
  process.stdout.write(
    `${JSON.stringify(
      {
        mode: report.mode,
        agents: report.agents.map((a) => ({ agent: a.agent, status: a.status, taskIds: a.taskIds, ...(a.error ? { error: a.error } : {}), ...(a.note ? { note: a.note } : {}) })),
        contractSequence: report.contractSequence && { failedFirst: report.contractSequence.failedFirst, passedAfterFix: report.contractSequence.passedAfterFix },
        conflicts: report.conflicts.map((x) => ({ mount: x.mountName, between: [x.left.agent, x.right.agent], result: x.result, paths: x.conflictPaths })),
        concurrency: { allConcurrent: report.concurrency.overlap.allConcurrent, taskStartedSpreadMs: report.concurrency.apiStart.spreadMs, startedWithinTwoSeconds: report.concurrency.apiStart.withinTwoSeconds },
        evidence: report.files,
        runDir,
      },
      null,
      2,
    )}\n`,
  );
  return failed.length ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (e: unknown) => {
      process.stderr.write(`demo-agents: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 1;
    },
  );
}
