-- apps/worker/migrations/0014_file_changes_staged.sql
-- Staging promotion and LFS (decision taken: file changes go through promotion). In a staging-mode
-- project a git folder's file change stops at staging (`staged`) and reaches main only when a
-- promotion accepts its landing. Table rebuild: SQLite cannot alter a CHECK. Runs after 0013 in
-- every environment (it copies 0013's idempotency_key and recreates the indexes of 0011 and 0013);
-- nothing has a foreign key into file_changes.
CREATE TABLE file_changes_v2 (
  change_id         TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL,
  project_id        TEXT NOT NULL,
  resource_id       TEXT NOT NULL,
  mount_name        TEXT NOT NULL,
  user_id           TEXT NOT NULL,
  title             TEXT NOT NULL,
  ops_json          TEXT NOT NULL,
  has_edits         INTEGER NOT NULL,
  state             TEXT NOT NULL CHECK (state IN ('applying', 'checking', 'waiting_approval', 'staged', 'added', 'failed')),
  attempt           INTEGER NOT NULL DEFAULT 1,
  task_id           TEXT,
  task_workspace_id TEXT,
  job_id            TEXT,
  base_revision     TEXT,
  receipt_json      TEXT,
  proposal_id       TEXT,
  error_code        TEXT,
  error             TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  idempotency_key   TEXT
);
INSERT INTO file_changes_v2 (change_id, org_id, project_id, resource_id, mount_name, user_id, title, ops_json, has_edits, state, attempt, task_id, task_workspace_id, job_id, base_revision, receipt_json, proposal_id, error_code, error, created_at, updated_at, idempotency_key)
  SELECT change_id, org_id, project_id, resource_id, mount_name, user_id, title, ops_json, has_edits, state, attempt, task_id, task_workspace_id, job_id, base_revision, receipt_json, proposal_id, error_code, error, created_at, updated_at, idempotency_key FROM file_changes;
DROP TABLE file_changes;
ALTER TABLE file_changes_v2 RENAME TO file_changes;
-- 0011
CREATE INDEX file_changes_by_job ON file_changes (job_id);
CREATE INDEX file_changes_by_proposal ON file_changes (proposal_id);
CREATE INDEX file_changes_by_task ON file_changes (task_id);
CREATE INDEX file_changes_waiting ON file_changes (org_id, resource_id, state);
-- 0013
CREATE INDEX file_changes_by_project ON file_changes (org_id, project_id, created_at);
CREATE UNIQUE INDEX file_changes_by_idempotency_key ON file_changes (org_id, user_id, idempotency_key);
