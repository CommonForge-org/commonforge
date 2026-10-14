import { sha256HexSync } from "@commonforge-org/core";
import { describe, expect, it } from "vitest";
import { applyStagingData, deleteRetired, ensureStagingResources, resetStagingResources, stagingMigrationsNeedReset } from "../../src/services/staging-data.js";
import { codeResource, harness, ownerWithOrg, projectWith } from "../helpers.js";

const staging = {
  environment: { api: { vars: {}, kv: [{ binding: "ORDERS", seed: "seed/orders.json" }], d1: [{ binding: "DB", migrationsDir: "migrations", seed: ["seed/contacts.sql"] }] } },
  captureVars: [],
  promotion: { rules: [], classifier: { provider: "none" as const, threshold: 0.9 } },
};
const receipt = (files: Record<string, string>) => ({
  jobId: "j",
  releaseId: "rel-1",
  outputDigest: "0".repeat(64),
  builtAt: "2026-10-07T00:00:00.000Z",
  targets: [{ targetId: "api", digest: "0".repeat(64), files: [], config: {} as never, dataFiles: Object.keys(files).map((path) => ({ path, sha256: sha256HexSync(files[path]!), size: files[path]!.length })) }],
});

async function setup(files: Record<string, string>) {
  const h = harness();
  const o = await ownerWithOrg(h);
  const api = await codeResource(h, o, "api", { "src/index.ts": "x" });
  const pid = await projectWith(h, o, [{ mountName: "api", resourceId: api.resourceId }]);
  const svc = h.services();
  const project = (await svc.db.prepare("SELECT * FROM projects WHERE project_id = ?").bind(pid).first())!;
  for (const [path, text] of Object.entries(files)) await h.env().COMMONFORGE_ASSETS.put(`org/${o.orgId}/releases/rel-1/api/__data/${path}`, text);
  const rel = { org_id: o.orgId, project_id: pid, output_prefix: `org/${o.orgId}/releases/rel-1/` };
  return { h, o, svc, project: project as never, rel };
}

describe("staging data", () => {
  it("creates one D1 and one KV per binding, idempotently, named in the org namespace", async () => {
    const { h, svc, project, o } = await setup({});
    const a = await ensureStagingResources(svc, project, staging);
    const b = await ensureStagingResources(svc, project, staging);
    expect(a.map((r) => [r.kind, r.binding, r.generation])).toEqual([["d1", "DB", 1], ["kv", "ORDERS", 1]]);
    expect(b.map((r) => r.resource_id)).toEqual(a.map((r) => r.resource_id));
    expect(h.deployApi.created.map((c) => c.name)).toEqual([expect.stringMatching(new RegExp(`^cfapp-${o.orgId}-stg-[0-9a-f]{16}-db-1-[0-9a-f]{4}$`)), expect.stringMatching(/^cfapp-o-[0-9a-f]{12}-stg-[0-9a-f]{16}-orders-1-[0-9a-f]{4}$/)]);
    expect(a[0]!.resource_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(a[1]!.resource_id).toMatch(/^[0-9a-f]{32}$/);
  });
  it("applies new migrations in name order, then seeds once", async () => {
    const files = { "migrations/0001_init.sql": "CREATE TABLE contacts (id INTEGER PRIMARY KEY);", "migrations/0002_phone.sql": "ALTER TABLE contacts ADD COLUMN phone TEXT;", "seed/contacts.sql": "INSERT INTO contacts (id) VALUES (1);", "seed/orders.json": '[{"key":"order:1","value":"{}"}]' };
    const { h, svc, project, rel } = await setup(files);
    await ensureStagingResources(svc, project, staging);
    const r1 = await applyStagingData(svc, rel, receipt(files) as never, staging);
    expect(r1.applied).toEqual(["0001_init.sql", "0002_phone.sql"]);
    expect(h.deployApi.queries.map((q) => q.sql)).toEqual([files["migrations/0001_init.sql"], files["migrations/0002_phone.sql"], files["seed/contacts.sql"]]);
    expect(h.deployApi.kvPuts).toEqual([{ id: expect.any(String), entries: [{ key: "order:1", value: "{}" }] }]);
    const r2 = await applyStagingData(svc, rel, receipt(files) as never, staging);
    expect(r2.applied).toEqual([]);
    expect(h.deployApi.queries).toHaveLength(3);
  });
  it("needs a reset when an applied migration is gone; reset makes generation 2 and retires generation 1", async () => {
    const files = { "migrations/0001_init.sql": "CREATE TABLE a (id INTEGER);", "migrations/0002_b.sql": "CREATE TABLE b (id INTEGER);", "seed/contacts.sql": "SELECT 1;", "seed/orders.json": "[]" };
    const { h, svc, project, rel } = await setup(files);
    await ensureStagingResources(svc, project, staging);
    await applyStagingData(svc, rel, receipt(files) as never, staging);
    const { "migrations/0002_b.sql": _gone, ...without } = files;
    expect(await stagingMigrationsNeedReset(svc, project, receipt(without) as never, staging)).toBe(true);
    expect(await stagingMigrationsNeedReset(svc, project, receipt(files) as never, staging)).toBe(false);
    const fresh = await resetStagingResources(svc, project, staging);
    expect(fresh.map((r) => r.generation)).toEqual([2, 2]);
    await deleteRetired(svc, rel.org_id, rel.project_id);
    expect(h.deployApi.deleted).toHaveLength(2);
    expect((await svc.db.prepare("SELECT COUNT(*) AS n FROM staging_resources WHERE project_id = ?").bind(rel.project_id).first<{ n: number }>())!.n).toBe(2);
  });
  it("records applied migrations as name@sha256: an edited applied migration needs a reset, unchanged content does not", async () => {
    const files = { "migrations/0001_init.sql": "CREATE TABLE a (id INTEGER);", "seed/contacts.sql": "SELECT 1;", "seed/orders.json": "[]" };
    const { svc, project, rel } = await setup(files);
    await ensureStagingResources(svc, project, staging);
    await applyStagingData(svc, rel, receipt(files) as never, staging);
    const row = await svc.db.prepare("SELECT applied_migrations_json FROM staging_resources WHERE project_id = ? AND kind = 'd1'").bind(rel.project_id).first<{ applied_migrations_json: string }>();
    expect(JSON.parse(row!.applied_migrations_json)).toEqual([`0001_init.sql@${sha256HexSync(files["migrations/0001_init.sql"])}`]);
    expect(await stagingMigrationsNeedReset(svc, project, receipt(files) as never, staging)).toBe(false);
    expect(await stagingMigrationsNeedReset(svc, project, receipt({ ...files, "migrations/0002_b.sql": "CREATE TABLE b (id INTEGER);" }) as never, staging)).toBe(false);
    const edited = { ...files, "migrations/0001_init.sql": "CREATE TABLE a (id INTEGER, name TEXT);" };
    expect(await stagingMigrationsNeedReset(svc, project, receipt(edited) as never, staging)).toBe(true);
  });
  it("an applied entry recorded without @sha256 compares by name only (and is not re-applied)", async () => {
    const files = { "migrations/0001_init.sql": "CREATE TABLE a (id INTEGER);", "seed/contacts.sql": "SELECT 1;", "seed/orders.json": "[]" };
    const { h, svc, project, rel } = await setup(files);
    await ensureStagingResources(svc, project, staging);
    await svc.db.prepare("UPDATE staging_resources SET applied_migrations_json = '[\"0001_init.sql\"]' WHERE project_id = ? AND kind = 'd1'").bind(rel.project_id).run();
    expect(await stagingMigrationsNeedReset(svc, project, receipt({ ...files, "migrations/0001_init.sql": "CREATE TABLE a (x TEXT);" }) as never, staging)).toBe(false);
    expect((await applyStagingData(svc, rel, receipt(files) as never, staging)).applied).toEqual([]);
    expect(h.deployApi.queries.map((q) => q.sql)).toEqual([files["seed/contacts.sql"]]);
  });
  it("names differ per target for the same binding, and the hash is stable across generations", async () => {
    const { h, svc, project } = await setup({});
    const seg = (n: string) => /-stg-([0-9a-f]{16})/.exec(n)![1]!;
    const two = { ...staging, environment: { api: staging.environment.api, worker: { vars: {}, kv: [], d1: [{ binding: "DB" }] } } };
    await ensureStagingResources(svc, project, two);
    const gen1 = h.deployApi.created.filter((c) => c.kind === "d1").map((c) => seg(c.name));
    expect(gen1).toHaveLength(2);
    expect(gen1[0]).not.toBe(gen1[1]);
    // same project, target, kind and binding: the deterministic segment survives a reset (only the generation changes)
    h.deployApi.created.length = 0;
    await resetStagingResources(svc, project, two);
    const gen2 = h.deployApi.created.filter((c) => c.kind === "d1");
    expect(gen2.map((c) => seg(c.name))).toEqual(gen1);
    expect(gen2.every((c) => /-2-[0-9a-f]{4}$/.test(c.name))).toBe(true);
  });
  it("keeps long bindings inside the org namespace and 63 characters", async () => {
    const { h, svc, project, o } = await setup({});
    const long = { ...staging, environment: { api: { vars: {}, kv: [{ binding: "K".repeat(64) }], d1: [{ binding: "D".repeat(64) }] } } };
    await ensureStagingResources(svc, project, long);
    for (const c of h.deployApi.created) {
      expect(c.name.startsWith(`cfapp-${o.orgId}-`)).toBe(true);
      expect(c.name.length).toBeLessThanOrEqual(63);
    }
    expect(new Set(h.deployApi.created.map((c) => c.name)).size).toBe(2);
  });
});
