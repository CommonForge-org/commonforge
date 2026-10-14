/**
 * Locating a checked-out workspace from the current directory and picking the mounts a command
 * acts on. The authority for "which task / which remotes" is the checkout record in the user
 * config dir (written by `cforge checkout`), cross-checked against `.commonforge/workspace.json`.
 */
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { WORKSPACE_JSON_PATH } from "@commonforge-org/runner-protocol";
import { CliError } from "./context.js";
import type { CheckoutRecord, ConfigStore } from "./config.js";

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Walk up from `start` to the directory holding `.commonforge/workspace.json`. */
export async function findWorkspaceRoot(start: string): Promise<string | null> {
  let cur = resolve(start);
  for (;;) {
    if (await exists(join(cur, WORKSPACE_JSON_PATH))) return realpath(cur);
    const up = dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
}

export interface WorkspaceDoc {
  snapshotId: string;
  projectId: string;
  organizationId: string;
  mounts: Array<{ mountName: string; resourceId: string; writable: boolean; taskWorkspaceId?: string; source: { kind: string; remoteUrl?: string; sha?: string } }>;
}

export async function readWorkspaceDoc(root: string): Promise<WorkspaceDoc> {
  return JSON.parse(await readFile(join(root, WORKSPACE_JSON_PATH), "utf8")) as WorkspaceDoc;
}

export interface ResolvedWorkspace {
  root: string;
  record: CheckoutRecord;
  recordPath: string;
  doc: WorkspaceDoc;
  /** the mount the cwd is inside, if any */
  cwdMount: string | null;
}

/** The checkout containing `cwd` (or `--workspace`), with its task record. */
export async function resolveWorkspace(store: ConfigStore, cwd: string, opts: { workspace?: string; task?: string } = {}): Promise<ResolvedWorkspace> {
  const root = await findWorkspaceRoot(opts.workspace ?? cwd);
  if (!root) throw new CliError("not_in_workspace", "not inside a cforge workspace (no .commonforge/workspace.json); use --workspace or run `cforge checkout`");
  const matches: Array<{ path: string; record: CheckoutRecord }> = [];
  for (const r of await store.checkouts(opts.task)) {
    let real: string;
    try {
      real = await realpath(r.record.workspaceRoot);
    } catch {
      continue;
    }
    if (real === root) matches.push(r);
  }
  if (matches.length === 0) throw new CliError("unknown_workspace", `${root} was not checked out by this cforge user (no checkout record)`);
  // one record per (task, root); should two tasks claim the same root, the newest checkout wins
  const { record, path: recordPath } = matches.sort((a, b) => (a.record.createdAt < b.record.createdAt ? 1 : -1))[0]!;
  const doc = await readWorkspaceDoc(root);
  const rel = relative(root, await realpath(resolve(cwd)).catch(() => resolve(cwd)));
  const first = rel && !rel.startsWith("..") ? rel.split(sep)[0]! : "";
  const cwdMount = record.mounts.some((m) => m.mountName === first) ? first : null;
  return { root, record, recordPath, doc, cwdMount };
}

/** Writable git mounts to act on: `--mount` names, else the cwd's mount, else all writable ones. */
export function pickWritableMounts(ws: ResolvedWorkspace, names: readonly string[]): CheckoutRecord["mounts"] {
  const writable = ws.record.mounts.filter((m) => m.writable && m.taskWorkspaceId);
  if (names.length > 0) {
    return names.map((n) => {
      const m = writable.find((x) => x.mountName === n);
      if (!m) throw new CliError("invalid_mount", `${n} is not a writable mount of this workspace (writable: ${writable.map((x) => x.mountName).join(", ") || "none"})`);
      return m;
    });
  }
  if (ws.cwdMount) {
    const m = writable.find((x) => x.mountName === ws.cwdMount);
    if (!m) throw new CliError("invalid_mount", `${ws.cwdMount} is a read-only mount`);
    return [m];
  }
  return writable;
}
