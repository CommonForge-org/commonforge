-- Staging capture sink: the 7-day GC sweep deletes by received_at across all projects.
CREATE INDEX staging_captures_by_time ON staging_captures (received_at);
