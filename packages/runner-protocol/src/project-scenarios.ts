/** G1 local behavioral protocol. Deliberately separate from immutable legacy SignedJob encoding. */
import { z } from 'zod';
import { canonicalJson, hashCanonicalSync, ProjectSourceHeadSchema, RequiredScenarioSchema, ScenarioEvidenceSchema } from '@commonforge-org/core';
import { hmacSha256Hex, verifyHmacSha256Hex, type JobSigningKey } from './hmac.js';
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Id = z.string().min(1).max(256);
const Time = z.string().datetime({ offset: true });
export const ScenarioVerificationRequestSchema = z.object({
  protocolVersion: z.literal(1), organizationId: Id, projectId: Id, runId: Id,
  envelopeDigest: Digest, buildDigest: Digest, runtimeRecipeDigest: Digest,
  sourceHeads: z.array(ProjectSourceHeadSchema).min(1).max(100),
  requiredScenarios: z.array(RequiredScenarioSchema).min(1).max(100), issuedAt: Time, expiresAt: Time,
}).strict().superRefine((v, ctx) => {
  if (new Set(v.sourceHeads.map(s => s.resourceId)).size !== v.sourceHeads.length || new Set(v.requiredScenarios.map(s => s.id)).size !== v.requiredScenarios.length) ctx.addIssue({ code: 'custom', message: 'duplicate identity' });
  if (Date.parse(v.expiresAt) <= Date.parse(v.issuedAt) || Date.parse(v.expiresAt) - Date.parse(v.issuedAt) > 300000) ctx.addIssue({ code: 'custom', message: 'invalid request lifetime' });
});
export type ScenarioVerificationRequest = z.infer<typeof ScenarioVerificationRequestSchema>;
export const ScenarioVerificationResultSchema = z.object({
  protocolVersion: z.literal(1), requestDigest: Digest, runId: Id,
  evidence: z.array(ScenarioEvidenceSchema).min(1).max(100), completedAt: Time,
  execution: z.literal('bubblewrap-linux-http'), network: z.literal('none'), controlPlaneMounted: z.literal(false),
}).strict();
export type ScenarioVerificationResult = z.infer<typeof ScenarioVerificationResultSchema>;
const Signed = z.object({ payload: z.unknown(), kid: Id, signature: Digest }).strict();
export interface SignedScenarioMessage { payload: unknown; kid: string; signature: string }
export function scenarioBuildDigest(sourceHeads: readonly z.infer<typeof ProjectSourceHeadSchema>[]): string {
  return hashCanonicalSync({ domain: 'cf.project-build/1', sourceHeads: [...sourceHeads].sort((a, b) => a.resourceId < b.resourceId ? -1 : a.resourceId > b.resourceId ? 1 : 0) });
}
async function sign(payload: unknown, key: JobSigningKey, domain: string): Promise<SignedScenarioMessage> {
  return { payload, kid: key.kid, signature: await hmacSha256Hex(key, canonicalJson({ domain, payload, kid: key.kid })) };
}
async function verify(value: unknown, key: JobSigningKey, domain: string): Promise<unknown> {
  const signed = Signed.parse(value);
  if (signed.kid !== key.kid || !await verifyHmacSha256Hex(key, canonicalJson({ domain, payload: signed.payload, kid: signed.kid }), signed.signature)) throw new Error('scenario signature invalid');
  return signed.payload;
}
export async function signScenarioRequest(request: ScenarioVerificationRequest, key: JobSigningKey) { return sign(ScenarioVerificationRequestSchema.parse(request), key, 'cf.local-scenario-request/1'); }
export async function verifyScenarioRequest(value: unknown, key: JobSigningKey, now = Date.now()): Promise<ScenarioVerificationRequest> {
  const r = ScenarioVerificationRequestSchema.parse(await verify(value, key, 'cf.local-scenario-request/1'));
  if (Date.parse(r.issuedAt) > now + 30000 || Date.parse(r.expiresAt) <= now || r.buildDigest !== scenarioBuildDigest(r.sourceHeads)) throw new Error('scenario request expired or subject invalid');
  return r;
}
export async function signScenarioResult(result: ScenarioVerificationResult, key: JobSigningKey) { return sign(ScenarioVerificationResultSchema.parse(result), key, 'cf.local-scenario-result/1'); }
export async function verifyScenarioResult(value: unknown, key: JobSigningKey, request: ScenarioVerificationRequest): Promise<ScenarioVerificationResult> {
  const r = ScenarioVerificationResultSchema.parse(await verify(value, key, 'cf.local-scenario-result/1'));
  if (r.requestDigest !== hashCanonicalSync(request) || r.runId !== request.runId || r.evidence.length !== request.requiredScenarios.length || Date.parse(r.completedAt) < Date.parse(request.issuedAt) || Date.parse(r.completedAt) > Date.parse(request.expiresAt)) throw new Error('scenario result request mismatch');
  const seen = new Set<string>();
  for (const e of r.evidence) {
    const scenario = request.requiredScenarios.find(s => s.id === e.scenarioId);
    if (seen.has(e.scenarioId) || !scenario || e.scenarioRevision !== scenario.revision || e.verifierDigest !== scenario.verifierDigest || e.method !== 'automated' || scenario.method !== 'automated' || e.organizationId !== request.organizationId || e.projectId !== request.projectId || e.runId !== request.runId || e.envelopeDigest !== request.envelopeDigest || e.buildDigest !== request.buildDigest || e.runtimeRecipeDigest !== request.runtimeRecipeDigest || e.provenance !== 'runner-verified' || Date.parse(e.startedAt) < Date.parse(request.issuedAt) || Date.parse(e.completedAt) > Date.parse(r.completedAt) || Date.parse(e.completedAt) < Date.parse(e.startedAt)) throw new Error('scenario evidence binding mismatch');
    seen.add(e.scenarioId);
  }
  return r;
}
