-- Always-on staging (spec 2026-10-07). Staging composition is D1 state (like releases and
-- previews): it never moves a ledger head and is rebuilt from main + landings on every change.

-- Platform-owned staging D1/KV per project binding; a reset creates the next generation.
CREATE TABLE staging_resources (
  org_id                  TEXT NOT NULL,
  project_id              TEXT NOT NULL,
  target_id               TEXT NOT NULL,
  kind                    TEXT NOT NULL CHECK (kind IN ('d1', 'kv')),
  binding                 TEXT NOT NULL,
  generation              INTEGER NOT NULL,
  resource_id             TEXT NOT NULL UNIQUE,
  state                   TEXT NOT NULL CHECK (state IN ('active', 'retired')),
  applied_migrations_json TEXT NOT NULL DEFAULT '[]',
  seeded                  INTEGER NOT NULL DEFAULT 0,
  created_at              TEXT NOT NULL,
  PRIMARY KEY (org_id, project_id, target_id, kind, binding, generation)
);

-- One landed task (its proposal is its change set). seq orders the composition.
CREATE TABLE staging_landings (
  landing_id   TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL,
  project_id   TEXT NOT NULL,
  task_id      TEXT NOT NULL,
  proposal_id  TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('checking', 'landed', 'failed', 'rolling_back', 'rolled_back')),
  reason_code  TEXT,
  reason       TEXT,
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE (org_id, project_id, seq)
);
CREATE INDEX staging_landings_by_task ON staging_landings (org_id, task_id);

-- One staging revision: main shas + ordered landings, merged, built, deployed.
CREATE TABLE staging_builds (
  build_id          TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL,
  project_id        TEXT NOT NULL,
  seq               INTEGER NOT NULL,
  landings_json     TEXT NOT NULL,          -- ordered landing ids
  reset             INTEGER NOT NULL DEFAULT 0,
  state             TEXT NOT NULL CHECK (state IN ('queued', 'merging', 'building', 'deploying', 'live', 'failed', 'superseded')),
  merge_job_id      TEXT,
  staging_json      TEXT,                   -- {resourceId: {sha, revisionId}} after the merge
  release_id        TEXT,
  error_code        TEXT,
  error             TEXT,
  created_by        TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (org_id, project_id, seq)
);

-- Outbound calls staging made to its capture vars (kept 7 days).
CREATE TABLE staging_captures (
  capture_id   TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL,
  project_id   TEXT NOT NULL,
  received_at  TEXT NOT NULL,
  method       TEXT NOT NULL,
  path         TEXT NOT NULL,
  headers_json TEXT NOT NULL,
  body         TEXT NOT NULL,
  truncated    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX staging_captures_by_project ON staging_captures (org_id, project_id, received_at);
CREATE TABLE staging_sinks (
  org_id     TEXT NOT NULL,
  project_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (org_id, project_id)
);
