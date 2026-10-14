/**
 * `cforge status [taskId]`: the task as the server sees it (`GET /api/tasks/:id`: state, lease,
 * workspaces, candidates) plus, when run inside a checkout, each mount's local HEAD and changes.
 */
import { resolve } from "node:path";
import { normalizeApiUrl, resolveApiUrl, taskClient } from "./api.js";
import { parse, str, type CommandContext } from "./command.js";
import { CliError } from "./context.js";
import { SAFE_GIT } from "./git.js";
import { resolveWorkspace, type ResolvedWorkspace } from "./workspace.js";

const USAGE = "cforge status [taskId] [--workspace <dir>] [--json]";

interface TaskView {
  taskId: string;
  projectId: string;
  title: string;
  state: string;
  lease: { generation: number; expiresAt: string; holder: string } | null;
  workspaces: Array<{ taskWorkspaceId: string; mountName: string; access: string; state: string; provider: string }>;
  candidates: Array<{ candidateId: string; resourceId: string; taskWorkspaceId: string; state: string; sha?: string; changedPaths: string[]; preparedReceiptId: string | null }>;
}

export async function status(ctx: CommandContext, args: readonly string[]): Promise<void> {
  const p = parse(args, { workspace: { type: "string" } }, USAGE);
  let ws: ResolvedWorkspace | null = null;
  let taskId = p.positionals[0];
  if (!taskId || str(p, "workspace")) {
    try {
      ws = await resolveWorkspace(ctx.store, ctx.io.cwd, { ...(str(p, "workspace") ? { workspace: str(p, "workspace")! } : {}), ...(taskId ? { task: taskId } : {}) });
      taskId = ws.record.taskId;
    } catch (e) {
      if (!taskId) throw e;
    }
  }
  if (!taskId) throw new CliError("invalid_arguments", `missing taskId\nusage: ${USAGE}`, undefined, 2);
  const apiUrl = ws ? normalizeApiUrl(ws.record.apiUrl) : await resolveApiUrl(ctx.io, ctx.store, ctx.global.apiUrl);
  const api = await taskClient(ctx.io, ctx.store, taskId, apiUrl, (l) => ctx.out.warn(l));
  const task = await api.get<TaskView>(`/api/tasks/${encodeURIComponent(taskId)}`);
  const lease = await ctx.store.lease(taskId);

  const local = ws
    ? await Promise.all(
        ws.record.mounts.map(async (m) => {
          const dir = resolve(ws!.root, m.mountName);
          const head = (await ctx.git([...SAFE_GIT, "rev-parse", "HEAD"], dir)).stdout.trim();
          const changes = (await ctx.git([...SAFE_GIT, "status", "--porcelain"], dir)).stdout.split("\n").filter(Boolean).length;
          return { mountName: m.mountName, writable: m.writable, baseSha: m.baseSha, head, committedSinceBase: head !== m.baseSha, uncommittedChanges: changes };
        }),
      )
    : null;

  const value = {
    task: { taskId: task.taskId, projectId: task.projectId, title: task.title, state: task.state, lease: task.lease, workspaces: task.workspaces, candidates: task.candidates },
    localLease: lease ? { leaseGeneration: lease.leaseGeneration, expiresAt: lease.expiresAt } : ctx.io.env.CFORGE_LEASE_TOKEN ? { source: "env" } : null,
    workspace: ws ? { root: ws.root, mounts: local } : null,
  };
  ctx.out.result(value, () =>
    [
      `${task.taskId}  ${task.state}  ${task.title}`,
      `  lease: ${task.lease ? `generation ${task.lease.generation}, expires ${task.lease.expiresAt}` : "none"}`,
      ...task.workspaces.map((w) => `  workspace ${w.mountName.padEnd(18)} ${w.access.padEnd(5)} ${w.state}`),
      ...task.candidates.map((c) => `  candidate ${c.candidateId} ${c.state} ${c.sha?.slice(0, 12) ?? ""} (${c.changedPaths.length} path(s))`),
      ...(local
        ? [`  local checkout ${ws!.root}:`, ...local.map((m) => `    ${m.mountName.padEnd(18)} ${m.writable ? "rw" : "ro"} ${m.head.slice(0, 12)}${m.committedSinceBase ? " (committed since base)" : ""}${m.uncommittedChanges ? `, ${m.uncommittedChanges} uncommitted` : ""}`)]
        : []),
    ].join("\n"),
  );
}
