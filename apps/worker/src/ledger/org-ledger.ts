/**
 * `OrgLedger`: the per-organization acceptance ledger (plan §A.4, §A.7; P0: one DO per org, §C.2).
 *
 * - Every mutating RPC runs inside `ctx.storage.transactionSync` through {@link SqliteLedgerStore}.
 *   `accept` / `restore` / `bindHead` call the shared `executeCommit` / `executeRestore` /
 *   `executeBindHead`, which plan with the ledger invariants and apply writes only via the shared
 *   `applyWrites`. No network I/O ever happens inside a transaction.
 * - Inputs are validated with core/ledger Zod schemas at the RPC boundary. Every thrown error carries
 *   a stable code prefix (`ledger_invalid_input: ...`, see errors.ts for the HTTP mapping); a policy
 *   refusal is a returned `{ ok: false, code }` decision, not an error.
 * - Organization pinning: every mutating RPC names the acting organization (in its input or as the
 *   first argument). The first *successful* write pins the ledger to it; afterwards any write for
 *   another organization throws `ledger_wrong_organization`.
 * - Record-keeping writes are guarded by `@commonforge-org/ledger`'s record guards (the same rules a
 *   Postgres store enforces; ledger conformance `record.*` scenarios): proposal identity is immutable, terminal
 *   states are final, `updatedAt` is monotonic and bounded by the ledger clock; receipts and
 *   approvals are write-once; candidate/workspace identity is immutable.
 * - Outbox: committed events are drained by `alarm()` to the `OUTBOX` queue in `seq` order, one
 *   message at a time. The alarm is set in the same synchronous turn as the commit (so it is part of
 *   the same storage batch). A row is marked delivered only after `send` resolved; on failure the
 *   row keeps its place (later rows wait), `next_attempt_at` moves out with exponential backoff, and
 *   after {@link OUTBOX_MAX_ATTEMPTS} failures it is dead-lettered (audited, never sent again, no
 *   longer blocking). Delivery is at-least-once; consumers dedupe by `(organizationId, dedupeKey)`.
 */
import { DurableObject } from 'cloudflare:workers';
import {
  AcceptInputSchema,
  ApprovalRefSchema,
  CandidateRecordSchema,
  IdSegmentSchema,
  IntegrationReceiptSchema,
  PreparedReceiptSchema,
  ProposalRecordSchema,
  TaskWorkspaceHandleSchema,
  hashCanonicalSync,
  canonicalJson,
  ProjectStateSchema,
  ProjectError,
  createProjectState,
  computeProjectManifestHash,
  materializeProjectContext,
  currentConfirmed,
  ReleaseObservationSchema,
  ScenarioEvidenceSchema,
  type AcceptedHead,
  type AcceptedProjectVersion,
  type ApprovalRef,
  type AuditEvent,
  type CandidateRecord,
  type IntegrationReceipt,
  type OutboxEvent,
  type PreparedReceipt,
  type ProposalRecord,
  type TaskWorkspaceHandle,
} from '@commonforge-org/core';
import {
  BindHeadRequestSchema,
  PROPOSAL_TERMINAL_STATES,
  RestoreRequestSchema,
  assertNotFuture,
  checkCandidateUpdate,
  checkWorkspaceUpdate,
  executeBindHead,
  executeCommit,
  executePutProposal,
  executeRestore,
  applyProjectCommand,
  planProjectAccept,
  validateProjectRecovery,
  applyWrites,
  createNativeGenesis,
  importProjectBundle,
  validateProjectBundle,
  type CommitDecision,
} from '@commonforge-org/ledger';
import { z } from 'zod';
import { ScenarioVerificationRequestSchema, ScenarioVerificationResultSchema } from '@commonforge-org/runner-protocol';
import type { Env } from '../env.js';
import { ledgerError, toLedgerRpcError } from './errors.js';
import { migrate } from './schema.js';
import { SqliteLedgerStore, type AuditRow, type ConsumedEvent, type OutboxRow, type RefState, type SqliteLedgerTx } from './sqlite-store.js';

export type LedgerResult =
  | { ok: true; replayed: boolean; acceptedVersionId: string }
  | Extract<CommitDecision, { ok: false }>;

export const OUTBOX_BATCH_LIMIT = 100;
export const OUTBOX_RETRY_BASE_MS = 2_000;
export const OUTBOX_RETRY_MAX_MS = 5 * 60_000;
/** Failed sends after which a row is dead-lettered (about 1.3 h of backoff in total). */
export const OUTBOX_MAX_ATTEMPTS = 20;
/** Principal recorded on audit events the ledger itself emits. */
export const LEDGER_SERVICE_ACTOR = { kind: 'service', id: 'org-ledger' } as const;

/** Delay before retrying a row that has failed `attempts` times (attempts >= 1). */
export function outboxBackoffMs(attempts: number): number {
  return Math.min(OUTBOX_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), OUTBOX_RETRY_MAX_MS);
}

const PageSchema = z.object({
  after: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(500).default(100),
});
const OutboxQuerySchema = PageSchema.extend({ filter: z.enum(['all', 'pending', 'dead']).default('all') });
const ResourceIdArg = z.string().min(1);
const ConsumeSchema = z.object({
  dedupeKey: z.string().min(1).max(512),
  eventId: z.string().min(1).max(256).nullable().default(null),
  kind: z.string().min(1).max(64),
  outcome: z.string().min(1).max(200),
});
const ReconciliationInputSchema = z.object({
  resourceId: z.string().min(1),
  revisionId: z.string().min(1),
  state: z.enum(['synced', 'pending', 'diverged']),
  /** sha observed on the canonical ref (audit detail only) */
  observedSha: z.string().max(64).nullable().optional(),
  /** consume this event in the same transaction (no effect when it was already consumed) */
  consume: ConsumeSchema.optional(),
});
export type ConsumeInput = z.input<typeof ConsumeSchema>;
export type ReconciliationInput = z.input<typeof ReconciliationInputSchema>;

export interface ReconciliationResult {
  /** the head is still at `revisionId` (otherwise nothing was changed: a newer head exists) */
  headMatches: boolean;
  /** the state changed (an audit event was written) */
  changed: boolean;
  /** the event was consumed by this call */
  consumed: boolean;
  /** the event had already been consumed earlier; nothing was written */
  alreadyConsumed: boolean;
}

function toResult(d: CommitDecision): LedgerResult {
  if (!d.ok) return d;
  return { ok: true, replayed: d.replayed === true, acceptedVersionId: d.acceptedVersionId };
}

const wroteOutbox = (d: CommitDecision): boolean => d.ok && d.replayed !== true && d.writes.some((w) => w.op === 'appendOutbox');

function outboxSubject(event: OutboxEvent): AuditEvent['subject'] {
  if (event.kind === 'projection-refresh') return { kind: 'resource', id: event.payload.resourceIds[0] ?? event.eventId };
  return { kind: 'resource', id: event.payload.resourceId };
}

export interface DrainResult {
  sent: number;
  /** a send failed and the row was rescheduled (the drain stopped there) */
  failed: boolean;
  deadLettered: number;
  /** the head-of-line row is still backing off; the alarm is set for its retry time */
  waiting: boolean;
  remaining: boolean;
}

export class OrgLedger extends DurableObject<Env> {
  readonly #store: SqliteLedgerStore;
  #draining: Promise<DrainResult> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#store = new SqliteLedgerStore(ctx.storage);
    void ctx.blockConcurrencyWhile(async () => {
      migrate(ctx.storage);
      // recovery: never leave pending outbox rows without an alarm
      if (this.#store.transactionSync((tx) => tx.hasPendingOutbox()) && (await ctx.storage.getAlarm()) === null) {
        await ctx.storage.setAlarm(Date.now());
      }
    });
  }

  /**
   * Test seam: the ledger clock. Only tests running inside the DO (`runInDurableObject`) set it, to
   * run conformance record scenarios through the real `putProposal` at the scenario's time. An
   * instance field, so it is not reachable over RPC.
   */
  clockForTests: (() => string) | null = null;

  #now(): string {
    return this.clockForTests?.() ?? new Date().toISOString();
  }

  /** Run an RPC body, converting every error to a coded `LedgerRpcError`. */
  async #rpc<T>(fn: () => T | Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw toLedgerRpcError(e);
    }
  }

  /**
   * Run a ledger operation and, in the same synchronous turn as its commit, arm the outbox alarm,
   * so the alarm write lands in the same storage batch as the outbox rows (no await in between).
   */
  #commit(op: (tx: SqliteLedgerTx) => CommitDecision): CommitDecision {
    const d = this.#store.transactionSync(op);
    if (wroteOutbox(d)) void this.ctx.storage.setAlarm(Date.now());
    return d;
  }

  /** Record-keeping write on behalf of `organizationId`: check the pin, write, pin on success. */
  #recordTx<T>(organizationId: string, fn: (tx: SqliteLedgerTx) => T): T {
    const org = IdSegmentSchema.parse(organizationId);
    return this.#store.transactionSync((tx) => {
      tx.checkLedgerOrganization(org);
      const r = fn(tx);
      tx.pinLedgerOrganization(org);
      return r;
    });
  }

  // ------------------------------------------------------------------ ledger operations

  // Native evidence payload registration/deletion. Trusted service writes bytes before registration.
  async registerNativePayload(organizationId:string,projectId:string,actorId:string,raw:unknown):Promise<string> {
    const record=z.object({digest:z.string().regex(/^[a-f0-9]{64}$/),size:z.number().int().nonnegative().max(1048576),mediaType:z.string().min(1).max(256)}).strict().parse(raw);
    return this.#rpc(()=>this.#recordTx(organizationId,tx=>{
      const value=tx.getNativeProjectJson(projectId);if(!value)throw new ProjectError('project_not_found','project is not enabled');
      const state=ProjectStateSchema.parse(JSON.parse(value));
      if(!state.authorities.some(a=>a.principalId===actorId&&a.active&&a.role!=='agent'))throw new ProjectError('authority_denied','active human project authority required');
      const old=tx.nativePayload(projectId,record.digest);
      if(old){if(old.state!=='active'||old.size!==record.size||old.mediaType!==record.mediaType)throw new ProjectError('revision_conflict','payload was deleted or metadata differs');return canonicalJson({...old,replayed:true});}
      tx.putNativePayload(projectId,record.digest,record.size,record.mediaType);return canonicalJson({...record,state:'active',replayed:false});
    }));
  }
  async getNativePayload(projectId:string,digest:string):Promise<string|null> {
    return this.#rpc(()=>this.#store.transactionSync(tx=>{const record=tx.nativePayload(projectId,digest);return record?canonicalJson(record):null;}));
  }
  async deleteNativePayload(organizationId:string,projectId:string,actorId:string,digest:string):Promise<string> {
    z.string().regex(/^[a-f0-9]{64}$/).parse(digest);
    return this.#rpc(()=>this.#recordTx(organizationId,tx=>{
      const value=tx.getNativeProjectJson(projectId);if(!value)throw new ProjectError('project_not_found','project is not enabled');
      const state=ProjectStateSchema.parse(JSON.parse(value));
      if(!state.authorities.some(a=>a.principalId===actorId&&a.active&&a.role!=='agent'))throw new ProjectError('authority_denied','active human project authority required');
      if(state.evidence.some(e=>e.attachments.some(a=>a.digest===digest)))throw new ProjectError('revision_conflict','payload is retained by project evidence history');
      const old=tx.nativePayload(projectId,digest);
      tx.tombstoneNativePayload(projectId,digest);return canonicalJson({deleted:true,replayed:!old||old.state==='deleted'});
    }));
  }
  #checkNativeEvidencePayloads(tx:SqliteLedgerTx,projectId:string,raw:unknown):void {
    const evidence=ScenarioEvidenceSchema.parse(raw);
    for(const attachment of evidence.attachments){const payload=tx.nativePayload(projectId,attachment.digest);if(!payload||payload.state!=='active'||payload.size!==attachment.size||payload.mediaType!==attachment.mediaType)throw new ProjectError('scenario_evidence_invalid','evidence attachment is not an active verified project payload');}
  }
  // End native evidence payload operations.

  async getNativeProject(projectId: string): Promise<string | null> {
    return this.#rpc(() => this.#store.transactionSync(tx => tx.getNativeProjectJson(IdSegmentSchema.parse(projectId))));
  }

  /** Controlled one-way enablement. The HTTP adapter checks directory/in-flight operations;
   * resource ownership and exact accepted heads are rechecked atomically here. */
  async enableNativeProject(raw: unknown): Promise<string> {
    const q = z.object({ organizationId: IdSegmentSchema, projectId: IdSegmentSchema, actorId: z.string().min(1),
      creation: z.boolean().optional(), policyRevision: z.number().int().nonnegative(), sourceHeads: z.array(z.object({resourceId:z.string(),revisionId:z.string()})).max(1000),
      authorities: z.array(z.object({principalId:z.string(),role:z.enum(['owner','developer']),revision:z.number().int().nonnegative(),active:z.boolean()})).max(1000),
    }).strict().parse(raw);
    return this.#rpc(() => this.#recordTx(q.organizationId, tx => {
      const existing = tx.getNativeProjectJson(q.projectId);
      if (existing) return existing;
      const s = createProjectState(q.organizationId, q.projectId);
      s.authorities = q.authorities.map(a=>({...a,active:a.active&&!tx.nativeAuthorityTransitionPending(a.principalId)})); s.sourceHeads = q.sourceHeads; s.policyRevision = q.policyRevision;
      if (!s.authorities.some(a => a.principalId === q.actorId && a.active && (a.role === 'owner' || q.creation === true && q.sourceHeads.length === 0 && a.role === 'developer'))) throw new ProjectError('authority_denied', 'owner enablement or fresh empty project creation required');
      if(tx.projectResourceReservations(q.projectId).some(id=>!s.sourceHeads.some(h=>h.resourceId===id)))throw new ProjectError('review_subject_changed','source setup or prior attachment requires reconciliation before enablement');
      for (const h of s.sourceHeads) {
        if (tx.hasOtherResourceMount(h.resourceId,q.projectId) || tx.nativeResourceProject(h.resourceId) || tx.getResourceOrganization(h.resourceId) !== q.organizationId || tx.getHead(h.resourceId)?.revisionId !== h.revisionId) throw new ProjectError('review_subject_changed', 'source ownership or head changed');
      }
      const value = canonicalJson(createNativeGenesis(s,{actorId:q.actorId,now:this.#now()}));
      tx.putNativeProjectJson(q.projectId,q.organizationId,s.generation,value);
      for (const h of s.sourceHeads) tx.lockNativeResource(h.resourceId,q.projectId);
      return value;
    }));
  }

  /** Permanent attachment history serializes legacy attachment against native ownership. */
  async reserveResourceMount(organizationId:string,projectId:string,resourceId:string):Promise<void> {
    return this.#rpc(()=>this.#recordTx(organizationId,tx=>{
      const owner=tx.nativeResourceProject(resourceId);
      if(tx.getNativeProjectJson(projectId)&&owner!==projectId)throw new ProjectError('project_mode_unsupported','project mode changed; create a reserved native source');
      if(owner&&owner!==projectId)throw new ProjectError('project_mode_unsupported','native sources cannot be shared');
      tx.reserveResourceMount(resourceId,projectId);
    }));
  }

  async nativeSourceProject(resourceId:string):Promise<string|null> {
    return this.#rpc(()=>this.#store.transactionSync(tx=>tx.nativeResourceProject(resourceId)));
  }
  /** Reserve a fresh source before it is visible in a directory mount or setup job. */
  async reserveNativeSource(organizationId:string,projectId:string,actorId:string,resourceId:string):Promise<void> {
    return this.#rpc(()=>this.#recordTx(organizationId,tx=>{
      const stored=tx.getNativeProjectJson(projectId);if(!stored)throw new ProjectError('project_not_found','project is not enabled');
      const s=ProjectStateSchema.parse(JSON.parse(stored));
      if(!s.authorities.some(a=>a.principalId===actorId&&a.active&&a.role!=='agent'))throw new ProjectError('authority_denied','active human project authority required');
      const owner=tx.nativeResourceProject(resourceId);
      if(owner===projectId)return;
      if(owner||tx.hasOtherResourceMount(resourceId,projectId)||tx.getHead(resourceId)||tx.getResourceOrganization(resourceId)!==null)throw new ProjectError('review_subject_changed','source reservation requires an unbound resource');
      tx.lockNativeResource(resourceId,projectId);
    }));
  }

  /** Fresh folder genesis only. Existing source changes still require native acceptance. */
  async initializeNativeSource(raw:unknown):Promise<LedgerResult> {
    const q=z.object({organizationId:IdSegmentSchema,projectId:IdSegmentSchema,actorId:z.string().min(1),resourceId:z.string().min(1),revisionId:z.string().min(1),idempotencyKey:z.string().min(1).max(256)}).strict().parse(raw);
    return this.#rpc(()=>this.#recordTx(q.organizationId,tx=>{
      const stored=tx.getNativeProjectJson(q.projectId);if(!stored)throw new ProjectError('project_not_found','project is not enabled');
      const s=ProjectStateSchema.parse(JSON.parse(stored));
      if(!s.authorities.some(a=>a.principalId===q.actorId&&a.active&&a.role!=='agent'))throw new ProjectError('authority_denied','active human project authority required');
      if(tx.hasOtherResourceMount(q.resourceId,q.projectId))throw new ProjectError('review_subject_changed','source attachment history belongs to another project');
      const ownership=tx.nativeResourceProject(q.resourceId),head=s.sourceHeads.find(h=>h.resourceId===q.resourceId);
      if(ownership && (ownership!==q.projectId || head && head.revisionId!==q.revisionId))throw new ProjectError('review_subject_changed','source already belongs to an accepted project');
      if(!head && (tx.getHead(q.resourceId)||tx.getResourceOrganization(q.resourceId)!==null))throw new ProjectError('review_subject_changed','source genesis requires an unbound resource');
      const now=this.#now();
      const d=executeBindHead(tx,{organizationId:q.organizationId,resourceId:q.resourceId,revisionId:q.revisionId,idempotencyKey:q.idempotencyKey,actor:{kind:'user',id:q.actorId}},now);
      if(!d.ok)return toResult(d);
      if(head){if(!d.replayed)throw new ProjectError('review_subject_changed','source genesis is already recorded');return toResult(d);}
      if(d.replayed)throw new ProjectError('review_subject_changed','source was initialized outside this project');
      s.sourceHeads.push({resourceId:q.resourceId,revisionId:q.revisionId});s.sourceHeads.sort((a,b)=>a.resourceId.localeCompare(b.resourceId));s.generation++;
      const parent=s.manifests.at(-1);
      const manifest={schemaVersion:1 as const,organizationId:q.organizationId,projectId:q.projectId,id:`source-init:${q.resourceId}`,author:q.actorId,createdAt:now,sequence:(parent?.sequence??-1)+1,parent:parent?.hash??null,sourceHeads:s.sourceHeads,knowledgeHead:s.knowledgeHead,knowledgeGeneration:s.knowledgeGeneration,envelopeDigest:null,decisionId:null,evidenceIds:[],behavior:'historical-unverified' as const};
      s.manifests.push({...manifest,hash:computeProjectManifestHash(manifest)});
      if(!ownership)tx.lockNativeResource(q.resourceId,q.projectId);tx.putNativeProjectJson(q.projectId,q.organizationId,s.generation,canonicalJson(ProjectStateSchema.parse(s)));
      return toResult(d);
    }));
  }

  /** Directory checks occur in trusted Worker code; CAS fences any concurrent revocation. */
  async reconcileNativeAuthority(organizationId:string,projectId:string,actorId:string,principalId:string,role:'owner'|'developer',expectedGeneration:number,idempotencyKey:string):Promise<string> {
    z.enum(['owner','developer']).parse(role);z.string().min(1).max(256).parse(idempotencyKey);
    return this.#rpc(()=>this.#recordTx(organizationId,tx=>{
      const stored=tx.getNativeProjectJson(projectId);if(!stored)throw new ProjectError('project_not_found','project is not enabled');
      const s=ProjectStateSchema.parse(JSON.parse(stored));
      const requestDigest=hashCanonicalSync({domain:'cf.native-authority-reconcile/1',actorId,principalId,role,expectedGeneration});
      const replay=s.idempotency.find(r=>r.key===idempotencyKey);
      if(replay){if(replay.requestDigest!==requestDigest)throw new ProjectError('revision_conflict','idempotency key belongs to another request');return canonicalJson(s);}
      if(tx.nativeAuthorityTransitionPending(principalId)||tx.nativeAuthorityTransitionPending(actorId))throw new ProjectError('revision_conflict','directory authority update is still pending');
      if(s.generation!==expectedGeneration)throw new ProjectError('revision_conflict','authority or project changed; retry directory reconciliation');
      if(!s.authorities.some(a=>a.principalId===actorId&&a.active&&a.role==='owner'))throw new ProjectError('authority_denied','active project owner required');
      const previous=s.authorities.find(a=>a.principalId===principalId);
      if(previous){if(!previous.active||previous.role!==role){previous.active=true;previous.role=role;previous.revision++;}}else s.authorities.push({principalId,role,revision:1,active:true});
      s.generation++;s.idempotency.push({key:idempotencyKey,requestDigest,resultGeneration:s.generation,resultId:principalId});
      tx.putNativeProjectJson(projectId,organizationId,s.generation,canonicalJson(ProjectStateSchema.parse(s)));return canonicalJson(s);
    }));
  }

  /** Only trusted Worker service code calls this RPC; authority never comes from command JSON. */
  async nativeCommand(organizationId: string, projectId: string, command: unknown, actorId: string, artifactInput?: unknown, runnerId?: string): Promise<string> {
    return this.#rpc(() => this.#recordTx(organizationId, tx => {
      const stored = tx.getNativeProjectJson(projectId);
      if (!stored) throw new ProjectError('project_not_found','agent-native project is not enabled');
      const state = ProjectStateSchema.parse(JSON.parse(stored));
      const actor = {actorId,now:this.#now(),...(runnerId ? {trustedRunner:{runnerId}} : {})};
      const c = command as {type?:string;record?:unknown};
      if(c.type==='recordEvidence')this.#checkNativeEvidencePayloads(tx,projectId,c.record);
      const result = c.type === 'accept' ? planProjectAccept(tx,state,command,actor,artifactInput === undefined ? undefined : AcceptInputSchema.parse(artifactInput)) : applyProjectCommand(state,command,actor);
      if (!result.replayed) {
        // No asynchronous operation may split artifact writes from the project state write.
        applyWrites(tx,result.artifactWrites);
        tx.putNativeProjectJson(projectId,organizationId,result.state.generation,canonicalJson(result.state));
        if (result.artifactWrites.some(w => w.op === 'appendOutbox')) void this.ctx.storage.setAlarm(Date.now());
      }
      return canonicalJson(result);
    }));
  }

  /** Revoke effective native authority BEFORE a D1 membership/grant change reports success. */
  async revokeNativeAuthority(organizationId:string, principalId:string):Promise<string> {
    return this.#rpc(() => this.#recordTx(organizationId,tx => {
      const token=crypto.randomUUID();tx.beginNativeAuthorityTransition(token,principalId);
      for (const value of tx.listNativeProjectJson()) {
        const s = ProjectStateSchema.parse(JSON.parse(value));
        const a = s.authorities.find(a => a.principalId === principalId);
        // Fence reconciliation even when the principal has never been enrolled.
        if(a){a.active=false; a.revision++;} s.generation++;
        const latest = new Map(s.mandates.map(m => [m.id,m]));
        for (const m of latest.values()) if (m.issuer === principalId && !m.revokedAt) s.mandates.push({...m,revision:m.revision+1,createdAt:this.#now(),revokedAt:this.#now(),revocationGeneration:m.revocationGeneration+1});
        tx.putNativeProjectJson(s.projectId,organizationId,s.generation,canonicalJson(s));
      }
      return token;
    }));
  }

  /** Complete only after directory writes and lease narrowing succeed. Failures stay denied. */
  async finishNativeAuthorityRevocation(organizationId:string,token:string):Promise<void> {
    return this.#rpc(()=>this.#recordTx(organizationId,tx=>{
      tx.finishNativeAuthorityTransition(token);
      for(const value of tx.listNativeProjectJson()) {const s=ProjectStateSchema.parse(JSON.parse(value));s.generation++;tx.putNativeProjectJson(s.projectId,organizationId,s.generation,canonicalJson(s));}
    }));
  }

  async issueNativeHandoff(organizationId:string,projectId:string,actorId:string,taskId:string,agentId:string,resourceIds:string[],codeHash:string,renewal?:{mandateId:string;revision:number;expectedGeneration:number;idempotencyKey:string}):Promise<string> {
    return this.#rpc(() => this.#recordTx(organizationId,tx => {
      const stored=tx.getNativeProjectJson(projectId);
      if(!stored) throw new ProjectError('project_not_found','project is not enabled');
      const s=ProjectStateSchema.parse(JSON.parse(stored)); const now=this.#now();
      const renewalKey=renewal?`native-renewal:${actorId}:${renewal.idempotencyKey}`:null;
      const requestDigest=renewal?hashCanonicalSync({domain:'cf.native-renewal/1',organizationId,projectId,actorId,taskId,agentId,resourceIds:[...resourceIds].sort(),codeHash,...renewal}):null;
      if(renewal){
        const actor=s.authorities.find(a=>a.principalId===actorId&&a.active&&a.role!=='agent');
        if(!actor)throw new ProjectError('authority_denied','active human project authority required');
        const replay=s.idempotency.find(i=>i.key===renewalKey);
        if(replay){
          if(replay.requestDigest!==requestDigest)throw new ProjectError('idempotency_conflict','renewal key already used for another request');
          const raw=tx.getNativeHandoff(codeHash);const issued=raw?JSON.parse(raw) as {mandateId:string;consumed:boolean;expiresAt:number}:null;
          const latest=issued?s.mandates.filter(m=>m.id===issued.mandateId).at(-1):null;
          if(!issued||issued.consumed||issued.expiresAt<=Date.parse(now))throw new ProjectError('revision_conflict','replacement handoff consumed or expired; use the issued lease or request a new replacement');
          if(!latest||latest.revokedAt)throw new ProjectError('mandate_revoked','replacement authority is no longer active');
          return canonicalJson({mandateId:issued.mandateId,expiresAt:issued.expiresAt,replacesMandateId:renewal.mandateId,replayed:true});
        }
        if(s.generation!==renewal.expectedGeneration)throw new ProjectError('revision_conflict','project generation changed');
        const prior=s.mandates.filter(m=>m.id===renewal.mandateId).at(-1);
        if(!prior||prior.taskId!==taskId||prior.revision!==renewal.revision||prior.revokedAt)throw new ProjectError('revision_conflict','renewal must name the current unrevoked task mandate');
      }
      // Issuing a replacement handoff ends authority of previous attempts for this task.
      for(const old of new Map(s.mandates.map(m=>[m.id,m])).values()) if(old.taskId===taskId&&!old.revokedAt){s.mandates.push({...old,revision:old.revision+1,createdAt:now,revokedAt:now,revocationGeneration:old.revocationGeneration+1});s.attempts=s.attempts.map(a=>a.mandateId===old.id?{...a,status:'revoked' as const,endedAt:now}:a);}
      if(!s.authorities.some(a=>a.principalId===agentId)) s.authorities.push({principalId:agentId,role:'agent',revision:1,active:true});
      if(resourceIds.some(id=>!s.sourceHeads.some(h=>h.resourceId===id))) throw new ProjectError('mandate_scope_denied','resource outside project');
      const mandateId=`mandate:${codeHash}`;
      const result=applyProjectCommand(s,{type:'issueMandate',expectedGeneration:s.generation,idempotencyKey:`handoff:${codeHash}`,record:{schemaVersion:1,organizationId,projectId,id:mandateId,author:actorId,createdAt:now,revision:1,taskId,agentId,issuer:actorId,operations:['context:read','source:checkout','candidate:submit','knowledge:propose','attempt:read'],resourceIds,issuedAt:now,expiresAt:new Date(Date.parse(now)+3600000).toISOString(),revocationGeneration:0,revokedAt:null,maxAttempts:1,maxJobs:10,timeoutSeconds:120}}, {actorId,now});
      const record={codeHash,projectId,taskId,issuer:actorId,agentId,mandateId,expiresAt:Date.parse(now)+900000,consumed:false,packet:null,attemptId:null};
      if(renewal)result.state.idempotency.push({key:renewalKey!,requestDigest:requestDigest!,resultGeneration:result.state.generation,resultId:mandateId});
      tx.putNativeHandoff(codeHash,null,projectId,canonicalJson(record));
      tx.putNativeProjectJson(projectId,organizationId,result.state.generation,canonicalJson(ProjectStateSchema.parse(result.state)));
      return canonicalJson({mandateId,expiresAt:record.expiresAt,...(renewal?{replacesMandateId:renewal.mandateId,replayed:false}:{})});
    }));
  }

  async exchangeNativeHandoff(organizationId:string,projectId:string,codeHash:string,tokenHash:string):Promise<string> {
    return this.#rpc(() => this.#recordTx(organizationId,tx => {
      const raw=tx.getNativeHandoff(codeHash); const stored=tx.getNativeProjectJson(projectId);
      if(!raw || !stored) throw new ProjectError('authority_denied','handoff unavailable');
      const h=JSON.parse(raw) as {codeHash:string;projectId:string;taskId:string;issuer:string;agentId:string;mandateId:string;expiresAt:number;consumed:boolean;packet:unknown;attemptId:string|null};
      const now=this.#now();
      if(h.projectId!==projectId || h.consumed || h.expiresAt<=Date.parse(now)) throw new ProjectError('authority_denied','handoff unavailable');
      const s=ProjectStateSchema.parse(JSON.parse(stored));
      const m=s.mandates.filter(m=>m.id===h.mandateId).at(-1);
      if(!m) throw new ProjectError('authority_denied','handoff unavailable');
      const attemptId=`attempt:${codeHash}`;
      const outcomes=[...new Map(s.outcomes.map(o=>[o.id,o])).values()];
      const packet=materializeProjectContext({domain:'cf.project-context/1',schemaVersion:1,organizationId,projectId,taskId:h.taskId,attemptId,mandate:m,knowledgeHead:s.knowledgeHead,knowledgeGeneration:s.knowledgeGeneration,outcomes,rules:currentConfirmed(s.knowledge).filter(k=>k.kind!=='assumption'),assumptions:[...new Map(s.knowledge.filter(k=>k.kind==='assumption' && !k.archived).map(k=>[k.id,k])).values()],scenarios:currentConfirmed(s.scenarios),sourceHeads:s.sourceHeads,omissions:[]});
      const result=applyProjectCommand(s,{type:'exchangeHandoff',expectedGeneration:s.generation,idempotencyKey:`exchange:${codeHash}`,record:{schemaVersion:1,organizationId,projectId,id:attemptId,author:h.agentId,createdAt:now,taskId:h.taskId,agentId:h.agentId,mandateId:m.id,mandateRevision:m.revision,contextDigest:packet.digest,knowledgeHead:s.knowledgeHead,startedAt:now,endedAt:null,status:'active',proposalIds:[]}}, {actorId:h.agentId,now});
      h.consumed=true;h.packet=packet;h.attemptId=attemptId;
      tx.putNativeHandoff(codeHash,tokenHash,projectId,canonicalJson(h));
      tx.putNativeProjectJson(projectId,organizationId,result.state.generation,canonicalJson(result.state));
      return canonicalJson({taskId:h.taskId,issuer:h.issuer,agentId:h.agentId,mandateId:m.id,attemptId,expiresAt:m.expiresAt,generation:result.state.generation,context:packet});
    }));
  }

  async resolveNativeToken(projectId:string,tokenHash:string):Promise<string|null> {
    return this.#rpc(() => this.#store.transactionSync(tx => {
      const raw=tx.getNativeHandoff(tokenHash,true);const stored=tx.getNativeProjectJson(projectId);
      if(!raw || !stored) return null;
      const h=JSON.parse(raw) as {projectId:string;taskId:string;issuer:string;agentId:string;mandateId:string;attemptId:string;packet:unknown};
      const s=ProjectStateSchema.parse(JSON.parse(stored));const m=s.mandates.filter(m=>m.id===h.mandateId).at(-1);const now=Date.parse(this.#now());
      if(h.projectId!==projectId || !m || m.revokedAt || Date.parse(m.expiresAt)<=now || !s.authorities.some(a=>a.principalId===h.issuer && a.active) || !s.authorities.some(a=>a.principalId===h.agentId && a.active)) return null;
      return canonicalJson({...h,generation:s.generation,expiresAt:m.expiresAt,knowledgeStale:(s.attempts.find(a=>a.id===h.attemptId)?.knowledgeHead!==s.knowledgeHead)});
    }));
  }

  async recordNativeObservation(organizationId:string,projectId:string,raw:unknown):Promise<void> {
    return this.#rpc(() => this.#recordTx(organizationId,tx => {
      const value=tx.getNativeProjectJson(projectId);if(!value)throw new ProjectError('project_not_found','project unavailable');
      const s=ProjectStateSchema.parse(JSON.parse(value)),r=ReleaseObservationSchema.parse(raw);
      if(r.organizationId!==organizationId || r.projectId!==projectId || !s.manifests.some(m=>m.hash===r.manifestHash&&m.behavior==='verified') || Date.parse(r.observedAt)>Date.parse(this.#now()) || Date.parse(r.freshUntil)<=Date.parse(r.observedAt))throw new ProjectError('review_subject_changed','observation subject unavailable');
      const prior=s.observations.find(x=>x.id===r.id);if(prior){if(canonicalJson(prior)!==canonicalJson(r))throw new ProjectError('revision_conflict','observation identity already used');return;}
      s.observations.push(r);s.generation++;tx.putNativeProjectJson(projectId,organizationId,s.generation,canonicalJson(ProjectStateSchema.parse(s)));
    }));
  }

  async reserveNativeVerification(organizationId:string,projectId:string,actorId:string,key:string,raw:unknown):Promise<string> {
    return this.#rpc(() => this.#recordTx(organizationId,tx => {
      const request=ScenarioVerificationRequestSchema.parse(raw),value=tx.getNativeProjectJson(projectId);
      if(!value)throw new ProjectError('project_not_found','project unavailable');
      const s=ProjectStateSchema.parse(JSON.parse(value));
      if(!s.authorities.some(a=>a.principalId===actorId&&a.active&&a.role!=='agent'))throw new ProjectError('authority_denied','human authority required');
      const p=s.proposals.find(p=>p.digest===request.envelopeDigest);
      const terminal=tx.nativeJob(projectId,key);
      if(p&&request.organizationId===organizationId&&request.projectId===projectId&&terminal?.result){const old=ScenarioVerificationRequestSchema.parse(JSON.parse(terminal.request));if(old.envelopeDigest!==request.envelopeDigest)throw new ProjectError('idempotency_conflict','verification key already used');return canonicalJson(terminal);}
      if(!p || request.organizationId!==organizationId || request.projectId!==projectId || p.envelope.expectedKnowledgeHead!==s.knowledgeHead || p.envelope.expectedParent!==s.manifests.at(-1)?.hash || p.envelope.policyRevision!==s.policyRevision)throw new ProjectError('knowledge_stale','proposal requirements changed');
      if(p.envelope.recovery){
        validateProjectRecovery(s,p.envelope);
        if(!s.authorities.some(a=>a.principalId===p.author&&a.active&&a.role!=='agent'))throw new ProjectError('authority_denied','recovery requester authority unavailable');
        const prior=tx.nativeJob(projectId,key);
        if(prior){const old=ScenarioVerificationRequestSchema.parse(JSON.parse(prior.request));if(old.envelopeDigest!==request.envelopeDigest)throw new ProjectError('idempotency_conflict','verification key already used');return canonicalJson(prior);}
        if(tx.nativeJobCount(projectId,p.digest)>=10)throw new ProjectError('mandate_scope_denied','recovery verification job budget exhausted');
      }else{
      const mandate=s.mandates.filter(m=>m.id===p.envelope.mandateId).at(-1);
      const attempt=s.attempts.find(a=>a.id===p.envelope.attemptId);
      if(!mandate||!attempt||mandate.revokedAt||Date.parse(mandate.expiresAt)<=Date.parse(this.#now())||mandate.revision!==p.envelope.mandateRevision||attempt.mandateId!==mandate.id||attempt.status==='revoked'||!s.authorities.some(a=>a.principalId===mandate.issuer&&a.active&&a.role!=='agent'))throw new ProjectError('mandate_revoked','verification mandate unavailable');
      // A pending idempotent dispatch is still new execution: revocation must win over replay.
      const prior=tx.nativeJob(projectId,key);
      if(prior){const old=ScenarioVerificationRequestSchema.parse(JSON.parse(prior.request));if(old.envelopeDigest!==request.envelopeDigest)throw new ProjectError('idempotency_conflict','verification key already used');return canonicalJson(prior);}
      const used=s.proposals.filter(q=>q.envelope.mandateId===mandate.id).reduce((count,q)=>count+tx.nativeJobCount(projectId,q.digest),0);
      if(used>=mandate.maxJobs)throw new ProjectError('mandate_scope_denied','verification job budget exhausted');
      }
      tx.putNativeJob(projectId,key,canonicalJson(request),null);return canonicalJson({request:canonicalJson(request),result:null});
    }));
  }

  /** Authenticated dispatch failed before trusted execution could be established. No scenario
   * evidence is fabricated; persist a terminal record so retry/history stays inspectable. */
  async failNativeVerification(organizationId:string,projectId:string,actorId:string,key:string,code:'transport_unavailable'|'result_invalid'):Promise<string> {
    return this.#rpc(()=>this.#recordTx(organizationId,tx=>{
      z.enum(['transport_unavailable','result_invalid']).parse(code);
      const job=tx.nativeJob(projectId,key),value=tx.getNativeProjectJson(projectId);
      if(!job||!value)throw new ProjectError('scenario_evidence_invalid','verification job unavailable');
      const state=ProjectStateSchema.parse(JSON.parse(value));
      if(!state.authorities.some(a=>a.principalId===actorId&&a.active&&a.role!=='agent'))throw new ProjectError('authority_denied','human authority required');
      if(job.result)return job.result;
      const request=ScenarioVerificationRequestSchema.parse(JSON.parse(job.request));
      const output=canonicalJson({runId:request.runId,state,evidence:[],status:'error',execution:'not-established',completedAt:this.#now(),failure:{code,summary:code==='result_invalid'?'Verifier result could not be authenticated or matched to this request.':'Verifier transport, source preparation, or isolation was unavailable; candidate execution was not established.'}});
      tx.putNativeJob(projectId,key,job.request,output);return output;
    }));
  }

  async listNativeVerifications(organizationId:string,projectId:string,actorId:string,digests:string[],cursor=0,limit=50):Promise<string> {
    return this.#rpc(()=>this.#recordTx(organizationId,tx=>{
      z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(100).parse(digests);z.number().int().nonnegative().parse(cursor);z.number().int().min(1).max(100).parse(limit);
      const value=tx.getNativeProjectJson(projectId);if(!value)throw new ProjectError('project_not_found','project unavailable');
      const s=ProjectStateSchema.parse(JSON.parse(value)),auth=s.authorities.find(a=>a.principalId===actorId&&a.active);
      if(!auth || digests.some(d=>!s.proposals.some(p=>p.digest===d&&(auth.role!=='agent'||s.attempts.some(a=>a.id===p.envelope.attemptId&&a.agentId===actorId)))))throw new ProjectError('authority_denied','verification history unavailable');
      const rows=tx.nativeJobs(projectId,digests,cursor,limit+1),items=rows.slice(0,limit).map(job=>{
        const request=ScenarioVerificationRequestSchema.parse(JSON.parse(job.request)),result=job.result?JSON.parse(job.result):null;
        return {runId:request.runId,envelopeDigest:request.envelopeDigest,issuedAt:request.issuedAt,completedAt:result?.completedAt??result?.evidence?.[0]?.completedAt??null,status:result?(result.status??(result.failure?'error':'completed')):(Date.parse(request.expiresAt)<=Date.parse(this.#now())?'expired':'pending'),execution:result?.execution??'not-established',failure:result?.failure??null,evidenceIds:(result?.evidence??[]).map((e:{id:string})=>e.id)};
      });return canonicalJson({items,nextCursor:rows.length>limit?cursor+limit:null});
    }));
  }

  /** Result signature/set was checked by trusted HTTP service. Ingest all scenario records atomically. */
  async completeNativeVerification(organizationId:string,projectId:string,actorId:string,key:string,raw:unknown):Promise<string> {
    return this.#rpc(() => this.#recordTx(organizationId,tx => {
      const job=tx.nativeJob(projectId,key);if(!job)throw new ProjectError('scenario_evidence_invalid','verification request unavailable');
      if(job.result)return job.result;
      const request=ScenarioVerificationRequestSchema.parse(JSON.parse(job.request));const result=ScenarioVerificationResultSchema.parse(raw);
      if(result.requestDigest!==hashCanonicalSync(request))throw new ProjectError('scenario_evidence_invalid','verification request mismatch');
      const value=tx.getNativeProjectJson(projectId);if(!value)throw new ProjectError('project_not_found','project unavailable');
      let state=ProjectStateSchema.parse(JSON.parse(value));
      const proposal=state.proposals.find(p=>p.digest===request.envelopeDigest);
      if(!state.authorities.some(a=>a.principalId===actorId&&a.active&&a.role!=='agent'))throw new ProjectError('authority_denied','human authority required');
      if(!proposal||proposal.envelope.expectedKnowledgeHead!==state.knowledgeHead||proposal.envelope.expectedParent!==state.manifests.at(-1)?.hash||proposal.envelope.policyRevision!==state.policyRevision){
        const output=canonicalJson({runId:result.runId,state,evidence:result.evidence,status:'stale',execution:result.execution,completedAt:result.completedAt,failure:{code:'requirements_changed',summary:'This run completed against earlier project requirements or source. Its observations are historical and cannot authorize acceptance.'}});
        tx.putNativeJob(projectId,key,job.request,output);return output;
      }
      for(const record of result.evidence){
        this.#checkNativeEvidencePayloads(tx,projectId,record);
        const previous=state.evidence.filter(e=>e.envelopeDigest===record.envelopeDigest&&e.scenarioId===record.scenarioId).at(-1);
        // Retry supersession is explicit in the persisted platform ingestion record.
        const bound={...record,supersedes:previous?.id??null};
        state=applyProjectCommand(state,{type:'recordEvidence',record:bound,expectedGeneration:state.generation,idempotencyKey:`evidence:${record.id}`},{actorId,now:this.#now(),trustedRunner:{runnerId:record.actor}}).state;
      }
      tx.putNativeProjectJson(projectId,organizationId,state.generation,canonicalJson(state));
      const output=canonicalJson({runId:result.runId,evidence:state.evidence.filter(e=>e.runId===result.runId),state,execution:result.execution});
      tx.putNativeJob(projectId,key,job.request,output);return output;
    }));
  }

  async importNativeBundle(organizationId:string,projectId:string,ownerId:string,raw:unknown):Promise<string> {
    return this.#rpc(() => this.#recordTx(organizationId,tx=>{
      const bundle=validateProjectBundle(raw),archive=tx.getNativeArchive(projectId);
      if(archive){if(validateProjectBundle(JSON.parse(archive)).digest!==bundle.digest)throw new ProjectError('idempotency_conflict','import destination already used');return tx.getNativeProjectJson(projectId)!;}
      if(tx.getNativeProjectJson(projectId))throw new ProjectError('project_mode_unsupported','import requires a new project');
      const result=importProjectBundle(bundle,{organizationId,projectId,ownerId,now:this.#now()});const value=canonicalJson(result.state);
      tx.putNativeProjectJson(projectId,organizationId,result.state.generation,value);tx.putNativeArchive(projectId,bundle.digest,canonicalJson(bundle));return value;
    }));
  }

  async nativeArchive(projectId:string):Promise<string|null>{return this.#rpc(()=>this.#store.transactionSync(tx=>tx.getNativeArchive(projectId)));}

  /** Conditional acceptance (§B.9). The acting organization is the proposal's. */
  async accept(input: unknown): Promise<LedgerResult> {
    return this.#rpc(() => {
      const parsed = AcceptInputSchema.parse(input);
      const now = this.#now();
      const d = this.#commit((tx) => {
        const proposal = tx.getProposal(parsed.proposalId);
        if (proposal) tx.checkLedgerOrganization(proposal.organizationId);
        if (proposal && (tx.getNativeProjectJson(proposal.projectId) || [...proposal.resourceChanges,...proposal.assetManifestChanges].some(r => tx.nativeResourceProject(r.resourceId)))) throw new ProjectError('project_mode_unsupported','use project envelope acceptance for agent-native resources');
        const decision = executeCommit(tx, parsed, now);
        if (decision.ok && proposal) tx.pinLedgerOrganization(proposal.organizationId);
        return decision;
      });
      return toResult(d);
    });
  }

  /** Forward restore of one resource head under CAS. Pins the organization only on success. */
  async restore(input: unknown): Promise<LedgerResult> {
    return this.#rpc(() => {
      const parsed = RestoreRequestSchema.parse(input);
      const now = this.#now();
      const d = this.#commit((tx) => {
        tx.checkLedgerOrganization(parsed.organizationId);
        if (tx.nativeResourceProject(parsed.resourceId)) throw new ProjectError('project_mode_unsupported','recovery requires a project proposal under current knowledge');
        const decision = executeRestore(tx, parsed, now);
        if (decision.ok) tx.pinLedgerOrganization(parsed.organizationId);
        return decision;
      });
      return toResult(d);
    });
  }

  /** Genesis: create a resource's first head and bind it to the organization (pins only on success). */
  async bindHead(input: unknown): Promise<LedgerResult> {
    return this.#rpc(() => {
      const parsed = BindHeadRequestSchema.parse(input);
      const now = this.#now();
      const d = this.#commit((tx) => {
        tx.checkLedgerOrganization(parsed.organizationId);
        if (tx.nativeResourceProject(parsed.resourceId)) throw new ProjectError('project_mode_unsupported','native genesis source ownership is already fixed');
        const decision = executeBindHead(tx, parsed, now);
        if (decision.ok) tx.pinLedgerOrganization(parsed.organizationId);
        return decision;
      });
      return toResult(d);
    });
  }

  // ------------------------------------------------------------------ record keeping (never moves heads)

  /** Create or update a proposal under the rules of the ledger's `checkProposalUpdate` (via `executePutProposal`). */
  async putProposal(record: unknown): Promise<ProposalRecord> {
    return this.#rpc(() => {
      const p = ProposalRecordSchema.parse(record);
      const now = this.#now();
      return this.#recordTx(p.organizationId, (tx) => executePutProposal(tx, p, now).proposal);
    });
  }

  /** Write-once approval of an existing, non-terminal proposal. */
  async putApproval(organizationId: string, approval: unknown): Promise<ApprovalRef> {
    return this.#rpc(() => {
      const a = ApprovalRefSchema.parse(approval);
      assertNotFuture('approvedAt', a.approvedAt, Date.now());
      return this.#recordTx(organizationId, (tx) => {
        const proposal = tx.getProposal(a.proposalId);
        if (!proposal) throw ledgerError('ledger_not_found', `unknown proposal ${a.proposalId}`);
        if (PROPOSAL_TERMINAL_STATES.includes(proposal.state)) throw ledgerError('ledger_conflict', `proposal ${a.proposalId} is ${proposal.state}`);
        tx.putApproval(a);
        return a;
      });
    });
  }

  /** Candidate lifecycle record; the frozen candidate is immutable, state follows core's machine. */
  async putCandidate(organizationId: string, record: unknown): Promise<CandidateRecord> {
    return this.#rpc(() => {
      const c = CandidateRecordSchema.parse(record);
      return this.#recordTx(organizationId, (tx) => {
        if (checkCandidateUpdate(tx.getCandidate(c.candidate.candidateId), c) === 'write') tx.putCandidate(c);
        return c;
      });
    });
  }

  /** Task workspace handle; identity is immutable, state follows core's machine. */
  async putWorkspace(organizationId: string, handle: unknown): Promise<TaskWorkspaceHandle> {
    return this.#rpc(() => {
      const w = TaskWorkspaceHandleSchema.parse(handle);
      return this.#recordTx(organizationId, (tx) => {
        if (checkWorkspaceUpdate(tx.getWorkspace(w.taskWorkspaceId), w) === 'write') tx.putWorkspace(w);
        return w;
      });
    });
  }

  /** Record a `prepare-candidate` receipt (the caller verified the runner signature first). Write-once. */
  async recordPreparedReceipt(organizationId: string, receipt: unknown): Promise<void> {
    return this.#rpc(() => {
      const r = PreparedReceiptSchema.parse(receipt);
      assertNotFuture('preparedAt', r.preparedAt, Date.now());
      this.#recordTx(organizationId, (tx) => tx.putPreparedReceipt(r));
    });
  }

  /**
   * Record an `integrate` receipt (the caller verified the runner signature first). Write-once per
   * (proposalId, jobId); the proposal must exist and not be terminal (an accepted proposal's
   * receipts are frozen), and a new job's receipt may not be older than the latest one.
   */
  async recordIntegrationReceipt(organizationId: string, receipt: unknown): Promise<void> {
    return this.#rpc(() => {
      const r = IntegrationReceiptSchema.parse(receipt);
      assertNotFuture('integratedAt', r.integratedAt, Date.now());
      this.#recordTx(organizationId, (tx) => {
        const proposal = tx.getProposal(r.proposalId);
        if (!proposal) throw ledgerError('ledger_not_found', `unknown proposal ${r.proposalId}`);
        if (PROPOSAL_TERMINAL_STATES.includes(proposal.state)) {
          throw ledgerError('ledger_conflict', `proposal ${r.proposalId} is ${proposal.state}; its receipts are frozen`);
        }
        const latest = tx.getIntegrationReceipt(r.proposalId);
        if (latest && latest.jobId !== r.jobId && r.integratedAt < latest.integratedAt) {
          throw ledgerError('ledger_conflict', `integration receipt ${r.jobId} is older than the recorded ${latest.jobId}`);
        }
        tx.putIntegrationReceipt(r);
      });
    });
  }

  /** Set a project's current policy revision (never decreases). */
  async setPolicyRevision(organizationId: string, projectId: string, policyRevision: number): Promise<void> {
    return this.#rpc(() => {
      const project = IdSegmentSchema.parse(projectId);
      const rev = z.number().int().nonnegative().parse(policyRevision);
      this.#recordTx(organizationId, (tx) => {
        const current = tx.getCurrentPolicyRevision(project);
        if (current !== null && rev < current) throw ledgerError('ledger_conflict', `policy revision for ${project} cannot decrease (${current} -> ${rev})`);
        tx.setPolicyRevision(project, rev);
        const value=tx.getNativeProjectJson(project);
        if(value){const s=ProjectStateSchema.parse(JSON.parse(value));if(s.policyRevision!==rev){s.policyRevision=rev;s.generation++;tx.putNativeProjectJson(project,organizationId,s.generation,canonicalJson(s));}}
      });
    });
  }

  // ------------------------------------------------------------------ consumer side (Task 17; never moves heads)

  /** Consumer dedupe: the record of an already consumed `(organizationId, dedupeKey)`, or null. */
  async getConsumedEvent(organizationId: string, dedupeKey: string): Promise<ConsumedEvent | null> {
    return this.#rpc(() => {
      const org = IdSegmentSchema.parse(organizationId);
      const key = z.string().min(1).parse(dedupeKey);
      return this.#store.transactionSync((tx) => tx.getConsumed(org, key));
    });
  }

  /** Mark an event consumed; `false` when it already was (a duplicate delivery). */
  async consumeEvent(organizationId: string, input: ConsumeInput): Promise<boolean> {
    return this.#rpc(() => {
      const c = ConsumeSchema.parse(input);
      const at = this.#now();
      return this.#recordTx(organizationId, (tx) => tx.putConsumed({ organizationId, ...c, consumedAt: at }));
    });
  }

  /**
   * Record what the canonical ref was observed to be relative to a head (`synced` / `diverged`, or
   * back to `pending`), and optionally consume the event that produced the observation, atomically.
   * Projection health only: the head itself never moves. A change is applied only while the head is
   * still at `revisionId`; every change is audited (`head.reconciliation_changed`).
   */
  async recordReconciliation(organizationId: string, input: ReconciliationInput): Promise<ReconciliationResult> {
    return this.#rpc(() => {
      const r = ReconciliationInputSchema.parse(input);
      const at = this.#now();
      return this.#recordTx(organizationId, (tx) => {
        const out: ReconciliationResult = { headMatches: false, changed: false, consumed: false, alreadyConsumed: false };
        if (r.consume && tx.getConsumed(organizationId, r.consume.dedupeKey)) return { ...out, alreadyConsumed: true };
        const head = tx.getHead(r.resourceId);
        out.headMatches = head !== null && head.revisionId === r.revisionId;
        const from = tx.setReconciliation(r.resourceId, r.revisionId, r.state);
        if (out.headMatches && r.observedSha !== undefined) {
          tx.putRefState({ resourceId: r.resourceId, revisionId: r.revisionId, state: r.state, observedSha: r.observedSha, observedAt: at });
        }
        if (from !== null) {
          out.changed = true;
          tx.appendAudit({
            auditId: `au-${hashCanonicalSync([organizationId, 'head.reconciliation_changed', r.resourceId, r.revisionId, from, r.state, at]).slice(0, 32)}`,
            organizationId,
            at: at as AuditEvent['at'],
            actor: LEDGER_SERVICE_ACTOR,
            action: 'head.reconciliation_changed',
            subject: { kind: 'resource', id: r.resourceId },
            detail: { revisionId: r.revisionId, from, to: r.state, ...(r.observedSha !== undefined ? { observedSha: r.observedSha } : {}), ...(r.consume ? { dedupeKey: r.consume.dedupeKey } : {}) },
          });
        }
        if (r.consume) out.consumed = tx.putConsumed({ organizationId, ...r.consume, consumedAt: at });
        return out;
      });
    });
  }

  /** Last canonical-ref observation recorded for a resource (lease candidates, review I-1). */
  async getRefState(resourceId: string): Promise<RefState | null> {
    return this.#rpc(() => {
      const id = ResourceIdArg.parse(resourceId);
      return this.#store.transactionSync((tx) => tx.getRefState(id));
    });
  }

  // ------------------------------------------------------------------ reads

  async getAcceptedVersion(acceptedVersionId: string): Promise<AcceptedProjectVersion | null> {
    return this.#rpc(() => {
      const id = z.string().min(1).parse(acceptedVersionId);
      return this.#store.transactionSync((tx) => tx.getAcceptedVersion(id));
    });
  }

  async getOrganization(): Promise<string | null> {
    return this.#rpc(() => this.#store.transactionSync((tx) => tx.getLedgerOrganization()));
  }

  async getHead(resourceId: string): Promise<AcceptedHead | null> {
    return this.#rpc(() => {
      const id = ResourceIdArg.parse(resourceId);
      return this.#store.transactionSync((tx) => tx.getHead(id));
    });
  }

  async listHeads(): Promise<AcceptedHead[]> {
    return this.#rpc(() => this.#store.transactionSync((tx) => tx.listHeads()));
  }

  async getResourceOrganization(resourceId: string): Promise<string | null> {
    return this.#rpc(() => {
      const id = ResourceIdArg.parse(resourceId);
      return this.#store.transactionSync((tx) => tx.getResourceOrganization(id));
    });
  }

  async getProposal(proposalId: string): Promise<ProposalRecord | null> {
    return this.#rpc(() => {
      const id = z.string().min(1).parse(proposalId);
      return this.#store.transactionSync((tx) => tx.getProposal(id));
    });
  }

  async getPreparedReceipt(receiptId: string): Promise<PreparedReceipt | null> {
    return this.#rpc(() => {
      const id = z.string().min(1).parse(receiptId);
      return this.#store.transactionSync((tx) => tx.getPreparedReceipt(id));
    });
  }

  /** The latest recorded integration receipt of a proposal (review I1: the authority, not D1). */
  async getIntegrationReceipt(proposalId: string): Promise<IntegrationReceipt | null> {
    return this.#rpc(() => {
      const id = z.string().min(1).parse(proposalId);
      return this.#store.transactionSync((tx) => tx.getIntegrationReceipt(id));
    });
  }

  async listProposals(projectId?: string): Promise<ProposalRecord[]> {
    return this.#rpc(() => {
      const id = z.string().min(1).optional().parse(projectId);
      return this.#store.transactionSync((tx) => tx.listProposals(id));
    });
  }

  async listApprovals(proposalId: string): Promise<ApprovalRef[]> {
    return this.#rpc(() => {
      const id = z.string().min(1).parse(proposalId);
      return this.#store.transactionSync((tx) => tx.listApprovals(id));
    });
  }

  async getCandidate(candidateId: string): Promise<CandidateRecord | null> {
    return this.#rpc(() => {
      const id = z.string().min(1).parse(candidateId);
      return this.#store.transactionSync((tx) => tx.getCandidate(id));
    });
  }

  async listCandidates(resourceId: string): Promise<CandidateRecord[]> {
    return this.#rpc(() => {
      const id = ResourceIdArg.parse(resourceId);
      return this.#store.transactionSync((tx) => tx.listCandidates(id));
    });
  }

  async getWorkspace(taskWorkspaceId: string): Promise<TaskWorkspaceHandle | null> {
    return this.#rpc(() => {
      const id = z.string().min(1).parse(taskWorkspaceId);
      return this.#store.transactionSync((tx) => tx.getWorkspace(id));
    });
  }

  /** Accepted versions with `sequence > after`, ascending (one DO serves one organization). */
  async listAcceptedVersions(query: { after?: number; limit?: number } = {}): Promise<AcceptedProjectVersion[]> {
    return this.#rpc(() => {
      const q = PageSchema.parse(query);
      return this.#store.transactionSync((tx) => tx.listAcceptedVersions(q.after, q.limit));
    });
  }

  /** Outbox rows with `seq > after`, ascending; `filter`: all (default), pending, or dead. */
  async listOutbox(query: { after?: number; limit?: number; filter?: 'all' | 'pending' | 'dead' } = {}): Promise<OutboxRow[]> {
    return this.#rpc(() => {
      const q = OutboxQuerySchema.parse(query);
      return this.#store.transactionSync((tx) => tx.listOutbox({ filter: q.filter, afterSeq: q.after, limit: q.limit }));
    });
  }

  /** Dead-lettered outbox rows (exceeded {@link OUTBOX_MAX_ATTEMPTS}); never sent again automatically. */
  async listDeadLetters(query: { after?: number; limit?: number } = {}): Promise<OutboxRow[]> {
    return this.#rpc(() => {
      const q = PageSchema.parse(query);
      return this.#store.transactionSync((tx) => tx.listOutbox({ filter: 'dead', afterSeq: q.after, limit: q.limit }));
    });
  }

  /** Audit rows with `seq > after`, ascending. */
  async listAudit(query: { after?: number; limit?: number } = {}): Promise<AuditRow[]> {
    return this.#rpc(() => {
      const q = PageSchema.parse(query);
      return this.#store.transactionSync((tx) => tx.listAudit(q.after, q.limit));
    });
  }

  // ------------------------------------------------------------------ outbox delivery

  override async alarm(): Promise<void> {
    await this.drainOutbox();
  }

  /** Drain pending outbox rows to the queue (single-flight). Exposed for tests and ops. */
  async drainOutbox(): Promise<DrainResult> {
    if (!this.#draining) {
      this.#draining = this.#drain().finally(() => {
        this.#draining = null;
      });
    }
    return this.#draining;
  }

  async #drain(): Promise<DrainResult> {
    const result: DrainResult = { sent: 0, failed: false, deadLettered: 0, waiting: false, remaining: false };
    const rows = this.#store.transactionSync((tx) => tx.listOutbox({ filter: 'pending', afterSeq: 0, limit: OUTBOX_BATCH_LIMIT }));
    for (const row of rows) {
      if (row.nextAttemptAt > Date.now()) {
        // head of line is backing off: later rows wait for it
        await this.ctx.storage.setAlarm(row.nextAttemptAt);
        return { ...result, waiting: true, remaining: true };
      }
      try {
        // network I/O: strictly outside any transaction
        await this.env.OUTBOX.send(row.event, { contentType: 'json' });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const failure = this.#store.transactionSync((tx) => {
          const attempts = tx.markOutboxFailed(row.seq, message, (n) => Date.now() + outboxBackoffMs(n));
          if (attempts < OUTBOX_MAX_ATTEMPTS) return { dead: false, attempts };
          const at = this.#now();
          tx.markOutboxDead(row.seq, at);
          tx.appendAudit({
            auditId: `au-${hashCanonicalSync([row.event.organizationId, 'outbox.dead_lettered', row.event.eventId]).slice(0, 32)}`,
            organizationId: row.event.organizationId,
            at: at as AuditEvent['at'],
            actor: LEDGER_SERVICE_ACTOR,
            action: 'outbox.dead_lettered',
            subject: outboxSubject(row.event),
            detail: { eventId: row.event.eventId, kind: row.event.kind, dedupeKey: row.event.dedupeKey, attempts, lastError: message.slice(0, 1000) },
          });
          return { dead: true, attempts };
        });
        if (failure.dead) {
          result.deadLettered++;
          continue;
        }
        await this.ctx.storage.setAlarm(Date.now() + outboxBackoffMs(failure.attempts));
        return { ...result, failed: true, remaining: true };
      }
      const now = this.#now();
      if (this.#store.transactionSync((tx) => tx.markOutboxSent(row.seq, now))) result.sent++;
    }
    result.remaining = this.#store.transactionSync((tx) => tx.hasPendingOutbox());
    if (result.remaining) await this.ctx.storage.setAlarm(Date.now());
    return result;
  }
}
