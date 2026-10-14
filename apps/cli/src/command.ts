/** Shared command plumbing: argument parsing (node:util parseArgs) and the per-run context. */
import { parseArgs, type ParseArgsConfig } from "node:util";
import { CliError, type CliIo, type GlobalOptions, type Output } from "./context.js";
import type { ConfigStore } from "./config.js";
import type { GitRunner } from "./git.js";

export interface CommandContext {
  io: CliIo;
  out: Output;
  store: ConfigStore;
  git: GitRunner;
  global: GlobalOptions;
}

export type Options = NonNullable<ParseArgsConfig["options"]>;

export const GLOBAL_OPTIONS = {
  json: { type: "boolean" },
  "api-url": { type: "string" },
  org: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const satisfies Options;

export interface Parsed {
  values: Record<string, string | boolean | string[] | undefined>;
  positionals: string[];
}

export function parse(args: readonly string[], options: Options, usage: string): Parsed {
  try {
    const r = parseArgs({ args: [...args], options: { ...GLOBAL_OPTIONS, ...options }, allowPositionals: true, strict: true });
    if (r.values.help === true) throw new CliError("help", `usage: ${usage}`, undefined, 0);
    return { values: r.values as Parsed["values"], positionals: r.positionals };
  } catch (e) {
    if (e instanceof CliError) throw e;
    throw new CliError("invalid_arguments", `${(e as Error).message}\nusage: ${usage}`, undefined, 2);
  }
}

export function str(p: Parsed, name: string): string | undefined {
  const v = p.values[name];
  return typeof v === "string" ? v : undefined;
}

export function list(p: Parsed, name: string): string[] {
  const v = p.values[name];
  return Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
}

export function int(p: Parsed, name: string): number | undefined {
  const v = str(p, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new CliError("invalid_arguments", `--${name} must be a non-negative integer`, undefined, 2);
  return n;
}

export function positional(p: Parsed, index: number, what: string, usage: string): string {
  const v = p.positionals[index];
  if (!v) throw new CliError("invalid_arguments", `missing ${what}\nusage: ${usage}`, undefined, 2);
  return v;
}

/** `--org`, `CFORGE_ORG`, the configured default, or the caller's only membership. */
export async function resolveOrg(ctx: CommandContext, memberships: () => Promise<Array<{ orgId: string; name: string }>>): Promise<string> {
  const explicit = ctx.global.org ?? ctx.io.env.CFORGE_ORG ?? (await ctx.store.config()).org;
  if (explicit) return explicit;
  const ms = await memberships();
  if (ms.length === 1) return ms[0]!.orgId;
  if (ms.length === 0) throw new CliError("no_org", "you are not a member of any organization");
  throw new CliError("org_required", `several organizations (${ms.map((m) => `${m.orgId} ${m.name}`).join(", ")}); pass --org`);
}
