/**
 * One agent's task session: `cforge checkout` → agent CLI (one or more phases) → `cforge submit`.
 * Every cforge call runs with the agent's own identity (private config dir + lease token).
 */
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { agentIdentity, cforgeJson, type AgentIdentity, type CforgeRunner } from "./cforge.js";
import type { AgentRun, AgentRunner } from "./agent-cli.js";
import type { PhaseSpec } from "./prompts.js";
import { bareEnv, runProc, tail } from "./proc.js";

/** git that runs no hooks, fsmonitor, signing program or ssh command from a materialized repository. */
async function safeGit(args: string[], cwd: string) {
  const r = await runProc(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "commit.gpgsign=false", "-c", "core.sshCommand=false", ...args],
    { cwd, env: bareEnv({ GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" }), timeoutMs: 120_000 },
  );
  if (r.code !== 0) throw new Error(`git ${args[0]} in ${cwd} failed: ${tail(r.stderr, 400)}`);
  return r.stdout;
}

export interface CheckoutResult {
  taskId: string;
  workspaceRoot: string;
  verified: boolean;
  mounts: Array<{ mountName: string; writable: boolean; kind: string; sha?: string }>;
}

export interface SubmitResult {
  taskId: string;
  candidates: Array<{ mountName: string; candidateId: string; taskWorkspaceId: string; sha: string; changedPaths: string[]; state: string }>;
  skipped: string[];
}

export interface PhaseRecord {
  phase: string;
  run: AgentRun;
  submit: SubmitResult;
  /** files edited outside the phase's writable mounts (left unsubmitted) */
  strayEdits: string[];
}

export class AgentSession {
  identity!: AgentIdentity;
  checkout!: CheckoutResult;
  readonly phases: PhaseRecord[] = [];
  readonly workspaceRoot: string;
  /** top-level entries of the workspace right after checkout */
  #rootEntries = new Set<string>();

  constructor(
    readonly o: {
      agent: string;
      name: string;
      taskId: string;
      leaseToken: string;
      apiUrl: string;
      dir: string;
      cforge: CforgeRunner;
      runner: AgentRunner;
      tool: string;
      log: (line: string) => void;
      /** extra attempts of an agent step after a failure (review M-5; default 1) */
      retries?: number;
    },
  ) {
    this.workspaceRoot = join(o.dir, "ws");
  }

  async open(): Promise<CheckoutResult> {
    await mkdir(this.o.dir, { recursive: true });
    this.identity = await agentIdentity(join(this.o.dir, "home"), this.o.name, this.o.apiUrl, this.o.leaseToken);
    this.checkout = await cforgeJson<CheckoutResult>(this.o.cforge, ["checkout", this.o.taskId, this.workspaceRoot], { cwd: this.o.dir, env: this.identity.env });
    if (!this.checkout.verified) throw new Error(`${this.o.agent}: checkout not verified`);
    this.#rootEntries = new Set(await readdir(this.workspaceRoot));
    this.o.log(`${this.o.agent}: checked out ${this.o.taskId} (${this.checkout.mounts.map((m) => `${m.mountName}${m.writable ? "" : " ro"}`).join(", ")})`);
    return this.checkout;
  }

  /**
   * Run one phase with the agent CLI, then submit exactly the phase's writable mounts. A failed
   * agent step is retried (`retries`, default 1) after resetting the writable mounts to their HEAD.
   */
  async phase(spec: PhaseSpec, commitMessage: string): Promise<PhaseRecord> {
    const attempts = 1 + (this.o.retries ?? 1);
    let run: PhaseRecord["run"] | null = null;
    for (let i = 1; !run; i++) {
      this.o.log(`${this.o.agent}: ${spec.phase} — agent running${i > 1 ? ` (attempt ${i})` : ""}`);
      try {
        run = await this.o.runner(spec, this.workspaceRoot);
      } catch (e) {
        if (i >= attempts) throw e;
        this.o.log(`${this.o.agent}: ${spec.phase} — attempt ${i} failed (${e instanceof Error ? e.message : String(e)}); resetting ${spec.writable.join(", ")} and retrying`);
        for (const m of spec.writable) {
          await safeGit(["reset", "-q", "--hard", "HEAD"], this.mountDir(m));
          await safeGit(["clean", "-q", "-fd"], this.mountDir(m));
        }
      }
    }
    const strayEdits: string[] = [];
    for (const m of this.checkout.mounts) {
      if (m.kind !== "git" || spec.writable.includes(m.mountName)) continue;
      for (const line of (await safeGit(["status", "--porcelain"], this.mountDir(m.mountName))).split("\n").filter(Boolean)) strayEdits.push(`${m.mountName}/${line.slice(3)}`);
    }
    for (const name of await readdir(this.workspaceRoot)) if (!this.#rootEntries.has(name)) strayEdits.push(name);
    if (strayEdits.length) this.o.log(`${this.o.agent}: warning: edits outside ${spec.writable.join(", ")} are not submitted: ${strayEdits.join(", ")}`);
    const submit = await cforgeJson<SubmitResult>(this.o.cforge, ["submit", ...spec.writable.flatMap((m) => ["--mount", m]), "--commit", commitMessage, "--tool", this.o.tool], { cwd: this.workspaceRoot, env: this.identity.env });
    this.o.log(`${this.o.agent}: ${spec.phase} — submitted ${submit.candidates.map((c) => `${c.mountName}@${c.sha.slice(0, 10)}`).join(", ")}`);
    const rec = { phase: spec.phase, run, submit, strayEdits };
    this.phases.push(rec);
    return rec;
  }

  mountDir(mountName: string): string {
    return join(this.workspaceRoot, mountName);
  }
}
