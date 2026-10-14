/**
 * The promotion gate (staging phase 2, spec §7): which review a promotion needs.
 *
 * - Path levels: every candidate's changed paths as `<mountName>/<path>` against the staging
 *   promotion rules (first matching rule wins; unmatched paths need a developer).
 * - Migration veto: every staging `environment[t].d1[].migrationsDir` and every
 *   `release.migrations[].dir` (the folders that actually run on staging and production), resolved
 *   to the target's mount. For each folder a candidate touched, the `.sql` files directly in it are
 *   read at the `main` head and at the promotion's integration result and linted: only provably
 *   additive SQL passes; anything else (an edited or removed migration, an unreadable or oversized
 *   folder, bytes that are not UTF-8) is destructive.
 * - Risk classifier (staging phase 3): a `classify` path level (after the veto passed, with no
 *   `developer` path) calls the caller's `classify` callback once. Evidence clears only when it
 *   validates, has no error, saw a complete input (P3-11), names the policy's provider and threshold,
 *   and its answers clear again at the policy's threshold (`riskClears`); it keeps the level
 *   `classify` with `reasonCode: "classifier"`. Declined evidence is `classifier_declined`; no
 *   callback, a `not_configured` or failed answer (also `input_incomplete`, `input_too_large`),
 *   invalid evidence, evidence for another provider or threshold, or a throw is
 *   `classifier_unavailable` (never `gate_error`: the classifier is asked once per gating).
 * - A clearance carried from an earlier build (P3-4): a `developer` one covers `classify` without
 *   asking (`reasonCode: "carried"`); a `classifier` one does too while its evidence still clears under
 *   the policy (`reasonCode: "classifier"`, `classifier.reason: "carried"`, the evidence kept);
 *   otherwise the classifier is asked again.
 *
 * It fails closed: a destructive veto, an unanswered classifier and any error all mean `developer`.
 */
import { artRevisionId, lintMigrations, promotionLevel, riskClears, RiskEvidenceSchema, type FrozenCandidate, type PromotionLevel, type RiskQuestionId } from "@commonforge-org/core";
import type { Services } from "../context.js";
import type { ClassifierEvidence } from "./classifier.js";
import { getResource, resourceCoords, type ProjectRow } from "./directory.js";
import type { ReleasePolicy } from "./release-policy.js";
import { resourceRef } from "./resources.js";
import type { StagingPolicy } from "./staging-policy.js";

export interface GateInput {
  project: ProjectRow;
  staging: StagingPolicy;
  release: ReleasePolicy;
  /** every candidate of the promotion set */
  candidates: FrozenCandidate[];
  /**
   * mount name → resourceId for **every** mount of the project (a resource may be mounted under
   * more than one name; each name is gated, and the strictest level wins)
   */
  resourceByMount: Map<string, string>;
  /** resourceId → the `main` head commit sha */
  heads: Map<string, string>;
  /** resourceId → the promotion's integration result commit sha */
  results: Map<string, string>;
  /**
   * Asks the risk classifier about this promotion (the caller builds the input from the gate's
   * per-path levels, picks the provider and applies the timeout). Called at most once, only for a
   * `classify` path level whose veto passed. Absent: not configured.
   */
  classify?: (gated: { perPath: GateResult["perPath"] }) => Promise<ClassifierEvidence>;
  /**
   * A clearance carried from an earlier build (key unchanged, clearer still qualifies) that covers a
   * `classify` level (P3-4): `developer`, or `classifier` with the evidence it was written on. The
   * classifier is not asked again (the level stays `classify`, the caller carries the clearance)
   * unless that evidence no longer clears under the policy.
   */
  carried?: { kind: "developer" } | { kind: "classifier"; evidence: ClassifierEvidence | null };
}

export type GateReasonCode = "self" | "classifier" | "carried" | "developer_paths" | "migration_destructive" | "classifier_declined" | "classifier_unavailable" | "gate_error";

export type GateClassifierReason = "not_needed" | "not_configured" | "carried" | "cleared" | "declined" | "error";
export interface GateClassifier {
  /** the classifier was asked in this gating */
  asked: boolean;
  /** the evidence clears (asked now, or carried with a `classifier` clearance) */
  cleared: boolean;
  reason: GateClassifierReason;
  /** what the classifier answered (or why it could not); developers and owners only */
  evidence?: ClassifierEvidence;
}

export interface GateResult {
  /** after the veto and the classifier */
  level: PromotionLevel;
  /** from the rules alone */
  pathLevel: PromotionLevel;
  perPath: Array<{ path: string; level: PromotionLevel; rule: number | null }>;
  veto: { kind: "additive" | "destructive" | "none"; offending: Array<{ file: string; statement: string }> };
  classifier: GateClassifier;
  reasonCode: GateReasonCode;
}

export type GatePendingCode = Exclude<GateReasonCode, "self" | "classifier" | "carried">;

/** Platform-composed client texts of the reasons a promotion waits for a developer. */
export const GATE_REASON_TEXT: Record<GatePendingCode, string> = {
  developer_paths: "Changes files that need a developer's review.",
  migration_destructive: "Changes the database structure in a way that needs a developer.",
  classifier_declined: "Needs a developer's review.",
  classifier_unavailable: "Needs a developer's review.",
  gate_error: "Needs a developer's review.",
};

/** `classifier_declined` client text by the first question that did not clear (P3-5). */
export const CLASSIFIER_DECLINED_TEXT: Record<RiskQuestionId, string> = {
  risk: "The automatic review could not confirm this change is low risk.",
  migration: "Changes the database structure in a way that needs a developer.",
  apiChange: "May change how the API works for existing callers.",
  authOrPayments: "Touches sign-in or payments.",
  addressedToReviewer: "Needs a developer's review.",
};

/** The client text of a gate result that waits for a developer (declined: by its failed question). */
export function gateReasonText(code: GatePendingCode, classifier?: GateClassifier): string {
  if (code === "classifier_declined") {
    const failed = classifier?.evidence?.failed;
    if (failed && Object.hasOwn(CLASSIFIER_DECLINED_TEXT, failed)) return CLASSIFIER_DECLINED_TEXT[failed as RiskQuestionId];
  }
  return GATE_REASON_TEXT[code];
}

/** Per folder: at most this many `.sql` files, each at most this many bytes, else destructive. */
export const MAX_MIGRATION_FILES = 50;
export const MAX_MIGRATION_BYTES = 256 * 1024;
const TOO_LARGE = "(migration folder too large to check)";

type ClassifierPolicy = StagingPolicy["promotion"]["classifier"];

/** Validated evidence, or null (logged): what is stored and trusted is only what the schema accepts. */
function validEvidence(raw: unknown): ClassifierEvidence | null {
  const parsed = RiskEvidenceSchema.safeParse(raw);
  if (!parsed.success) {
    console.warn(`promotion classifier evidence invalid (${parsed.error.issues[0]?.path.join(".") ?? "shape"})`);
    return null;
  }
  return parsed.data as ClassifierEvidence;
}

/**
 * Does `e` clear under `policy` (defense in depth, P3-11)? No error, a complete input, the policy's
 * provider and threshold, both its own verdict and `riskClears` over its answers at the policy's
 * threshold. `"mismatch"`: answered for another provider or threshold, or from an incomplete input.
 */
export function evidenceClears(e: ClassifierEvidence, policy: ClassifierPolicy): "cleared" | "declined" | "mismatch" {
  if (e.provider !== policy.provider || e.threshold !== policy.threshold || e.omittedFiles > 0 || (e.incomplete?.length ?? 0) > 0) return "mismatch";
  if (e.error !== null || !e.answers) return "declined";
  return e.cleared && e.failed === null && riskClears(e.answers, policy.threshold).cleared ? "cleared" : "declined";
}

/**
 * Asks the classifier once (P3-4, P3-5). Evidence is validated before it is trusted or stored and
 * re-checked against the policy; a throw or invalid evidence is `error` without evidence. Never throws.
 */
async function classifyPromotion(classify: GateInput["classify"], perPath: GateResult["perPath"], policy: ClassifierPolicy): Promise<{ classifier: GateClassifier; reasonCode: GateReasonCode }> {
  if (!classify) return { classifier: { asked: true, cleared: false, reason: "not_configured" }, reasonCode: "classifier_unavailable" };
  let evidence: ClassifierEvidence | null;
  try {
    evidence = validEvidence(await classify({ perPath }));
  } catch (e) {
    console.warn(`promotion classifier failed closed: ${e instanceof Error ? e.message.slice(0, 300) : String(e)}`);
    evidence = null;
  }
  if (!evidence) return { classifier: { asked: true, cleared: false, reason: "error" }, reasonCode: "classifier_unavailable" };
  if (evidence.error === "not_configured") return { classifier: { asked: true, cleared: false, reason: "not_configured", evidence }, reasonCode: "classifier_unavailable" };
  if (evidence.error !== null) return { classifier: { asked: true, cleared: false, reason: "error", evidence }, reasonCode: "classifier_unavailable" };
  const verdict = evidenceClears(evidence, policy);
  if (verdict === "mismatch") {
    console.warn(`promotion classifier evidence does not match the policy (provider ${evidence.provider}, threshold ${evidence.threshold}, omitted ${evidence.omittedFiles})`);
    return { classifier: { asked: true, cleared: false, reason: "error", evidence }, reasonCode: "classifier_unavailable" };
  }
  if (verdict === "cleared") return { classifier: { asked: true, cleared: true, reason: "cleared", evidence }, reasonCode: "classifier" };
  return { classifier: { asked: true, cleared: false, reason: "declined", evidence }, reasonCode: "classifier_declined" };
}

type Veto = GateResult["veto"];

export async function gatePromotion(svc: Services, input: GateInput): Promise<GateResult> {
  let pathLevel: PromotionLevel = "developer";
  let perPath: GateResult["perPath"] = [];
  try {
    ({ level: pathLevel, perPath } = promotionLevel(input.staging.promotion.rules, gatePaths(input)));
    const veto = await migrationVeto(svc, input);
    if (veto.kind === "destructive") return { level: "developer", pathLevel, perPath, veto, classifier: { asked: false, cleared: false, reason: "not_needed" }, reasonCode: "migration_destructive" };
    if (pathLevel === "classify") {
      const policy = input.staging.promotion.classifier;
      const carried = input.carried;
      if (carried?.kind === "developer") return { level: "classify", pathLevel, perPath, veto, classifier: { asked: false, cleared: false, reason: "carried" }, reasonCode: "carried" };
      if (carried?.kind === "classifier") {
        const evidence = carried.evidence ? validEvidence(carried.evidence) : null;
        if (evidence && evidenceClears(evidence, policy) === "cleared") return { level: "classify", pathLevel, perPath, veto, classifier: { asked: false, cleared: true, reason: "carried", evidence }, reasonCode: "classifier" };
        // the evidence it was written on does not clear under this policy: ask again
      }
      const answer = await classifyPromotion(input.classify, perPath, policy);
      return { level: answer.classifier.cleared ? "classify" : "developer", pathLevel, perPath, veto, classifier: answer.classifier, reasonCode: answer.reasonCode };
    }
    const notAsked = { asked: false, cleared: false, reason: "not_needed" } as const;
    if (pathLevel === "developer") return { level: "developer", pathLevel, perPath, veto, classifier: notAsked, reasonCode: "developer_paths" };
    return { level: "self", pathLevel, perPath, veto, classifier: notAsked, reasonCode: "self" };
  } catch (e) {
    console.warn(`promotion gate failed closed: ${e instanceof Error ? e.message.slice(0, 300) : String(e)}`);
    return {
      level: "developer",
      pathLevel,
      perPath,
      veto: { kind: "destructive", offending: [{ file: "(gate)", statement: "(migrations could not be checked)" }] },
      classifier: { asked: false, cleared: false, reason: "not_needed" },
      reasonCode: "gate_error",
    };
  }
}

/**
 * `<mountName>/<path>` of every candidate's changed paths under **every** mount name of its
 * resource (so the strictest rule of any name applies), deduped, in candidate order.
 */
function gatePaths(input: GateInput): string[] {
  const out = new Set<string>();
  for (const c of input.candidates) {
    const mounts = [...input.resourceByMount].filter(([, rid]) => rid === c.resourceId).map(([mount]) => mount);
    if (mounts.length === 0) throw new Error(`candidate ${c.candidateId} changes resource ${c.resourceId}, which is not a mount of the project`);
    for (const p of c.changedPaths) for (const mount of mounts) out.add(`${mount}/${p}`);
  }
  return [...out];
}

/** The migration folders that run (staging and production), as (resource, dir), deduped. */
export function migrationFolders(input: Pick<GateInput, "staging" | "release" | "resourceByMount">): Array<{ resourceId: string; mountName: string; dir: string }> {
  const mountOfTarget = new Map(input.release.targets.map((t) => [t.targetId as string, t.mountName as string]));
  const dirs: Array<{ targetId: string; dir: string }> = [];
  for (const [targetId, env] of Object.entries(input.staging.environment)) for (const d of env.d1) if (d.migrationsDir) dirs.push({ targetId, dir: d.migrationsDir });
  for (const m of input.release.migrations) dirs.push({ targetId: m.targetId, dir: m.dir });
  const seen = new Set<string>();
  const out: Array<{ resourceId: string; mountName: string; dir: string }> = [];
  for (const { targetId, dir } of dirs) {
    const mountName = mountOfTarget.get(targetId);
    if (!mountName) throw new Error(`migrations folder ${dir} names target ${targetId}, which is not a release target`);
    // a target built from a mount the project does not have: the folder cannot be read, so the gate
    // fails closed rather than skip a folder that runs
    const resourceId = input.resourceByMount.get(mountName);
    if (!resourceId) throw new Error(`migrations folder ${dir} of target ${targetId} is in mount ${mountName}, which is not a mount of the project`);
    const clean = dir.replace(/\/+$/, "");
    const key = `${resourceId}\u0000${clean}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ resourceId, mountName, dir: clean });
  }
  return out;
}

/** Is `path` (in `resourceId`) a `.sql` file directly in one of `folders` (the files the veto lints)? */
export function isMigrationFile(folders: ReadonlyArray<{ resourceId: string; dir: string }>, resourceId: string, path: string): boolean {
  if (!path.endsWith(".sql")) return false;
  return folders.some((f) => f.resourceId === resourceId && path.startsWith(`${f.dir}/`) && !path.slice(f.dir.length + 1).includes("/"));
}

async function migrationVeto(svc: Services, input: GateInput): Promise<Veto> {
  const offending: Veto["offending"] = [];
  let checked = false;
  for (const folder of migrationFolders(input)) {
    const prefix = `${folder.dir}/`;
    const touched = input.candidates.some((c) => c.resourceId === folder.resourceId && c.changedPaths.some((p) => p === folder.dir || p.startsWith(prefix)));
    if (!touched) continue;
    checked = true;
    const head = input.heads.get(folder.resourceId);
    const result = input.results.get(folder.resourceId);
    if (!head || !result) throw new Error(`no main head or promotion result for resource ${folder.resourceId}`);
    const label = `${folder.mountName}/${folder.dir}`;
    const before = await readMigrations(svc, input.project.org_id, folder.resourceId, head, folder.dir);
    const after = await readMigrations(svc, input.project.org_id, folder.resourceId, result, folder.dir);
    if (before === "too_large" || after === "too_large") {
      offending.push({ file: label, statement: TOO_LARGE });
      continue;
    }
    // a file that cannot be read as SQL text cannot be proven additive (reported once per name)
    const unreadable = new Map([...before.unreadable, ...after.unreadable]);
    for (const [name, statement] of [...unreadable].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) offending.push({ file: `${label}/${name}`, statement });
    if (unreadable.size > 0) continue;
    for (const o of lintMigrations(before.files, after.files).offending) offending.push({ file: `${label}/${o.file}`, statement: o.statement });
  }
  if (!checked) return { kind: "none", offending: [] };
  return { kind: offending.length === 0 ? "additive" : "destructive", offending };
}

/**
 * The `.sql` files directly in `dir` at `sha`, keyed by file name in a null-prototype object (a file
 * named like an `Object.prototype` key is an ordinary entry). `too_large` past the caps.
 */
async function readMigrations(svc: Services, orgId: string, resourceId: string, sha: string, dir: string): Promise<{ files: Record<string, string>; unreadable: Map<string, string> } | "too_large"> {
  const r = await getResource(svc.db, orgId, resourceId);
  const coords = r ? resourceCoords(r) : null;
  if (!r || !coords || coords.kind !== "artifacts") throw new Error(`resource ${resourceId} has no canonical repository`);
  const ref = resourceRef(r);
  const rev = artRevisionId(coords.repoId, sha);
  const entries = (await svc.provider().listTree(ref, rev, dir)).filter((e) => e.path.endsWith(".sql"));
  if (entries.length > MAX_MIGRATION_FILES) return "too_large";
  const files = Object.create(null) as Record<string, string>;
  const unreadable = new Map<string, string>();
  for (const e of entries) {
    const name = e.path.slice(e.path.lastIndexOf("/") + 1);
    // a symlink or submodule (by type or by git mode) cannot be proven additive
    if (e.type !== "file" || (e.mode !== undefined && e.mode !== "100644" && e.mode !== "100755")) {
      unreadable.set(name, `(not a regular file: ${e.type === "file" ? (e.mode ?? "file") : e.type})`);
      continue;
    }
    const bytes = await svc.provider().readFile(ref, rev, e.path);
    if (!bytes) throw new Error(`migration ${e.path} listed but not readable at ${sha}`);
    if (bytes.byteLength > MAX_MIGRATION_BYTES) return "too_large";
    try {
      files[name] = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    } catch {
      unreadable.set(name, "(not UTF-8 text)");
    }
  }
  return { files, unreadable };
}
