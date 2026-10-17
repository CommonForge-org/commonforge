import { describe, expect, it } from 'vitest';
import { hashCanonicalSync, type ScenarioEvidence } from '@commonforge-org/core';
import { scenarioBuildDigest, signScenarioRequest, signScenarioResult, verifyScenarioRequest, verifyScenarioResult, type ScenarioVerificationRequest, type ScenarioVerificationResult } from '../src/project-scenarios.js';
const key = { kid: 'k1', secret: 'a-trusted-local-job-key-at-least-32-bytes' };
const time = '2026-10-17T12:00:00.000Z', digest = 'a'.repeat(64);
function request(): ScenarioVerificationRequest {
  const sourceHeads = [{ resourceId: 'app', revisionId: 'local:app:abc' }];
  return { protocolVersion: 1, organizationId: 'org', projectId: 'project', runId: 'run', envelopeDigest: digest, buildDigest: scenarioBuildDigest(sourceHeads), runtimeRecipeDigest: digest,
    sourceHeads, requiredScenarios: [{ id: 'cutoff', revision: 1, verifierDigest: digest, method: 'automated' }], issuedAt: time, expiresAt: '2026-10-17T12:01:00.000Z' };
}
function result(req: ScenarioVerificationRequest): ScenarioVerificationResult {
  const evidence: ScenarioEvidence = { schemaVersion: 1, organizationId: req.organizationId, projectId: req.projectId, id: 'evidence', author: 'runner', createdAt: time,
    envelopeDigest: req.envelopeDigest, buildDigest: req.buildDigest, runtimeRecipeDigest: req.runtimeRecipeDigest,
    scenarioId: 'cutoff', scenarioRevision: 1, verifierDigest: digest, method: 'automated', result: 'pass', runId: req.runId, actor: 'runner', startedAt: time, completedAt: time,
    provenance: 'runner-verified', supersedes: null, attachments: [], summary: 'Observed behavior' };
  return { protocolVersion: 1, requestDigest: hashCanonicalSync(req), runId: req.runId, evidence: [evidence], completedAt: time, execution: 'bubblewrap-linux-http', network: 'none', controlPlaneMounted: false };
}
describe('G1 strict signed behavioral protocol', () => {
  it('signs and verifies exact request and evidence bindings', async () => {
    const req = request();
    expect(await verifyScenarioRequest(await signScenarioRequest(req, key), key, Date.parse(time))).toEqual(req);
    const res = result(req);
    expect(await verifyScenarioResult(await signScenarioResult(res, key), key, req)).toEqual(res);
  });
  it('rejects tampering, wrong keys, expiry, arbitrary build labels and future protocol', async () => {
    const req = request(), signed = await signScenarioRequest(req, key);
    await expect(verifyScenarioRequest({ ...signed, payload: { ...req, projectId: 'other' } }, key, Date.parse(time))).rejects.toThrow();
    await expect(verifyScenarioRequest(signed, { ...key, secret: 'b'.repeat(40) }, Date.parse(time))).rejects.toThrow();
    await expect(verifyScenarioRequest(signed, key, Date.parse(req.expiresAt))).rejects.toThrow();
    await expect(verifyScenarioRequest(await signScenarioRequest({ ...req, buildDigest: digest }, key), key, Date.parse(time))).rejects.toThrow();
    await expect(signScenarioRequest({ ...req, protocolVersion: 2 } as unknown as ScenarioVerificationRequest, key)).rejects.toThrow();
  });
  it('rejects missing, duplicated, wrong-subject, wrong-verifier and replayed evidence', async () => {
    const req = request(), res = result(req);
    const mutations = [
      { ...res, evidence: [] },
      { ...res, evidence: [...res.evidence, ...res.evidence] },
      { ...res, evidence: [{ ...res.evidence[0]!, buildDigest: 'b'.repeat(64) }] },
      { ...res, evidence: [{ ...res.evidence[0]!, verifierDigest: 'b'.repeat(64) }] },
      { ...res, runId: 'other-run' },
      { ...res, evidence: [{ ...res.evidence[0]!, organizationId: 'other-org' }] },
    ];
    for (const mutation of mutations) {
      await expect((async () => verifyScenarioResult(await signScenarioResult(mutation, key), key, req))()).rejects.toThrow();
    }
  });
});
