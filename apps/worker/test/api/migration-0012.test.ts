import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

async function columns(table: string): Promise<string[]> {
  const r = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  return r.results.map((c) => c.name).sort();
}
async function indexes(table: string): Promise<string[]> {
  const r = await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL`).bind(table).all<{ name: string }>();
  return r.results.map((c) => c.name).sort();
}

describe("migration 0012", () => {
  it("landings accept promoting/promoted; one open landing per task still holds; d1 deploy resources; parallel promotions with a production claim and landing claims", async () => {
    const now = new Date().toISOString();
    await env.DB.prepare("INSERT INTO staging_landings (landing_id, org_id, project_id, task_id, proposal_id, seq, state, created_by, created_at, updated_at) VALUES ('l1','o','p','t','pr',1,'promoting','u',?,?)").bind(now, now).run();
    await expect(env.DB.prepare("INSERT INTO staging_landings (landing_id, org_id, project_id, task_id, proposal_id, seq, state, created_by, created_at, updated_at) VALUES ('l2','o','p','t','pr',2,'landed','u',?,?)").bind(now, now).run()).rejects.toThrow();
    await env.DB.prepare("INSERT INTO staging_landings (landing_id, org_id, project_id, task_id, proposal_id, seq, state, created_by, created_at, updated_at) VALUES ('l3','o','p','t3','pr',3,'promoted','u',?,?)").bind(now, now).run();
    await expect(env.DB.prepare("INSERT INTO staging_landings (landing_id, org_id, project_id, task_id, proposal_id, seq, state, created_by, created_at, updated_at) VALUES ('l4','o','p','t4','pr',4,'bogus','u',?,?)").bind(now, now).run()).rejects.toThrow();
    await env.DB.prepare("INSERT INTO org_deploy_resources (org_id, kind, name, resource_id, created_by, created_at) VALUES ('o','d1','contacts','0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b','u',?)").bind(now).run();
    await expect(env.DB.prepare("INSERT INTO org_deploy_resources (org_id, kind, name, resource_id, created_by, created_at) VALUES ('o','r2','x','id-x','u',?)").bind(now).run()).rejects.toThrow();
    await env.DB.prepare("INSERT INTO promotions (promotion_id, org_id, project_id, target_landing_id, landings_json, state, requested_by, created_at, updated_at) VALUES ('pm1','o','p','l1','[]','requested','u',?,?)").bind(now, now).run();
    const ins = (id: string, st: string) => env.DB.prepare("INSERT INTO promotions (promotion_id, org_id, project_id, target_landing_id, landings_json, state, requested_by, created_at, updated_at) VALUES (?,'o','p','l1','[]',?,'u',?,?)").bind(id, st, now, now).run();
    // parallel promotions: two in flight in one project are fine
    await ins("pm2", "building");
    await ins("pm4", "withdrawn");
    // production claim: one accepting/releasing per project
    await env.DB.prepare("UPDATE promotions SET state = 'accepting' WHERE promotion_id = 'pm1'").run();
    await expect(env.DB.prepare("UPDATE promotions SET state = 'releasing' WHERE promotion_id = 'pm2'").run()).rejects.toThrow(/UNIQUE/);
    // a landing in at most one active claim
    const claim = (id: string) => env.DB.prepare("INSERT INTO promotion_landings (promotion_id, landing_id, org_id, project_id, created_at) VALUES (?,'l1','o','p',?)").bind(id, now).run();
    await claim("pm1");
    await expect(claim("pm2")).rejects.toThrow(/UNIQUE/);
    await env.DB.prepare("UPDATE promotion_landings SET active = 0 WHERE promotion_id = 'pm1'").run();
    await claim("pm2");
  });

  it("rebuilt tables keep every earlier column and index; new columns and tables exist", async () => {
    expect(await columns("staging_landings")).toEqual(["created_at", "created_by", "detail", "landing_id", "org_id", "project_id", "proposal_id", "reason", "reason_code", "seq", "state", "task_id", "updated_at"]);
    expect(await indexes("staging_landings")).toEqual(["staging_landings_by_task", "staging_landings_open_per_task"]);
    expect(await columns("org_deploy_resources")).toEqual(["created_at", "created_by", "kind", "name", "org_id", "resource_id"]);
    expect(await columns("staging_landing_parts")).toEqual(["created_at", "landing_id", "part", "proposal_id", "task_id"]);
    expect(await columns("production_migrations")).toEqual(["applied_at", "key", "org_id", "release_id", "resource_id", "started_at", "state"]);
    expect(await columns("proposals_index")).toEqual(expect.arrayContaining(["kind", "promotion_id"]));
    expect(await columns("tasks")).toContain("revises_task_id");
    expect(await indexes("promotions")).toEqual(["promotions_by_project", "promotions_by_state", "promotions_production_claim"]);
    expect(await columns("promotions")).toEqual(expect.arrayContaining(["claimed_at", "mode", "going_without_json", "needs_json", "chain_at"]));
    expect(await columns("promotion_landings")).toEqual(["active", "created_at", "landing_id", "org_id", "project_id", "promotion_id"]);
    expect(await columns("staging_landing_links")).toEqual(["created_at", "created_by", "landing_id", "org_id", "project_id", "with_landing_id"]);
    expect(await columns("staging_baselines")).toEqual(["accepted_version_id", "established_at", "org_id", "project_id", "release_id", "sources_json"]);
    // the org_deploy_resources resource_id uniqueness survives the rebuild
    const now = new Date().toISOString();
    await env.DB.prepare("INSERT INTO org_deploy_resources (org_id, kind, name, resource_id, created_by, created_at) VALUES ('o9','kv','a','dup','u',?)").bind(now).run();
    await expect(env.DB.prepare("INSERT INTO org_deploy_resources (org_id, kind, name, resource_id, created_by, created_at) VALUES ('o9','d1','b','dup','u',?)").bind(now).run()).rejects.toThrow();
  });
});
