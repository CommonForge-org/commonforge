/**
 * Remove leftovers of interrupted CI runs: every Artifacts namespace `commonforge-ci-o-*`, every
 * release or staging Worker `cfci-o-*`, then every D1 database named and every KV namespace titled
 * `cfci-o-*` (all pages; names.ts `isSweepable`). CI resources only: the names are
 * checked against those prefixes before any delete, and production (`commonforge-dev-*`, `cfapp-*`)
 * never matches. The CI platform itself (commonforge-ci-worker/-preview/-runner, D1, queues, R2)
 * is kept. Run it only while no CI run is in progress.
 *
 *   node scripts/ci-live/sweep.ts [--dry-run]
 */
import { ArtifactsOperator, NS_PREFIX, RELEASE_PREFIX, devVars, requireCiTarget } from "./lib.ts";
import { isSweepable, listAllPages } from "./names.ts";
requireCiTarget("sweep.ts");

const dry = process.argv.includes("--dry-run");
const v = await devVars();
const op = new ArtifactsOperator(v.CF_ACCOUNT_ID!, v.CF_API_TOKEN!);
const out: string[] = [];

const nss = ((await op.call<Array<{ namespace: string }>>("GET", "/artifacts/namespaces?per_page=1000")) ?? []).map((n) => n.namespace);
const orgs = new Set(nss.filter((n) => n.startsWith(`${NS_PREFIX}-o-`)).map((n) => n.slice(NS_PREFIX.length + 1).replace(/-(canonical|tasks|editions)$/, "")));
for (const org of orgs) out.push(...(dry ? [`would delete namespaces of ${org}`] : await op.deleteOrgNamespaces(org)));

// Workers first, so no Worker still binds a database being deleted. Staging Workers
// (`cfci-o-*-staging`) and staging D1/KV (`cfci-o-*-stg-*`) match the same prefix.
const scripts = ((await op.call<Array<{ id: string }>>("GET", "/workers/scripts")) ?? []).map((s) => s.id).filter((n) => isSweepable(n, RELEASE_PREFIX));
for (const w of scripts) {
  if (!dry) await op.call("DELETE", `/workers/scripts/${w}?force=true`);
  out.push(`${dry ? "would delete" : "deleted"} worker ${w}`);
}
const d1s = (await listAllPages((page, per) => op.call<Array<{ uuid: string; name: string }>>("GET", `/d1/database?page=${page}&per_page=${per}`))).filter((d) => isSweepable(d.name, RELEASE_PREFIX));
for (const d of d1s) {
  if (!dry) await op.call("DELETE", `/d1/database/${d.uuid}`);
  out.push(`${dry ? "would delete" : "deleted"} d1 ${d.name}`);
}
const kvs = (await listAllPages((page, per) => op.call<Array<{ id: string; title: string }>>("GET", `/storage/kv/namespaces?page=${page}&per_page=${per}`))).filter((k) => isSweepable(k.title, RELEASE_PREFIX));
for (const k of kvs) {
  if (!dry) await op.call("DELETE", `/storage/kv/namespaces/${k.id}`);
  out.push(`${dry ? "would delete" : "deleted"} kv ${k.title}`);
}
console.log(out.length ? out.join("\n") : "nothing to sweep");
