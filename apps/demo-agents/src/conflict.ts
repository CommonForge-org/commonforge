/**
 * Same-file textual conflict probe (AT-07): merge two agents' submitted commits of the same
 * resource with `git merge-tree --write-tree` in a scratch repository. Both commits descend from
 * the task snapshot's base, so git finds the merge base itself. Reads the agents' local mounts
 * (their submitted HEAD); needs no credential and writes nothing to them.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bareEnv, runProc, tail } from "./proc.js";

export interface ConflictProbe {
  mountName: string;
  left: { agent: string; sha: string };
  right: { agent: string; sha: string };
  result: "clean" | "textual-conflict";
  conflictPaths: string[];
}

const GIT = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "protocol.file.allow=always"];

async function git(args: string[], cwd: string) {
  return runProc("git", [...GIT, ...args], { cwd, env: bareEnv({ GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" }), timeoutMs: 120_000 });
}

async function gitOk(args: string[], cwd: string): Promise<string> {
  const r = await git(args, cwd);
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${tail(r.stderr, 500)}`);
  return r.stdout.trim();
}

export async function probeTextualConflict(mountName: string, left: { agent: string; dir: string }, right: { agent: string; dir: string }): Promise<ConflictProbe> {
  const scratch = await mkdtemp(join(tmpdir(), "cf-merge-probe-"));
  try {
    await gitOk(["init", "-q", "--bare", "probe.git"], scratch);
    const repo = join(scratch, "probe.git");
    await gitOk(["fetch", "-q", "--no-tags", left.dir, "+HEAD:refs/heads/left"], repo);
    await gitOk(["fetch", "-q", "--no-tags", right.dir, "+HEAD:refs/heads/right"], repo);
    const leftSha = await gitOk(["rev-parse", "refs/heads/left"], repo);
    const rightSha = await gitOk(["rev-parse", "refs/heads/right"], repo);
    // exit 0 = clean, 1 = conflicts; stdout: tree id, then one conflicted path per line
    const r = await git(["merge-tree", "--write-tree", "--name-only", "--no-messages", "refs/heads/left", "refs/heads/right"], repo);
    if (r.code !== 0 && r.code !== 1) throw new Error(`git merge-tree failed: ${tail(r.stderr, 500)}`);
    const conflictPaths = r.code === 1 ? [...new Set(r.stdout.trim().split("\n").slice(1).filter(Boolean))].sort() : [];
    return { mountName, left: { agent: left.agent, sha: leftSha }, right: { agent: right.agent, sha: rightSha }, result: r.code === 1 ? "textual-conflict" : "clean", conflictPaths };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
