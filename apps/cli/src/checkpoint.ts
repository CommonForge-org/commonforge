/**
 * `cforge checkpoint` (plan §A.8 durability ladder, §B.5): push the current commit of each
 * writable mount to `refs/commonforge/checkpoints/<n>` on its task repository. One ref per push,
 * never `--atomic`; the new ref must not exist yet (lease), and a busy repository is retried.
 * A checkpoint is recoverable from any machine but is not a candidate: nothing is frozen.
 */
import { resolve } from "node:path";
import { CHECKPOINT_REF_PREFIX } from "@commonforge-org/runner-protocol";
import { list, parse, str, type CommandContext } from "./command.js";
import { CliError } from "./context.js";
import { SAFE_GIT, gitOk, pushOneRef, type GitRunner } from "./git.js";
import { pickWritableMounts, resolveWorkspace } from "./workspace.js";

const USAGE = "cforge checkpoint [--mount <name>]... [--commit <message>] [--workspace <dir>] [--json]";

const FALLBACK_IDENTITY = ["-c", "user.name=cforge agent", "-c", "user.email=agent@commonforge.invalid"];

/** `git add -A && git commit -m <message>` when the tree has changes; returns whether it committed. */
export async function commitAll(git: GitRunner, dir: string, message: string): Promise<boolean> {
  const status = await gitOk(git, ["status", "--porcelain"], dir);
  if (!status) return false;
  await gitOk(git, ["add", "-A"], dir);
  const hasIdentity = (await git([...SAFE_GIT, "config", "user.email"], dir)).stdout.trim() !== "";
  await gitOk(git, [...(hasIdentity ? [] : FALLBACK_IDENTITY), "commit", "--quiet", "--no-verify", "-m", message], dir);
  return true;
}

/** Existing checkpoint numbers → sha, from the remote. */
export async function remoteCheckpoints(git: GitRunner, dir: string): Promise<Map<number, string>> {
  const out = await gitOk(git, ["ls-remote", "--", "origin", `${CHECKPOINT_REF_PREFIX}*`], dir);
  const m = new Map<number, string>();
  for (const line of out.split("\n")) {
    const [sha, ref] = line.split("\t");
    if (!sha || !ref?.startsWith(CHECKPOINT_REF_PREFIX)) continue;
    const n = Number(ref.slice(CHECKPOINT_REF_PREFIX.length));
    if (Number.isInteger(n) && n > 0) m.set(n, sha);
  }
  return m;
}

export interface CheckpointResult {
  mountName: string;
  ref: string;
  sha: string;
  status: "pushed" | "already";
  committed: boolean;
}

export async function checkpointMount(ctx: CommandContext, dir: string, mountName: string, commitMessage?: string): Promise<CheckpointResult> {
  const committed = commitMessage ? await commitAll(ctx.git, dir, commitMessage) : false;
  const sha = await gitOk(ctx.git, ["rev-parse", "HEAD"], dir);
  for (let race = 0; race < 5; race++) {
    const existing = await remoteCheckpoints(ctx.git, dir);
    for (const [n, s] of [...existing].sort((a, b) => b[0] - a[0])) {
      if (s === sha) return { mountName, ref: `${CHECKPOINT_REF_PREFIX}${n}`, sha, status: "already", committed };
    }
    const n = Math.max(0, ...existing.keys()) + 1;
    const ref = `${CHECKPOINT_REF_PREFIX}${n}`;
    const r = await pushOneRef({ git: ctx.git, dir, sha, ref, expected: null, sleep: ctx.io.sleep });
    if (r.status !== "rejected") return { mountName, ref, sha, status: r.status === "already" ? "already" : "pushed", committed };
    // someone else took checkpoint <n> meanwhile: take the next number
    if (r.observed && r.observed !== sha) continue;
    throw new CliError("push_failed", `checkpoint push of ${mountName} failed: ${r.detail}`);
  }
  throw new CliError("push_failed", `checkpoint push of ${mountName} kept racing other pushes`);
}

export async function checkpoint(ctx: CommandContext, args: readonly string[]): Promise<void> {
  const p = parse(args, { mount: { type: "string", multiple: true }, commit: { type: "string" }, workspace: { type: "string" } }, USAGE);
  const ws = await resolveWorkspace(ctx.store, ctx.io.cwd, { ...(str(p, "workspace") ? { workspace: str(p, "workspace")! } : {}) });
  const mounts = pickWritableMounts(ws, list(p, "mount"));
  if (mounts.length === 0) throw new CliError("nothing_to_checkpoint", "this workspace has no writable mounts");
  const results: CheckpointResult[] = [];
  for (const m of mounts) results.push(await checkpointMount(ctx, resolve(ws.root, m.mountName), m.mountName, str(p, "commit")));
  ctx.out.result({ taskId: ws.record.taskId, checkpoints: results }, () =>
    results.map((r) => `${r.mountName}: ${r.status === "pushed" ? "checkpointed" : "already checkpointed"} ${r.sha.slice(0, 12)} at ${r.ref}`).join("\n"),
  );
}
