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

const insert = (rid: string, state: string, org = "o") => {
  const now = new Date().toISOString();
  return env.DB.prepare(
    "INSERT INTO folder_inits (org_id, resource_id, project_id, mount_name, requested_by, commit_time, state, created_at, updated_at) VALUES (?, ?, 'p', 'site', 'u', '2026-10-11T12:00:00Z', ?, ?, ?)",
  )
    .bind(org, rid, state, now, now)
    .run();
};

describe("migration 0016", () => {
  it("folder_inits has its columns and the pending index", async () => {
    expect(await columns("folder_inits")).toEqual(
      ["attempts", "commit_sha", "commit_time", "created_at", "error", "first_commit_json", "job_id", "mount_name", "org_id", "project_id", "requested_by", "resource_id", "state", "updated_at"].sort(),
    );
    expect(await indexes("folder_inits")).toEqual(["folder_inits_pending"]);
  });

  it("accepts pending, done and failed; refuses other states; one row per (org, resource); attempts start at 0", async () => {
    for (const s of ["pending", "done", "failed"]) await insert(`r-${s}`, s);
    await expect(insert("r-bogus", "bogus")).rejects.toThrow();
    await expect(insert("r-pending", "pending")).rejects.toThrow(/UNIQUE/);
    await insert("r-pending", "pending", "o2");
    const row = await env.DB.prepare("SELECT attempts, job_id, commit_sha, error FROM folder_inits WHERE org_id = 'o' AND resource_id = 'r-pending'").first();
    expect(row).toEqual({ attempts: 0, job_id: null, commit_sha: null, error: null });
  });
});
