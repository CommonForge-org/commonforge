/**
 * Pure name filters for the cleanup (project.ts `cleanupRun`) and the sweep (sweep.ts): which
 * Cloudflare Workers, D1 databases and KV namespaces belong to one org's run, or to any CI run.
 * No imports from lib.ts (it parses argv), so the unit test (names.test.ts) can load it alone:
 *
 *   node --test scripts/ci-live/names.test.ts
 */

/** Release prefixes the harness knows: `cfci` (CI deployment) and `cfapp` (production). */
export const RELEASE_PREFIXES = ["cfci", "cfapp"] as const;
export type ReleasePrefix = (typeof RELEASE_PREFIXES)[number];
/** Server-generated org ids (apps/worker ORG_ID_RE): fixed length, so `<prefix>-<org>-` prefixes are disjoint. */
const ORG_ID_RE = /^o-[0-9a-f]{12}$/;

function checkPrefix(prefix: string): asserts prefix is ReleasePrefix {
  if (!(RELEASE_PREFIXES as readonly string[]).includes(prefix)) throw new Error(`unknown release prefix ${JSON.stringify(prefix)}`);
}

/** `<prefix>-<orgId>-`: every Worker, D1 and KV the platform creates for the org starts with it. */
export function orgPrefix(prefix: string, orgId: string): string {
  checkPrefix(prefix);
  if (!ORG_ID_RE.test(orgId)) throw new Error(`unexpected org id ${JSON.stringify(orgId)}`);
  return `${prefix}-${orgId}-`;
}

/** Whether a D1 name / KV title / Worker name belongs to `orgId` under `prefix`. */
export function isOrgResource(name: string, prefix: string, orgId: string): boolean {
  return name.startsWith(orgPrefix(prefix, orgId));
}

/** The demo project's Workers: release `api`/`website`, then their always-on staging copies. */
export function orgWorkers(prefix: string, orgId: string): string[] {
  const p = orgPrefix(prefix, orgId);
  const release = [`${p}api`, `${p}website`];
  return [...release, ...release.map((w) => `${w}-staging`)];
}

/**
 * Whether a Worker / D1 / KV name is a per-org resource of any run under `prefix`
 * (`<prefix>-o-...`). Never the platform's own resources (`commonforge-ci-*`), never another
 * prefix's.
 */
export function isSweepable(name: string, prefix: string): boolean {
  checkPrefix(prefix);
  return name.startsWith(`${prefix}-o-`);
}

/**
 * Every item of a Cloudflare page-numbered listing (`?page=N&per_page=M`): fetch pages until one
 * comes back short. `maxPages` stops a listing that never ends.
 */
export async function listAllPages<T>(fetchPage: (page: number, perPage: number) => Promise<T[] | null | undefined>, perPage = 100, maxPages = 100): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const items = (await fetchPage(page, perPage)) ?? [];
    out.push(...items);
    if (items.length < perPage) return out;
  }
  throw new Error(`listing has more than ${maxPages} pages of ${perPage}`);
}
