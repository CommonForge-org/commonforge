/**
 * One organization at a time. `/` opens the organization the viewer used last in this browser (a
 * per-viewer convenience only), else their first membership. Access is decided by the API per
 * organization; nothing here grants or hides anything.
 */
import type { Membership } from "../api/types.js";

export const ROLE_LABEL: Record<string, string> = {
  owner: "Owner",
  developer: "Developer",
  client: "Client",
  viewer: "Viewer",
};

export function roleLabel(role: string): string {
  return ROLE_LABEL[role] ?? role;
}

const LAST_ORG_KEY = "cf-last-org";

export function readLastOrg(): string | null {
  try {
    return globalThis.localStorage?.getItem(LAST_ORG_KEY) ?? null;
  } catch {
    return null;
  }
}

export function rememberOrg(org: string): void {
  try {
    globalThis.localStorage?.setItem(LAST_ORG_KEY, org);
  } catch {
    // a per-viewer convenience only
  }
}

/** The organization `/` opens: the remembered one while still a member, else the first. */
export function pickOrg(memberships: Membership[], remembered: string | null): string | null {
  if (remembered && memberships.some((m) => m.orgId === remembered)) return remembered;
  return memberships[0]?.orgId ?? null;
}

/** Display names; organizations that share a name get the start of their id ("Freeze run 1 · f1e6"). */
export function orgLabels(memberships: Membership[]): Map<string, string> {
  const count = new Map<string, number>();
  for (const m of memberships) count.set(m.name, (count.get(m.name) ?? 0) + 1);
  return new Map(memberships.map((m) => [m.orgId, (count.get(m.name) ?? 0) > 1 ? `${m.name} · ${m.orgId.replace(/^o-/, "").slice(0, 4)}` : m.name]));
}
