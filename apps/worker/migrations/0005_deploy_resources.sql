-- Task 22 review C-1: production resources the PLATFORM created for an org's release targets.
-- Release policy may bind only these (never an arbitrary id on the account); Worker names are
-- forced into the `<deployPrefix>-<orgId>-` namespace in code.
CREATE TABLE org_deploy_resources (
  org_id      TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('kv')),
  name        TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (org_id, kind, name),
  UNIQUE (resource_id)
);

-- Task 22 review I-4: what was live before a deploy (the rollback target), and the rollback itself.
ALTER TABLE releases ADD COLUMN previous_release_id TEXT;
ALTER TABLE releases ADD COLUMN rollback_job_id TEXT;
ALTER TABLE releases ADD COLUMN rollback_state TEXT CHECK (rollback_state IN ('running', 'verifying', 'done', 'failed'));
ALTER TABLE releases ADD COLUMN rollback_receipt_json TEXT;
