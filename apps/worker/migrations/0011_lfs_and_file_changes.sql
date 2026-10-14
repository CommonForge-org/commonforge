-- apps/worker/migrations/0011_lfs_and_file_changes.sql
-- Folders and uploads, phase 2 (spec 2026-10-07 §4–§7). One R2 key per LFS object
-- (org/<org>/lfs/<resourceId>/obj/<stagingId>); "accepted" is accepted_at, bytes never move.

CREATE TABLE lfs_objects (
  staging_id   TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL,
  resource_id  TEXT NOT NULL,
  r2_key       TEXT NOT NULL UNIQUE,
  size         INTEGER NOT NULL,
  -- git-lfs uploads name their oid up front; browser uploads learn it from the hash step
  claimed_oid  TEXT,
  -- verified by the hash step (lfs.hash); NULL until then
  sha256       TEXT,
  binary       INTEGER,
  -- the R2 etag of the bytes the hash step hashed: everything that serves or uses the object pins it
  -- (a presigned PUT can overwrite the key until it expires; changed bytes are never served)
  etag         TEXT,
  -- times the GC re-enqueued the hash step of an object stuck in 'uploaded' (at most 3, then rejected)
  hash_attempts INTEGER NOT NULL DEFAULT 0,
  state        TEXT NOT NULL CHECK (state IN ('uploading', 'uploaded', 'verified', 'rejected')),
  accepted_at  TEXT,
  source       TEXT NOT NULL CHECK (source IN ('browser', 'lfs')),
  -- the uploader (for an agent: the lease holder)
  user_id      TEXT NOT NULL,
  -- agent uploads: the task whose staging area this is
  task_id      TEXT,
  -- browser uploads: the R2 multipart upload id while uploading
  upload_id    TEXT,
  path         TEXT,
  mime         TEXT,
  error        TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  last_used_at TEXT NOT NULL
);
CREATE INDEX lfs_objects_by_oid ON lfs_objects (org_id, resource_id, sha256);
CREATE INDEX lfs_objects_by_claim ON lfs_objects (org_id, resource_id, claimed_oid, state);
CREATE INDEX lfs_objects_by_state ON lfs_objects (org_id, state, last_used_at);
CREATE INDEX lfs_objects_by_task ON lfs_objects (task_id);

-- an accepted agent proposal: its task's objects in these resources are accepted, including ones
-- the hash step verifies only afterwards
CREATE TABLE lfs_task_promotions (
  org_id      TEXT NOT NULL,
  task_id     TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  PRIMARY KEY (task_id, resource_id)
);

CREATE TABLE file_changes (
  change_id         TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL,
  project_id        TEXT NOT NULL,
  resource_id       TEXT NOT NULL,
  mount_name        TEXT NOT NULL,
  user_id           TEXT NOT NULL,
  title             TEXT NOT NULL,
  ops_json          TEXT NOT NULL,
  has_edits         INTEGER NOT NULL,
  state             TEXT NOT NULL CHECK (state IN ('applying', 'checking', 'waiting_approval', 'added', 'failed')),
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
  updated_at        TEXT NOT NULL
);
CREATE INDEX file_changes_by_job ON file_changes (job_id);
CREATE INDEX file_changes_by_proposal ON file_changes (proposal_id);
CREATE INDEX file_changes_by_task ON file_changes (task_id);
CREATE INDEX file_changes_waiting ON file_changes (org_id, resource_id, state);

-- which objects a change references (expiry never deletes an object an unfinished change needs)
CREATE TABLE file_change_objects (
  change_id  TEXT NOT NULL,
  staging_id TEXT NOT NULL,
  PRIMARY KEY (change_id, staging_id)
);
CREATE INDEX file_change_objects_by_object ON file_change_objects (staging_id);
