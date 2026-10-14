-- Task 22: isolated previews and the gated release service (plan §A.5 rule 6, §A.6, §C.1 rows 10-11).
-- Approval (ledger) ≠ acceptance (ledger) ≠ publish approval (here) ≠ release (here): separate records.

-- One private preview of a proposal's integration commits (state machine: core PreviewState).
CREATE TABLE previews (
  preview_id    TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  project_id    TEXT NOT NULL,
  proposal_id   TEXT NOT NULL,
  proposal_hash TEXT NOT NULL,
  state         TEXT NOT NULL CHECK (state IN ('queued', 'building', 'ready', 'failed', 'expired')),
  -- {resourceId: sha} the preview was built from
  sources_json  TEXT NOT NULL,
  recipe_json   TEXT NOT NULL,
  -- non-secret vars for the preview host (fixture bindings are added by the host)
  host_vars_json TEXT NOT NULL DEFAULT '{}',
  ttl_seconds   INTEGER NOT NULL,
  job_id        TEXT,
  receipt_json  TEXT,
  error_code    TEXT,
  error         TEXT,
  -- link expiry (ms since epoch); set when the preview becomes ready
  expires_at    INTEGER,
  revoked_at    INTEGER,
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX previews_by_proposal ON previews (org_id, proposal_id, created_at);

-- A release: {acceptedVersionId, recipe revision, envDigest} fixed at prepare; outputDigest after build.
CREATE TABLE releases (
  release_id          TEXT PRIMARY KEY,
  org_id              TEXT NOT NULL,
  project_id          TEXT NOT NULL,
  accepted_version_id TEXT NOT NULL,
  -- {resourceId: revisionId} the release builds from (the heads at acceptedVersionId)
  sources_json        TEXT NOT NULL,
  recipe_json         TEXT NOT NULL,
  recipe_revision     INTEGER NOT NULL,
  policy_revision     INTEGER NOT NULL,
  -- server-owned release environment (targets, vars, bindings) and its digest
  environment_json    TEXT NOT NULL,
  env_digest          TEXT NOT NULL,
  -- sha256 of the identity inputs; one live (not failed-to-build) release per identity
  identity_key        TEXT NOT NULL,
  -- core ReleaseState
  state               TEXT NOT NULL CHECK (state IN ('not_requested', 'prepared', 'publish_approved', 'deploying', 'health_verification', 'live', 'failed', 'partial', 'recovery_required')),
  build_state         TEXT NOT NULL CHECK (build_state IN ('building', 'built', 'failed')),
  build_job_id        TEXT,
  build_receipt_json  TEXT,
  output_digest       TEXT,
  deploy_job_id       TEXT,
  deploy_attempts     INTEGER NOT NULL DEFAULT 0,
  deploy_receipt_json TEXT,
  health_json         TEXT,
  error_code          TEXT,
  error               TEXT,
  created_by          TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX releases_by_project ON releases (org_id, project_id, created_at);
CREATE INDEX releases_by_identity ON releases (org_id, identity_key);

-- Publish approvals: bound to the exact release id AND output digest (AT-33), role-checked.
CREATE TABLE release_publish_approvals (
  approval_id   TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  release_id    TEXT NOT NULL,
  output_digest TEXT NOT NULL,
  env_digest    TEXT NOT NULL,
  approver      TEXT NOT NULL,
  role          TEXT NOT NULL,
  approved_at   TEXT NOT NULL
);
CREATE INDEX release_approvals_by_release ON release_publish_approvals (release_id);

-- Deploy requests by idempotency key: a retried request never starts a second deploy.
CREATE TABLE release_deploy_requests (
  org_id          TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  release_id      TEXT NOT NULL,
  attempt         INTEGER NOT NULL,
  job_id          TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  PRIMARY KEY (org_id, idempotency_key)
);

-- The live pointer per project: moves only after a deploy passed its health check.
CREATE TABLE release_live (
  org_id              TEXT NOT NULL,
  project_id          TEXT NOT NULL,
  release_id          TEXT NOT NULL,
  accepted_version_id TEXT NOT NULL,
  output_digest       TEXT NOT NULL,
  deployments_json    TEXT NOT NULL,
  since               TEXT NOT NULL,
  PRIMARY KEY (org_id, project_id)
);
