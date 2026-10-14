-- Task 21: client Workspace Editions (PRD §4.5, FR-16..FR-18; plan §B.13, §C.1 row 9).
-- The edition manifest (inventory, mappings, canonical bases) is server-owned and lives here;
-- nothing a client returns can change it (AT-28).

-- An edition: a developer-authorized, fresh-history projection of one or more mounted resources.
CREATE TABLE editions (
  edition_id       TEXT PRIMARY KEY,
  org_id           TEXT NOT NULL,
  project_id       TEXT NOT NULL,
  name             TEXT NOT NULL,
  -- EditionPolicy: sources (mount, read allowlist, write allowlist), exclude, protected paths
  policy_json      TEXT NOT NULL,
  policy_revision  INTEGER NOT NULL DEFAULT 1,
  -- the -editions namespace repository (ArtifactsCoords), created by the first build
  repo_json        TEXT,
  state            TEXT NOT NULL CHECK (state IN ('draft', 'building', 'ready', 'failed')),
  current_build_id TEXT,
  created_by       TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX editions_by_project ON editions (org_id, project_id);

-- One published build: the server-side edition manifest (plan §B.13) of one fresh commit.
CREATE TABLE edition_builds (
  build_id          TEXT PRIMARY KEY,
  edition_id        TEXT NOT NULL,
  org_id            TEXT NOT NULL,
  policy_revision   INTEGER NOT NULL,
  -- the EditionPolicy this build publishes (snapshotted at request time; the step builds from it)
  policy_json       TEXT NOT NULL,
  state             TEXT NOT NULL CHECK (state IN ('queued', 'ready', 'failed')),
  job_id            TEXT,
  -- the live release the build was published from; NULL until releases exist (Task 22)
  source_release_id TEXT,
  -- project snapshot (sources only) the build was made from
  snapshot_json     TEXT NOT NULL,
  -- [{ resourceId, revisionId }]: canonical bases; [EditionMapping]; [protected glob]
  bases_json        TEXT NOT NULL,
  mappings_json     TEXT NOT NULL,
  protected_json    TEXT NOT NULL,
  -- the edition commit and its inventory [{ editionPath, sha256, size }] (from the runner receipt)
  sha               TEXT,
  inventory_json    TEXT,
  error             TEXT,
  created_by        TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX edition_builds_by_edition ON edition_builds (edition_id, created_at);

-- Edition access is its own audited grant (PRD §6: no canonical grant is implied by it).
CREATE TABLE edition_grants (
  edition_id TEXT NOT NULL,
  org_id     TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  granted_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (edition_id, user_id)
);
CREATE INDEX edition_grants_by_user ON edition_grants (org_id, user_id);

-- Read tokens minted on edition repos (revoked when the edition grant is revoked).
CREATE TABLE edition_tokens (
  edition_id TEXT NOT NULL,
  org_id     TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  token_id   TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (edition_id, token_id)
);

-- "Start an update": an edit session pins one build (inventory + canonical bases + live release).
CREATE TABLE edition_sessions (
  session_id TEXT PRIMARY KEY,
  edition_id TEXT NOT NULL,
  build_id   TEXT NOT NULL,
  org_id     TEXT NOT NULL,
  project_id TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  title      TEXT NOT NULL,
  request    TEXT NOT NULL,
  state      TEXT NOT NULL CHECK (state IN ('open', 'closed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX edition_sessions_by_edition ON edition_sessions (edition_id, user_id);

-- A returned ZIP: R2 staging → edition-return job → candidate in a new task workspace → proposal.
CREATE TABLE edition_returns (
  return_id         TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL,
  edition_id        TEXT NOT NULL,
  build_id          TEXT NOT NULL,
  org_id            TEXT NOT NULL,
  project_id        TEXT NOT NULL,
  user_id           TEXT NOT NULL,
  mode              TEXT NOT NULL CHECK (mode IN ('full', 'partial')),
  deletions_json    TEXT NOT NULL,
  r2_key            TEXT NOT NULL,
  size              INTEGER NOT NULL,
  sha256            TEXT NOT NULL,
  tool              TEXT,
  -- target resource and the canonical base the return must apply to (stale → refused)
  resource_id       TEXT NOT NULL,
  expected_head     TEXT NOT NULL,
  task_id           TEXT NOT NULL,
  task_workspace_id TEXT NOT NULL,
  state             TEXT NOT NULL CHECK (state IN ('queued', 'running', 'freezing', 'proposed', 'no_changes', 'stale', 'conflict', 'refused', 'failed')),
  job_id            TEXT,
  -- the Worker's own diff/mapping of the upload (shown at once; the runner recomputes it)
  preview_json      TEXT NOT NULL,
  receipt_json      TEXT,
  proposal_id       TEXT,
  error_code        TEXT,
  error             TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX edition_returns_by_session ON edition_returns (session_id, created_at);
