-- Staging landings: `reason` is text the platform composes itself (shown to clients and viewers);
-- `detail` keeps the raw runner/release error for owners and developers only (it can name
-- repositories and namespaces).
ALTER TABLE staging_landings ADD COLUMN detail TEXT;
-- At most one open landing per task (`staging.land` relies on it instead of a lock).
CREATE UNIQUE INDEX staging_landings_open_per_task ON staging_landings (org_id, task_id) WHERE state IN ('checking', 'landed', 'rolling_back');
