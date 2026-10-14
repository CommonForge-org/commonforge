import {
  AcceptedHeadSchema,
  IdSegmentSchema,
  IntegrationReceiptSchema,
  PreparedReceiptSchema,
  ProposalRecordSchema,
  type AcceptedHead,
  type IntegrationReceipt,
  type PreparedReceipt,
  type ProposalRecord,
} from '@commonforge-org/core';
import { z } from 'zod';

/** Timestamp given to seeded heads that do not specify one. */
export const SEED_EPOCH = '2026-01-01T00:00:00.000Z';

/**
 * A seeded head (an imported/bound resource): defaults `acceptedVersionId: null`,
 * `reconciliation: 'synced'`. `organizationId` binds the resource (omit it only to overwrite the
 * head of an already-bound resource). Production code creates first heads with `planBindHead`.
 */
export const SeedHeadSchema = AcceptedHeadSchema.extend({
  organizationId: IdSegmentSchema.optional(),
  acceptedVersionId: AcceptedHeadSchema.shape.acceptedVersionId.default(null),
  acceptedAt: AcceptedHeadSchema.shape.acceptedAt.default(SEED_EPOCH),
  reconciliation: AcceptedHeadSchema.shape.reconciliation.default('synced'),
});
export type SeedHeadInput = z.input<typeof SeedHeadSchema>;

/**
 * State a test or conformance harness puts into a store before running ledger operations.
 * Receipts are recorded by the consuming app after it verified the runner's signature; the ledger
 * only reads them. Every store used with the conformance scenarios must accept this shape.
 */
export interface LedgerSeed {
  heads?: SeedHeadInput[];
  proposals?: z.input<typeof ProposalRecordSchema>[];
  preparedReceipts?: z.input<typeof PreparedReceiptSchema>[];
  integrationReceipts?: z.input<typeof IntegrationReceiptSchema>[];
  policyRevisions?: Array<{ projectId: string; policyRevision: number }>;
}

/** Parsed (branded) seed. */
export interface ParsedLedgerSeed {
  heads: Array<AcceptedHead & { organizationId?: string }>;
  proposals: ProposalRecord[];
  preparedReceipts: PreparedReceipt[];
  integrationReceipts: IntegrationReceipt[];
  policyRevisions: Array<{ projectId: string; policyRevision: number }>;
}

export function parseLedgerSeed(seed: LedgerSeed): ParsedLedgerSeed {
  return {
    heads: (seed.heads ?? []).map((h) => SeedHeadSchema.parse(h)),
    proposals: (seed.proposals ?? []).map((p) => ProposalRecordSchema.parse(p)),
    preparedReceipts: (seed.preparedReceipts ?? []).map((r) => PreparedReceiptSchema.parse(r)),
    integrationReceipts: (seed.integrationReceipts ?? []).map((r) => IntegrationReceiptSchema.parse(r)),
    policyRevisions: (seed.policyRevisions ?? []).map((p) => ({
      projectId: z.string().min(1).parse(p.projectId),
      policyRevision: z.number().int().nonnegative().parse(p.policyRevision),
    })),
  };
}
