/**
 * AT-05 overlap evidence: `task.started` and `task.candidate_frozen` timestamps *as recorded by the
 * API* (`GET /api/orgs/:org/events`), not local clocks. An agent's active interval is
 * [its first task.started, its last task.candidate_frozen]; the run is concurrent when every
 * interval contains a common instant (max start < min end).
 */
import type { ApiEvent } from "./owner-api.js";

export interface AgentTasks {
  agent: string;
  role: string;
  cli: string;
  taskIds: string[];
  launchedAt: string;
}

export interface TaskTimeline {
  taskId: string;
  startedAt: string | null;
  frozen: Array<{ at: string; subject: string; sha?: string; manifestId?: string }>;
}

export interface AgentTimeline extends AgentTasks {
  tasks: TaskTimeline[];
  startedAt: string | null;
  lastFrozenAt: string | null;
}

export interface ConcurrencyEvidence {
  schema: "commonforge.demo.concurrency/1";
  mode: "live" | "dry-run";
  label: string;
  generatedAt: string;
  apiUrl: string;
  orgId: string;
  projectId: string;
  source: string;
  /** AT-05 start spread from the API's `task.started` records (every task of every agent) */
  apiStart: { firstAt: string | null; lastAt: string | null; spreadMs: number | null; withinTwoSeconds: boolean; tasks: number; source: string };
  /** when the orchestrator launched each agent, by the orchestrator's own clock (diagnostic only) */
  launch: { clock: "orchestrator"; firstAt: string; lastAt: string; spreadMs: number; withinTwoSeconds: boolean };
  agents: AgentTimeline[];
  overlap: {
    allConcurrent: boolean;
    /** the instant range during which every agent was active (null when there is none) */
    commonWindow: { from: string; to: string; ms: number } | null;
    pairs: Array<{ a: string; b: string; overlapMs: number }>;
  };
}

const ms = (iso: string) => Date.parse(iso);

export function timelines(agents: AgentTasks[], events: ApiEvent[]): AgentTimeline[] {
  return agents.map((a) => {
    const tasks: TaskTimeline[] = a.taskIds.map((taskId) => {
      const started = events.filter((e) => e.action === "task.started" && e.subject.id === taskId).map((e) => e.at).sort();
      const frozen = events
        .filter((e) => e.action === "task.candidate_frozen" && e.detail?.taskId === taskId)
        .map((e) => ({
          at: e.at,
          subject: e.subject.id,
          ...(typeof e.detail?.sha === "string" ? { sha: e.detail.sha } : {}),
          ...(typeof e.detail?.manifestId === "string" ? { manifestId: e.detail.manifestId } : {}),
        }))
        .sort((x, y) => ms(x.at) - ms(y.at));
      return { taskId, startedAt: started[0] ?? null, frozen };
    });
    const starts = tasks.map((t) => t.startedAt).filter((x): x is string => !!x).sort();
    const ends = tasks.flatMap((t) => t.frozen.map((f) => f.at)).sort();
    return { ...a, tasks, startedAt: starts[0] ?? null, lastFrozenAt: ends[ends.length - 1] ?? null };
  });
}

export function concurrencyEvidence(o: { mode: "live" | "dry-run"; apiUrl: string; orgId: string; projectId: string; agents: AgentTasks[]; events: ApiEvent[] }): ConcurrencyEvidence {
  const agents = timelines(o.agents, o.events);
  const launches = o.agents.map((a) => ms(a.launchedAt)).sort((x, y) => x - y);
  const spreadMs = launches.length ? launches[launches.length - 1]! - launches[0]! : 0;
  const complete = agents.every((a) => a.startedAt && a.lastFrozenAt);
  const maxStart = Math.max(...agents.map((a) => (a.startedAt ? ms(a.startedAt) : Infinity)));
  const minEnd = Math.min(...agents.map((a) => (a.lastFrozenAt ? ms(a.lastFrozenAt) : -Infinity)));
  const pairs: ConcurrencyEvidence["overlap"]["pairs"] = [];
  for (let i = 0; i < agents.length; i++) {
    for (let j = i + 1; j < agents.length; j++) {
      const a = agents[i]!;
      const b = agents[j]!;
      const overlapMs = a.startedAt && b.startedAt && a.lastFrozenAt && b.lastFrozenAt ? Math.max(0, Math.min(ms(a.lastFrozenAt), ms(b.lastFrozenAt)) - Math.max(ms(a.startedAt), ms(b.startedAt))) : 0;
      pairs.push({ a: a.agent, b: b.agent, overlapMs });
    }
  }
  const taskStarts = agents.flatMap((a) => a.tasks.map((t) => t.startedAt));
  const startMs = taskStarts.filter((x): x is string => !!x).map(ms).sort((x, y) => x - y);
  const allStarted = taskStarts.length > 0 && startMs.length === taskStarts.length;
  const apiSpread = allStarted ? startMs[startMs.length - 1]! - startMs[0]! : null;
  const apiStart: ConcurrencyEvidence["apiStart"] = {
    firstAt: startMs.length ? new Date(startMs[0]!).toISOString() : null,
    lastAt: startMs.length ? new Date(startMs[startMs.length - 1]!).toISOString() : null,
    spreadMs: apiSpread,
    withinTwoSeconds: apiSpread !== null && apiSpread <= 2000,
    tasks: taskStarts.length,
    source: "task.started events",
  };
  const allConcurrent = complete && agents.length > 1 && maxStart < minEnd;
  return {
    schema: "commonforge.demo.concurrency/1",
    mode: o.mode,
    label:
      o.mode === "live"
        ? "LIVE: real agent CLI sessions; timestamps recorded by the CommonForge API"
        : "DRY-RUN: scripted edits replace the agent CLI (deterministic rehearsal / CI); not live throughput evidence",
    generatedAt: new Date().toISOString(),
    apiUrl: o.apiUrl,
    orgId: o.orgId,
    projectId: o.projectId,
    source: "GET /api/orgs/:org/events (task.started, task.candidate_frozen)",
    apiStart,
    launch: { clock: "orchestrator", firstAt: new Date(launches[0] ?? 0).toISOString(), lastAt: new Date(launches[launches.length - 1] ?? 0).toISOString(), spreadMs, withinTwoSeconds: spreadMs <= 2000 },
    agents,
    overlap: { allConcurrent, commonWindow: allConcurrent ? { from: new Date(maxStart).toISOString(), to: new Date(minEnd).toISOString(), ms: minEnd - maxStart } : null, pairs },
  };
}
