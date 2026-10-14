/**
 * Production D1 (staging phase 2, Task 4; R8): org-owned D1 databases (`deploy-resources` kind
 * d1), bound by the release policy with `release.migrations` naming each database's migrations
 * folder. A production deploy applies pending migrations first (each file verified against the
 * build's sha256), records them, never re-runs them and never seeds.
 */
import { describe, expect, it } from "vitest";
import { FakeRunner } from "../fakes/runner.js";
import { member, projectWith } from "../helpers.js";
import { productionFixture, stagingReleasePolicy, type ProductionFixture } from "../staging-helpers.js";

const FOREIGN_D1 = "0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b";
const INIT = "CREATE TABLE contacts (id INTEGER PRIMARY KEY);";
const PHONE = "ALTER TABLE contacts ADD COLUMN phone TEXT;";

const migrationRows = async (f: ProductionFixture) =>
  (await f.svc.db.prepare("SELECT key, state FROM production_migrations WHERE org_id = ? ORDER BY key").bind(f.o.orgId).all<{ key: string; state: string }>()).results;

describe("production D1", () => {
  it("owners create org D1; a release policy may bind only org D1 ids, with migrations folders", async () => {
    const f = await productionFixture();
    const d1 = await f.h.api("POST", `/api/orgs/${f.o.orgId}/deploy-resources`, { token: f.o.token, body: { kind: "d1", name: "contacts" } });
    expect(d1.status, JSON.stringify(d1.body)).toBe(201);
    expect(d1.body).toMatchObject({ kind: "d1", name: "contacts", title: `cfapp-${f.o.orgId}-contacts`, created: true });
    expect(f.h.deployApi.created).toContainEqual({ kind: "d1", name: `cfapp-${f.o.orgId}-contacts`, id: d1.body.id });
    const listed = await f.h.api("GET", `/api/orgs/${f.o.orgId}/deploy-resources`, { token: f.o.token });
    expect(listed.body.resources.map((r: { kind: string; id: string }) => [r.kind, r.id])).toContainEqual(["d1", d1.body.id]);

    const ok = await f.putPolicy({ release: f.releaseWith({ d1: [{ binding: "DB", id: d1.body.id }], migrations: [{ targetId: "api", binding: "DB", dir: "migrations" }] }) });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const foreign = await f.putPolicy({ release: f.releaseWith({ d1: [{ binding: "DB", id: FOREIGN_D1 }] }) });
    expect([foreign.status, foreign.body.error.code]).toEqual([403, "binding_not_allowed"]);
    const data = await f.putPolicy({ release: f.releaseWith({ data: ["seed/contacts.sql"] }) });
    expect(data.status).toBe(400);
    // a migrations entry must name a D1 binding of a worker target of the policy
    const unbound = await f.putPolicy({ release: f.releaseWith({ d1: [{ binding: "DB", id: d1.body.id }], migrations: [{ targetId: "api", binding: "OTHER", dir: "migrations" }] }) });
    expect(unbound.status).toBe(400);
    const unknownTarget = await f.putPolicy({ release: f.releaseWith({ d1: [{ binding: "DB", id: d1.body.id }], migrations: [{ targetId: "web", binding: "DB", dir: "migrations" }] }) });
    expect(unknownTarget.status).toBe(400);
  });

  it("staging D1/KV ids never appear in a production release, and org D1 ids never in staging", async () => {
    const f = await productionFixture();
    const now = f.svc.nowIso();
    const stagingD1 = crypto.randomUUID();
    const stagingKv = "ab".repeat(16);
    for (const [kind, id, binding] of [["d1", stagingD1, "DB"], ["kv", stagingKv, "ORDERS"]] as const) {
      await f.svc.db.prepare("INSERT INTO staging_resources (org_id, project_id, target_id, kind, binding, generation, resource_id, state, created_at) VALUES (?, ?, 'api', ?, ?, 1, ?, 'active', ?)").bind(f.o.orgId, f.pid, kind, binding, id, now).run();
    }
    const d1 = await f.putPolicy({ release: f.releaseWith({ d1: [{ binding: "DB", id: stagingD1 }] }) });
    expect([d1.status, d1.body.error.code]).toEqual([403, "binding_not_allowed"]);
    const kv = await f.putPolicy({ release: f.releaseWith({ kv: [{ binding: "ORDERS", id: stagingKv }] }) });
    expect([kv.status, kv.body.error.code]).toEqual([403, "binding_not_allowed"]);
    // an org D1 is not a staging resource: the staging deploy gate checks staging_resources only (staging-release tests)
    const org = await f.createD1("contacts");
    expect((await f.svc.db.prepare("SELECT COUNT(*) AS n FROM staging_resources WHERE resource_id = ?").bind(org).first<{ n: number }>())!.n).toBe(0);
  });

  it("an org has at most 3 D1 databases (counted apart from its KV namespaces)", async () => {
    const f = await productionFixture();
    for (const name of ["a", "b", "c"]) await f.createD1(name);
    const fourth = await f.h.api("POST", `/api/orgs/${f.o.orgId}/deploy-resources`, { token: f.o.token, body: { kind: "d1", name: "d" } });
    expect([fourth.status, fourth.body.error.code]).toEqual([409, "quota_exceeded"]);
    expect(fourth.body.error.message).toContain("3 D1 databases");
    const kv = await f.h.api("POST", `/api/orgs/${f.o.orgId}/deploy-resources`, { token: f.o.token, body: { kind: "kv", name: "orders" } });
    expect(kv.status).toBe(201);
  });

  it("a production deploy applies pending migrations first (verified), records them, never re-runs them, never seeds", async () => {
    const f = await productionFixture({ withD1: true, files: { "migrations/0001_init.sql": INIT, "seed/contacts.sql": "INSERT INTO contacts VALUES (1);" } });
    const runner = new FakeRunner(f.h);
    const rel = await f.publishedRelease(); // prepare → build → publish approval (owner)
    // production data = the migrations folder only (never the seed)
    expect(runner.handled.find((j) => j.job.kind === "release-build")!.job).toMatchObject({ environment: { api: { data: ["migrations"], d1Databases: [{ binding: "DB", id: f.d1Id }] } } });
    expect((await f.deploy(rel)).state).toBe("live");
    expect(f.h.deployApi.queries).toEqual([{ id: f.d1Id, sql: INIT }]);
    const rows = await f.svc.db.prepare("SELECT resource_id, key, release_id FROM production_migrations WHERE org_id = ? ORDER BY applied_at, key").bind(f.o.orgId).all<{ resource_id: string; key: string; release_id: string }>();
    expect(rows.results).toEqual([{ resource_id: f.d1Id, key: expect.stringMatching(/^0001_init\.sql@[0-9a-f]{64}$/), release_id: rel.release_id }]);

    const rel2 = await f.publishedRelease({ files: { "migrations/0002_phone.sql": PHONE } });
    expect((await f.deploy(rel2)).state).toBe("live");
    expect(f.h.deployApi.queries.map((q) => q.sql)).toEqual([INIT, PHONE]);
    // each production deploy records what it applied
    const events = await f.svc.db.prepare("SELECT detail_json FROM events WHERE org_id = ? AND action = 'release.migrations_applied' ORDER BY seq").bind(f.o.orgId).all<{ detail_json: string }>();
    expect(events.results.map((e) => JSON.parse(e.detail_json))).toEqual([
      { applied: ["0001_init.sql"], channel: "production" },
      { applied: ["0002_phone.sql"], channel: "production" },
    ]);
    expect(runner.errors).toEqual([]);
  }, 30_000);

  it("a migration D1 refuses (4xx) stops the release before any deploy job; nothing is recorded and a retry runs it again", async () => {
    const f = await productionFixture({ withD1: true, files: { "migrations/0001_init.sql": INIT } });
    const runner = new FakeRunner(f.h);
    f.h.deployApi.failQuery = { status: 400, message: "near DROP: syntax error" };
    const rel = await f.publishedRelease();
    await expect(f.deploy(rel)).rejects.toMatchObject({ code: "migration_failed" });
    expect(runner.handled.filter((j) => j.job.kind === "release-deploy")).toHaveLength(0);
    expect(await f.release(rel.release_id)).toMatchObject({ state: "failed", error_code: "migration_failed" });
    const ev = await f.svc.db.prepare("SELECT detail_json, client_detail_json FROM events WHERE org_id = ? AND action = 'release.migration_failed'").bind(f.o.orgId).first<{ detail_json: string; client_detail_json: string }>();
    expect(JSON.parse(ev!.detail_json)).toMatchObject({ code: "migration_failed", channel: "production" });
    expect(JSON.parse(ev!.client_detail_json)).toEqual({ code: "migration_failed", channel: "production" });
    expect(await migrationRows(f)).toEqual([]);
    f.h.deployApi.failQuery = undefined;
    expect((await f.deploy(rel)).state).toBe("live");
    expect(f.h.deployApi.queries.map((q) => q.sql)).toEqual([INIT]);
    expect(await migrationRows(f)).toEqual([{ key: expect.stringMatching(/^0001_init\.sql@/), state: "applied" }]);
    expect(runner.errors).toEqual([]);
  }, 30_000);

  it("a partly applied set resumes: file 1 applied, file 2 refused (4xx); the retry runs only file 2", async () => {
    const f = await productionFixture({ withD1: true, files: { "migrations/0001_init.sql": INIT, "migrations/0002_phone.sql": PHONE } });
    const runner = new FakeRunner(f.h);
    f.h.deployApi.failQuery = { status: 400, message: "duplicate column", match: "phone" };
    const rel = await f.publishedRelease();
    await expect(f.deploy(rel)).rejects.toMatchObject({ code: "migration_failed" });
    expect(f.h.deployApi.queries.map((q) => q.sql)).toEqual([INIT]);
    expect((await migrationRows(f)).map((r) => r.state)).toEqual(["applied"]);
    f.h.deployApi.failQuery = undefined;
    expect((await f.deploy(rel)).state).toBe("live");
    expect(f.h.deployApi.queries.map((q) => q.sql)).toEqual([INIT, PHONE]);
    expect(runner.errors).toEqual([]);
  }, 30_000);

  it("a migration sent without a definite answer is migration_state_unknown: deploys are refused until an owner resolves it", async () => {
    for (const applied of [true, false]) {
      const f = await productionFixture({ withD1: true, files: { "migrations/0001_init.sql": INIT } });
      const runner = new FakeRunner(f.h);
      f.h.deployApi.failQuery = { status: 504, message: "gateway timeout" };
      const rel = await f.publishedRelease();
      await expect(f.deploy(rel)).rejects.toMatchObject({ code: "migration_state_unknown" });
      expect(await f.release(rel.release_id)).toMatchObject({ state: "failed", error_code: "migration_state_unknown" });
      const [row] = await migrationRows(f);
      expect(row).toMatchObject({ state: "applying" });
      // the provider answers again, but the outcome of the first attempt is still unknown: refused, nothing re-sent
      f.h.deployApi.failQuery = undefined;
      await expect(f.deploy(rel)).rejects.toMatchObject({ code: "migration_state_unknown" });
      expect(f.h.deployApi.queries).toEqual([]);
      expect(runner.handled.filter((j) => j.job.kind === "release-deploy")).toHaveLength(0);
      // owners and developers can find it; the failure event names it for developers
      const body = { resourceId: f.d1Id, key: row!.key, applied };
      const dev = await member(f.h, f.o, "developer");
      const listed = await f.h.api("GET", `/api/orgs/${f.o.orgId}/production-migrations?state=applying`, { token: dev.token });
      expect(listed.body.migrations).toEqual([{ resourceId: f.d1Id, key: row!.key, releaseId: rel.release_id, state: "applying", startedAt: expect.any(String), appliedAt: null }]);
      expect((await f.h.api("GET", `/api/orgs/${f.o.orgId}/production-migrations?state=applied`, { token: f.o.token })).body.migrations).toEqual([]);
      expect((await f.h.api("GET", `/api/orgs/${f.o.orgId}/production-migrations?state=nope`, { token: f.o.token })).status).toBe(400);
      const failed = await f.svc.db.prepare("SELECT detail_json, client_detail_json FROM events WHERE org_id = ? AND action = 'release.migration_failed' ORDER BY seq LIMIT 1").bind(f.o.orgId).first<{ detail_json: string; client_detail_json: string }>();
      expect(JSON.parse(failed!.detail_json)).toMatchObject({ code: "migration_state_unknown", resourceId: f.d1Id, key: row!.key });
      expect(JSON.parse(failed!.client_detail_json)).toEqual({ code: "migration_state_unknown", channel: "production" });
      // never while a production deploy binding that database is in flight
      await f.svc.db.prepare("UPDATE releases SET state = 'deploying' WHERE release_id = ?").bind(rel.release_id).run();
      const busy = await f.h.api("POST", `/api/orgs/${f.o.orgId}/production-migrations/resolve`, { token: f.o.token, body });
      expect([busy.status, busy.body.error.code]).toEqual([409, "deploy_in_progress"]);
      await f.svc.db.prepare("UPDATE releases SET state = 'failed' WHERE release_id = ?").bind(rel.release_id).run();
      // only an owner resolves it
      expect((await f.h.api("POST", `/api/orgs/${f.o.orgId}/production-migrations/resolve`, { token: dev.token, body })).status).toBe(403);
      const resolved = await f.h.api("POST", `/api/orgs/${f.o.orgId}/production-migrations/resolve`, { token: f.o.token, body });
      expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
      expect(resolved.body.state).toBe(applied ? "applied" : "pending");
      const ev = await f.svc.db.prepare("SELECT subject_kind, subject_id, detail_json FROM events WHERE org_id = ? AND action = 'production_migration.resolved'").bind(f.o.orgId).first<{ subject_kind: string; subject_id: string; detail_json: string }>();
      expect([ev!.subject_kind, ev!.subject_id, JSON.parse(ev!.detail_json)]).toEqual(["org", f.o.orgId, body]);
      expect((await f.h.api("POST", `/api/orgs/${f.o.orgId}/production-migrations/resolve`, { token: f.o.token, body })).status).toBe(applied ? 409 : 404);
      expect((await f.deploy(rel)).state).toBe("live");
      // resolved as applied: never sent again; as not applied: the next deploy runs it
      expect(f.h.deployApi.queries.map((q) => q.sql)).toEqual(applied ? [] : [INIT]);
      expect(await migrationRows(f)).toEqual([{ key: row!.key, state: "applied" }]);
      expect(runner.errors).toEqual([]);
    }
  }, 60_000);

  it("a pending migration that sorts before the last applied one is refused (migration_out_of_order)", async () => {
    const f = await productionFixture({ withD1: true, files: { "migrations/0001_init.sql": INIT, "migrations/0003_phone.sql": PHONE } });
    new FakeRunner(f.h);
    expect((await f.deploy(await f.publishedRelease())).state).toBe("live");
    const rel2 = await f.publishedRelease({ files: { "migrations/0002_email.sql": "ALTER TABLE contacts ADD COLUMN email TEXT;" } });
    await expect(f.deploy(rel2)).rejects.toMatchObject({ status: 409, code: "migration_out_of_order" });
    expect(f.h.deployApi.queries.map((q) => q.sql)).toEqual([INIT, PHONE]);
  }, 30_000);

  it("a stored release whose data files leave the migrations folders, or whose migrations name an unbound database, is refused", async () => {
    const f = await productionFixture({ withD1: true, files: { "migrations/0001_init.sql": INIT } });
    const runner = new FakeRunner(f.h);
    const rel = await f.publishedRelease();
    // a seed file in a production build (it can only get there by tampering)
    const receipt = JSON.parse(rel.build_receipt_json!);
    const stray = { ...receipt, targets: [{ ...receipt.targets[0], dataFiles: [...receipt.targets[0].dataFiles, { path: "seed/contacts.sql", sha256: "a".repeat(64), size: 1 }] }] };
    await f.svc.db.prepare("UPDATE releases SET build_receipt_json = ? WHERE release_id = ?").bind(JSON.stringify(stray), rel.release_id).run();
    await expect(f.deploy(rel)).rejects.toMatchObject({ status: 403, code: "release_data_not_allowed" });
    await f.svc.db.prepare("UPDATE releases SET build_receipt_json = ? WHERE release_id = ?").bind(JSON.stringify(receipt), rel.release_id).run();
    // migrations naming a binding the built target does not have
    const env = JSON.parse(rel.environment_json);
    await f.svc.db.prepare("UPDATE releases SET environment_json = ? WHERE release_id = ?").bind(JSON.stringify({ ...env, migrations: [{ targetId: "api", binding: "OTHER", dir: "migrations" }] }), rel.release_id).run();
    await expect(f.deploy(rel)).rejects.toMatchObject({ code: "release_migration_unbound" });
    expect((await f.release(rel.release_id)).error_code).toBe("release_migration_unbound");
    expect(f.h.deployApi.queries).toEqual([]);
    expect(runner.handled.filter((j) => j.job.kind === "release-deploy")).toHaveLength(0);
  }, 30_000);

  it("an approved release never migrates a D1 another project binds by now (binding_in_use at deploy, nothing sent)", async () => {
    const f = await productionFixture({ withD1: true, files: { "migrations/0001_init.sql": INIT } });
    const runner = new FakeRunner(f.h);
    const old = await f.publishedRelease();
    expect((await f.putPolicy({ release: f.releaseWith() })).status).toBe(200); // A drops X
    const pid2 = await projectWith(f.h, f.o, [{ mountName: "api", resourceId: f.api.resourceId }]);
    const release = { ...f.releaseWith({ d1: [{ binding: "DB", id: f.d1Id! }] }), targets: [{ ...stagingReleasePolicy(f.o.orgId).targets[0]!, workerName: `cfapp-${f.o.orgId}-api2` }] };
    const put = await f.h.api("PUT", `/api/orgs/${f.o.orgId}/projects/${pid2}/policy`, { token: f.o.token, body: { release } }); // B binds X
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    await expect(f.deploy(old)).rejects.toMatchObject({ status: 409, code: "binding_in_use" });
    expect(f.h.deployApi.queries).toEqual([]);
    expect(runner.handled.filter((j) => j.job.kind === "release-deploy")).toHaveLength(0);
    expect(await migrationRows(f)).toEqual([]);
  }, 30_000);

  it("an org D1 belongs to one project: another project binding it is refused (binding_in_use) at save and prepare", async () => {
    const f = await productionFixture({ withD1: true, files: { "migrations/0001_init.sql": INIT } });
    new FakeRunner(f.h);
    const pid2 = await projectWith(f.h, f.o, [{ mountName: "api", resourceId: f.api.resourceId }]);
    const release = { ...f.releaseWith({ d1: [{ binding: "DB", id: f.d1Id! }] }), targets: [{ ...stagingReleasePolicy(f.o.orgId).targets[0]!, workerName: `cfapp-${f.o.orgId}-api2` }] };
    const put = await f.h.api("PUT", `/api/orgs/${f.o.orgId}/projects/${pid2}/policy`, { token: f.o.token, body: { release } });
    expect([put.status, put.body.error?.code]).toEqual([409, "binding_in_use"]);
    const v = await f.h.api("POST", `/api/orgs/${f.o.orgId}/projects/${pid2}/policy/validate`, { token: f.o.token, body: { release } });
    expect(v.body).toEqual({ ok: false, issues: [{ path: "release", message: expect.stringContaining("already bound by project") }] });
    // a policy stored before the rule (or saved concurrently) is caught when a release is prepared
    await f.svc.db.prepare("UPDATE projects SET policy_json = ? WHERE org_id = ? AND project_id = ?").bind(JSON.stringify({ release }), f.o.orgId, pid2).run();
    const prep = await f.h.api("POST", `/api/orgs/${f.o.orgId}/projects/${pid2}/releases`, { token: f.o.token, body: {} });
    expect([prep.status, prep.body.error?.code]).toEqual([409, "binding_in_use"]);
  }, 30_000);

  it("an edited applied migration is refused (production_migration_changed) before any deploy job", async () => {
    const f = await productionFixture({ withD1: true, files: { "migrations/0001_init.sql": INIT } });
    const runner = new FakeRunner(f.h);
    expect((await f.deploy(await f.publishedRelease())).state).toBe("live");
    const rel2 = await f.publishedRelease({ files: { "migrations/0001_init.sql": "CREATE TABLE contacts (id INTEGER PRIMARY KEY, name TEXT);" } });
    const deploysBefore = runner.handled.filter((j) => j.job.kind === "release-deploy").length;
    await expect(f.deploy(rel2)).rejects.toMatchObject({ status: 409, code: "production_migration_changed" });
    expect(runner.handled.filter((j) => j.job.kind === "release-deploy")).toHaveLength(deploysBefore);
    expect(await f.release(rel2.release_id)).toMatchObject({ state: "failed", error_code: "production_migration_changed" });
    expect(f.h.deployApi.queries.map((q) => q.sql)).toEqual([INIT]);
  }, 30_000);

  it("a data file whose stored bytes differ from the build receipt is refused (release_data_mismatch)", async () => {
    const f = await productionFixture({ withD1: true, files: { "migrations/0001_init.sql": INIT } });
    new FakeRunner(f.h);
    const rel = await f.publishedRelease();
    await f.h.env().COMMONFORGE_ASSETS.put(`org/${f.o.orgId}/releases/${rel.release_id}/api/__data/migrations/0001_init.sql`, "DROP TABLE contacts;");
    await expect(f.deploy(rel)).rejects.toMatchObject({ code: "release_data_mismatch" });
    expect(f.h.deployApi.queries).toEqual([]);
    expect((await f.release(rel.release_id)).error_code).toBe("release_data_mismatch");
  }, 30_000);

  it("release identity covers the migrations: the same accepted version with migrations added is a new release that carries them", async () => {
    const f = await productionFixture({ files: { "migrations/0001_init.sql": INIT } });
    const runner = new FakeRunner(f.h);
    const d1 = await f.createD1("contacts");
    expect((await f.putPolicy({ release: f.releaseWith({ d1: [{ binding: "DB", id: d1 }] }) })).status).toBe(200);
    const r1 = await f.preparedRelease();
    expect(JSON.parse(r1.build_receipt_json!).targets[0].dataFiles).toBeUndefined();
    expect((await f.putPolicy({ release: f.releaseWith({ d1: [{ binding: "DB", id: d1 }], migrations: [{ targetId: "api", binding: "DB", dir: "migrations" }] }) })).status).toBe(200);
    const r2 = await f.preparedRelease();
    expect(r2.accepted_version_id).toBe(r1.accepted_version_id);
    expect(r2.release_id).not.toBe(r1.release_id);
    expect(r2.env_digest).not.toBe(r1.env_digest);
    expect(JSON.parse(r2.build_receipt_json!).targets[0].dataFiles.map((d: { path: string }) => d.path)).toEqual(["migrations/0001_init.sql"]);
    expect(JSON.parse(r2.environment_json)).toMatchObject({ migrations: [{ targetId: "api", binding: "DB", dir: "migrations" }], environment: { api: { data: ["migrations"] } } });
    expect(runner.errors).toEqual([]);
  }, 30_000);
});
