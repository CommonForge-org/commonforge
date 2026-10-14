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

const insert = (id: string, state: string, key: string | null = null) => {
  const now = new Date().toISOString();
  return env.DB.prepare(
    "INSERT INTO file_changes (change_id, org_id, project_id, resource_id, mount_name, user_id, title, ops_json, has_edits, state, attempt, created_at, updated_at, idempotency_key) VALUES (?, 'o', 'p', 'r', 'site', 'u', 't', '[]', 0, ?, 1, ?, ?, ?)",
  )
    .bind(id, state, now, now, key)
    .run();
};

describe("migration 0014", () => {
  it("file changes accept `staged`; other states are still refused", async () => {
    await insert("fc-staged", "staged");
    for (const s of ["applying", "checking", "waiting_approval", "added", "failed"]) await insert(`fc-${s}`, s);
    await expect(insert("fc-bogus", "bogus")).rejects.toThrow();
  });

  it("the rebuilt table keeps every column of 0011 and 0013 and every index; the idempotency key is still unique per user", async () => {
    expect(await columns("file_changes")).toEqual(
      ["attempt", "base_revision", "change_id", "created_at", "error", "error_code", "has_edits", "idempotency_key", "job_id", "mount_name", "ops_json", "org_id", "project_id", "proposal_id", "receipt_json", "resource_id", "state", "task_id", "task_workspace_id", "title", "updated_at", "user_id"].sort(),
    );
    expect(await indexes("file_changes")).toEqual(["file_changes_by_idempotency_key", "file_changes_by_job", "file_changes_by_project", "file_changes_by_proposal", "file_changes_by_task", "file_changes_waiting"]);
    await insert("fc-k1", "applying", "key-1");
    await expect(insert("fc-k2", "applying", "key-1")).rejects.toThrow(/UNIQUE/);
  });

  it("every row and value survives the rebuild (the migration's statements run again over a full row)", async () => {
    const now = new Date().toISOString();
    const row = ["fc-full", "o", "p", "r", "site", "u", "Title", '[{"delete":"a"}]', 1, "waiting_approval", 2, "task-1", "tw-1", "job-1", "art:x:y", '{"changeId":"fc-full"}', "prop-fc-1", "code", "error", now, now, "key-full"];
    const cols = "change_id, org_id, project_id, resource_id, mount_name, user_id, title, ops_json, has_edits, state, attempt, task_id, task_workspace_id, job_id, base_revision, receipt_json, proposal_id, error_code, error, created_at, updated_at, idempotency_key";
    await env.DB.prepare(`INSERT INTO file_changes (${cols}) VALUES (${row.map(() => "?").join(", ")})`).bind(...row).run();
    const m = (env.TEST_MIGRATIONS as Array<{ name: string; queries: string[] }>).find((x) => x.name.startsWith("0014_"))!;
    expect(m).toBeTruthy();
    for (const q of m.queries) await env.DB.prepare(q).run();
    const after = await env.DB.prepare(`SELECT ${cols} FROM file_changes WHERE change_id = 'fc-full'`).first<Record<string, unknown>>();
    expect(Object.values(after!)).toEqual(row);
    expect(await indexes("file_changes")).toHaveLength(6);
  });
});
