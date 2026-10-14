/**
 * The demo orchestrator (plan §C.1 rows 5–9, AT-05/AT-07). As the project owner it creates the
 * agents' tasks, waits until they are provisioned, then starts every agent within 2 s: each start
 * takes the task lease (the API records `task.started`) and hands *only that lease* to the agent's
 * pipeline (`cforge checkout` → agent CLI → `cforge submit`). Afterwards it runs the contract
 * gate for agent 1 (fail → repair → pass), probes same-file conflicts between agents that wrote
 * the same resource, and writes the API's own timestamps to `evidence/concurrency.json`.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { replaceAsset, type AssetFreeze } from "./assets.js";
import type { AgentRunner } from "./agent-cli.js";
import type { CforgeRunner } from "./cforge.js";
import { probeTextualConflict, type ConflictProbe } from "./conflict.js";
import { prepareClientEdition, resetEditionCopy, returnClientEdition, type EditionPrep } from "./edition.js";
import { concurrencyEvidence, type AgentTasks, type ConcurrencyEvidence } from "./evidence.js";
import { apiGate, localGate, type ContractGate, type GateOutcome } from "./gate.js";
import { installLogoTool } from "./logo-tool.js";
import type { OwnerApi, TaskView } from "./owner-api.js";
import { agent1FeaturePrompt, agent1FixPrompt, agent2ClientPrompt, agent3BrandPrompt, type AgentId } from "./prompts.js";
import { AgentSession, type PhaseRecord } from "./session.js";

export interface Mounts {
  website: string;
  api: string;
  requirements: string;
  brandAssets: string;
}

export const DEFAULT_MOUNTS: Mounts = { website: "website", api: "api", requirements: "requirements", brandAssets: "brand-assets" };

/** How agent 2 (client edition) runs: not at all, through the Task 21 edition API, or as a website-only task stand-in. */
export type ClientEditionMode = "off" | "edition" | "task-fallback";

export interface DemoConfig {
  mode: "live" | "dry-run";
  apiUrl: string;
  orgId: string;
  projectId: string;
  agents: AgentId[];
  clientEdition: ClientEditionMode;
  owner: OwnerApi;
  /** agent 2 in edition mode: the client's own session (else the owner uses the edition itself) */
  client?: OwnerApi;
  cforge: CforgeRunner;
  runners: Record<AgentId, { runner: AgentRunner; tool: string }>;
  /** `api`: proposal + trusted integration (live); `local`: contract check on the agent's workspace (rehearsal) */
  gate: "api" | "local";
  gatePollMs?: number;
  gateTimeoutMs?: number;
  runDir: string;
  evidenceDir: string;
  /** the logo generator (fixtures/brand-assets/scripts/make-logo.mjs); copied read-only outside the workspaces */
  makeLogoScript: string;
  mounts?: Mounts;
  /** extra attempts per agent step after a failure (default 1) */
  stepRetries?: number;
  leaseTtlSeconds?: number;
  readyTimeoutMs?: number;
  readyPollMs?: number;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

export interface AgentOutcome {
  agent: AgentId;
  role: string;
  cli: string;
  status: "done" | "failed" | "blocked" | "skipped";
  error?: string;
  taskIds: string[];
  launchedAt?: string;
  phases: PhaseRecord[];
  gates?: GateOutcome[];
  asset?: AssetFreeze;
  /** agent 2 in edition mode: the edition round trip */
  edition?: { editionId: string; sessionId: string; actor: "client" | "owner"; returnId?: string; proposalId?: string | null; changes?: Array<{ path: string; kind: string }>; blocked?: Array<{ path: string; reason: string }>; run?: PhaseRecord["run"] };
  note?: string;
}

export interface DemoReport {
  schema: "commonforge.demo.run/1";
  mode: "live" | "dry-run";
  label: string;
  startedAt: string;
  finishedAt: string;
  apiUrl: string;
  orgId: string;
  projectId: string;
  agents: AgentOutcome[];
  contractSequence: { failedFirst: boolean; passedAfterFix: boolean; attempts: GateOutcome[] } | null;
  conflicts: ConflictProbe[];
  concurrency: ConcurrencyEvidence;
  files: { concurrency: string; report: string };
}

const ROLES: Record<AgentId, string> = {
  "agent-1": "developer: website + api quote breakdown (one Change, several candidates)",
  "agent-2": "client edition: website only, no api source",
  "agent-3": "brand + requirements: logo (Git + R2) and R4 text",
};

interface Planned {
  agent: AgentId;
  taskId: string;
  view: TaskView;
}

export async function runDemo(c: DemoConfig): Promise<DemoReport> {
  const log = c.log ?? ((l: string) => process.stderr.write(`${l}\n`));
  const m = c.mounts ?? DEFAULT_MOUNTS;
  const ttl = c.leaseTtlSeconds ?? 7200;
  const startedAt = new Date().toISOString();
  await refuseToOverwriteLiveEvidence(c);
  const outcomes = new Map<AgentId, AgentOutcome>();
  for (const a of c.agents) outcomes.set(a, { agent: a, role: ROLES[a], cli: c.runners[a].tool, status: "skipped", taskIds: [], phases: [] });

  const startSeq = (await c.owner.allEvents(c.orgId, 0, c.projectId)).next;
  const gate: ContractGate =
    c.gate === "api"
      ? apiGate(c.owner, c.orgId, { startSeq, projectId: c.projectId, ...(c.gatePollMs ? { pollMs: c.gatePollMs } : {}), ...(c.gateTimeoutMs ? { timeoutMs: c.gateTimeoutMs } : {}) })
      : localGate();

  // ---- 1. tasks (created and provisioned before the clock starts)
  const logoTool = await installLogoTool(join(c.runDir, "tools"), c.makeLogoScript);

  let editionPrep: EditionPrep | null = null;
  // One task per agent, each with explicit `readMounts`. Asset mounts check out with the lease alone
  // (`GET /api/tasks/:id/assets/file`), so agent 1 gets the brand assets as pinned context.
  const specs: Array<{ agent: AgentId; title: string; request: string; writeMounts: string[]; readMounts: string[] }> = [];
  for (const a of c.agents) {
    if (a === "agent-1") specs.push({ agent: a, title: "Quote breakdown across api and website", request: "Add breakdown { gross, discount } to GET /quote and show it in the quote view.", writeMounts: [m.api, m.website, m.requirements], readMounts: [m.brandAssets] });
    if (a === "agent-2") {
      if (c.clientEdition === "off") continue;
      if (c.clientEdition === "edition") {
        // prepared before the clock starts, like the other agents' task provisioning
        const o = outcomes.get(a)!;
        try {
          editionPrep = await prepareClientEdition(editionOptions(c, m, log));
          o.edition = { editionId: editionPrep.editionId, sessionId: editionPrep.sessionId, actor: editionPrep.actor };
        } catch (e) {
          o.status = "blocked";
          o.note = `blocked: client edition setup failed: ${e instanceof Error ? e.message : String(e)}`;
          log(`agent-2: ${o.note}`);
        }
        continue;
      }
      // the client agent never sees the api source (or anything but the website)
      specs.push({ agent: a, title: "Client edition: explain what the quote covers", request: "Website-only change made in a client edition (stand-in task until editions exist).", writeMounts: [m.website], readMounts: [] });
    }
    if (a === "agent-3") {
      // one Change: the Git copy of the logo (website), R4.2 (requirements) and the R2 copy (brand-assets)
      specs.push({ agent: a, title: "Brand colour refresh: logo (Git + R2) and requirements", request: "Switch the brand colour to violet; regenerate the logo in website and brand-assets; update R4.2.", writeMounts: [m.website, m.requirements, m.brandAssets], readMounts: [] });
    }
  }
  const created = await Promise.all(specs.map(async (s) => ({ ...s, view: await c.owner.createTask(c.orgId, c.projectId, { title: s.title, request: s.request, writeMounts: s.writeMounts, readMounts: s.readMounts }) })));
  log(`created ${created.length} task(s); waiting for provisioning`);
  const ready = await Promise.all(created.map(async (t) => ({ ...t, view: await c.owner.waitReady(t.view.taskId, c.readyTimeoutMs ?? 10 * 60_000, c.readyPollMs ?? 1000) })));
  const planned: Planned[] = [];
  for (const t of ready) {
    planned.push({ agent: t.agent, taskId: t.view.taskId, view: t.view });
    outcomes.get(t.agent)!.taskIds.push(t.view.taskId);
  }

  // ---- 2. start every agent at once
  const sessions = new Map<AgentId, AgentSession>();
  const gates: GateOutcome[] = [];
  const t0 = Date.now();
  log(`starting ${planned.length + (editionPrep ? 1 : 0)} agent(s)`);
  const editionRun = editionPrep ? runEditionAgent(c, m, editionPrep, outcomes.get("agent-2")!, log) : Promise.resolve();
  await Promise.all([
    editionRun,
    ...planned.map(async (p) => {
      const o = outcomes.get(p.agent)!;
      o.launchedAt = new Date().toISOString();
      try {
        const lease = (await c.owner.lease(p.taskId, ttl)).leaseToken;
        const session = new AgentSession({ agent: p.agent, name: `Demo ${p.agent}`, taskId: p.taskId, leaseToken: lease, apiUrl: c.apiUrl, dir: join(c.runDir, p.agent), cforge: c.cforge, runner: c.runners[p.agent].runner, tool: c.runners[p.agent].tool, log, retries: c.stepRetries ?? 1 });
        sessions.set(p.agent, session);
        await session.open();
        if (p.agent === "agent-1") {
          await session.phase(agent1FeaturePrompt(), "feat: quote breakdown in api and website");
          const first = await gate({ taskId: p.taskId, workspaceRoot: session.workspaceRoot, attempt: 1 });
          gates.push(first);
          log(`agent-1: gate attempt 1: ${first.result} (${first.detail})`);
          if (first.result === "fail") {
            await session.phase(agent1FixPrompt(first.detail), "fix(contract): declare quote breakdown");
            const second = await gate({ taskId: p.taskId, workspaceRoot: session.workspaceRoot, attempt: 2 });
            gates.push(second);
            log(`agent-1: gate attempt 2: ${second.result} (${second.detail})`);
          }
          o.gates = gates;
        } else if (p.agent === "agent-2") {
          await session.phase(agent2ClientPrompt(), "feat(website): explain what the quote covers");
          o.note = "client-edition stand-in: a website-only task (no api, no requirements mounted) until Task 21 editions exist";
        } else {
          await session.phase(agent3BrandPrompt(logoTool), "chore(brand): violet brand colour and logo");
          // the same task's R2 asset workspace, with the same lease (lease-only asset upload)
          const ws = p.view.workspaces.find((w) => w.mountName === m.brandAssets);
          if (!ws) throw new Error(`task ${p.taskId} has no ${m.brandAssets} workspace`);
          const bytes = new Uint8Array(await readFile(join(session.mountDir(m.website), "public", "logo.png")));
          if (!isPng(bytes)) throw new Error("website/public/logo.png is not a PNG after the brand step");
          o.asset = await replaceAsset({ ...(c.fetchImpl ? { fetchImpl: c.fetchImpl } : {}), apiUrl: c.apiUrl, lease, taskId: p.taskId, taskWorkspaceId: ws.taskWorkspaceId, mountName: m.brandAssets, path: "logo.png", bytes, mime: "image/png" });
          log(`agent-3: brand-assets/logo.png → manifest ${o.asset.manifestId}`);
        }
        o.status = "done";
      } catch (e) {
        o.status = "failed";
        o.error = e instanceof Error ? e.message : String(e);
        log(`${p.agent}: FAILED: ${o.error}`);
        await c.owner.releaseLease(p.taskId).catch(() => {});
      } finally {
        const s = sessions.get(p.agent);
        if (s) o.phases = s.phases;
      }
    }),
  ]);
  log(`all agents finished in ${Date.now() - t0} ms`);

  // ---- 3. same-file conflicts between agents that submitted the same resource
  const conflicts: ConflictProbe[] = [];
  // in the configured agent order (not lease-completion order), so the probes are deterministic
  const done = c.agents.flatMap((a) => (sessions.has(a) && outcomes.get(a)!.status === "done" ? [[a, sessions.get(a)!] as const] : []));
  for (const mount of [m.website, m.api, m.requirements]) {
    const writers = done.filter(([, s]) => s.phases.some((ph) => ph.submit.candidates.some((cand) => cand.mountName === mount)));
    for (let i = 0; i < writers.length; i++) {
      for (let j = i + 1; j < writers.length; j++) {
        const [a, sa] = writers[i]!;
        const [b, sb] = writers[j]!;
        conflicts.push(await probeTextualConflict(mount, { agent: a, dir: sa.mountDir(mount) }, { agent: b, dir: sb.mountDir(mount) }));
      }
    }
  }

  // ---- 4. evidence from the API's own event log
  const events = (await c.owner.allEvents(c.orgId, startSeq, c.projectId)).events;
  // an edition return is a client upload, not a leased agent task (no task.started): AT-05 covers the leased agents
  const agentTasks: AgentTasks[] = [...outcomes.values()].filter((o) => o.launchedAt && !o.edition).map((o) => ({ agent: o.agent, role: o.role, cli: o.cli, taskIds: o.taskIds, launchedAt: o.launchedAt! }));
  const concurrency = concurrencyEvidence({ mode: c.mode, apiUrl: c.apiUrl, orgId: c.orgId, projectId: c.projectId, agents: agentTasks, events });
  const attempts = outcomes.get("agent-1")?.gates ?? [];
  const report: DemoReport = {
    schema: "commonforge.demo.run/1",
    mode: c.mode,
    label: concurrency.label,
    startedAt,
    finishedAt: new Date().toISOString(),
    apiUrl: c.apiUrl,
    orgId: c.orgId,
    projectId: c.projectId,
    agents: [...outcomes.values()],
    contractSequence: c.agents.includes("agent-1") ? { failedFirst: attempts[0]?.result === "fail", passedAfterFix: attempts[0]?.result === "fail" && attempts[1]?.result === "pass", attempts } : null,
    conflicts,
    concurrency,
    files: { concurrency: join(c.evidenceDir, "concurrency.json"), report: join(c.evidenceDir, "demo-run.json") },
  };
  await mkdir(c.evidenceDir, { recursive: true });
  await writeFile(report.files.concurrency, `${JSON.stringify(concurrency, null, 2)}\n`);
  await writeFile(report.files.report, `${JSON.stringify(report, null, 2)}\n`);
  log(`evidence: ${report.files.concurrency} (allConcurrent=${concurrency.overlap.allConcurrent}, task.started spread ${concurrency.apiStart.spreadMs} ms)`);
  return report;
}

/** A dry run never replaces evidence recorded by a live run (review M-2). */
async function refuseToOverwriteLiveEvidence(c: DemoConfig): Promise<void> {
  if (c.mode !== "dry-run") return;
  let existing: { mode?: string } | null = null;
  try {
    existing = JSON.parse(await readFile(join(c.evidenceDir, "concurrency.json"), "utf8")) as { mode?: string };
  } catch {
    return;
  }
  if (existing?.mode === "live") throw new Error(`refusing to overwrite live evidence in ${c.evidenceDir} with a dry run; pass another --evidence-dir`);
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const isPng = (b: Uint8Array) => PNG_MAGIC.every((x, i) => b[i] === x);

function editionOptions(c: DemoConfig, m: Mounts, log: (l: string) => void) {
  return {
    owner: c.owner,
    ...(c.client ? { client: c.client } : {}),
    orgId: c.orgId,
    projectId: c.projectId,
    mountName: m.website,
    dir: join(c.runDir, "agent-2"),
    title: "Explain what the quote covers",
    request: "Tell the customer what the quoted price covers (client edition: website only).",
    ...(c.readyPollMs ? { pollMs: c.readyPollMs } : {}),
    ...(c.readyTimeoutMs ? { timeoutMs: c.readyTimeoutMs } : {}),
    log,
  };
}

/**
 * Agent 2 through a client edition (Task 21): the agent edits the unpacked edition folder (no
 * git, no lease, no api source); the client sends back the changed files; the server turns the
 * return into a candidate in a fresh task workspace and opens a proposal.
 */
async function runEditionAgent(c: DemoConfig, m: Mounts, prep: EditionPrep, o: AgentOutcome, log: (l: string) => void): Promise<void> {
  o.launchedAt = new Date().toISOString();
  const spec = agent2ClientPrompt();
  const attempts = 1 + (c.stepRetries ?? 1);
  try {
    let run: PhaseRecord["run"] | null = null;
    for (let i = 1; !run; i++) {
      log(`agent-2: ${spec.phase} (client edition) — agent running${i > 1 ? ` (attempt ${i})` : ""}`);
      try {
        run = await c.runners["agent-2"].runner(spec, prep.workspaceRoot);
      } catch (e) {
        if (i >= attempts) throw e;
        log(`agent-2: ${spec.phase} — attempt ${i} failed (${e instanceof Error ? e.message : String(e)}); restoring the working copy and retrying`);
        await resetEditionCopy(prep);
      }
    }
    const ret = await returnClientEdition(editionOptions(c, m, log), prep, c.runners["agent-2"].tool);
    o.edition = { ...o.edition!, returnId: ret.returnId, proposalId: ret.proposalId, changes: ret.changes, blocked: ret.blocked, run };
    if (ret.taskId) o.taskIds.push(ret.taskId);
    o.status = "done";
    o.note = `client edition: returned as proposal ${ret.proposalId}`;
    log(`agent-2: ${o.note}`);
  } catch (e) {
    o.status = "failed";
    o.error = e instanceof Error ? e.message : String(e);
    log(`agent-2: FAILED: ${o.error}`);
  }
}
