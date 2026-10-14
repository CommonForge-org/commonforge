-- apps/worker/migrations/0016_folder_inits.sql
-- Folders phase 4 (Add folder, one kind; ruling P4-1): a new folder's first commit is made by the
-- runner's `init-folder` job and bound as the folder's genesis head. One row per folder being set
-- up: the request (who, which mount, the fixed commit time that makes the commit id deterministic,
-- P4-3), the first job's content once issued (reused by every later attempt), the attempts (at most
-- 3; GC re-queues a stale `pending`), and the outcome. Retry resets the attempts.
CREATE TABLE folder_inits (
  org_id       TEXT NOT NULL,
  resource_id  TEXT NOT NULL,
  project_id   TEXT NOT NULL,
  mount_name   TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  commit_time  TEXT NOT NULL,          -- ISO, whole seconds: the first commit's author/committer time
  state        TEXT NOT NULL CHECK (state IN ('pending', 'done', 'failed')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  job_id       TEXT,
  commit_sha   TEXT,
  first_commit_json TEXT,              -- the first job's files, author and message: every later attempt (and Try again) reuses them, so the commit id never changes (P4-3)
  error        TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (org_id, resource_id)
);
CREATE INDEX folder_inits_pending ON folder_inits (state, updated_at) WHERE state = 'pending';
