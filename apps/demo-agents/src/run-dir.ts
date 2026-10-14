/**
 * The run dir holds agent homes and workspaces; agent CLIs run inside it. It must not be inside the
 * repository checkout (or any git work tree): claude would pick up parent CLAUDE.md/.claude context
 * and codex could read repo files such as apps/worker/.dev.vars (review M-1).
 */
import { existsSync, realpathSync } from "node:fs";
import { dirname, relative, resolve, isAbsolute } from "node:path";
import { bareEnv, runProc } from "./proc.js";

const inside = (child: string, parent: string) => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

export async function assertRunDirOutsideCheckout(runDir: string, repoRoot: string): Promise<void> {
  let probe = resolve(runDir);
  while (!existsSync(probe)) probe = dirname(probe);
  const real = realpathSync(probe);
  if (inside(real, realpathSync(repoRoot)) || inside(resolve(runDir), resolve(repoRoot))) throw new Error(`--run-dir ${runDir} is inside the repository checkout ${repoRoot}; use a directory outside it (default: under $TMPDIR)`);
  const r = await runProc("git", ["rev-parse", "--show-toplevel"], { cwd: real, env: bareEnv({ GIT_CONFIG_NOSYSTEM: "1" }) });
  if (r.code === 0) throw new Error(`--run-dir ${runDir} is inside the git work tree ${r.stdout.trim()}; use a directory outside any repository (default: under $TMPDIR)`);
}
