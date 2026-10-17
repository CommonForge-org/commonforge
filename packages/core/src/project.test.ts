import { describe, expect, it } from 'vitest';
import {
  AgentMandateSchema, KnowledgeRevisionSchema, ProjectProposalEnvelopeSchema, ProjectStateSchema,
  computeKnowledgeHead, computeProjectProposalHash, createProjectState, currentConfirmed,
  materializeProjectContext, observationHealth,
  type AgentMandate, type KnowledgeRevision, type ProjectContextPacket, type ProjectProposalEnvelope, type ReleaseObservation,
} from './project.js';

const D = 'a'.repeat(64);
const T = '2026-10-17T12:00:00Z';
const base = { schemaVersion: 1 as const, organizationId: 'org', projectId: 'project', author: 'owner', createdAt: T };
const confirmation = { actor: 'owner', confirmedAt: T, authorityRevision: 1, decisionId: 'confirm-1' };
const rule: KnowledgeRevision = { ...base, id: 'cutoff', revision: 1, predecessor: null, kind: 'rule', text: 'Customers may reschedule until 24 hours before the appointment.', rationale: 'Allow predictable dispatch.', sources: [{ kind: 'text', ref: 'Owner requirement', digest: null }], confirmation, archived: false };
const corrected: KnowledgeRevision = { ...rule, revision: 2, predecessor: 1, text: 'Managers may override the 24-hour cutoff only with a retained reason.', confirmation: { ...confirmation, decisionId: 'confirm-2' } };
const mandate: AgentMandate = { ...base, id: 'mandate', revision: 1, taskId: 'task', agentId: 'agent', issuer: 'owner', operations: ['context:read', 'candidate:submit'], resourceIds: ['source'], issuedAt: T, expiresAt: '2026-10-17T13:00:00Z', revocationGeneration: 0, revokedAt: null, maxAttempts: 1, maxJobs: 5, timeoutSeconds: 60 };
const envelope: ProjectProposalEnvelope = {
  ...{ schemaVersion: 1, organizationId: 'org', projectId: 'project' }, domain: 'cf.project-proposal/1',
  outcome: null, attemptId: null, mandateId: null, mandateRevision: null, contextDigest: null,
  innerProposalId: null, innerProposalHash: null, sourceHeads: [{ resourceId: 'b', revisionId: '2' }, { resourceId: 'a', revisionId: '1' }],
  runtimeRecipeDigest: D, buildDigest: D, expectedParent: null, expectedKnowledgeHead: D,
  policyRevision: 0, proposedKnowledge: [], proposedScenarios: [], requiredScenarios: [], recovery: null, effects: [],
};
function packet(): ProjectContextPacket {
  return { domain: 'cf.project-context/1', schemaVersion: 1, organizationId: 'org', projectId: 'project', taskId: 'task', attemptId: 'attempt', mandate, knowledgeHead: D, knowledgeGeneration: 1, outcomes: [], rules: [corrected], assumptions: [], scenarios: [], sourceHeads: [], omissions: [] };
}

describe('G1 independently versioned contracts', () => {
  it('locks the independent G1 genesis hash vector', () => {
    expect(createProjectState('org', 'project').knowledgeHead).toBe('0f660c22e643f1836a835631b1f428219d05690cb11af4eebe05b93f48bd2025');
  });
  it('uses strict wire boundaries including nested authority', () => {
    expect(ProjectStateSchema.safeParse({ ...createProjectState('org', 'project'), secret: 'no' }).success).toBe(false);
    expect(KnowledgeRevisionSchema.safeParse({ ...rule, confirmation: { ...confirmation, trusted: true } }).success).toBe(false);
    expect(AgentMandateSchema.safeParse({ ...mandate, operations: ['deploy'] }).success).toBe(false);
    expect(ProjectProposalEnvelopeSchema.safeParse({ ...envelope, domain: 'cf.proposal/1' }).success).toBe(false);
  });
  it('requires dual inner binding and complete attempt authority binding', () => {
    expect(ProjectProposalEnvelopeSchema.safeParse({ ...envelope, innerProposalId: 'p' }).success).toBe(false);
    expect(ProjectProposalEnvelopeSchema.safeParse({ ...envelope, attemptId: 'a' }).success).toBe(false);
  });
  it('hashes complete source sets deterministically and refuses ambiguous identities', () => {
    expect(computeProjectProposalHash(envelope)).toBe(computeProjectProposalHash({ ...envelope, sourceHeads: [...envelope.sourceHeads].reverse() }));
    expect(computeProjectProposalHash(envelope)).not.toBe(computeProjectProposalHash({ ...envelope, buildDigest: 'b'.repeat(64) }));
    expect(() => computeProjectProposalHash({ ...envelope, sourceHeads: [{ resourceId: 'a', revisionId: '1' }, { resourceId: 'a', revisionId: '2' }] })).toThrow('duplicate');
  });
  it('keeps drafts out of authority, retains confirmed correction and archives explicitly', () => {
    const draft = { ...corrected, revision: 3, confirmation: null };
    expect(currentConfirmed([rule, corrected, draft])).toEqual([corrected]);
    expect(currentConfirmed([rule, corrected, { ...draft, confirmation, archived: true }])).toEqual([]);
    const initial = computeKnowledgeHead('org', 'project', 1, [rule], []);
    expect(initial).toBe(computeKnowledgeHead('org', 'project', 1, [rule, { ...corrected, confirmation: null }], []));
    expect(initial).not.toBe(computeKnowledgeHead('org', 'project', 2, [rule, corrected], []));
    expect(() => computeKnowledgeHead('org', 'another-project', 1, [rule], [])).toThrow('scope mismatch');
  });
  it('pins deterministic JSON and readable correction without credentials', () => {
    const first = materializeProjectContext(packet());
    expect(first.markdown).toContain(corrected.text);
    expect(first.digest).toBe(materializeProjectContext(JSON.parse(first.json)).digest);
    expect(first.digest).not.toBe(materializeProjectContext({ ...packet(), rules: [rule] }).digest);
    expect(() => materializeProjectContext({ ...packet(), rules: [{ ...corrected, text: 'password=supersecret' }] })).toThrow('credential');
    expect(() => materializeProjectContext({ ...packet(), rules: [{ ...corrected, text: 'Use cfs_broadsecret123456 for access' }] })).toThrow('credential');
    expect(() => materializeProjectContext({ ...packet(), rules: [{ ...corrected, confirmation: null }] })).toThrow('unconfirmed');
    expect(() => materializeProjectContext(packet(), { maxBytes: 10, maxRecords: 100 })).toThrow('bound');
    expect(() => materializeProjectContext(packet(), { maxBytes: 100000, maxRecords: 0 })).toThrow('bound');
  });
  it('never calls expired or future observations healthy', () => {
    const observation: ReleaseObservation = { ...base, id: 'observation', releaseId: 'release', manifestHash: D, buildDigest: D, environment: 'local-simulation', target: 'fixture', checkDigest: D, result: 'healthy', observedAt: T, freshUntil: '2026-10-17T13:00:00Z', summary: 'HTTP check passed' };
    expect(observationHealth(observation, '2026-10-17T12:30:00Z')).toBe('healthy');
    expect(observationHealth(observation, '2026-10-17T13:00:00Z')).toBe('unknown');
    expect(observationHealth(observation, '2026-10-17T11:00:00Z')).toBe('unknown');
    expect(observationHealth({ ...observation, result: 'unhealthy' }, T)).toBe('unhealthy');
    expect(observationHealth(undefined, T)).toBe('unknown');
  });
});
