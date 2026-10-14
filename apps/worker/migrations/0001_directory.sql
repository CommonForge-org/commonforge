-- CommonForge directory (D1). Identity, membership, grants, project layout, task/job bookkeeping.
-- Authority over accepted state (heads, proposals, candidates, approvals, receipts) lives in the
-- OrgLedger Durable Object; rows here that mirror ledger records are indexes/projections only.

CREATE TABLE users (
  user_id      TEXT PRIMARY KEY,
  email        TEXT NOT NULL UNIQUE,
  display_name TEXT,
  created_at   TEXT NOT NULL
);

-- Magic-link tokens: only an HMAC of the token is stored; single use.
CREATE TABLE magic_links (
  token_hash  TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  -- web: consumed by POST /api/auth/verify (cookie); cli: by POST /api/auth/cli/verify (bearer)
  purpose     TEXT NOT NULL DEFAULT 'web' CHECK (purpose IN ('web', 'cli')),
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE INDEX magic_links_by_email ON magic_links (email, created_at);

CREATE TABLE sessions (
  session_hash TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users (user_id),
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  revoked_at   INTEGER
);
CREATE INDEX sessions_by_user ON sessions (user_id);

CREATE TABLE orgs (
  org_id     TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE memberships (
  org_id     TEXT NOT NULL REFERENCES orgs (org_id),
  user_id    TEXT NOT NULL REFERENCES users (user_id),
  role       TEXT NOT NULL CHECK (role IN ('owner', 'developer', 'client', 'viewer')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX memberships_by_user ON memberships (user_id);

CREATE TABLE projects (
  org_id              TEXT NOT NULL REFERENCES orgs (org_id),
  project_id          TEXT NOT NULL,
  name                TEXT NOT NULL,
  membership_revision INTEGER NOT NULL DEFAULT 0,
  policy_revision     INTEGER NOT NULL DEFAULT 0,
  -- server-owned policy (checks, contracts, approval roles); never read from repository files
  policy_json         TEXT NOT NULL DEFAULT '{}',
  created_by          TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  PRIMARY KEY (org_id, project_id)
);

CREATE TABLE resources (
  org_id      TEXT NOT NULL REFERENCES orgs (org_id),
  resource_id TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  provider    TEXT NOT NULL CHECK (provider IN ('artifacts', 'r2-assets')),
  state       TEXT NOT NULL CHECK (state IN ('empty', 'importing', 'active', 'failed')),
  coords_json TEXT,
  -- branch recorded explicitly (Artifacts import misreports default_branch, spike A6)
  branch      TEXT,
  source_json TEXT,
  error       TEXT,
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (org_id, resource_id)
);

CREATE TABLE mounts (
  org_id          TEXT NOT NULL,
  project_id      TEXT NOT NULL,
  mount_name      TEXT NOT NULL,
  resource_id     TEXT NOT NULL,
  mode            TEXT NOT NULL CHECK (mode IN ('pinned-reference', 'must-match-accepted')),
  operations_json TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  PRIMARY KEY (org_id, project_id, mount_name),
  FOREIGN KEY (org_id, project_id) REFERENCES projects (org_id, project_id)
);
CREATE INDEX mounts_by_resource ON mounts (org_id, resource_id);

-- Per-principal grants (projection; owners have implicit access). scope_kind project|resource.
CREATE TABLE grants (
  org_id          TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  scope_kind      TEXT NOT NULL CHECK (scope_kind IN ('project', 'resource')),
  scope_id        TEXT NOT NULL,
  operations_json TEXT NOT NULL,
  granted_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  PRIMARY KEY (org_id, user_id, scope_kind, scope_id)
);

CREATE TABLE tasks (
  task_id          TEXT PRIMARY KEY,
  org_id           TEXT NOT NULL,
  project_id       TEXT NOT NULL,
  change_id        TEXT NOT NULL,
  title            TEXT NOT NULL,
  request          TEXT NOT NULL,
  state            TEXT NOT NULL CHECK (state IN ('provisioning', 'ready', 'running', 'submitted', 'failed', 'canceled')),
  snapshot_json    TEXT NOT NULL,
  created_by       TEXT NOT NULL,
  lease_hash       TEXT UNIQUE,
  lease_generation INTEGER NOT NULL DEFAULT 0,
  lease_expires_at INTEGER,
  lease_holder     TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX tasks_by_project ON tasks (org_id, project_id);

CREATE TABLE task_workspaces (
  task_workspace_id TEXT PRIMARY KEY,
  task_id           TEXT NOT NULL REFERENCES tasks (task_id),
  org_id            TEXT NOT NULL,
  resource_id       TEXT NOT NULL,
  mount_name        TEXT NOT NULL,
  provider          TEXT NOT NULL,
  -- write: the task's writable copy; read: a read-only reference copy seeded at the pinned sha
  access            TEXT NOT NULL DEFAULT 'write' CHECK (access IN ('write', 'read')),
  base_revision     TEXT NOT NULL,
  state             TEXT NOT NULL CHECK (state IN ('provisioning', 'writable', 'freezing', 'frozen', 'failed', 'abandoned', 'collected')),
  attempts          INTEGER NOT NULL DEFAULT 0,
  error             TEXT,
  -- r2-assets mounts: the manifest the task produced (asset "candidate")
  asset_manifest_id TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (task_id, resource_id)
);

CREATE TABLE task_candidates (
  candidate_id      TEXT PRIMARY KEY,
  task_id           TEXT NOT NULL,
  org_id            TEXT NOT NULL,
  resource_id       TEXT NOT NULL,
  task_workspace_id TEXT NOT NULL,
  created_at        TEXT NOT NULL
);
CREATE INDEX task_candidates_by_task ON task_candidates (task_id);

CREATE TABLE proposals_index (
  proposal_id TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL,
  project_id  TEXT NOT NULL,
  task_id     TEXT,
  -- full snapshots (the ledger keeps only their ids)
  base_snapshot_json      TEXT NOT NULL,
  candidate_snapshot_json TEXT NOT NULL,
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX proposals_by_project ON proposals_index (org_id, project_id);

CREATE TABLE runner_jobs (
  job_id       TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL,
  kind         TEXT NOT NULL,
  -- sha256 of the canonical job body: a retried step waits on the same open job
  job_key      TEXT NOT NULL,
  subject      TEXT,
  signed_json  TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('queued', 'succeeded', 'failed')),
  result_json  TEXT,
  result_hash  TEXT,
  issued_at    INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  completed_at INTEGER,
  -- pull mode (POST /api/runner/jobs/next): which runner claimed the job and when
  claimed_by   TEXT,
  claimed_at   INTEGER
);
CREATE INDEX runner_jobs_by_key ON runner_jobs (job_key, status);
CREATE INDEX runner_jobs_by_subject ON runner_jobs (org_id, subject);
CREATE INDEX runner_jobs_open ON runner_jobs (status, issued_at);

CREATE TABLE runner_job_tokens (
  job_id     TEXT NOT NULL,
  namespace  TEXT NOT NULL,
  repo_name  TEXT NOT NULL,
  token_id   TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (job_id, token_id)
);

CREATE TABLE intakes (
  intake_id    TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('url', 'zip')),
  state        TEXT NOT NULL,
  request_json TEXT NOT NULL,
  r2_key       TEXT,
  job_id       TEXT,
  inventory_json TEXT,
  plan_json    TEXT,
  result_json  TEXT,
  error        TEXT,
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX intakes_by_org ON intakes (org_id);

CREATE TABLE exports (
  export_id    TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL,
  project_id   TEXT NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('queued', 'succeeded', 'failed')),
  snapshot_json TEXT NOT NULL,
  job_id       TEXT,
  receipt_json TEXT,
  error        TEXT,
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- Application activity (task.started, candidate.frozen, ...). Ledger audit stays in OrgLedger.
CREATE TABLE events (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id         TEXT NOT NULL,
  project_id     TEXT,
  at             TEXT NOT NULL,
  actor_json     TEXT NOT NULL,
  action         TEXT NOT NULL,
  subject_kind   TEXT NOT NULL,
  subject_id     TEXT NOT NULL,
  detail_json    TEXT,
  -- resources the event is about: every one must be readable by the caller (empty: org-level, owners only unless project-scoped)
  resource_ids   TEXT NOT NULL DEFAULT '[]',
  client_visible INTEGER NOT NULL DEFAULT 0,
  -- what clients/viewers see instead of detail_json (never raw runner output)
  client_detail_json TEXT
);
CREATE INDEX events_by_org ON events (org_id, seq);
