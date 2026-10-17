-- G1 immutable release-to-project acceptance identity. Legacy releases have no binding.
CREATE TABLE native_release_bindings (
  release_id TEXT PRIMARY KEY REFERENCES releases(release_id),
  org_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  envelope_digest TEXT NOT NULL,
  verified_source_digest TEXT NOT NULL,
  runtime_recipe_digest TEXT NOT NULL,
  sources_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TRIGGER native_release_bindings_no_update BEFORE UPDATE ON native_release_bindings BEGIN SELECT RAISE(ABORT, 'native release binding is immutable'); END;
CREATE TRIGGER native_release_bindings_no_delete BEFORE DELETE ON native_release_bindings BEGIN SELECT RAISE(ABORT, 'native release binding is retained'); END;
