/**
 * `LedgerStore` / `LedgerTx` over a SQLite-backed Durable Object's `ctx.storage.sql`.
 *
 * - `transactionSync(fn)` = `storage.transactionSync`: all-or-nothing, synchronous only. A callback
 *   that returns a promise is rejected (and rolled back), exactly like `InMemoryLedgerStore`.
 * - Writes are validated with core's Zod schemas; uniqueness is enforced by SQL constraints (see
 *   schema.ts), so a violating write throws and rolls the whole transaction back.
 * - Reads parse stored JSON back through the schemas, so callers always get branded, valid records.
 * - Beyond `LedgerTx`, the adapter has the record-keeping writes the Worker API needs (receipts,
 *   approvals, candidates, workspaces, policy revisions). These never move heads.
 *
 * This class is deliberately not the DO itself: DO public methods are RPC-callable and a
 * `transaction(fn)` taking a callback must never be reachable over RPC.
 */
import {
  AcceptedHeadSchema,
  AcceptedProjectVersionSchema,
  ApprovalRefSchema,
  AuditEventSchema,
  CandidateRecordSchema,
  IdSegmentSchema,
  IdempotencyRecordSchema,
  IntegrationReceiptSchema,
  OutboxEventSchema,
  PreparedReceiptSchema,
  ProposalRecordSchema,
  TaskWorkspaceHandleSchema,
  canonicalJson,
  type AcceptedHead,
  type AcceptedProjectVersion,
  type ApprovalRef,
  type AuditEvent,
  type CandidateRecord,
  type IdempotencyRecord,
  type IntegrationReceipt,
  type OutboxEvent,
  type PreparedReceipt,
  type ProposalRecord,
  type TaskWorkspaceHandle,
} from '@commonforge-org/core';
import { parseLedgerSeed, type LedgerSeed, type LedgerStore, type LedgerTx } from '@commonforge-org/ledger';
import { z } from 'zod';

type Row = Record<string, SqlStorageValue>;

const str = (v: SqlStorageValue | undefined): string => {
  if (typeof v !== 'string') throw new Error(`ledger row: expected text, got ${typeof v}`);
  return v;
};
const num = (v: SqlStorageValue | undefined): number => {
  if (typeof v !== 'number') throw new Error(`ledger row: expected integer, got ${typeof v}`);
  return v;
};
const json = (v: SqlStorageValue | undefined): unknown => JSON.parse(str(v));

function isThenable(v: unknown): boolean {
  return typeof v === 'object' && v !== null && typeof (v as { then?: unknown }).then === 'function';
}

/** An outbox row as stored, with delivery bookkeeping. */
export interface OutboxRow {
  seq: number;
  event: OutboxEvent;
  lastError: string | null;
  /** epoch ms before which the alarm does not retry this row (0 = due now) */
  nextAttemptAt: number;
  /** set when the row exceeded its retry budget and was dead-lettered (never sent again) */
  deadAt: string | null;
}

/**
 * An audit row as returned over RPC. `detail` is carried as its canonical JSON text: the RPC type
 * mapping turns `unknown` into `never` and a recursive JSON type is too deep for it.
 */
export interface AuditRow {
  seq: number;
  event: Omit<AuditEvent, 'detail'>;
  detailJson: string | null;
}

function toHead(r: Row): AcceptedHead {
  return AcceptedHeadSchema.parse({
    resourceId: r.resource_id,
    revisionId: r.revision_id,
    versionSeq: r.version_seq,
    acceptedVersionId: r.accepted_version_id ?? null,
    acceptedAt: r.accepted_at,
    reconciliation: r.reconciliation,
  });
}

function toOutboxRow(r: Row): OutboxRow {
  const stored = json(r.json) as Record<string, unknown>;
  const event = OutboxEventSchema.parse({ ...stored, attempts: num(r.attempts), deliveredAt: r.delivered_at ?? null });
  return {
    seq: num(r.seq),
    event,
    lastError: (r.last_error as string | null) ?? null,
    nextAttemptAt: num(r.next_attempt_at),
    deadAt: (r.dead_at as string | null) ?? null,
  };
}

/** A consumed outbox event or Artifacts wakeup (consumer-side dedupe, Task 17). */
export interface ConsumedEvent {
  organizationId: string;
  dedupeKey: string;
  eventId: string | null;
  kind: string;
  /** what the consumer did, e.g. `synced`, `superseded`, `no_head`, `failed:not_found` */
  outcome: string;
  consumedAt: string;
}

/** Last canonical-ref observation of a resource (Task 17 review I-1). */
export interface RefState {
  resourceId: string;
  /** the head that was current when the ref was observed */
  revisionId: string;
  state: 'synced' | 'pending' | 'diverged';
  /** sha the ref held (null: the branch did not exist) */
  observedSha: string | null;
  observedAt: string;
}

function toConsumed(r: Row): ConsumedEvent {
  return {
    organizationId: str(r.organization_id),
    dedupeKey: str(r.dedupe_key),
    eventId: (r.event_id as string | null) ?? null,
    kind: str(r.kind),
    outcome: str(r.outcome),
    consumedAt: str(r.consumed_at),
  };
}

/** Write-once by primary key: an identical re-put is a no-op, a different record throws. */
function insertOnce(sql: SqlStorage, table: string, idColumn: string, id: string, canonical: string, insert: () => void): void {
  const existing = sql.exec<{ json: string }>(`SELECT json FROM ${table} WHERE ${idColumn} = ?`, id).toArray()[0];
  if (existing) {
    if (existing.json !== canonical) throw new Error(`write-once violation: ${table} ${id} already recorded with different content`);
    return;
  }
  insert();
}

export class SqliteLedgerTx implements LedgerTx {
  closed = false;
  constructor(private readonly sqlStorage: SqlStorage) {}

  private get sql(): SqlStorage {
    if (this.closed) throw new Error('ledger transaction is closed');
    return this.sqlStorage;
  }

  private rows(query: string, ...bindings: unknown[]): Row[] {
    return this.sql.exec<Row>(query, ...bindings).toArray();
  }

  /** Versioned project aggregate, read and written in the same transaction as artifact heads. */
  getNativeProjectJson(projectId: string): string | null {
    const r = this.rows('SELECT json FROM native_projects WHERE project_id = ?', projectId)[0];
    return r ? str(r.json) : null;
  }

  listNativeProjectJson(): string[] {
    return this.rows('SELECT json FROM native_projects ORDER BY project_id LIMIT 1000').map(r => str(r.json));
  }

  putNativeProjectJson(projectId: string, organizationId: string, generation: number, value: string): void {
    this.sql.exec(`INSERT INTO native_projects (project_id, organization_id, generation, json) VALUES (?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET generation = excluded.generation, json = excluded.json`, projectId, organizationId, generation, value);
  }

  nativeResourceProject(resourceId: string): string | null {
    const r = this.rows('SELECT project_id FROM native_resource_locks WHERE resource_id = ?', resourceId)[0];
    return r ? str(r.project_id) : null;
  }

  lockNativeResource(resourceId: string, projectId: string): void {
    this.sql.exec('INSERT INTO native_resource_locks (resource_id, project_id) VALUES (?, ?)', resourceId, projectId);
  }

  getNativeHandoff(hash: string, token = false): string | null {
    const r = this.rows(`SELECT json FROM native_handoffs WHERE ${token ? 'token_hash' : 'code_hash'} = ?`,hash)[0];
    return r ? str(r.json) : null;
  }

  putNativeHandoff(codeHash:string, tokenHash:string|null, projectId:string, value:string):void {
    this.sql.exec(`INSERT INTO native_handoffs (code_hash,token_hash,project_id,json) VALUES (?,?,?,?) ON CONFLICT(code_hash) DO UPDATE SET token_hash=excluded.token_hash,json=excluded.json`,codeHash,tokenHash,projectId,value);
  }

  // Native payload registry: transaction-only metadata, bytes remain in scoped R2.
  nativePayload(projectId:string,digest:string):{digest:string;size:number;mediaType:string;state:'active'|'deleted'}|null {
    const r=this.rows('SELECT digest,size,media_type,state FROM native_payloads WHERE project_id=? AND digest=?',projectId,digest)[0];
    return r?{digest:str(r.digest),size:num(r.size),mediaType:str(r.media_type),state:str(r.state) as 'active'|'deleted'}:null;
  }
  putNativePayload(projectId:string,digest:string,size:number,mediaType:string):void {
    this.sql.exec("INSERT INTO native_payloads (project_id,digest,size,media_type,state) VALUES (?,?,?,?,'active')",projectId,digest,size,mediaType);
  }
  tombstoneNativePayload(projectId:string,digest:string):void {
    this.sql.exec("INSERT INTO native_payloads (project_id,digest,size,media_type,state) VALUES (?,?,0,'application/octet-stream','deleted') ON CONFLICT(project_id,digest) DO UPDATE SET state='deleted'",projectId,digest);
  }
  // End native payload registry.

  nativeJob(projectId:string,key:string):{request:string;result:string|null}|null {
    const r=this.rows('SELECT request_json,result_json FROM native_jobs WHERE project_id=? AND idempotency_key=?',projectId,key)[0];
    return r?{request:str(r.request_json),result:r.result_json===null?null:str(r.result_json)}:null;
  }
  nativeJobCount(projectId:string,envelopeDigest:string):number {
    return num(this.rows("SELECT count(*) AS n FROM native_jobs WHERE project_id=? AND json_extract(request_json,'$.envelopeDigest')=?",projectId,envelopeDigest)[0]!.n);
  }
  putNativeJob(projectId:string,key:string,request:string,result:string|null):void {
    this.sql.exec('INSERT INTO native_jobs (project_id,idempotency_key,request_json,result_json) VALUES (?,?,?,?) ON CONFLICT(project_id,idempotency_key) DO UPDATE SET result_json=excluded.result_json',projectId,key,request,result);
  }
  putNativeArchive(projectId:string,digest:string,value:string):void {
    this.sql.exec('INSERT INTO native_archives (project_id,digest,json) VALUES (?,?,?)',projectId,digest,value);
  }
  getNativeArchive(projectId:string):string|null {
    const r=this.rows('SELECT json FROM native_archives WHERE project_id=?',projectId)[0];return r?str(r.json):null;
  }

  // ---------------------------------------------------------------- LedgerTx (§A.4)

  getHead(resourceId: string): AcceptedHead | null {
    const r = this.rows('SELECT * FROM heads WHERE resource_id = ?', resourceId)[0];
    return r ? toHead(r) : null;
  }

  setHead(head: AcceptedHead): void {
    const h = AcceptedHeadSchema.parse(head);
    this.sql.exec(
      `INSERT INTO heads (resource_id, revision_id, version_seq, accepted_version_id, accepted_at, reconciliation)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (resource_id) DO UPDATE SET
         revision_id = excluded.revision_id, version_seq = excluded.version_seq,
         accepted_version_id = excluded.accepted_version_id, accepted_at = excluded.accepted_at,
         reconciliation = excluded.reconciliation`,
      h.resourceId,
      h.revisionId,
      h.versionSeq,
      h.acceptedVersionId,
      h.acceptedAt,
      h.reconciliation,
    );
    this.sql.exec(
      'INSERT OR IGNORE INTO head_history (resource_id, revision_id, first_version_seq) VALUES (?, ?, ?)',
      h.resourceId,
      h.revisionId,
      h.versionSeq,
    );
  }

  getProposal(proposalId: string): ProposalRecord | null {
    const r = this.rows('SELECT json FROM proposals WHERE proposal_id = ?', proposalId)[0];
    return r ? ProposalRecordSchema.parse(json(r.json)) : null;
  }

  putProposal(p: ProposalRecord): void {
    const v = ProposalRecordSchema.parse(p);
    this.sql.exec(
      `INSERT INTO proposals (proposal_id, organization_id, project_id, proposal_hash, state, updated_at, json)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (proposal_id) DO UPDATE SET
         organization_id = excluded.organization_id, project_id = excluded.project_id,
         proposal_hash = excluded.proposal_hash, state = excluded.state,
         updated_at = excluded.updated_at, json = excluded.json`,
      v.proposalId,
      v.organizationId,
      v.projectId,
      v.proposalHash,
      v.state,
      v.updatedAt,
      canonicalJson(v),
    );
  }

  getIdempotency(organizationId: string, key: string): IdempotencyRecord | null {
    const r = this.rows('SELECT * FROM idempotency WHERE organization_id = ? AND key = ?', organizationId, key)[0];
    if (!r) return null;
    return IdempotencyRecordSchema.parse({
      key: r.key,
      scope: r.scope,
      requestHash: r.request_hash,
      acceptedVersionId: r.accepted_version_id,
      createdAt: r.created_at,
    });
  }

  putIdempotency(organizationId: string, rec: IdempotencyRecord): void {
    const v = IdempotencyRecordSchema.parse(rec);
    // plain INSERT: the (organization_id, key) primary key makes a reused key throw
    this.sql.exec(
      'INSERT INTO idempotency (organization_id, key, scope, request_hash, accepted_version_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      z.string().min(1).parse(organizationId),
      v.key,
      v.scope,
      v.requestHash,
      v.acceptedVersionId,
      v.createdAt,
    );
  }

  putAcceptedVersion(version: AcceptedProjectVersion): void {
    const v = AcceptedProjectVersionSchema.parse(version);
    this.sql.exec(
      `INSERT INTO accepted_versions (organization_id, accepted_version_id, sequence, kind, proposal_id, accepted_at, json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      v.organizationId,
      v.acceptedVersionId,
      v.sequence,
      v.kind,
      v.proposalId,
      v.acceptedAt,
      canonicalJson(v),
    );
  }

  appendOutbox(event: OutboxEvent): void {
    const v = OutboxEventSchema.parse(event);
    this.sql.exec(
      `INSERT INTO outbox (event_id, organization_id, dedupe_key, kind, created_at, attempts, delivered_at, json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      v.eventId,
      v.organizationId,
      v.dedupeKey,
      v.kind,
      v.createdAt,
      v.attempts,
      v.deliveredAt,
      canonicalJson(v),
    );
  }

  appendAudit(event: AuditEvent): void {
    const v = AuditEventSchema.parse(event);
    this.sql.exec(
      `INSERT INTO audit (audit_id, organization_id, at, action, subject_kind, subject_id, json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      v.auditId,
      v.organizationId,
      v.at,
      v.action,
      v.subject.kind,
      v.subject.id,
      canonicalJson(v),
    );
  }

  // ---------------------------------------------------------------- LedgerTx additions (reads + bind)

  getPreparedReceipt(receiptId: string): PreparedReceipt | null {
    const r = this.rows('SELECT json FROM prepared_receipts WHERE receipt_id = ?', receiptId)[0];
    return r ? PreparedReceiptSchema.parse(json(r.json)) : null;
  }

  getIntegrationReceipt(proposalId: string): IntegrationReceipt | null {
    // the latest recorded receipt for the proposal
    const r = this.rows('SELECT json FROM integration_receipts WHERE proposal_id = ? ORDER BY recorded_seq DESC LIMIT 1', proposalId)[0];
    return r ? IntegrationReceiptSchema.parse(json(r.json)) : null;
  }

  getCurrentPolicyRevision(projectId: string): number | null {
    const r = this.rows('SELECT policy_revision FROM policy WHERE project_id = ?', projectId)[0];
    return r ? num(r.policy_revision) : null;
  }

  getLatestAcceptedVersion(organizationId: string): AcceptedProjectVersion | null {
    const r = this.rows('SELECT json FROM accepted_versions WHERE organization_id = ? ORDER BY sequence DESC LIMIT 1', organizationId)[0];
    return r ? AcceptedProjectVersionSchema.parse(json(r.json)) : null;
  }

  wasAcceptedHead(resourceId: string, revisionId: string): boolean {
    return this.rows('SELECT 1 AS x FROM head_history WHERE resource_id = ? AND revision_id = ?', resourceId, revisionId).length > 0;
  }

  getResourceOrganization(resourceId: string): string | null {
    const r = this.rows('SELECT organization_id FROM resource_orgs WHERE resource_id = ?', resourceId)[0];
    return r ? str(r.organization_id) : null;
  }

  bindResource(resourceId: string, organizationId: string): void {
    const org = z.string().min(1).parse(organizationId);
    const owner = this.getResourceOrganization(resourceId);
    if (owner !== null) {
      if (owner !== org) throw new Error(`resource ${resourceId} is already bound to ${owner}`);
      return;
    }
    this.sql.exec('INSERT INTO resource_orgs (resource_id, organization_id) VALUES (?, ?)', resourceId, org);
  }

  // ---------------------------------------------------------------- record keeping (Worker API)

  /** Write-once by receiptId (a runner-verified receipt never changes). */
  putPreparedReceipt(receipt: PreparedReceipt): void {
    const v = PreparedReceiptSchema.parse(receipt);
    const c = canonicalJson(v);
    insertOnce(this.sql, 'prepared_receipts', 'receipt_id', v.receiptId, c, () =>
      this.sql.exec(
        'INSERT INTO prepared_receipts (receipt_id, candidate_id, resource_id, json) VALUES (?, ?, ?, ?)',
        v.receiptId,
        v.candidateId,
        v.resourceId,
        c,
      ),
    );
  }

  /**
   * Record an integration receipt. Write-once per (proposalId, jobId): an identical re-put is a no-op,
   * different content throws. A re-integration (new job) adds a row; the latest one is what
   * `getIntegrationReceipt` returns. Earlier receipts are kept for the audit trail.
   */
  putIntegrationReceipt(receipt: IntegrationReceipt): void {
    const v = IntegrationReceiptSchema.parse(receipt);
    const c = canonicalJson(v);
    const existing = this.rows('SELECT json FROM integration_receipts WHERE proposal_id = ? AND job_id = ?', v.proposalId, v.jobId)[0];
    if (existing) {
      if (existing.json !== c) throw new Error(`write-once violation: integration_receipts ${v.proposalId}/${v.jobId} already recorded with different content`);
      return;
    }
    const next = this.rows('SELECT coalesce(max(recorded_seq), 0) + 1 AS n FROM integration_receipts WHERE proposal_id = ?', v.proposalId)[0]!;
    this.sql.exec(
      'INSERT INTO integration_receipts (proposal_id, job_id, integrated_at, recorded_seq, json) VALUES (?, ?, ?, ?, ?)',
      v.proposalId,
      v.jobId,
      v.integratedAt,
      num(next.n),
      c,
    );
  }

  /** Policy revisions never go backwards (an equal value is a no-op). */
  setPolicyRevision(projectId: string, policyRevision: number): void {
    const project = IdSegmentSchema.parse(projectId);
    const rev = z.number().int().nonnegative().parse(policyRevision);
    const current = this.getCurrentPolicyRevision(project);
    if (current !== null && rev < current) throw new Error(`policy revision for ${project} cannot decrease (${current} -> ${rev})`);
    this.sql.exec(
      'INSERT INTO policy (project_id, policy_revision) VALUES (?, ?) ON CONFLICT (project_id) DO UPDATE SET policy_revision = excluded.policy_revision',
      project,
      rev,
    );
  }

  /** Write-once by approvalId (an approval is an immutable fact about a proposal hash). */
  putApproval(approval: ApprovalRef): void {
    const v = ApprovalRefSchema.parse(approval);
    const c = canonicalJson(v);
    insertOnce(this.sql, 'approvals', 'approval_id', v.approvalId, c, () =>
      this.sql.exec(
        'INSERT INTO approvals (approval_id, proposal_id, proposal_hash, approved_at, json) VALUES (?, ?, ?, ?, ?)',
        v.approvalId,
        v.proposalId,
        v.proposalHash,
        v.approvedAt,
        c,
      ),
    );
  }

  listApprovals(proposalId: string): ApprovalRef[] {
    return this.rows('SELECT json FROM approvals WHERE proposal_id = ? ORDER BY approved_at, approval_id', proposalId).map((r) =>
      ApprovalRefSchema.parse(json(r.json)),
    );
  }

  putCandidate(record: CandidateRecord): void {
    const v = CandidateRecordSchema.parse(record);
    this.sql.exec(
      `INSERT INTO candidates (candidate_id, resource_id, task_workspace_id, state, updated_at, json) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (candidate_id) DO UPDATE SET resource_id = excluded.resource_id, task_workspace_id = excluded.task_workspace_id,
         state = excluded.state, updated_at = excluded.updated_at, json = excluded.json`,
      v.candidate.candidateId,
      v.candidate.resourceId,
      v.candidate.taskWorkspaceId,
      v.state,
      v.updatedAt,
      canonicalJson(v),
    );
  }

  getCandidate(candidateId: string): CandidateRecord | null {
    const r = this.rows('SELECT json FROM candidates WHERE candidate_id = ?', candidateId)[0];
    return r ? CandidateRecordSchema.parse(json(r.json)) : null;
  }

  listCandidates(resourceId: string): CandidateRecord[] {
    return this.rows('SELECT json FROM candidates WHERE resource_id = ? ORDER BY updated_at, candidate_id', resourceId).map((r) =>
      CandidateRecordSchema.parse(json(r.json)),
    );
  }

  putWorkspace(handle: TaskWorkspaceHandle): void {
    const v = TaskWorkspaceHandleSchema.parse(handle);
    this.sql.exec(
      `INSERT INTO workspaces (task_workspace_id, resource_id, state, json) VALUES (?, ?, ?, ?)
       ON CONFLICT (task_workspace_id) DO UPDATE SET resource_id = excluded.resource_id, state = excluded.state, json = excluded.json`,
      v.taskWorkspaceId,
      v.resourceId,
      v.state,
      canonicalJson(v),
    );
  }

  getWorkspace(taskWorkspaceId: string): TaskWorkspaceHandle | null {
    const r = this.rows('SELECT json FROM workspaces WHERE task_workspace_id = ?', taskWorkspaceId)[0];
    return r ? TaskWorkspaceHandleSchema.parse(json(r.json)) : null;
  }

  // ---------------------------------------------------------------- read helpers (Worker API)

  listHeads(): AcceptedHead[] {
    return this.rows('SELECT * FROM heads ORDER BY resource_id').map(toHead);
  }

  listProposals(projectId?: string): ProposalRecord[] {
    const rows =
      projectId === undefined
        ? this.rows('SELECT json FROM proposals ORDER BY updated_at, proposal_id')
        : this.rows('SELECT json FROM proposals WHERE project_id = ? ORDER BY updated_at, proposal_id', projectId);
    return rows.map((r) => ProposalRecordSchema.parse(json(r.json)));
  }

  /** All accepted versions with `sequence > afterSequence` (a DO ledger serves one organization). */
  listAcceptedVersions(afterSequence: number, limit: number): AcceptedProjectVersion[] {
    return this.rows('SELECT json FROM accepted_versions WHERE sequence > ? ORDER BY sequence, organization_id LIMIT ?', afterSequence, limit).map((r) =>
      AcceptedProjectVersionSchema.parse(json(r.json)),
    );
  }

  /** `pending` = neither delivered nor dead-lettered; `dead` = dead-lettered only. */
  listOutbox(opts: { filter: 'all' | 'pending' | 'dead'; afterSeq: number; limit: number }): OutboxRow[] {
    const where =
      opts.filter === 'pending' ? 'delivered_at IS NULL AND dead_at IS NULL AND ' : opts.filter === 'dead' ? 'dead_at IS NOT NULL AND ' : '';
    return this.rows(`SELECT * FROM outbox WHERE ${where}seq > ? ORDER BY seq LIMIT ?`, opts.afterSeq, opts.limit).map(toOutboxRow);
  }

  listAudit(afterSeq: number, limit: number): AuditRow[] {
    return this.rows('SELECT seq, json FROM audit WHERE seq > ? ORDER BY seq LIMIT ?', afterSeq, limit).map((r) => {
      const { detail, ...event } = AuditEventSchema.parse(json(r.json));
      return { seq: num(r.seq), event, detailJson: detail === undefined ? null : canonicalJson(detail) };
    });
  }

  // ---------------------------------------------------------------- outbox delivery bookkeeping

  /** Mark one row delivered (only if still unsent); returns whether this call marked it. */
  markOutboxSent(seq: number, deliveredAt: string): boolean {
    return (
      this.sql.exec('UPDATE outbox SET delivered_at = ?, attempts = attempts + 1, last_error = NULL WHERE seq = ? AND delivered_at IS NULL', deliveredAt, seq)
        .rowsWritten > 0
    );
  }

  /** Record a failed delivery attempt and when to retry; returns the new attempt count. */
  markOutboxFailed(seq: number, error: string, nextAttemptAt: (attempts: number) => number): number {
    const r = this.rows('SELECT attempts FROM outbox WHERE seq = ? AND delivered_at IS NULL AND dead_at IS NULL', seq)[0];
    if (!r) return 0;
    const attempts = num(r.attempts) + 1;
    this.sql.exec('UPDATE outbox SET attempts = ?, last_error = ?, next_attempt_at = ? WHERE seq = ?', attempts, error.slice(0, 1000), nextAttemptAt(attempts), seq);
    return attempts;
  }

  /** Park a row that exhausted its retries: it no longer blocks later rows and is never sent again. */
  markOutboxDead(seq: number, deadAt: string): void {
    this.sql.exec('UPDATE outbox SET dead_at = ? WHERE seq = ? AND delivered_at IS NULL AND dead_at IS NULL', deadAt, seq);
  }

  hasPendingOutbox(): boolean {
    return this.rows('SELECT 1 AS x FROM outbox WHERE delivered_at IS NULL AND dead_at IS NULL LIMIT 1').length > 0;
  }

  // ---------------------------------------------------------------- reconciliation + consumer dedupe (Task 17)

  /**
   * Set the canonical-ref projection state of a head, only while the head is still at `revisionId`
   * (a later accept/restore made a newer head, whose own event reconciles it). Returns the previous
   * state when it changed, null otherwise.
   */
  setReconciliation(resourceId: string, revisionId: string, state: AcceptedHead['reconciliation']): AcceptedHead['reconciliation'] | null {
    const head = this.getHead(resourceId);
    if (!head || head.revisionId !== revisionId || head.reconciliation === state) return null;
    this.sql.exec('UPDATE heads SET reconciliation = ? WHERE resource_id = ? AND revision_id = ?', state, resourceId, revisionId);
    return head.reconciliation;
  }

  /** Record what the canonical ref held while `revisionId` was the head. */
  putRefState(r: RefState): void {
    this.sql.exec(
      `INSERT INTO ref_state (resource_id, revision_id, state, observed_sha, observed_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (resource_id) DO UPDATE SET revision_id = excluded.revision_id, state = excluded.state,
         observed_sha = excluded.observed_sha, observed_at = excluded.observed_at`,
      r.resourceId,
      r.revisionId,
      r.state,
      r.observedSha,
      r.observedAt,
    );
  }

  getRefState(resourceId: string): RefState | null {
    const r = this.rows('SELECT * FROM ref_state WHERE resource_id = ?', resourceId)[0];
    return r
      ? { resourceId: str(r.resource_id), revisionId: str(r.revision_id), state: str(r.state) as RefState['state'], observedSha: (r.observed_sha as string | null) ?? null, observedAt: str(r.observed_at) }
      : null;
  }

  getAcceptedVersion(acceptedVersionId: string): AcceptedProjectVersion | null {
    const r = this.rows('SELECT json FROM accepted_versions WHERE accepted_version_id = ?', acceptedVersionId)[0];
    return r ? AcceptedProjectVersionSchema.parse(json(r.json)) : null;
  }

  getConsumed(organizationId: string, dedupeKey: string): ConsumedEvent | null {
    const r = this.rows('SELECT * FROM consumed_events WHERE organization_id = ? AND dedupe_key = ?', organizationId, dedupeKey)[0];
    return r ? toConsumed(r) : null;
  }

  /** Record a consumed event; returns false when (organization, dedupeKey) was already consumed. */
  putConsumed(c: ConsumedEvent): boolean {
    return (
      this.sql.exec(
        'INSERT OR IGNORE INTO consumed_events (organization_id, dedupe_key, event_id, kind, outcome, consumed_at) VALUES (?, ?, ?, ?, ?, ?)',
        c.organizationId,
        c.dedupeKey,
        c.eventId,
        c.kind,
        c.outcome,
        c.consumedAt,
      ).rowsWritten > 0
    );
  }

  // ---------------------------------------------------------------- org pinning

  /** The organization this ledger serves (pinned on first organization-carrying write), or null. */
  getLedgerOrganization(): string | null {
    const r = this.rows("SELECT value FROM meta WHERE key = 'organization_id'")[0];
    return r ? str(r.value) : null;
  }

  /** Throw unless the ledger is unpinned or pinned to `organizationId` (reads only). */
  checkLedgerOrganization(organizationId: string): void {
    const pinned = this.getLedgerOrganization();
    if (pinned !== null && pinned !== organizationId) {
      throw new Error(`ledger_wrong_organization: this ledger serves organization ${pinned}, not ${organizationId}`);
    }
  }

  /** Pin this ledger to `organizationId` if unpinned (call only once the operation succeeded). */
  pinLedgerOrganization(organizationId: string): void {
    const org = IdSegmentSchema.parse(organizationId);
    this.checkLedgerOrganization(org);
    if (this.getLedgerOrganization() === null) this.sql.exec("INSERT INTO meta (key, value) VALUES ('organization_id', ?)", org);
  }
}

/** `LedgerStore` over a SQLite-backed DO's storage. One instance per DO; cheap to construct. */
export class SqliteLedgerStore implements LedgerStore {
  private queue: Promise<unknown> = Promise.resolve();
  private inTx = false;

  constructor(private readonly storage: DurableObjectStorage) {}

  /** Run `fn` atomically and synchronously inside `storage.transactionSync`. */
  transactionSync<T>(fn: (tx: SqliteLedgerTx) => T): T {
    if (this.inTx) throw new Error('nested ledger transactions are not supported');
    const tx = new SqliteLedgerTx(this.storage.sql);
    this.inTx = true;
    try {
      return this.storage.transactionSync(() => {
        const result = fn(tx);
        if (isThenable(result)) {
          (result as unknown as Promise<unknown>).then(undefined, () => undefined);
          throw new Error('ledger transaction callback must be synchronous');
        }
        return result;
      });
    } finally {
      tx.closed = true;
      this.inTx = false;
    }
  }

  /** Port method: transactions run one at a time, in submission order. */
  transaction<T>(fn: (tx: LedgerTx) => T): Promise<T> {
    const run = this.queue.then(() => this.transactionSync(fn));
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Seed state for tests and the conformance harness (bypasses the ledger invariants; production
   * creates first heads only with `executeBindHead`). Same semantics as `InMemoryLedgerStore.seed`.
   */
  seed(seed: LedgerSeed): void {
    const p = parseLedgerSeed(seed);
    this.transactionSync((tx) => {
      for (const { organizationId, ...h } of p.heads) {
        if (organizationId !== undefined) tx.bindResource(h.resourceId, organizationId);
        tx.setHead(h);
      }
      for (const x of p.proposals) tx.putProposal(x);
      for (const r of p.preparedReceipts) tx.putPreparedReceipt(r);
      for (const r of p.integrationReceipts) tx.putIntegrationReceipt(r);
      for (const x of p.policyRevisions) tx.setPolicyRevision(x.projectId, x.policyRevision);
    });
  }
}
