/**
 * Production D1 (staging phase 2, R8): org-owned databases bound by the release policy. Before a
 * production deploy the Worker applies pending migrations from the release's data files (each
 * verified against the build receipt's sha256), records each applied file, and never re-runs,
 * edits or seeds anything. A failure stops the release before any code changes.
 *
 * Re-run safety (review I2): a migration's row is written as `applying` BEFORE its query is sent
 * and becomes `applied` once D1 confirms it. A definite refusal (D1 answered 4xx) removes the row
 * (nothing ran; a retry runs it again). Any other failure once the query was sent (no answer, 5xx,
 * 429, or the confirmation could not be recorded) leaves the row `applying`: the outcome is
 * unknown, and every later deploy needing that database refuses (`migration_state_unknown`) until
 * an owner checks the database and resolves the row ({@link resolveProductionMigration}).
 */
import { migrationKey, sha256Hex } from "@commonforge-org/core";
import type { ReleaseBuildReceipt } from "@commonforge-org/runner-protocol";
import type { Services } from "../context.js";
import { ApiError, conflict, notFound } from "../lib/http.js";
import { DeployApiError } from "./deploy-api.js";
import type { ReleasePolicy } from "./release-policy.js";

export type ProductionMigrations = ReleasePolicy["migrations"];

const dirPrefix = (dir: string) => `${dir.replace(/\/$/, "")}/`;

/** The data paths of a production target: its migrations folders only (never a seed). */
export function productionDataFor(migrations: ProductionMigrations, targetId: string): string[] {
  return [...new Set(migrations.filter((m) => m.targetId === targetId).map((m) => m.dir.replace(/\/$/, "")))].sort();
}

/** Why a production target's built data files are not exactly migrations-folder files (null: they are). */
export function productionDataProblem(migrations: ProductionMigrations, targetId: string, dataFiles: ReadonlyArray<{ path: string }>): string | null {
  const dirs = productionDataFor(migrations, targetId).map(dirPrefix);
  const stray = dataFiles.find((f) => !dirs.some((d) => f.path.startsWith(d)));
  return stray ? `${targetId}/${stray.path} is not inside a declared migrations folder` : null;
}

interface MigrationRow {
  key: string;
  state: "applying" | "applied";
}

const nameOf = (key: string) => key.slice(0, key.lastIndexOf("@"));

/**
 * Apply the pending migrations of every `migrations` entry (name order, one `d1Query` per file),
 * each file's stored bytes verified against the receipt's sha256 first, and record each file as
 * `<name>@<sha256>` per database. Refused: an applied name whose content changed (add a new
 * migration instead), a row whose outcome is unknown, and a pending name that sorts before the
 * database's last recorded one (out of order). A renamed migration is a new name: it is refused
 * when it sorts before the last applied one, and otherwise runs again (do not rename applied
 * migrations). `rel.output_prefix` is where the build stored the release's outputs; `accountId` is
 * the deploy account stored with the release.
 */
export async function applyProductionMigrations(
  svc: Services,
  rel: { org_id: string; release_id: string; output_prefix: string },
  accountId: string,
  receipt: ReleaseBuildReceipt,
  migrations: ProductionMigrations,
): Promise<{ applied: string[] }> {
  const api = svc.deps.deployApi(svc.env);
  const applied: string[] = [];
  for (const m of migrations) {
    const t = receipt.targets.find((x) => x.targetId === m.targetId);
    const db = t?.config.d1Databases?.find((d) => d.binding === m.binding);
    if (!t || !db) throw new ApiError(409, "release_migration_unbound", `migrations ${m.dir} name ${m.binding}, which ${m.targetId} does not bind`);
    const dir = dirPrefix(m.dir);
    const files = (t.dataFiles ?? [])
      .filter((f) => f.path.startsWith(dir) && f.path.endsWith(".sql") && !f.path.slice(dir.length).includes("/"))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const rows = (await svc.db.prepare("SELECT key, state FROM production_migrations WHERE org_id = ? AND resource_id = ?").bind(rel.org_id, db.id).all<MigrationRow>()).results;
    const unknown = rows.find((r) => r.state === "applying");
    if (unknown) throw new ApiError(409, "migration_state_unknown", `migration ${nameOf(unknown.key)} of database ${db.id} has an unknown outcome; an owner must check the database and resolve it (POST …/production-migrations/resolve)`, { resourceId: db.id, key: unknown.key });
    const done = new Map(rows.map((r) => [nameOf(r.key), r.key]));
    let last = rows.map((r) => nameOf(r.key)).sort().at(-1);
    for (const f of files) {
      const name = f.path.slice(dir.length);
      const key = migrationKey(name, f.sha256);
      const prior = done.get(name);
      if (prior === key) continue;
      if (prior !== undefined) throw new ApiError(409, "production_migration_changed", `${name} was already applied to production with different content; add a new migration instead`, { targetId: t.targetId, binding: m.binding, migration: name });
      if (last !== undefined && name < last) throw new ApiError(409, "migration_out_of_order", `${name} sorts before ${last}, which production already applied; name new migrations after the last one`, { targetId: t.targetId, binding: m.binding, migration: name });
      const obj = await svc.env.COMMONFORGE_ASSETS.get(`${rel.output_prefix}${t.targetId}/__data/${f.path}`);
      if (!obj) throw new ApiError(409, "release_data_missing", `the build did not store ${t.targetId}/${f.path}`);
      // the runner hashed the raw bytes (sha256HexSync of the file): verify those, then decode
      const bytes = new Uint8Array(await obj.arrayBuffer());
      if (bytes.byteLength !== f.size || (await sha256Hex(bytes)) !== f.sha256) throw new ApiError(409, "release_data_mismatch", `${t.targetId}/${f.path} does not match the build`);
      const claimed = await svc.db
        .prepare("INSERT INTO production_migrations (org_id, resource_id, key, release_id, state, started_at) VALUES (?, ?, ?, ?, 'applying', ?) ON CONFLICT DO NOTHING")
        .bind(rel.org_id, db.id, key, rel.release_id, svc.nowIso())
        .run();
      if ((claimed.meta.changes ?? 0) === 0) throw new ApiError(409, "migration_state_unknown", `${name} is being applied by another deploy`, { resourceId: db.id, key });
      try {
        await api.d1Query(accountId, db.id, new TextDecoder().decode(bytes));
      } catch (e) {
        if (e instanceof DeployApiError && !e.transient) {
          // D1 refused the statement: nothing ran, the migration is still pending
          await svc.db.prepare("DELETE FROM production_migrations WHERE resource_id = ? AND key = ? AND state = 'applying'").bind(db.id, key).run();
          throw new ApiError(409, "migration_failed", `production migration ${name} failed: ${e.message}`, { targetId: t.targetId, binding: m.binding, migration: name });
        }
        throw stateUnknown(name, db.id, key, e);
      }
      try {
        await svc.db.prepare("UPDATE production_migrations SET state = 'applied', applied_at = ? WHERE resource_id = ? AND key = ?").bind(svc.nowIso(), db.id, key).run();
      } catch (e) {
        throw stateUnknown(name, db.id, key, e);
      }
      done.set(name, key);
      last = name;
      applied.push(name);
    }
  }
  return { applied };
}

function stateUnknown(name: string, resourceId: string, key: string, e: unknown): ApiError {
  return new ApiError(409, "migration_state_unknown", `production migration ${name} was sent but its outcome is unknown (${String((e as Error)?.message ?? e).slice(0, 300)}); an owner must check the database and resolve it`, { resourceId, key });
}

/**
 * Owner action (review I2): after checking the database by hand, record whether a migration whose
 * outcome is unknown ran (`applied`: never run again) or not (the row is removed; the next deploy
 * runs it).
 */
export async function resolveProductionMigration(svc: Services, orgId: string, input: { resourceId: string; key: string; applied: boolean }): Promise<{ state: "applied" | "pending" }> {
  const row = await svc.db.prepare("SELECT state FROM production_migrations WHERE org_id = ? AND resource_id = ? AND key = ?").bind(orgId, input.resourceId, input.key).first<{ state: string }>();
  if (!row) throw notFound("production migration not found");
  if (row.state !== "applying") throw conflict("migration_state_known", "this migration is recorded as applied; nothing to resolve");
  // a deploy in flight may be applying migrations to this database right now
  const deploying = await svc.db.prepare("SELECT release_id, build_receipt_json FROM releases WHERE org_id = ? AND channel = 'production' AND state = 'deploying'").bind(orgId).all<{ release_id: string; build_receipt_json: string | null }>();
  const busy = deploying.results.find((r) => (JSON.parse(r.build_receipt_json ?? "null") as ReleaseBuildReceipt | null)?.targets.some((t) => t.config.d1Databases?.some((d) => d.id === input.resourceId)));
  if (busy) throw conflict("deploy_in_progress", `release ${busy.release_id} is deploying with this database; resolve once it has finished`, { releaseId: busy.release_id });
  if (input.applied) {
    await svc.db.prepare("UPDATE production_migrations SET state = 'applied', applied_at = ? WHERE org_id = ? AND resource_id = ? AND key = ? AND state = 'applying'").bind(svc.nowIso(), orgId, input.resourceId, input.key).run();
    return { state: "applied" };
  }
  await svc.db.prepare("DELETE FROM production_migrations WHERE org_id = ? AND resource_id = ? AND key = ? AND state = 'applying'").bind(orgId, input.resourceId, input.key).run();
  return { state: "pending" };
}

export interface ProductionMigrationView {
  resourceId: string;
  key: string;
  releaseId: string;
  state: "applying" | "applied";
  startedAt: string;
  appliedAt: string | null;
}

/** The org's production migration records (newest first), optionally of one state (`applying`: what an owner must resolve). */
export async function listProductionMigrations(svc: Services, orgId: string, state?: "applying" | "applied"): Promise<ProductionMigrationView[]> {
  const rows = await svc.db
    .prepare(`SELECT resource_id, key, release_id, state, started_at, applied_at FROM production_migrations WHERE org_id = ? ${state ? "AND state = ?" : ""} ORDER BY started_at DESC, key LIMIT 500`)
    .bind(orgId, ...(state ? [state] : []))
    .all<{ resource_id: string; key: string; release_id: string; state: "applying" | "applied"; started_at: string; applied_at: string | null }>();
  return rows.results.map((r) => ({ resourceId: r.resource_id, key: r.key, releaseId: r.release_id, state: r.state, startedAt: r.started_at, appliedAt: r.applied_at }));
}
