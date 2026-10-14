import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliIo } from "../src/context.js";
import { run } from "../src/main.js";
import type { GitRunner } from "../src/git.js";
import { FakeCommonForge } from "./fake-commonforge.js";

export const EMAIL = "dev@example.com";

export interface Harness {
  world: FakeCommonForge;
  home: string;
  configDir: string;
  /** run cforge in-process; returns exit code and captured output */
  cli: (argv: string[], opts?: { cwd?: string; stdin?: string; prompt?: string | null; env?: Record<string, string>; git?: GitRunner; helperCommand?: string[]; mcpInput?: string[] }) => Promise<{ code: number; stdout: string; stderr: string; json: () => any }>;
  env: Record<string, string>;
  tmp: (prefix?: string) => string;
}

export function harness(): Harness {
  const world = new FakeCommonForge();
  const home = mkdtempSync(join(tmpdir(), "cforge-home-"));
  mkdirSync(join(home, ".config"), { recursive: true });
  writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Test Dev\n\temail = dev@example.com\n[init]\n\tdefaultBranch = main\n");
  const configDir = join(home, ".config", "commonforge");
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const h: Harness = {
    world,
    home,
    configDir,
    env,
    tmp: (prefix = "t-") => mkdtempSync(join(home, prefix)),
    async cli(argv, opts = {}) {
      let stdout = "";
      let stderr = "";
      const io: Partial<CliIo> = {
        env: { ...env, CFORGE_API_URL: world.baseUrl, ...(opts.env ?? {}) },
        cwd: opts.cwd ?? home,
        stdout: (t) => void (stdout += t),
        stderr: (t) => void (stderr += t),
        readStdin: async () => opts.stdin ?? "",
        prompt: async () => opts.prompt ?? null,
        fetch: world.fetch,
        sleep: async () => {},
        helperCommand: opts.helperCommand ?? [process.execPath, "/opt/cforge/dist/index.js"],
      };
      const code = await run(argv, io, { ...(opts.git ? { git: opts.git } : {}), ...(opts.mcpInput ? { mcpInput: lines(opts.mcpInput) } : {}) });
      return { code, stdout, stderr, json: () => JSON.parse(stdout) };
    },
  };
  return h;
}

async function* lines(xs: string[]): AsyncIterable<string> {
  for (const x of xs) yield x;
}

/** Log in `EMAIL` through the real code flow. */
export async function loginAs(h: Harness): Promise<void> {
  const r1 = await h.cli(["login", "--email", EMAIL, "--json"]);
  if (r1.code !== 0) throw new Error(r1.stdout + r1.stderr);
  const code = [...h.world.codes.keys()].pop()!;
  const r2 = await h.cli(["login", "--code", code, "--json"]);
  if (r2.code !== 0) throw new Error(r2.stdout + r2.stderr);
}

/** Every file under `dir` (including `.git`) whose bytes contain one of `needles`. */
export function filesContaining(dir: string, needles: readonly string[]): string[] {
  const hits: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        const text = readFileSync(p).toString("latin1");
        if (needles.some((n) => n && text.includes(n))) hits.push(p);
      }
    }
  };
  walk(dir);
  return hits;
}
