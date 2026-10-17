/**
 * `cforge submit` (plan §B.5): push each changed writable mount's commit to its task repository's
 * branch (one ref, fast-forward, busy retry), then freeze it through the API
 * (`POST /api/tasks/:id/workspaces/:ws/freeze {expectedSha}`), which revokes the write tokens and
 * records the candidate. Every push happens before any freeze, so a failed push freezes nothing.
 */
import { join, resolve } from "node:path";
import { stat } from "node:fs/promises";
import { agentClient, normalizeApiUrl, taskClient } from "./api.js";
import { list, parse, str, type CommandContext } from "./command.js";
import { CliError } from "./context.js";
import { commitAll } from "./checkpoint.js";
import { gitOk, pushOneRef, type GitRunner } from "./git.js";
import { checkPinnedNativeContext, fetchNativeContext } from "./native.js";
import { pickWritableMounts, resolveWorkspace } from "./workspace.js";

const USAGE = "cforge submit [--mount <name>]... [--commit <message>] [--tool <name>] [--workspace <dir>] [--json]";

/** The task repository's default branch (`refs/heads/<b>`), as recorded by clone or asked from the remote. */
export async function remoteBranch(git: GitRunner, dir: string): Promise<string> {
  const local = await git(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], dir);
  if (local.code === 0 && local.stdout.trim().startsWith("refs/remotes/origin/")) return `refs/heads/${local.stdout.trim().slice("refs/remotes/origin/".length)}`;
  const out = await gitOk(git, ["ls-remote", "--symref", "--", "origin", "HEAD"], dir);
  const m = /^ref: (refs\/heads\/\S+)\tHEAD$/m.exec(out);
  if (!m) throw new CliError("no_remote_branch", `cannot determine the task repository's branch for ${dir}`);
  return m[1]!;
}

interface Candidate {
  candidateId: string;
  taskWorkspaceId: string;
  resourceId: string;
  sha: string;
  changedPaths: string[];
  state: string;
}

export async function submit(ctx: CommandContext, args: readonly string[]): Promise<void> {
  const p = parse(args, { mount: { type: "string", multiple: true }, commit: { type: "string" }, tool: { type: "string" }, workspace: { type: "string" } }, USAGE);
  const ws = await resolveWorkspace(ctx.store, ctx.io.cwd, { ...(str(p, "workspace") ? { workspace: str(p, "workspace")! } : {}) });
  const explicit = list(p, "mount");
  const mounts = pickWritableMounts(ws, explicit);
  const taskId = ws.record.taskId;

  const nativeStored = await stat(join(ctx.store.dir, "native", `${taskId}.json`)).then(() => true, () => false) || await stat(join(ws.root, ".commonforge", "attempt.json")).then(() => true, () => false);
  const api = nativeStored ? await agentClient(ctx.io, ctx.store, taskId, normalizeApiUrl(ws.record.apiUrl)) : await taskClient(ctx.io, ctx.store, taskId, normalizeApiUrl(ws.record.apiUrl), (l) => ctx.out.warn(l));
  const task = await api.get<{ projectProtocolVersion?: number }>(`/api/tasks/${encodeURIComponent(taskId)}`);
  if (nativeStored && task.projectProtocolVersion !== 1 || task.projectProtocolVersion !== undefined && task.projectProtocolVersion !== 1) throw new CliError("unsupported_version", "unsupported project protocol");
  if (task.projectProtocolVersion === 1) await checkPinnedNativeContext(ws.root, await fetchNativeContext(api, taskId));

  const pushed: Array<{ mountName: string; taskWorkspaceId: string; sha: string; ref: string; committed: boolean }> = [];
  const skipped: string[] = [];
  for (const m of mounts) {
    const dir = resolve(ws.root, m.mountName);
    const committed = str(p, "commit") ? await commitAll(ctx.git, dir, str(p, "commit")!) : false;
    const dirty = await gitOk(ctx.git, ["status", "--porcelain"], dir);
    if (dirty) ctx.out.info(`warning: ${m.mountName} has uncommitted changes; only committed work is submitted (use --commit <message>)`);
    const sha = await gitOk(ctx.git, ["rev-parse", "HEAD"], dir);
    // Without an explicit --mount, unchanged mounts are not frozen.
    if (sha === m.baseSha && explicit.length === 0) {
      skipped.push(m.mountName);
      continue;
    }
    const ref = await remoteBranch(ctx.git, dir);
    const r = await pushOneRef({ git: ctx.git, dir, sha, ref, sleep: ctx.io.sleep });
    if (r.status === "rejected") throw new CliError("push_failed", `push of ${m.mountName} to ${ref} failed (nothing was frozen): ${r.detail}`);
    pushed.push({ mountName: m.mountName, taskWorkspaceId: m.taskWorkspaceId!, sha, ref, committed });
  }
  if (pushed.length === 0) throw new CliError("nothing_to_submit", `no writable mount has commits beyond its base (${skipped.join(", ") || "none"}); commit first or pass --mount`);

  const candidates: Array<Candidate & { mountName: string; ref: string }> = [];
  const summary = () => candidates.map((c) => ({ mountName: c.mountName, candidateId: c.candidateId, taskWorkspaceId: c.taskWorkspaceId, sha: c.sha, changedPaths: c.changedPaths, state: c.state }));
  for (const x of pushed) {
    try {
      const c = await api.post<Candidate>(`/api/tasks/${encodeURIComponent(taskId)}/workspaces/${encodeURIComponent(x.taskWorkspaceId)}/freeze`, {
        expectedSha: x.sha,
        tool: str(p, "tool") ?? "cforge",
      });
      candidates.push({ ...c, mountName: x.mountName, ref: x.ref });
    } catch (e) {
      if (!(e instanceof CliError) || candidates.length === 0) throw e;
      // partial submit: report what is already frozen, so nobody re-submits it blindly
      const frozen = summary();
      throw new CliError(e.code, `${e.message} — freezing ${x.mountName} failed after ${frozen.map((c) => `${c.mountName} (${c.candidateId})`).join(", ")} ${frozen.length === 1 ? "was" : "were"} frozen`, {
        ...(e.details ?? {}),
        failedMount: x.mountName,
        frozen,
        notAttempted: pushed.slice(pushed.indexOf(x) + 1).map((y) => y.mountName),
      }, e.exitCode);
    }
  }
  ctx.out.result({ taskId, candidates: summary(), skipped }, () =>
    [
      ...candidates.map((c) => `${c.mountName}: submitted ${c.sha.slice(0, 12)} → candidate ${c.candidateId} (${c.changedPaths.length} changed path(s), ${c.state})`),
      ...(skipped.length ? [`unchanged, not submitted: ${skipped.join(", ")}`] : []),
    ].join("\n"),
  );
}
