import { describe, expect, it } from 'vitest';
import {
  assertTransition,
  CANDIDATE_TRANSITIONS,
  canTransition,
  CHANGE_TRANSITIONS,
  ChangeStateSchema,
  isTerminal,
  PROPOSAL_TRANSITIONS,
  ProposalStateSchema,
  RELEASE_TRANSITIONS,
  STATE_MACHINES,
  TASK_WORKSPACE_TRANSITIONS,
} from './state.js';

describe('state machines', () => {
  it('follow the §A.6 happy paths', () => {
    const path = ['requested', 'planned', 'running', 'submitted', 'integrating', 'needs_resolution', 'integrating', 'validating', 'ready_for_review', 'approved', 'preparing', 'accepted', 'sync_pending', 'synchronized'] as const;
    for (let i = 1; i < path.length; i++) expect(canTransition(CHANGE_TRANSITIONS, path[i - 1]!, path[i]!)).toBe(true);
    expect(canTransition(TASK_WORKSPACE_TRANSITIONS, 'writable', 'frozen')).toBe(true);
    expect(canTransition(TASK_WORKSPACE_TRANSITIONS, 'writable', 'abandoned')).toBe(true);
    expect(canTransition(CANDIDATE_TRANSITIONS, 'prepared', 'accepted')).toBe(true);
    expect(canTransition(RELEASE_TRANSITIONS, 'health_verification', 'live')).toBe(true);
  });
  it('refuses skipping guards', () => {
    expect(canTransition(CANDIDATE_TRANSITIONS, 'frozen', 'accepted')).toBe(false); // must be prepared first
    expect(canTransition(CHANGE_TRANSITIONS, 'approved', 'accepted')).toBe(false); // must be preparing
    expect(canTransition(TASK_WORKSPACE_TRANSITIONS, 'frozen', 'writable')).toBe(false); // freezing is one-way
    expect(canTransition(RELEASE_TRANSITIONS, 'prepared', 'deploying')).toBe(false); // publish approval required
    expect(() => assertTransition(CHANGE_TRANSITIONS, 'synchronized', 'running', 'change')).toThrow(/invalid_transition/);
  });
  it('every table is total over its states and only targets known states', () => {
    for (const table of Object.values(STATE_MACHINES)) {
      const states = Object.keys(table);
      for (const targets of Object.values(table) as string[][]) for (const t of targets) expect(states).toContain(t);
    }
    expect(Object.keys(CHANGE_TRANSITIONS).sort()).toEqual([...ChangeStateSchema.options].sort());
  });
  it('proposal machine: accepted only from prepared; terminal states are final', () => {
    expect(Object.keys(PROPOSAL_TRANSITIONS).sort()).toEqual([...ProposalStateSchema.options].sort());
    expect(canTransition(PROPOSAL_TRANSITIONS, 'prepared', 'accepted')).toBe(true);
    expect(canTransition(PROPOSAL_TRANSITIONS, 'open', 'accepted')).toBe(false);
    expect(canTransition(PROPOSAL_TRANSITIONS, 'prepared', 'open')).toBe(true);
    for (const s of ['accepted', 'rejected', 'superseded', 'withdrawn'] as const) expect(isTerminal(PROPOSAL_TRANSITIONS, s)).toBe(true);
  });
  it('read_only workspaces never become writable or frozen', () => {
    expect(canTransition(TASK_WORKSPACE_TRANSITIONS, 'writable', 'read_only')).toBe(true);
    expect(canTransition(TASK_WORKSPACE_TRANSITIONS, 'provisioning', 'read_only')).toBe(true);
    expect(canTransition(TASK_WORKSPACE_TRANSITIONS, 'read_only', 'writable')).toBe(false);
    expect(canTransition(TASK_WORKSPACE_TRANSITIONS, 'read_only', 'frozen')).toBe(false);
    expect(canTransition(TASK_WORKSPACE_TRANSITIONS, 'read_only', 'collected')).toBe(true);
  });
  it('terminal states', () => {
    for (const s of ['synchronized', 'canceled', 'failed', 'rejected'] as const) expect(isTerminal(CHANGE_TRANSITIONS, s)).toBe(true);
    expect(isTerminal(CHANGE_TRANSITIONS, 'stale')).toBe(false);
  });
});
