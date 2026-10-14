/**
 * Clean up the leftovers of one kept or failed run (the same per-run cleanup e2e.ts does):
 *
 *   node scripts/ci-live/cleanup-org.ts [--target production] --org <orgId> [--kv <kvId>] [--d1 <d1Id>]
 *
 * Release Workers <prefix>-<orgId>-{api,website} and their -staging copies, every D1 and KV named
 * <prefix>-<orgId>-* (CI; production: only --kv/--d1 by id, never by name), and the Artifacts
 * namespaces (production: task + edition repos only; canonical repos and the org's ledger data
 * stay). Protected orgs refused.
 */
import { ArtifactsOperator, Evidence, devVars } from "./lib.ts";
import { cleanupRun } from "./project.ts";

const a = process.argv.slice(2);
const arg = (n: string) => (a.includes(n) ? a[a.indexOf(n) + 1] : undefined);
const orgId = arg("--org");
if (!orgId || !/^o-[0-9a-f]{12}$/.test(orgId)) throw new Error("--org o-<12 hex> required");
const v = await devVars();
const ev = new Evidence("cleanup-org");
await cleanupRun({ ev, op: new ArtifactsOperator(v.CF_ACCOUNT_ID!, v.CF_API_TOKEN!), orgId, kvId: arg("--kv") ?? "", d1Id: arg("--d1"), sessions: [] });
console.log(JSON.stringify(ev.steps, null, 2));
