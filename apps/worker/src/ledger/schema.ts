/**
 * OrgLedger SQLite schema, as an ordered migration list applied idempotently by {@link migrate}
 * (from the DO constructor inside `blockConcurrencyWhile`).
 *
 * Each record table keeps the full validated record as canonical JSON in `json` plus the columns
 * that are queried or constrained. The UNIQUE/PRIMARY KEY constraints mirror the uniqueness rules
 * of `InMemoryLedgerStore` (packages/ledger/src/memory-store.ts):
 *   - idempotency key per organization                    → idempotency PK (organization_id, key)
 *   - acceptedVersionId and sequence per organization     → accepted_versions PK + UNIQUE
 *   - outbox dedupeKey and eventId per organization       → outbox UNIQUE x2
 *   - auditId                                             → audit UNIQUE
 *   - resource → organization binding is write-once        → resource_orgs PK + no-UPDATE/DELETE triggers
 *   - head history (backs wasAcceptedHead)                 → head_history PK (resource_id, revision_id)
 * Record-keeping tables add their own write-once keys: prepared_receipts (receipt_id), approvals
 * (approval_id), integration_receipts (proposal_id, job_id).
 *
 * Migrations are append-only: never edit a shipped entry, add a new one.
 */

export interface Migration {
  id: number;
  name: string;
  statements: readonly string[];
}

export const MIGRATIONS: readonly Migration[] = [
  {
    id: 1,
    name: 'ledger-v1',
    statements: [
      `CREATE TABLE meta (
         key TEXT PRIMARY KEY,
         value TEXT NOT NULL
       )`,
      `CREATE TABLE heads (
         resource_id TEXT PRIMARY KEY,
         revision_id TEXT NOT NULL,
         version_seq INTEGER NOT NULL CHECK (version_seq > 0),
         accepted_version_id TEXT,
         accepted_at TEXT NOT NULL,
         reconciliation TEXT NOT NULL CHECK (reconciliation IN ('synced', 'pending', 'diverged'))
       )`,
      `CREATE TABLE head_history (
         resource_id TEXT NOT NULL,
         revision_id TEXT NOT NULL,
         first_version_seq INTEGER NOT NULL,
         PRIMARY KEY (resource_id, revision_id)
       )`,
      `CREATE TABLE resource_orgs (
         resource_id TEXT PRIMARY KEY,
         organization_id TEXT NOT NULL
       )`,
      `CREATE TRIGGER resource_orgs_no_update BEFORE UPDATE ON resource_orgs
       BEGIN SELECT RAISE(ABORT, 'resource organization binding is write-once'); END`,
      `CREATE TRIGGER resource_orgs_no_delete BEFORE DELETE ON resource_orgs
       BEGIN SELECT RAISE(ABORT, 'resource organization binding is write-once'); END`,
      `CREATE TABLE proposals (
         proposal_id TEXT PRIMARY KEY,
         organization_id TEXT NOT NULL,
         project_id TEXT NOT NULL,
         proposal_hash TEXT NOT NULL,
         state TEXT NOT NULL,
         updated_at TEXT NOT NULL,
         json TEXT NOT NULL
       )`,
      `CREATE INDEX proposals_project ON proposals (project_id, updated_at)`,
      `CREATE TABLE candidates (
         candidate_id TEXT PRIMARY KEY,
         resource_id TEXT NOT NULL,
         task_workspace_id TEXT NOT NULL,
         state TEXT NOT NULL,
         updated_at TEXT NOT NULL,
         json TEXT NOT NULL
       )`,
      `CREATE INDEX candidates_resource ON candidates (resource_id, state)`,
      `CREATE TABLE approvals (
         approval_id TEXT PRIMARY KEY,
         proposal_id TEXT NOT NULL,
         proposal_hash TEXT NOT NULL,
         approved_at TEXT NOT NULL,
         json TEXT NOT NULL
       )`,
      `CREATE INDEX approvals_proposal ON approvals (proposal_id, approved_at)`,
      `CREATE TABLE prepared_receipts (
         receipt_id TEXT PRIMARY KEY,
         candidate_id TEXT NOT NULL,
         resource_id TEXT NOT NULL,
         json TEXT NOT NULL
       )`,
      `CREATE TABLE integration_receipts (
         proposal_id TEXT NOT NULL,
         job_id TEXT NOT NULL,
         integrated_at TEXT NOT NULL,
         recorded_seq INTEGER NOT NULL,
         json TEXT NOT NULL,
         PRIMARY KEY (proposal_id, job_id)
       )`,
      `CREATE TABLE policy (
         project_id TEXT PRIMARY KEY,
         policy_revision INTEGER NOT NULL CHECK (policy_revision >= 0)
       )`,
      `CREATE TABLE accepted_versions (
         organization_id TEXT NOT NULL,
         accepted_version_id TEXT NOT NULL,
         sequence INTEGER NOT NULL CHECK (sequence > 0),
         kind TEXT NOT NULL,
         proposal_id TEXT,
         accepted_at TEXT NOT NULL,
         json TEXT NOT NULL,
         PRIMARY KEY (organization_id, accepted_version_id),
         UNIQUE (organization_id, sequence)
       )`,
      `CREATE TABLE idempotency (
         organization_id TEXT NOT NULL,
         key TEXT NOT NULL,
         scope TEXT NOT NULL,
         request_hash TEXT NOT NULL,
         accepted_version_id TEXT NOT NULL,
         created_at TEXT NOT NULL,
         PRIMARY KEY (organization_id, key)
       )`,
      `CREATE TABLE outbox (
         seq INTEGER PRIMARY KEY AUTOINCREMENT,
         event_id TEXT NOT NULL,
         organization_id TEXT NOT NULL,
         dedupe_key TEXT NOT NULL,
         kind TEXT NOT NULL,
         created_at TEXT NOT NULL,
         attempts INTEGER NOT NULL DEFAULT 0,
         delivered_at TEXT,
         next_attempt_at INTEGER NOT NULL DEFAULT 0,
         dead_at TEXT,
         last_error TEXT,
         json TEXT NOT NULL,
         UNIQUE (organization_id, dedupe_key),
         UNIQUE (organization_id, event_id)
       )`,
      `CREATE INDEX outbox_pending ON outbox (delivered_at, dead_at, seq)`,
      `CREATE TABLE audit (
         seq INTEGER PRIMARY KEY AUTOINCREMENT,
         audit_id TEXT NOT NULL UNIQUE,
         organization_id TEXT NOT NULL,
         at TEXT NOT NULL,
         action TEXT NOT NULL,
         subject_kind TEXT NOT NULL,
         subject_id TEXT NOT NULL,
         json TEXT NOT NULL
       )`,
      `CREATE TABLE workspaces (
         task_workspace_id TEXT PRIMARY KEY,
         resource_id TEXT NOT NULL,
         state TEXT NOT NULL,
         json TEXT NOT NULL
       )`,
      `CREATE INDEX workspaces_resource ON workspaces (resource_id, state)`,
    ],
  },
  {
    // Task 17: consumer-side dedupe. An outbox event (or an Artifacts `pushed` wakeup) is applied
    // once per (organization, dedupeKey); the row is written in the same transaction as its effect.
    id: 2,
    name: 'consumed-events',
    statements: [
      `CREATE TABLE consumed_events (
         organization_id TEXT NOT NULL,
         dedupe_key TEXT NOT NULL,
         event_id TEXT,
         kind TEXT NOT NULL,
         outcome TEXT NOT NULL,
         consumed_at TEXT NOT NULL,
         PRIMARY KEY (organization_id, dedupe_key)
       )`,
      // Last canonical-ref observation per resource (the sha recorded as synced, or the foreign sha
      // seen while a head was current): the only values a reconcile may lease on (review I-1).
      `CREATE TABLE ref_state (
         resource_id TEXT PRIMARY KEY,
         revision_id TEXT NOT NULL,
         state TEXT NOT NULL CHECK (state IN ('synced', 'pending', 'diverged')),
         observed_sha TEXT,
         observed_at TEXT NOT NULL
       )`,
    ],
  },
  {
    // Engine follow-up: core gained the `bind` version kind and idempotency scope. Genesis versions
    // written before it (kind `accept` with no proposal: only `planBindHead` writes that) become
    // `bind`, in the column and in the stored record, and so do their idempotency records (matched
    // through the version they point at). `planBindHead` still replays a legacy `accept`-scoped
    // bind record, so this migration is a data cleanup, not a precondition.
    id: 3,
    name: 'bind-version-kind',
    statements: [
      `UPDATE accepted_versions
         SET kind = 'bind', json = json_set(json, '$.kind', 'bind')
       WHERE kind = 'accept' AND proposal_id IS NULL`,
      `UPDATE idempotency
         SET scope = 'bind'
       WHERE scope = 'accept'
         AND EXISTS (
           SELECT 1 FROM accepted_versions v
            WHERE v.organization_id = idempotency.organization_id
              AND v.accepted_version_id = idempotency.accepted_version_id
              AND v.kind = 'bind'
         )`,
    ],
  },
  {
    id: 4,
    name: 'agent-native-projects',
    statements: [
      `CREATE TABLE native_projects (project_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, generation INTEGER NOT NULL, json TEXT NOT NULL)`,
      `CREATE TABLE native_resource_locks (resource_id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES native_projects(project_id))`,
      `CREATE TABLE native_handoffs (code_hash TEXT PRIMARY KEY, token_hash TEXT UNIQUE, project_id TEXT NOT NULL, json TEXT NOT NULL)`,
      `CREATE TABLE native_jobs (project_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_json TEXT NOT NULL, result_json TEXT, PRIMARY KEY(project_id,idempotency_key))`,
      `CREATE TABLE native_archives (project_id TEXT PRIMARY KEY, digest TEXT NOT NULL, json TEXT NOT NULL)`,
      `CREATE TABLE native_payloads (project_id TEXT NOT NULL, digest TEXT NOT NULL, size INTEGER NOT NULL, media_type TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('active','deleted')), PRIMARY KEY(project_id,digest))`,
      `CREATE TRIGGER native_locks_no_update BEFORE UPDATE ON native_resource_locks BEGIN SELECT RAISE(ABORT, 'native resource ownership is permanent'); END`,
      `CREATE TRIGGER native_locks_no_delete BEFORE DELETE ON native_resource_locks BEGIN SELECT RAISE(ABORT, 'native resource ownership is permanent'); END`,
    ],
  },
];

/** Tables created by the migrations (tests assert they exist). */
export const LEDGER_TABLES = [
  'meta',
  'heads',
  'head_history',
  'resource_orgs',
  'proposals',
  'candidates',
  'approvals',
  'prepared_receipts',
  'integration_receipts',
  'policy',
  'accepted_versions',
  'idempotency',
  'outbox',
  'audit',
  'workspaces',
  'consumed_events',
  'ref_state',
  'native_projects',
  'native_resource_locks',
  'native_handoffs',
  'native_jobs',
  'native_archives',
  'native_payloads',
] as const;

/**
 * Apply every migration not yet recorded in `ledger_migrations`, each in its own synchronous
 * transaction. Safe to call on every DO start.
 */
export function migrate(storage: DurableObjectStorage): number[] {
  const sql = storage.sql;
  sql.exec(`CREATE TABLE IF NOT EXISTS ledger_migrations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const applied = new Set(sql.exec<{ id: number }>('SELECT id FROM ledger_migrations').toArray().map((r) => r.id));
  const ran: number[] = [];
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    storage.transactionSync(() => {
      for (const stmt of m.statements) sql.exec(stmt);
      sql.exec('INSERT INTO ledger_migrations (id, name, applied_at) VALUES (?, ?, ?)', m.id, m.name, new Date().toISOString());
    });
    ran.push(m.id);
  }
  return ran;
}
