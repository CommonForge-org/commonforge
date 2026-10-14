-- Task 17: outbox consumer projections and GC bookkeeping.

-- Projection of the ledger's accepted heads (refreshed by the outbox consumer and the GC sweep).
-- The OrgLedger DO stays the authority; list views may read this instead of calling the DO.
CREATE TABLE resource_heads (
  org_id              TEXT NOT NULL,
  resource_id         TEXT NOT NULL,
  revision_id         TEXT NOT NULL,
  version_seq         INTEGER NOT NULL,
  accepted_version_id TEXT,
  accepted_at         TEXT NOT NULL,
  -- canonical-ref projection health: synced | pending | diverged (never authority)
  reconciliation      TEXT NOT NULL CHECK (reconciliation IN ('synced', 'pending', 'diverged')),
  refreshed_at        TEXT NOT NULL,
  PRIMARY KEY (org_id, resource_id)
);

-- When the GC sweep deleted (or confirmed absent) the workspace's task repo; NULL = not swept yet.
ALTER TABLE task_workspaces ADD COLUMN swept_at TEXT;
CREATE INDEX task_workspaces_sweep ON task_workspaces (org_id, state, swept_at);
