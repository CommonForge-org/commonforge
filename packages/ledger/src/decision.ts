import {
  CoreError,
  IdSegmentSchema,
  PrincipalRefSchema,
  ResourceIdSchema,
  RestoreInputSchema,
  RevisionIdSchema,
  type AcceptedVersionId,
  type CommitRefusalCode,
  type ResourceId,
} from '@commonforge-org/core';
import { z } from 'zod';
import type { LedgerWrite } from './store.js';

/**
 * Refusal codes. The eight §B.9 codes (`CommitRefusalCode` in core) plus two ledger additions:
 * - `idempotency_key_conflict`: the idempotency key was already used for a *different* request
 *   (different request hash or a different operation scope). Refusing instead of replaying keeps a
 *   reused key from silently returning someone else's version, and refusing instead of executing
 *   keeps a lost-response retry from ever applying twice.
 * - `restore_target_unknown`: restore target was never an accepted head of the resource.
 * - `restore_noop`: restore target already is the current head; nothing is written (no version,
 *   no outbox event, idempotency key not consumed). Callers may treat it as "already there".
 */
export type LedgerRefusalCode = CommitRefusalCode | 'idempotency_key_conflict' | 'restore_target_unknown' | 'restore_noop';

export const LEDGER_REFUSAL_CODES: readonly LedgerRefusalCode[] = [
  'proposal_hash_mismatch',
  'expected_head_stale',
  'dependency_stale',
  'approval_invalid',
  'policy_revision_stale',
  'receipt_missing',
  'evidence_missing',
  'proposal_not_prepared',
  'idempotency_key_conflict',
  'restore_target_unknown',
  'restore_noop',
];

export interface CommitAccepted {
  ok: true;
  replayed?: false;
  acceptedVersionId: AcceptedVersionId;
  writes: LedgerWrite[];
}
export interface CommitReplayed {
  ok: true;
  replayed: true;
  acceptedVersionId: AcceptedVersionId;
}
export interface CommitRefused {
  ok: false;
  code: LedgerRefusalCode;
  resourceId?: ResourceId;
  /** human-readable reason; not stable, never parse it */
  detail?: string;
}

/** Result of `planCommit` / `planRestore` (plan §B.9; `detail` is an addition). */
export type CommitDecision = CommitAccepted | CommitReplayed | CommitRefused;

/** Thrown for structurally invalid input (a caller bug / HTTP 400), never for a policy refusal. */
export class LedgerInputError extends CoreError<'invalid_ledger_input'> {
  constructor(message: string) {
    super('invalid_ledger_input', message);
    this.name = 'LedgerInputError';
  }
}

/**
 * `planRestore` input: §B.9's restore input plus `organizationId` (the acting tenant). It is not
 * trusted: the resource must be bound to it (`getResourceOrganization`), otherwise the restore is
 * refused as `expected_head_stale` (the resource has no head visible to that organization).
 */
export const RestoreRequestSchema = RestoreInputSchema.extend({ organizationId: IdSegmentSchema });
export type RestoreRequest = z.infer<typeof RestoreRequestSchema>;
export type RestoreRequestInput = z.input<typeof RestoreRequestSchema>;

export function refuse(code: LedgerRefusalCode, detail: string, resourceId?: ResourceId): CommitRefused {
  return resourceId === undefined ? { ok: false, code, detail } : { ok: false, code, resourceId, detail };
}

/** `planBindHead` input: create the first (genesis) head of a resource and bind it to an organization. */
export const BindHeadRequestSchema = z.object({
  organizationId: IdSegmentSchema,
  resourceId: ResourceIdSchema,
  revisionId: RevisionIdSchema,
  idempotencyKey: z.string().min(1).max(256),
  actor: PrincipalRefSchema,
});
export type BindHeadRequest = z.infer<typeof BindHeadRequestSchema>;
export type BindHeadRequestInput = z.input<typeof BindHeadRequestSchema>;
