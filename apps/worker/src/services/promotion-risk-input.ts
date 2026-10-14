/**
 * The risk classifier's input for a promotion (staging phase 3, plan ruling P3-6): what the gate
 * already knows, turned into core's `RiskInputParts` (`riskState` makes the text and applies the caps).
 *
 * - Tasks: the title and request of every part's task of every landing in the set.
 * - Paths: every changed path with its level (`perPath` from the gate, so never a path outside the set).
 * - Files: each changed path under a `classify` or `self` rule (and under no `developer` name), read at
 *   the `main` head and at the promotion's integration result, under its `classify` name when it has
 *   one. An LFS pointer or bytes that are not UTF-8 text (a NUL byte included) are `binary`; a read
 *   that fails, a path absent on both sides, or a file over 1 MiB on either side is `unread` (never a
 *   throw, never skipped). A `.sql` file the migration veto lints is marked `migration`. A file whose
 *   two sides are identical adds nothing (`riskState` skips it) and is not kept.
 * - Complete view or nothing (P3-11): the classifier may clear only when it saw the whole change.
 *   Reads stop at the first thing that makes the input incomplete (more than 200 such files: nothing
 *   is read; a file not read; a file over 1 MiB; more than 4 MiB read in all; a binary file at a
 *   `classify` name that is not an allow-listed asset; a text diff cut by the caps or the diff cap
 *   filled), and every file after it is listed as not read. `riskState` and the Worker's own reasons
 *   (`incomplete`) then keep the classifier from being asked. The provider reports no blob size, so
 *   the 1 MiB cap applies after a read: one file at a time is held whole, and at most 400 reads happen.
 * - Checks: the integration receipt's checks and contract checks (`checkId: result`).
 *
 * Everything here is untrusted content for the classifier's `state`; nothing is an instruction.
 */
import {
  artRevisionId,
  isBinaryAsset,
  RISK_DIFF_MAX_BYTES,
  RISK_FILE_MAX_BYTES,
  unifiedDiff,
  type FrozenCandidate,
  type PromotionLevel,
  type RiskIncompleteReason,
  type RiskInputParts,
  type ValidationEvidence,
} from "@commonforge-org/core";
import { LFS_POINTER_MAX_BYTES, parseLfsPointer } from "@commonforge-org/runner-protocol";
import type { Services } from "../context.js";
import { getResource, resourceCoords, type ProjectRow } from "./directory.js";
import { isMigrationFile, migrationFolders } from "./promotion-gate.js";
import type { ReleasePolicy } from "./release-policy.js";
import { resourceRef } from "./resources.js";
import { landingParts, type LandingRow } from "./staging.js";
import type { StagingPolicy } from "./staging-policy.js";

export interface RiskInputArgs {
  project: ProjectRow;
  staging: StagingPolicy;
  release: ReleasePolicy;
  /** the promotion's landings, in set order */
  landingIds: string[];
  candidates: FrozenCandidate[];
  /** the gate's per-path levels (`<mountName>/<path>`) */
  perPath: Array<{ path: string; level: PromotionLevel }>;
  resourceByMount: Map<string, string>;
  heads: Map<string, string>;
  results: Map<string, string>;
  /** the integration receipt's evidence */
  evidence: Pick<ValidationEvidence, "checks" | "contractChecks">;
}

const encoder = new TextEncoder();
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** Below this much diff room `riskState` omits a file anyway (a header and the truncation mark). */
const MIN_ROOM = 256;
/** At most this many changed `classify`/`self` files are read (each at both sides); more: nothing is read. */
export const RISK_MAX_FILES = 200;
/** A side over this many bytes is not kept (too large: the input is incomplete). */
export const RISK_READ_FILE_MAX_BYTES = 1024 * 1024;
/** At most this many bytes are read in all. */
export const RISK_READ_TOTAL_MAX_BYTES = 4 * 1024 * 1024;

type Read = { kind: "absent" } | { kind: "text"; text: string; bytes: number } | { kind: "binary"; bytes: number } | { kind: "too_large" } | { kind: "unread" };

/**
 * `notRead`: changed files listed as not read because reading stopped (counted in the evidence's
 * `omittedFiles`); `incomplete`: the Worker's reasons the input is not the complete change (its read
 * caps; `riskState` finds the others from `parts`).
 */
export async function buildRiskInput(svc: Services, a: RiskInputArgs): Promise<{ parts: RiskInputParts; notRead: number; incomplete: RiskIncompleteReason[] }> {
  const tasks = await taskTexts(svc, a.landingIds);
  const paths = a.perPath.map((p) => ({ path: p.path, level: p.level }));
  const checks = [
    ...a.evidence.checks.map((c) => ({ checkId: c.checkId as string, result: c.result as string })),
    ...a.evidence.contractChecks.map((c) => ({ checkId: `contract:${c.contractId as string}`, result: c.result as string })),
  ];

  // a path is read only when every mount name it appears under is classify or self
  const developer = new Set(a.perPath.filter((p) => p.level === "developer").map((p) => p.path));
  const allowed = new Set(a.perPath.filter((p) => (p.level === "classify" || p.level === "self") && !developer.has(p.path)).map((p) => p.path));
  const classifyNames = new Set(a.perPath.filter((p) => p.level === "classify").map((p) => p.path));
  const folders = migrationFolders(a);
  const wanted: Array<{ name: string; resourceId: string; path: string; migration: boolean }> = [];
  const seen = new Set<string>();
  for (const c of a.candidates) {
    const rid = c.resourceId as string;
    const mounts = [...a.resourceByMount].filter(([, r]) => r === rid).map(([m]) => m).sort(byCodeUnit);
    for (const path of c.changedPaths as string[]) {
      // one entry per (resource, path), under its first classify name, else its first allowed name
      const names = mounts.map((m) => `${m}/${path}`).filter((n) => allowed.has(n));
      const name = names.find((n) => classifyNames.has(n)) ?? names[0];
      const key = `${rid}\u0000${path}`;
      if (!name || seen.has(key)) continue;
      seen.add(key);
      wanted.push({ name, resourceId: rid, path, migration: isMigrationFile(folders, rid, path) });
    }
  }
  wanted.sort((x, y) => byCodeUnit(x.name, y.name));

  const files: RiskInputParts["files"] = [];
  const incomplete = new Set<RiskIncompleteReason>();
  let stopped = false;
  if (wanted.length > RISK_MAX_FILES) {
    incomplete.add("too_many_files");
    stopped = true;
  }
  let used = 0;
  let readBytes = 0;
  let notRead = 0;
  const unread = (w: (typeof wanted)[number]) => files.push({ path: w.name, before: null, after: null, kind: "unread", migration: w.migration });
  for (const w of wanted) {
    if (stopped || (!w.migration && RISK_DIFF_MAX_BYTES - used < MIN_ROOM)) {
      // the input is already incomplete: the rest is listed, not read
      stopped = true;
      notRead++;
      unread(w);
      continue;
    }
    const head = a.heads.get(w.resourceId);
    const result = a.results.get(w.resourceId);
    const before = head ? await readText(svc, a.project.org_id, w.resourceId, head, w.path) : ({ kind: "unread" } as Read);
    const after = result ? await readText(svc, a.project.org_id, w.resourceId, result, w.path) : ({ kind: "unread" } as Read);
    if (before.kind === "too_large" || after.kind === "too_large") incomplete.add("file_too_large");
    readBytes += ("bytes" in before ? before.bytes : 0) + ("bytes" in after ? after.bytes : 0);
    if (readBytes > RISK_READ_TOTAL_MAX_BYTES) incomplete.add("read_limit");
    // not read, too large, past the read budget, or absent on both sides: listed as not read
    const lost = before.kind === "unread" || after.kind === "unread" || before.kind === "too_large" || after.kind === "too_large" || (before.kind === "absent" && after.kind === "absent");
    if (lost || readBytes > RISK_READ_TOTAL_MAX_BYTES) {
      stopped = true;
      unread(w);
      continue;
    }
    if (before.kind === "binary" || after.kind === "binary") {
      files.push({ path: w.name, before: null, after: null, kind: "binary", migration: w.migration });
      if (classifyNames.has(w.name) && !isBinaryAsset(w.name)) stopped = true;
      continue;
    }
    const b = before.kind === "text" ? before.text : null;
    const t = after.kind === "text" ? after.text : null;
    // identical sides add nothing to the state
    if (b === t) continue;
    files.push({ path: w.name, before: b, after: t, kind: "text", migration: w.migration });
    if (!w.migration) {
      // the same bound riskState applies: a cut (or a size line) makes the input incomplete
      const d = unifiedDiff(w.name, b, t, { maxBytes: Math.min(RISK_FILE_MAX_BYTES, RISK_DIFF_MAX_BYTES - used) });
      used += encoder.encode(d.text).length;
      if (d.truncated || /^\(file too large to diff:/m.test(d.text)) stopped = true;
    }
  }
  const order: RiskIncompleteReason[] = ["too_many_files", "file_too_large", "read_limit"];
  return { parts: { tasks, paths, files, checks }, notRead, incomplete: order.filter((r) => incomplete.has(r)) };
}

/** Title and request of every part's task of every landing, deduped by task id. */
async function taskTexts(svc: Services, landingIds: string[]): Promise<RiskInputParts["tasks"]> {
  const out: RiskInputParts["tasks"] = [];
  const seen = new Set<string>();
  for (const id of landingIds) {
    const l = await svc.db.prepare("SELECT landing_id, task_id, proposal_id FROM staging_landings WHERE landing_id = ?").bind(id).first<Pick<LandingRow, "landing_id" | "task_id" | "proposal_id">>();
    if (!l) continue;
    for (const part of await landingParts(svc, l)) {
      if (seen.has(part.taskId)) continue;
      seen.add(part.taskId);
      const t = await svc.db.prepare("SELECT title, request FROM tasks WHERE task_id = ?").bind(part.taskId).first<{ title: string; request: string }>();
      if (t) out.push({ title: t.title, request: t.request });
    }
  }
  return out;
}

/** One file at `sha`: absent, text, binary (an LFS pointer, NUL bytes or not UTF-8), too large (over 1 MiB) or unread (any error). */
async function readText(svc: Services, orgId: string, resourceId: string, sha: string, path: string): Promise<Read> {
  try {
    const r = await getResource(svc.db, orgId, resourceId);
    const coords = r ? resourceCoords(r) : null;
    if (!r || !coords || coords.kind !== "artifacts") return { kind: "unread" };
    const bytes = await svc.provider().readFile(resourceRef(r), artRevisionId(coords.repoId, sha), path);
    if (!bytes) return { kind: "absent" };
    if (bytes.byteLength > RISK_READ_FILE_MAX_BYTES) return { kind: "too_large" };
    const n = bytes.byteLength;
    if (n <= LFS_POINTER_MAX_BYTES && parseLfsPointer(new TextDecoder().decode(bytes))) return { kind: "binary", bytes: n };
    if (bytes.includes(0)) return { kind: "binary", bytes: n };
    try {
      return { kind: "text", text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes), bytes: n };
    } catch {
      return { kind: "binary", bytes: n };
    }
  } catch (e) {
    console.warn(`classifier input: ${path} not read at ${sha}: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`);
    return { kind: "unread" };
  }
}
