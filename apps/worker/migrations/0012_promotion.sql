-- apps/worker/migrations/0011_promotion.sql
-- Staging phase 2: promotion to production (spec 2026-10-07 §7). Promotions and landing parts are
-- D1 state (Phase 2 ruling R1); the ledger sees only the promotion proposal, its approvals
-- (clearances) and the accept.

-- One promotion of a set of landings. Promotions run in parallel on disjoint landing sets (promotion_landings); accept and release take turns per project (B2).
CREATE TABLE promotions (
  promotion_id      TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL,
  project_id        TEXT NOT NULL,
  target_landing_id TEXT NOT NULL,
  landings_json     TEXT NOT NULL,           -- ordered landing ids in the set
  proposal_hashes_json TEXT NOT NULL DEFAULT '[]', -- the parts' proposal hashes, in set order (clearance key input)
  proposal_id       TEXT,                    -- the current promotion proposal (prop-pro-*)
  proposal_hash     TEXT,
  integrate_job_id  TEXT,
  merge_bases_json  TEXT,                    -- {candidateId: base sha} for the promotion build
  state             TEXT NOT NULL CHECK (state IN ('requested', 'building', 'gating', 'pending_approval', 'cleared', 'accepting', 'releasing', 'live', 'failed', 'release_failed', 'sent_back', 'superseded', 'withdrawn')),
  level             TEXT CHECK (level IN ('self', 'classify', 'developer')),
  gate_json         TEXT,                    -- { perPath, veto: {kind, offending}, classifier } (developers only)
  clearance_kind    TEXT CHECK (clearance_kind IN ('self', 'classifier', 'developer')),
  clearance_key     TEXT,
  cleared_by        TEXT,
  cleared_at        TEXT,
  policy_revision   INTEGER,
  accepted_version_id TEXT,
  release_id        TEXT,
  reason_code       TEXT,
  reason            TEXT,                    -- client-safe text, or the developer's send-back note
  detail            TEXT,                    -- raw error (owners and developers only)
  requested_by      TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  machine_since     TEXT,                    -- when it last entered 'requested' from outside requested/building/gating (the 6 h deadline)
  rebuilds          INTEGER NOT NULL DEFAULT 0, -- rebuilds because main moved by something other than this project's promotions (capped)
  promotion_rebuilds INTEGER NOT NULL DEFAULT 0, -- rebuilds because only this project's promotions moved main (not capped; bounded by the deadline)
  job_attempts      INTEGER NOT NULL DEFAULT 0, -- integrate jobs reissued for the current proposal hash (capped)
  chain_at          TEXT,                    -- heartbeat of the promotion.advance chain (NULL: no chain running)
  claimed_at        TEXT,                    -- when it took production (entered 'accepting'); the accept deadline's start (B2)
  mode              TEXT NOT NULL DEFAULT 'closure' CHECK (mode IN ('alone', 'closure')), -- alone-first (B8)
  going_without_json TEXT NOT NULL DEFAULT '[]', -- [{landingId, taskId, title}] earlier overlapping landings left in staging
  needs_json        TEXT NOT NULL DEFAULT '[]'  -- [{landingId, taskId, title}] landings added when an alone build widened
);
CREATE INDEX promotions_by_project ON promotions (org_id, project_id, created_at);
CREATE UNIQUE INDEX promotions_production_claim ON promotions (org_id, project_id)
  WHERE state IN ('accepting', 'releasing');
CREATE INDEX promotions_by_state ON promotions (org_id, project_id, state);

-- A landing's parts: the original task's proposal (part 1) and each revision's proposal (R6).
CREATE TABLE staging_landing_parts (
  landing_id  TEXT NOT NULL,
  part        INTEGER NOT NULL,
  task_id     TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (landing_id, part)
);
INSERT INTO staging_landing_parts (landing_id, part, task_id, proposal_id, created_at)
  SELECT landing_id, 1, task_id, proposal_id, created_at FROM staging_landings;

-- Landings gain 'promoting' and 'promoted' (table rebuild: SQLite cannot alter a CHECK).
CREATE TABLE staging_landings_v2 (
  landing_id   TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL,
  project_id   TEXT NOT NULL,
  task_id      TEXT NOT NULL,
  proposal_id  TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('checking', 'landed', 'failed', 'rolling_back', 'rolled_back', 'promoting', 'promoted')),
  reason_code  TEXT,
  reason       TEXT,
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  detail       TEXT,
  UNIQUE (org_id, project_id, seq)
);
INSERT INTO staging_landings_v2 (landing_id, org_id, project_id, task_id, proposal_id, seq, state, reason_code, reason, created_by, created_at, updated_at, detail)
  SELECT landing_id, org_id, project_id, task_id, proposal_id, seq, state, reason_code, reason, created_by, created_at, updated_at, detail FROM staging_landings;
DROP TABLE staging_landings;
ALTER TABLE staging_landings_v2 RENAME TO staging_landings;
CREATE INDEX staging_landings_by_task ON staging_landings (org_id, task_id);
CREATE UNIQUE INDEX staging_landings_open_per_task ON staging_landings (org_id, task_id) WHERE state IN ('checking', 'landed', 'rolling_back', 'promoting');

-- Proposals: landing ('staging'), promotion ('promotion') or ordinary (NULL).
ALTER TABLE proposals_index ADD COLUMN kind TEXT CHECK (kind IN ('staging', 'promotion'));
ALTER TABLE proposals_index ADD COLUMN promotion_id TEXT;
UPDATE proposals_index SET kind = 'staging' WHERE proposal_id LIKE 'prop-stg-%';

-- Revisions: a follow-up task names the task it revises.
ALTER TABLE tasks ADD COLUMN revises_task_id TEXT;
-- The staging build a task was seeded from (NULL: from the heads). A revision's landing builds on
-- that build's landings, which may come later than its own (promotion sets, Task 9 review).
ALTER TABLE tasks ADD COLUMN staging_build_id TEXT;

-- Org-owned production D1 (R8): org_deploy_resources gains kind 'd1' (table rebuild).
CREATE TABLE org_deploy_resources_v2 (
  org_id      TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('kv', 'd1')),
  name        TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (org_id, kind, name),
  UNIQUE (resource_id)
);
INSERT INTO org_deploy_resources_v2 SELECT org_id, kind, name, resource_id, created_by, created_at FROM org_deploy_resources;
DROP TABLE org_deploy_resources;
ALTER TABLE org_deploy_resources_v2 RENAME TO org_deploy_resources;

-- Migrations applied to production D1 databases (never re-run; key = name@sha256). A row is
-- written as 'applying' BEFORE the query is sent and becomes 'applied' when D1 confirms it; a row
-- left 'applying' (no answer, 5xx) has an unknown outcome and blocks deploys until an owner
-- resolves it (POST /api/orgs/:org/production-migrations/resolve).
CREATE TABLE production_migrations (
  org_id      TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  key         TEXT NOT NULL,
  release_id  TEXT NOT NULL,
  state       TEXT NOT NULL CHECK (state IN ('applying', 'applied')),
  started_at  TEXT NOT NULL,
  applied_at  TEXT,
  PRIMARY KEY (resource_id, key)
);

-- Which landings each promotion holds (B1). A landing is in at most one in-flight promotion:
-- active = 1 from the request (or a widen) until the promotion ends or is accepted.
CREATE TABLE promotion_landings (
  promotion_id TEXT NOT NULL,
  landing_id   TEXT NOT NULL,
  org_id       TEXT NOT NULL,
  project_id   TEXT NOT NULL,
  active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at   TEXT NOT NULL,
  PRIMARY KEY (promotion_id, landing_id)
);
CREATE UNIQUE INDEX promotion_landings_one_active ON promotion_landings (landing_id) WHERE active = 1;

-- "Must travel with": a landing is promoted only together with an earlier one (B9).
CREATE TABLE staging_landing_links (
  landing_id      TEXT NOT NULL,
  with_landing_id TEXT NOT NULL,
  org_id          TEXT NOT NULL,
  project_id      TEXT NOT NULL,
  created_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  PRIMARY KEY (landing_id, with_landing_id)
);
CREATE INDEX staging_landing_links_by_project ON staging_landing_links (org_id, project_id);

-- The owner's production publish that staging starts from (B6): production equalled main on every
-- release source when this release was live. Permanent.
CREATE TABLE staging_baselines (
  org_id              TEXT NOT NULL,
  project_id          TEXT NOT NULL,
  release_id          TEXT NOT NULL,
  accepted_version_id TEXT NOT NULL,
  sources_json        TEXT NOT NULL,           -- {resourceId: revisionId} of that release
  established_at      TEXT NOT NULL,
  PRIMARY KEY (org_id, project_id)
);
