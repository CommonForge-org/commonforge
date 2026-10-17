/** G1 wire contracts. Versioned separately from the legacy artifact protocol. */
import { z } from 'zod';
import { canonicalJson, hashCanonicalSync } from './canonical-json.js';

const Id = z.string().min(1).max(256);
const Text = z.string().min(1).max(32768);
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Revision = z.number().int().positive();
const Generation = z.number().int().nonnegative();
const Time = z.string().datetime({ offset: true });
const Scope = { schemaVersion: z.literal(1), organizationId: Id, projectId: Id };
const RecordFields = { ...Scope, id: Id, author: Id, createdAt: Time };

export const PROJECT_PROTOCOL_VERSION = 1;
export const PROJECT_ACCEPT_SCOPE = 'project-accept';
export const PROJECT_ERROR_CODES = [
  'invalid_project_record', 'revision_conflict', 'knowledge_stale', 'context_too_large',
  'context_forbidden', 'mandate_revoked', 'mandate_expired', 'mandate_scope_denied',
  'scenario_evidence_missing', 'scenario_evidence_invalid', 'review_subject_changed',
  'project_mode_unsupported', 'project_not_found', 'authority_denied', 'idempotency_conflict',
  'unsupported_version', 'recovery_unsupported', 'bundle_invalid',
] as const;
export type ProjectErrorCode = typeof PROJECT_ERROR_CODES[number];
export class ProjectError extends Error {
  constructor(public readonly code: ProjectErrorCode, message: string) { super(message); this.name = 'ProjectError'; }
}
export const ProjectModeSchema = z.enum(['legacy', 'agent-native']);
export const ProjectRevisionRefSchema = z.object({ id: Id, revision: Revision }).strict();
export type ProjectRevisionRef = z.infer<typeof ProjectRevisionRefSchema>;
export const ProjectSourceHeadSchema = z.object({ resourceId: Id, revisionId: Id }).strict();
export type ProjectSourceHead = z.infer<typeof ProjectSourceHeadSchema>;
export const ProjectSourceReferenceSchema = z.object({ kind: z.enum(['text', 'resource', 'url', 'decision']), ref: Text, digest: Digest.nullable() }).strict();
export const ProjectConfirmationSchema = z.object({ actor: Id, confirmedAt: Time, authorityRevision: Generation, decisionId: Id }).strict();
export const KnowledgeRevisionSchema = z.object({
  ...RecordFields, revision: Revision, predecessor: Revision.nullable(),
  kind: z.enum(['rule', 'decision', 'assumption']), text: Text, rationale: Text,
  sources: z.array(ProjectSourceReferenceSchema).max(100),
  confirmation: ProjectConfirmationSchema.nullable(), archived: z.boolean(),
}).strict();
export type KnowledgeRevision = z.infer<typeof KnowledgeRevisionSchema>;
export const ScenarioRevisionSchema = z.object({
  ...RecordFields, revision: Revision, predecessor: Revision.nullable(), title: Text,
  given: Text, when: Text, then: Text, ruleRefs: z.array(ProjectRevisionRefSchema).max(100),
  required: z.boolean(), method: z.enum(['manual', 'automated']), verifierDigest: Digest,
  confirmation: ProjectConfirmationSchema.nullable(), archived: z.boolean(),
}).strict();
export type ScenarioRevision = z.infer<typeof ScenarioRevisionSchema>;
export const ProjectOutcomeSchema = z.object({
  ...RecordFields, revision: Revision, description: Text, owner: Id,
  successCriteria: z.array(Text).min(1).max(100), state: z.enum(['open', 'achieved', 'deferred']), taskIds: z.array(Id).max(1000),
}).strict();
export type ProjectOutcome = z.infer<typeof ProjectOutcomeSchema>;
export const AgentMandateSchema = z.object({
  ...RecordFields, revision: Revision, taskId: Id, agentId: Id, issuer: Id,
  operations: z.array(z.enum(['context:read', 'source:checkout', 'candidate:submit', 'knowledge:propose', 'attempt:read'])).max(5),
  resourceIds: z.array(Id).max(1000), issuedAt: Time, expiresAt: Time,
  revocationGeneration: Generation, revokedAt: Time.nullable(),
  maxAttempts: Revision, maxJobs: Revision, timeoutSeconds: Revision,
}).strict();
export type AgentMandate = z.infer<typeof AgentMandateSchema>;
export const ProjectAttemptSchema = z.object({
  ...RecordFields, taskId: Id, agentId: Id, mandateId: Id, mandateRevision: Revision,
  contextDigest: Digest, knowledgeHead: Digest, startedAt: Time, endedAt: Time.nullable(),
  status: z.enum(['active', 'submitted', 'completed', 'failed', 'revoked']), proposalIds: z.array(Id).max(1000),
}).strict();
export type ProjectAttempt = z.infer<typeof ProjectAttemptSchema>;
export const RequiredScenarioSchema = z.object({ id: Id, revision: Revision, verifierDigest: Digest, method: z.enum(['manual', 'automated']) }).strict();
export type RequiredScenario = z.infer<typeof RequiredScenarioSchema>;
export const ProjectProposalEnvelopeSchema = z.object({
  domain: z.literal('cf.project-proposal/1'), ...Scope,
  outcome: ProjectRevisionRefSchema.nullable(), attemptId: Id.nullable(), mandateId: Id.nullable(), mandateRevision: Revision.nullable(),
  contextDigest: Digest.nullable(), innerProposalId: Id.nullable(), innerProposalHash: Digest.nullable(),
  sourceHeads: z.array(ProjectSourceHeadSchema).max(1000), runtimeRecipeDigest: Digest, buildDigest: Digest,
  expectedParent: Digest.nullable(), expectedKnowledgeHead: Digest, policyRevision: Generation,
  proposedKnowledge: z.array(ProjectRevisionRefSchema).max(1000), proposedScenarios: z.array(ProjectRevisionRefSchema).max(1000),
  requiredScenarios: z.array(RequiredScenarioSchema).max(1000),
  recovery: z.object({ manifestHash: Digest, planDigest: Digest }).strict().nullable(),
  effects: z.array(Text).max(100),
}).strict().superRefine((v, ctx) => {
  if ((v.innerProposalId === null) !== (v.innerProposalHash === null)) ctx.addIssue({ code: 'custom', message: 'inner proposal identity must be paired' });
  if ([v.attemptId, v.mandateId, v.mandateRevision, v.contextDigest].some(x => x !== null) && [v.attemptId, v.mandateId, v.mandateRevision, v.contextDigest].some(x => x === null)) ctx.addIssue({ code: 'custom', message: 'attempt authority binding must be complete' });
});
export type ProjectProposalEnvelope = z.infer<typeof ProjectProposalEnvelopeSchema>;
export const ProjectProposalSchema = z.object({ ...RecordFields, envelope: ProjectProposalEnvelopeSchema, digest: Digest }).strict();
export type ProjectProposal = z.infer<typeof ProjectProposalSchema>;
export const ProjectDecisionSchema = z.object({
  ...RecordFields, envelopeDigest: Digest, innerProposalHash: Digest.nullable(),
  action: z.enum(['approve', 'reject', 'correct', 'defer']), explanation: Text, authorityRevision: Generation,
}).strict();
export type ProjectDecision = z.infer<typeof ProjectDecisionSchema>;
export const ProjectAttachmentSchema = z.object({ digest: Digest, size: Generation, mediaType: Id }).strict();
export const ScenarioEvidenceSchema = z.object({
  ...RecordFields, envelopeDigest: Digest, buildDigest: Digest, runtimeRecipeDigest: Digest,
  scenarioId: Id, scenarioRevision: Revision, verifierDigest: Digest,
  method: z.enum(['manual', 'automated']), result: z.enum(['pass', 'fail', 'error', 'not_run']),
  runId: Id, actor: Id, startedAt: Time, completedAt: Time,
  provenance: z.enum(['runner-verified', 'human-attested', 'imported-untrusted']),
  supersedes: Id.nullable(), attachments: z.array(ProjectAttachmentSchema).max(100), summary: Text,
}).strict();
export type ScenarioEvidence = z.infer<typeof ScenarioEvidenceSchema>;
export const ProjectManifestSchema = z.object({
  ...RecordFields, sequence: Generation, parent: Digest.nullable(), hash: Digest,
  sourceHeads: z.array(ProjectSourceHeadSchema).max(1000), knowledgeHead: Digest,
  knowledgeGeneration: Generation, envelopeDigest: Digest.nullable(), decisionId: Id.nullable(),
  evidenceIds: z.array(Id).max(1000), behavior: z.enum(['verified', 'outstanding', 'historical-unverified']),
}).strict();
export type ProjectManifest = z.infer<typeof ProjectManifestSchema>;
export const ReleaseObservationSchema = z.object({
  ...RecordFields, releaseId: Id, manifestHash: Digest, buildDigest: Digest,
  environment: Id, target: Id, checkDigest: Digest, result: z.enum(['healthy', 'unhealthy', 'unknown']),
  observedAt: Time, freshUntil: Time, summary: Text,
}).strict();
export type ReleaseObservation = z.infer<typeof ReleaseObservationSchema>;
export const ProjectStateSchema = z.object({
  ...Scope, mode: z.literal('agent-native'), generation: Generation,
  knowledgeGeneration: Generation, knowledgeHead: Digest, policyRevision: Generation,
  sourceHeads: z.array(ProjectSourceHeadSchema).max(1000),
  authorities: z.array(z.object({ principalId: Id, role: z.enum(['owner', 'developer', 'agent']), revision: Generation, active: z.boolean() }).strict()).max(1000),
  idempotency: z.array(z.object({ key: Id, requestDigest: Digest, resultGeneration: Generation, resultId: Id.nullable() }).strict()).max(10000),
  outcomes: z.array(ProjectOutcomeSchema).max(1000), knowledge: z.array(KnowledgeRevisionSchema).max(10000), scenarios: z.array(ScenarioRevisionSchema).max(10000),
  mandates: z.array(AgentMandateSchema).max(1000), attempts: z.array(ProjectAttemptSchema).max(1000), proposals: z.array(ProjectProposalSchema).max(1000),
  decisions: z.array(ProjectDecisionSchema).max(10000), evidence: z.array(ScenarioEvidenceSchema).max(10000), manifests: z.array(ProjectManifestSchema).max(10000),
  observations: z.array(ReleaseObservationSchema).max(10000),
}).strict();
export type ProjectState = z.infer<typeof ProjectStateSchema>;

/** Explicit bounded cursor envelope shared by API consumers. Cursor is opaque to clients. */
export const ProjectListQuerySchema = z.object({ cursor: Id.optional(), limit: z.number().int().min(1).max(100).default(50) }).strict();
export const ProjectMutationSchema = z.object({ expectedGeneration: Generation, idempotencyKey: Id }).strict();
export type ProjectMutation = z.infer<typeof ProjectMutationSchema>;
export type ProjectPage<T> = { items: T[]; nextCursor: string | null; generation: number };

function set<T>(items: readonly T[], key: (item: T) => string): T[] {
  const sorted = [...items].sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
  if (sorted.some((x, i) => i > 0 && key(x) === key(sorted[i - 1]!))) throw new ProjectError('invalid_project_record', 'duplicate set identity');
  return sorted;
}
const refKey = (r: ProjectRevisionRef) => r.id;
export function computeProjectProposalHash(input: ProjectProposalEnvelope): string {
  const p = ProjectProposalEnvelopeSchema.parse(input);
  return hashCanonicalSync({ ...p,
    sourceHeads: set(p.sourceHeads, x => x.resourceId), proposedKnowledge: set(p.proposedKnowledge, refKey),
    proposedScenarios: set(p.proposedScenarios, refKey), requiredScenarios: set(p.requiredScenarios, refKey),
    effects: set(p.effects, x => x),
  });
}
/** Latest confirmed revision wins; a draft never shadows a previously confirmed revision. */
export function currentConfirmed<T extends { id: string; revision: number; confirmation: unknown; archived: boolean }>(records: readonly T[]): T[] {
  const latest = new Map<string, T>();
  const seen = new Set<string>();
  for (const r of records) {
    const key = canonicalJson([r.id, r.revision]);
    if (seen.has(key)) throw new ProjectError('invalid_project_record', 'duplicate immutable revision');
    seen.add(key);
  }
  for (const r of records) if (r.confirmation !== null && (!latest.has(r.id) || latest.get(r.id)!.revision < r.revision)) latest.set(r.id, r);
  return [...latest.values()].filter(r => !r.archived).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
export function computeKnowledgeHead(organizationId: string, projectId: string, generation: number, knowledge: readonly KnowledgeRevision[], scenarios: readonly ScenarioRevision[]): string {
  Id.parse(organizationId); Id.parse(projectId); Generation.parse(generation);
  for (const r of [...knowledge, ...scenarios]) if (r.organizationId !== organizationId || r.projectId !== projectId) throw new ProjectError('context_forbidden', 'project scope mismatch');
  return hashCanonicalSync({ domain: 'cf.project-knowledge/1', organizationId, projectId, generation,
    knowledge: currentConfirmed(knowledge).map(k => KnowledgeRevisionSchema.parse(k)),
    scenarios: currentConfirmed(scenarios).map(s => ScenarioRevisionSchema.parse(s)),
  });
}
export function computeProjectManifestHash(input: Omit<ProjectManifest, 'hash'>): string {
  const p = ProjectManifestSchema.omit({ hash: true }).parse(input);
  return hashCanonicalSync({ domain: 'cf.project-manifest/1', ...p, sourceHeads: set(p.sourceHeads, x => x.resourceId), evidenceIds: set(p.evidenceIds, x => x) });
}
export function createProjectState(organizationId: string, projectId: string): ProjectState {
  return ProjectStateSchema.parse({ schemaVersion: 1, organizationId, projectId, mode: 'agent-native', generation: 0,
    knowledgeGeneration: 0, knowledgeHead: computeKnowledgeHead(organizationId, projectId, 0, [], []), policyRevision: 0,
    sourceHeads: [], authorities: [], idempotency: [], outcomes: [], knowledge: [], scenarios: [], mandates: [], attempts: [], proposals: [], decisions: [], evidence: [], manifests: [], observations: [],
  });
}

export const ProjectContextPacketSchema = z.object({
  domain: z.literal('cf.project-context/1'), ...Scope, taskId: Id, attemptId: Id,
  mandate: AgentMandateSchema, knowledgeHead: Digest, knowledgeGeneration: Generation,
  outcomes: z.array(ProjectOutcomeSchema), rules: z.array(KnowledgeRevisionSchema), assumptions: z.array(KnowledgeRevisionSchema),
  scenarios: z.array(ScenarioRevisionSchema), sourceHeads: z.array(ProjectSourceHeadSchema),
  omissions: z.array(z.literal('optional context omitted')).max(1),
}).strict();
export type ProjectContextPacket = z.infer<typeof ProjectContextPacketSchema>;
export const PROJECT_CONTEXT_LIMITS = { maxRecords: 1000, maxBytes: 262144 } as const;
/** Caller must authorize and filter access before calling; never supply credentials as context. */
export function materializeProjectContext(input: ProjectContextPacket, limits: { maxRecords: number; maxBytes: number } = PROJECT_CONTEXT_LIMITS): { packet: ProjectContextPacket; digest: string; json: string; markdown: string } {
  const p = ProjectContextPacketSchema.parse(input);
  for (const r of [p.mandate, ...p.outcomes, ...p.rules, ...p.assumptions, ...p.scenarios]) if (r.organizationId !== p.organizationId || r.projectId !== p.projectId) throw new ProjectError('context_forbidden', 'project scope mismatch');
  if (p.mandate.taskId !== p.taskId) throw new ProjectError('mandate_scope_denied', 'task scope mismatch');
  p.outcomes = set(p.outcomes, x => x.id); p.rules = set(p.rules, refKey); p.assumptions = set(p.assumptions, refKey);
  p.scenarios = set(p.scenarios, refKey); p.sourceHeads = set(p.sourceHeads, x => x.resourceId);
  p.mandate.resourceIds = set(p.mandate.resourceIds, x => x); p.mandate.operations = set(p.mandate.operations, x => x);
  if ([...p.rules, ...p.scenarios].some(x => x.confirmation === null || x.archived) || p.assumptions.some(x => x.kind !== 'assumption')) throw new ProjectError('invalid_project_record', 'context has unconfirmed authority');
  const records = [...p.outcomes, ...p.rules, ...p.assumptions, ...p.scenarios, ...p.sourceHeads];
  const json = canonicalJson(p);
  // Reject recognizable credential material rather than pretending arbitrary user prose can be perfectly redacted.
  if (/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\b(?:Bearer\s+[A-Za-z0-9._~-]{16,}|(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{16,}|cf[slmh]_[A-Za-z0-9_-]{8,})|\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*\S+/i.test(json)) throw new ProjectError('context_forbidden', 'credential-like content cannot be materialized');
  const markdown = `# Project context\n\nTask: ${p.taskId}\nKnowledge: ${p.knowledgeHead}\n\n## Confirmed knowledge\n\n${p.rules.map(r => `- ${r.id}@${r.revision}: ${r.text}`).join('\n')}\n\n## Assumptions (not confirmed requirements)\n\n${p.assumptions.map(r => `- ${r.id}@${r.revision}: ${r.text}`).join('\n')}\n\n## Scenarios\n\n${p.scenarios.map(s => `- ${s.id}@${s.revision}: Given ${s.given}; when ${s.when}; then ${s.then}`).join('\n')}\n\nAuthority and exact source references are in the accompanying JSON packet.\n`;
  if (records.length > limits.maxRecords || new TextEncoder().encode(json + markdown).byteLength > limits.maxBytes) throw new ProjectError('context_too_large', 'project context exceeds the configured bound');
  return { packet: p, digest: hashCanonicalSync(p), json, markdown };
}
export function computeContextDigest(input: ProjectContextPacket): string { return materializeProjectContext(input).digest; }
export function observationHealth(observation: ReleaseObservation | undefined, now: string): 'healthy' | 'unhealthy' | 'unknown' {
  if (!Number.isFinite(Date.parse(now)) || !observation || !Number.isFinite(Date.parse(observation.freshUntil)) || !Number.isFinite(Date.parse(observation.observedAt)) || Date.parse(now) >= Date.parse(observation.freshUntil) || Date.parse(now) < Date.parse(observation.observedAt)) return 'unknown';
  return observation.result;
}
