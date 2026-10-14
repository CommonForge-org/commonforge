-- Releases gain a channel; the live pointer is per channel.
ALTER TABLE releases ADD COLUMN channel TEXT NOT NULL DEFAULT 'production' CHECK (channel IN ('production', 'staging'));
CREATE TABLE release_live_v2 (
  org_id              TEXT NOT NULL,
  project_id          TEXT NOT NULL,
  channel             TEXT NOT NULL DEFAULT 'production' CHECK (channel IN ('production', 'staging')),
  release_id          TEXT NOT NULL,
  accepted_version_id TEXT NOT NULL,
  output_digest       TEXT NOT NULL,
  deployments_json    TEXT NOT NULL,
  since               TEXT NOT NULL,
  PRIMARY KEY (org_id, project_id, channel)
);
INSERT INTO release_live_v2 (org_id, project_id, channel, release_id, accepted_version_id, output_digest, deployments_json, since)
  SELECT org_id, project_id, 'production', release_id, accepted_version_id, output_digest, deployments_json, since FROM release_live;
DROP TABLE release_live;
ALTER TABLE release_live_v2 RENAME TO release_live;
