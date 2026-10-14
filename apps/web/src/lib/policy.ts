/**
 * The policy editor's draft (admin screens spec §7): forms for roles, checks and rules; JSON text
 * for contracts, preview, release and staging. `toPolicy` builds the one document PUT …/policy saves.
 */
import type { PolicyIssue, ProjectPolicy, Role } from "../api/types.js";

export type PolicyRole = "owner" | "developer" | "client";
export const POLICY_ROLES: PolicyRole[] = ["owner", "developer", "client"];
const APPROVE_DEFAULT: PolicyRole[] = ["owner", "developer", "client"];
const PUBLISH_DEFAULT: PolicyRole[] = ["owner"];

export interface CheckDraft {
  checkId: string;
  mountName: string;
  command: string;
  timeoutSeconds: string;
  required: boolean;
  /** kept as stored and saved back (staging alone-first, B8); the form does not show it yet */
  gatesAlone?: boolean;
}

export interface PolicyDraft {
  approvalRoles: PolicyRole[];
  /** stored approval roles the form doesn't show (viewer): kept as they are and saved back */
  otherApprovalRoles: Role[];
  publishRoles: PolicyRole[];
  checks: CheckDraft[];
  rules: string[];
  contracts: string;
  preview: string;
  release: string;
  staging: string;
}

export type SectionKey = "approvalRoles" | "publishRoles" | "checks" | "rules" | "contracts" | "preview" | "release" | "staging";
export const SECTION_LABEL: Record<SectionKey, string> = {
  approvalRoles: "Who can approve changes",
  publishRoles: "Who can approve publishing",
  checks: "Checks",
  rules: "Rules",
  contracts: "Contracts",
  preview: "Preview",
  release: "Release",
  staging: "Staging",
};
const ORDER: SectionKey[] = ["approvalRoles", "publishRoles", "checks", "rules", "contracts", "preview", "release", "staging"];

const onlyPolicyRoles = (rs: readonly string[]): PolicyRole[] => POLICY_ROLES.filter((r) => rs.includes(r));
const json = (v: unknown) => JSON.stringify(v, null, 2);

export function fromPolicy(p: ProjectPolicy | undefined): PolicyDraft {
  return {
    approvalRoles: onlyPolicyRoles(p?.approvalRoles ?? APPROVE_DEFAULT),
    otherApprovalRoles: (p?.approvalRoles ?? []).filter((r) => !(POLICY_ROLES as string[]).includes(r)),
    publishRoles: onlyPolicyRoles(p?.publishRoles ?? PUBLISH_DEFAULT),
    checks: (p?.checks ?? []).map((c) => ({ checkId: c.checkId, mountName: c.mountName, command: c.command, timeoutSeconds: String(c.timeoutSeconds ?? 600), required: c.required ?? true, ...(c.gatesAlone !== undefined ? { gatesAlone: c.gatesAlone } : {}) })),
    rules: [...(p?.rules ?? [])],
    contracts: json(p?.contracts ?? []),
    preview: p?.preview === undefined ? "" : json(p.preview),
    release: p?.release === undefined ? "" : json(p.release),
    staging: p?.staging === undefined ? "" : json(p.staging),
  };
}

function parseSection(text: string, path: "contracts" | "preview" | "release" | "staging", issues: PolicyIssue[]): { value?: unknown; ok: boolean } {
  if (path !== "contracts" && text.trim() === "") return { ok: true };
  try {
    const value = JSON.parse(text);
    if (path === "contracts" && !Array.isArray(value)) {
      issues.push({ path, message: "Contracts must be a JSON list ([ … ])." });
      return { ok: false };
    }
    return { value, ok: true };
  } catch (e) {
    issues.push({ path, message: `Not valid JSON: ${e instanceof Error ? e.message : String(e)}` });
    return { ok: false };
  }
}

export function toPolicy(d: PolicyDraft): { policy?: ProjectPolicy; issues: PolicyIssue[] } {
  const issues: PolicyIssue[] = [];
  // hidden roles still count: a stored ["viewer"] is a valid list
  if (d.approvalRoles.length === 0 && d.otherApprovalRoles.length === 0) issues.push({ path: "approvalRoles", message: "Choose at least one role." });
  if (d.publishRoles.length === 0) issues.push({ path: "publishRoles", message: "Choose at least one role." });
  const contracts = parseSection(d.contracts, "contracts", issues);
  const preview = parseSection(d.preview, "preview", issues);
  const release = parseSection(d.release, "release", issues);
  const staging = parseSection(d.staging, "staging", issues);
  if (issues.length) return { issues };
  const policy: ProjectPolicy = {
    checks: d.checks.map((c) => ({ checkId: c.checkId.trim(), mountName: c.mountName, command: c.command, timeoutSeconds: Number(c.timeoutSeconds), required: c.required, ...(c.gatesAlone !== undefined ? { gatesAlone: c.gatesAlone } : {}) })),
    contracts: (contracts.value ?? []) as unknown[],
    rules: d.rules,
    approvalRoles: [...d.otherApprovalRoles, ...d.approvalRoles],
    publishRoles: d.publishRoles as ProjectPolicy["publishRoles"],
    ...(preview.value !== undefined ? { preview: preview.value } : {}),
    ...(release.value !== undefined ? { release: release.value } : {}),
    ...(staging.value !== undefined ? { staging: staging.value } : {}),
  };
  return { policy, issues };
}

/** Sections whose content differs, compared as the editor would save them (defaults filled in). */
export function changedSections(before: ProjectPolicy | undefined, after: ProjectPolicy): SectionChange[] {
  const a = toPolicy(fromPolicy(before)).policy ?? ({} as ProjectPolicy);
  const b = toPolicy(fromPolicy(after)).policy ?? after;
  const out: SectionChange[] = [];
  for (const k of ORDER) {
    const x = json((a as unknown as Record<string, unknown>)[k] ?? null);
    const y = json((b as unknown as Record<string, unknown>)[k] ?? null);
    if (x !== y) out.push({ section: k, label: SECTION_LABEL[k], before: x, after: y });
  }
  return out;
}

export interface SectionChange {
  section: SectionKey;
  label: string;
  before: string;
  after: string;
}

/** Issues at `path` or below it (`checks.0` matches `checks.0.command`, not `checks.01`). */
export function issuesAt(issues: PolicyIssue[], path: string): PolicyIssue[] {
  return issues.filter((i) => i.path === path || i.path.startsWith(`${path}.`));
}

/**
 * Issues that no rendered field shows: everything outside the role forms, the JSON sections, the
 * Checks and Rules sections themselves (`checks`, `rules`) and their existing rows (`checks.<i>`,
 * `rules.<i>`); for example the root (`""`), an unknown key, or a row past the end.
 */
export function unclaimedIssues(issues: PolicyIssue[], d: PolicyDraft): PolicyIssue[] {
  const claimed = ["approvalRoles", "publishRoles", "contracts", "preview", "release", "staging", ...d.checks.map((_, i) => `checks.${i}`), ...d.rules.map((_, i) => `rules.${i}`)];
  return issues.filter((i) => i.path !== "checks" && i.path !== "rules" && !claimed.some((c) => issuesAt([i], c).length > 0));
}
