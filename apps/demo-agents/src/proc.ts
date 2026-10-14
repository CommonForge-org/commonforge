/** Child-process plumbing shared by the cforge runner, the agent CLIs, git probes and the contract check. */
import { spawn } from "node:child_process";

export interface ProcResult {
  code: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface ProcOptions {
  cwd: string;
  /** the complete environment of the child: nothing is inherited implicitly */
  env: Record<string, string>;
  input?: string | Uint8Array;
  timeoutMs?: number;
}

/** Run `file args…` with exactly `env`; never throws for a non-zero exit. */
export function runProc(file: string, args: readonly string[], opts: ProcOptions): Promise<ProcResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(file, [...args], { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
        }, opts.timeoutMs)
      : null;
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.on("error", (e) => err.push(Buffer.from(String(e))));
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), durationMs: Date.now() - started, timedOut });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(opts.input ?? "");
  });
}

/** PATH-only environment for helper processes (git, node) that need no credentials at all. */
export function bareEnv(extra: Record<string, string> = {}): Record<string, string> {
  return { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8", ...extra };
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Last `n` characters, for logs and error details. */
export const tail = (text: string, n = 2000) => (text.length > n ? `…${text.slice(-n)}` : text);
