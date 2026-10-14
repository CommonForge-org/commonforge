/**
 * State model (plan §A.6): state enums and allowed-transition tables.
 *
 * Wire values are snake_case lowercase. Transitions not listed in the plan diagram but needed for a
 * total machine are marked `// addition` and documented in README.
 */
import { z } from 'zod';
import { CoreError } from './errors.js';

export const ResourceAuthoritySchema = z.enum(['legacy_storage', 'github', 'commonforge_ledger']);
export type ResourceAuthority = z.infer<typeof ResourceAuthoritySchema>;

export const ChangeStateSchema = z.enum([
  'requested',
  'planned',
  'running',
  'submitted',
  'integrating',
  'needs_resolution',
  'validating',
  'ready_for_review',
  'approved',
  'preparing',
  'accepted',
  'sync_pending',
  'synchronized',
  'canceled',
  'failed',
  'stale',
  'rejected',
  'recovery_required',
]);
export type ChangeState = z.infer<typeof ChangeStateSchema>;

/**
 * Task workspace states. `read_only` (addition) marks a workspace whose write access was removed for
 * good without freezing a candidate, e.g. a reference copy seeded only to be read. Providers never
 * produce it themselves (`createIsolatedChange` returns `provisioning`/`writable`); the consuming app
 * records it in its ledger. Providers decide credentials from their own state, so an app that
 * downgrades a workspace to `read_only` must also stop requesting write credentials for it.
 */
export const TaskWorkspaceStateSchema = z.enum(['provisioning', 'writable', 'read_only', 'frozen', 'retained', 'collected', 'abandoned']);
export type TaskWorkspaceState = z.infer<typeof TaskWorkspaceStateSchema>;

export const CandidateStateSchema = z.enum(['frozen', 'prepared', 'accepted', 'superseded', 'rejected']);
export type CandidateState = z.infer<typeof CandidateStateSchema>;

/** Proposal lifecycle (plan §A.6). `accepted` is reached only through the ledger's `planCommit`. */
export const ProposalStateSchema = z.enum(['open', 'prepared', 'accepted', 'rejected', 'superseded', 'withdrawn']);
export type ProposalState = z.infer<typeof ProposalStateSchema>;

export const PreviewStateSchema = z.enum(['not_requested', 'queued', 'building', 'ready', 'failed', 'expired']);
export type PreviewState = z.infer<typeof PreviewStateSchema>;

export const ReleaseStateSchema = z.enum([
  'not_requested',
  'prepared',
  'publish_approved',
  'deploying',
  'health_verification',
  'live',
  'failed',
  'partial',
  'recovery_required',
]);
export type ReleaseState = z.infer<typeof ReleaseStateSchema>;

/** Canonical ref projection health — never authority. */
export const ReconciliationStateSchema = z.enum(['synced', 'pending', 'diverged']);
export type ReconciliationState = z.infer<typeof ReconciliationStateSchema>;

export type TransitionTable<S extends string> = { readonly [K in S]: readonly S[] };

const CHANGE_ACTIVE: readonly ChangeState[] = [
  'requested',
  'planned',
  'running',
  'submitted',
  'integrating',
  'needs_resolution',
  'validating',
  'ready_for_review',
  'approved',
  'preparing',
];
const withExits = (to: ChangeState[]): ChangeState[] => [...to, 'canceled', 'failed'];

export const CHANGE_TRANSITIONS: TransitionTable<ChangeState> = {
  requested: withExits(['planned']),
  planned: withExits(['running']),
  running: withExits(['submitted']),
  submitted: withExits(['integrating', 'stale']),
  integrating: withExits(['needs_resolution', 'validating', 'stale']),
  needs_resolution: withExits(['integrating', 'stale']),
  validating: withExits(['ready_for_review', 'needs_resolution', 'stale']), // needs_resolution: addition (contract failure)
  ready_for_review: withExits(['approved', 'rejected', 'stale', 'integrating']), // integrating: addition (new candidate)
  approved: withExits(['preparing', 'stale', 'rejected']),
  preparing: withExits(['accepted', 'stale', 'recovery_required']),
  accepted: ['sync_pending', 'recovery_required'],
  sync_pending: ['synchronized', 'recovery_required'],
  synchronized: [],
  canceled: [],
  failed: [],
  stale: ['integrating', 'canceled'], // addition: re-integrate against the new head (new proposal)
  rejected: [],
  recovery_required: ['sync_pending', 'failed'], // addition: operator recovery
};

export const TASK_WORKSPACE_TRANSITIONS: TransitionTable<TaskWorkspaceState> = {
  provisioning: ['writable', 'read_only', 'abandoned'], // abandoned: addition (provisioning failure); read_only: addition
  writable: ['frozen', 'read_only', 'abandoned'], // read_only: addition (write access removed for good)
  read_only: ['abandoned', 'collected'], // addition
  frozen: ['retained', 'collected'], // collected: addition (candidate rejected/superseded before retention)
  retained: ['collected'],
  abandoned: ['collected'],
  collected: [],
};

export const CANDIDATE_TRANSITIONS: TransitionTable<CandidateState> = {
  frozen: ['prepared', 'superseded', 'rejected'], // superseded/rejected from frozen: addition
  prepared: ['accepted', 'superseded', 'rejected'],
  accepted: [],
  superseded: [],
  rejected: [],
};

/**
 * Proposal transitions (plan §A.6). `prepared -> open` is an addition: new content (a new candidate
 * or integration) moves a prepared proposal back to `open` until it is prepared again. `accepted` is
 * written only by the ledger's acceptance (`planCommit`); record-keeping writes may use every other
 * edge (see `@commonforge-org/ledger`'s `PROPOSAL_RECORD_TRANSITIONS`). Terminal: accepted,
 * rejected, superseded, withdrawn.
 */
export const PROPOSAL_TRANSITIONS: TransitionTable<ProposalState> = {
  open: ['prepared', 'rejected', 'superseded', 'withdrawn'],
  prepared: ['accepted', 'open', 'rejected', 'superseded', 'withdrawn'], // open: addition
  accepted: [],
  rejected: [],
  superseded: [],
  withdrawn: [],
};

export const PREVIEW_TRANSITIONS: TransitionTable<PreviewState> = {
  not_requested: ['queued'],
  queued: ['building', 'failed'],
  building: ['ready', 'failed'],
  ready: ['expired'],
  failed: ['queued'], // addition: retry
  expired: ['queued'], // addition: rebuild
};

export const RELEASE_TRANSITIONS: TransitionTable<ReleaseState> = {
  not_requested: ['prepared'],
  prepared: ['publish_approved', 'failed'],
  publish_approved: ['deploying', 'failed'],
  deploying: ['health_verification', 'failed', 'partial', 'recovery_required'],
  health_verification: ['live', 'failed', 'partial', 'recovery_required'],
  live: [],
  failed: ['deploying'], // addition: retry the same release after a failed deploy (AT-35); the publish approval must still match
  partial: ['recovery_required'],
  recovery_required: ['deploying', 'failed'],
};

export const RECONCILIATION_TRANSITIONS: TransitionTable<ReconciliationState> = {
  synced: ['pending', 'diverged'],
  pending: ['synced', 'diverged'],
  diverged: ['pending', 'synced'],
};

export const STATE_MACHINES = {
  change: CHANGE_TRANSITIONS,
  taskWorkspace: TASK_WORKSPACE_TRANSITIONS,
  candidate: CANDIDATE_TRANSITIONS,
  proposal: PROPOSAL_TRANSITIONS,
  preview: PREVIEW_TRANSITIONS,
  release: RELEASE_TRANSITIONS,
  reconciliation: RECONCILIATION_TRANSITIONS,
} as const;
export type StateMachineName = keyof typeof STATE_MACHINES;

export function canTransition<S extends string>(table: TransitionTable<S>, from: S, to: S): boolean {
  return (table[from] as readonly S[] | undefined)?.includes(to) ?? false;
}

export function assertTransition<S extends string>(table: TransitionTable<S>, from: S, to: S, label = 'state'): void {
  if (!canTransition(table, from, to)) {
    throw new CoreError('invalid_transition', `${label}: ${from} -> ${to}`, { from, to });
  }
}

export function isTerminal<S extends string>(table: TransitionTable<S>, state: S): boolean {
  return table[state].length === 0;
}

/** Change states that may still be canceled/failed (non-terminal, pre-acceptance). */
export const CHANGE_ACTIVE_STATES: readonly ChangeState[] = CHANGE_ACTIVE;
