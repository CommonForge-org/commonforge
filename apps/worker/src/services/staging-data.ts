/**
 * Staging data (spec 2026-10-07 §6): the platform creates one D1 database or KV namespace per
 * staging binding (never a production id), applies migrations and the seed through the REST API
 * from files the release build stored under `<outputPrefix><targetId>/__data/`, and records which
 * migrations each database has applied as `<file name>@<sha256>` (the build receipt's hash), so an
 * edited applied migration resets staging like a removed or reordered one. A reset creates the next generation and retires the old
 * one (deleted once a deploy bound to the new one is live).
 */
import { migrationApplied, migrationKey, migrationsNeedReset, sha256HexSync } from "@commonforge-org/core";
import type { ReleaseBuildReceipt } from "@commonforge-org/runner-protocol";
import type { Services } from "../context.js";
import { ApiError } from "../lib/http.js";
import { orgWorkerPrefix } from "./deploy-targets.js";
import type { ProjectRow } from "./directory.js";
import type { StagingPolicy } from "./staging-policy.js";

export interface StagingResource {
  org_id: string;
  project_id: string;
  target_id: string;
  kind: "d1" | "kv";
  binding: string;
  generation: number;
  resource_id: string;
  state: "active" | "retired";
  applied_migrations_json: string;
  seeded: 0 | 1;
  created_at: string;
}

const MAX_NAME = 63;
type Wanted = { target_id: string; kind: "d1" | "kv"; binding: string };

function account(svc: Services): string {
  const id = svc.env.COMMONFORGE_DEPLOY_ACCOUNT_ID || svc.env.CF_ACCOUNT_ID;
  if (!id || !/^[0-9a-f]{32}$/.test(id)) throw new ApiError(503, "config_missing", "the deploy account (COMMONFORGE_DEPLOY_ACCOUNT_ID or CF_ACCOUNT_ID) is not configured");
  return id;
}

function wanted(staging: StagingPolicy): Wanted[] {
  const out: Wanted[] = [];
  for (const [target_id, env] of Object.entries(staging.environment).sort(([a], [b]) => (a < b ? -1 : 1))) {
    for (const d of env.d1) out.push({ target_id, kind: "d1", binding: d.binding });
    for (const k of env.kv) out.push({ target_id, kind: "kv", binding: k.binding });
  }
  return out;
}

async function active(svc: Services, orgId: string, projectId: string): Promise<StagingResource[]> {
  return (await svc.db.prepare("SELECT * FROM staging_resources WHERE org_id = ? AND project_id = ? AND state = 'active' ORDER BY target_id, kind, binding").bind(orgId, projectId).all<StagingResource>()).results;
}

/**
 * `<org prefix>stg-<16 hex of sha256(project|target|kind|binding)>[-<binding slug>]-<generation>-<4 random hex>`.
 * D1 names are unique per account and KV titles are listed per account, so the name must differ per
 * project, target, kind and binding, must stay inside the org's namespace, and must fit 63 characters
 * whatever the binding length. The random tail makes a retry after a crash (resource created, row not
 * inserted) pick a fresh name instead of colliding with the orphan. Orphans are not tracked.
 */
function resourceName(svc: Services, project: ProjectRow, w: Wanted, generation: number): string {
  const prefix = orgWorkerPrefix(svc.env, project.org_id);
  const hash = sha256HexSync(`cf.staging-resource/1|${project.project_id}|${w.target_id}|${w.kind}|${w.binding}`).slice(0, 16);
  const tail = `-${generation}-${crypto.randomUUID().replace(/-/g, "").slice(0, 4)}`;
  const base = `${prefix}stg-${hash}`;
  const slug = `-${w.binding.toLowerCase().replace(/_/g, "-")}`;
  const name = base.length + slug.length + tail.length <= MAX_NAME ? `${base}${slug}${tail}` : `${base}${tail}`;
  if (!name.startsWith(prefix) || name.length > MAX_NAME) throw new ApiError(500, "internal", "derived staging resource name is outside the org namespace or too long");
  return name;
}

async function create(svc: Services, project: ProjectRow, w: Wanted, generation: number): Promise<void> {
  const name = resourceName(svc, project, w, generation);
  const api = svc.deps.deployApi(svc.env);
  const { id } = w.kind === "d1" ? await api.createD1Database(account(svc), name) : await api.createKvNamespace(account(svc), name);
  await svc.db
    .prepare("INSERT INTO staging_resources (org_id, project_id, target_id, kind, binding, generation, resource_id, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?) ON CONFLICT DO NOTHING")
    .bind(project.org_id, project.project_id, w.target_id, w.kind, w.binding, generation, id, svc.nowIso())
    .run();
}

/** One active resource per (target, kind, binding), created on demand (generation 1). */
export async function ensureStagingResources(svc: Services, project: ProjectRow, staging: StagingPolicy): Promise<StagingResource[]> {
  const have = await active(svc, project.org_id, project.project_id);
  for (const w of wanted(staging)) {
    if (!have.some((r) => r.target_id === w.target_id && r.kind === w.kind && r.binding === w.binding)) await create(svc, project, w, 1);
  }
  return active(svc, project.org_id, project.project_id);
}

/** The next generation of every binding; the old ones are `retired` and removed by `deleteRetired`. */
export async function resetStagingResources(svc: Services, project: ProjectRow, staging: StagingPolicy): Promise<StagingResource[]> {
  const have = await active(svc, project.org_id, project.project_id);
  for (const w of wanted(staging)) {
    const cur = have.find((r) => r.target_id === w.target_id && r.kind === w.kind && r.binding === w.binding);
    await create(svc, project, w, (cur?.generation ?? 0) + 1);
    if (cur) await svc.db.prepare("UPDATE staging_resources SET state = 'retired' WHERE resource_id = ?").bind(cur.resource_id).run();
  }
  return active(svc, project.org_id, project.project_id);
}

export async function deleteRetired(svc: Services, orgId: string, projectId: string): Promise<void> {
  const api = svc.deps.deployApi(svc.env);
  const old = (await svc.db.prepare("SELECT * FROM staging_resources WHERE org_id = ? AND project_id = ? AND state = 'retired'").bind(orgId, projectId).all<StagingResource>()).results;
  for (const r of old) {
    if (r.kind === "d1") await api.deleteD1Database(account(svc), r.resource_id);
    else await api.deleteKvNamespace(account(svc), r.resource_id);
    await svc.db.prepare("DELETE FROM staging_resources WHERE resource_id = ?").bind(r.resource_id).run();
  }
}

const fileName = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/** The migration files of `dir` in name order, each with its `name@sha256` key. */
function migrationFiles(receipt: ReleaseBuildReceipt, targetId: string, dir: string): Array<{ path: string; name: string; key: string }> {
  const t = receipt.targets.find((x) => x.targetId === targetId);
  const prefix = `${dir.replace(/\/$/, "")}/`;
  return (t?.dataFiles ?? [])
    .filter((f) => f.path.startsWith(prefix) && f.path.endsWith(".sql") && !f.path.slice(prefix.length).includes("/"))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((f) => ({ path: f.path, name: fileName(f.path), key: migrationKey(fileName(f.path), f.sha256) }));
}

export async function stagingMigrationsNeedReset(svc: Services, project: ProjectRow, receipt: ReleaseBuildReceipt, staging: StagingPolicy): Promise<boolean> {
  for (const r of await active(svc, project.org_id, project.project_id)) {
    if (r.kind !== "d1") continue;
    const spec = staging.environment[r.target_id]?.d1.find((d) => d.binding === r.binding);
    if (!spec?.migrationsDir) continue;
    const next = migrationFiles(receipt, r.target_id, spec.migrationsDir).map((m) => m.key);
    if (migrationsNeedReset(JSON.parse(r.applied_migrations_json) as string[], next)) return true;
  }
  return false;
}

async function dataText(svc: Services, outputPrefix: string, targetId: string, path: string): Promise<string> {
  const obj = await svc.env.COMMONFORGE_ASSETS.get(`${outputPrefix}${targetId}/__data/${path}`);
  if (!obj) throw new ApiError(409, "staging_data_missing", `the build did not store ${targetId}/${path}`);
  return obj.text();
}

/** Apply not-yet-applied migrations (name order, one `d1Query` per file) and seed each resource once. */
export async function applyStagingData(svc: Services, rel: { org_id: string; project_id: string; output_prefix: string }, receipt: ReleaseBuildReceipt, staging: StagingPolicy): Promise<{ applied: string[] }> {
  const api = svc.deps.deployApi(svc.env);
  const applied: string[] = [];
  for (const r of await active(svc, rel.org_id, rel.project_id)) {
    const env = staging.environment[r.target_id];
    if (r.kind === "d1") {
      const spec = env?.d1.find((d) => d.binding === r.binding);
      const done = JSON.parse(r.applied_migrations_json) as string[];
      for (const m of spec?.migrationsDir ? migrationFiles(receipt, r.target_id, spec.migrationsDir) : []) {
        if (migrationApplied(done, m.key)) continue;
        await api.d1Query(account(svc), r.resource_id, await dataText(svc, rel.output_prefix, r.target_id, m.path));
        done.push(m.key);
        applied.push(m.name);
        await svc.db.prepare("UPDATE staging_resources SET applied_migrations_json = ? WHERE resource_id = ?").bind(JSON.stringify(done), r.resource_id).run();
      }
      if (!r.seeded) {
        for (const path of spec?.seed ?? []) await api.d1Query(account(svc), r.resource_id, await dataText(svc, rel.output_prefix, r.target_id, path));
      }
    } else if (!r.seeded) {
      const seed = env?.kv.find((k) => k.binding === r.binding)?.seed;
      if (seed) {
        const entries = JSON.parse(await dataText(svc, rel.output_prefix, r.target_id, seed)) as Array<{ key: string; value: string }>;
        await api.kvBulkPut(account(svc), r.resource_id, entries);
      }
    }
    if (!r.seeded) await svc.db.prepare("UPDATE staging_resources SET seeded = 1 WHERE resource_id = ?").bind(r.resource_id).run();
  }
  return { applied };
}
