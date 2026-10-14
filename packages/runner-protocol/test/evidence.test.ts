import { describe, expect, it } from 'vitest';
import { ValidationEvidenceSchema, type ValidationEvidence } from '@commonforge-org/core';
import {
  deriveEvidenceKey,
  evidenceKeyFromWire,
  evidenceKeyToWire,
  signEvidence,
  signJob,
  verifyEvidence,
  verifySignedJob,
  type EvidenceSigningKey,
  type UnsignedValidationEvidence,
} from '../src/index.js';
import { KEY_A, KEY_B, PROPOSAL_HASH, prepareJob, snapshot } from './fixtures.js';

const ek = (jobId = 'job-1') => deriveEvidenceKey(KEY_A, jobId);

function unsigned(): UnsignedValidationEvidence {
  return {
    evidenceId: 'ev-1',
    proposalHash: PROPOSAL_HASH,
    snapshotId: snapshot([]).snapshotId,
    runnerId: 'runner-1',
    runnerKind: 'sandbox',
    checks: [{ checkId: 'test', command: 'pnpm test', result: 'pass', startedAt: '2026-10-06T10:00:00.000Z', endedAt: '2026-10-06T10:01:00.000Z' }],
    contractChecks: [],
    mergeOutcome: [{ resourceId: 'res-site' as never, result: 'clean' }],
    producedAt: '2026-10-06T10:01:00.000Z',
  };
}

describe('ValidationEvidence signatures', () => {
  it('round-trips and produces a schema-valid evidence record', async () => {
    const ev = await signEvidence(unsigned(), await ek(), { jobId: 'job-1' });
    expect(ev.signature).toMatch(new RegExp(`^hs256:${KEY_A.kid}:[0-9a-f]{64}$`));
    expect(ValidationEvidenceSchema.parse(ev)).toEqual(ev);
    expect(await verifyEvidence(ev, [KEY_A], { jobId: 'job-1' })).toEqual({ ok: true, evidence: ev });
    expect((await verifyEvidence(JSON.parse(JSON.stringify(ev)), [KEY_B, KEY_A], { jobId: 'job-1' })).ok).toBe(true);
  });

  it('is bound to the job id', async () => {
    const ev = await signEvidence(unsigned(), await ek(), { jobId: 'job-1' });
    expect(await verifyEvidence(ev, [KEY_A], { jobId: 'job-2' })).toMatchObject({ ok: false, reason: 'bad_signature' });
  });

  it('rejects tampering with results, unknown keys and agent-written signatures', async () => {
    const ev = await signEvidence(unsigned(), await ek(), { jobId: 'job-1' });
    const flipped: ValidationEvidence = structuredClone(ev);
    flipped.checks[0]!.result = 'fail';
    expect((await verifyEvidence(flipped, [KEY_A], { jobId: 'job-1' })).ok).toBe(false);
    const passed = structuredClone(ev);
    passed.mergeOutcome[0]!.result = 'textual-conflict';
    expect((await verifyEvidence(passed, [KEY_A], { jobId: 'job-1' })).ok).toBe(false);
    expect(await verifyEvidence(ev, [KEY_B], { jobId: 'job-1' })).toMatchObject({ ok: false, reason: 'unknown_key' });
    expect((await verifyEvidence({ ...ev, signature: 'LGTM, all checks pass' }, [KEY_A], { jobId: 'job-1' })).ok).toBe(false);
    expect((await verifyEvidence({ ...ev, extra: 1 }, [KEY_A], { jobId: 'job-1' })).ok).toBe(false);
  });

  it('job signatures and evidence signatures are domain separated', async () => {
    const ev = await signEvidence(unsigned(), await ek(), { jobId: 'job-1' });
    const other = await signEvidence({ ...unsigned(), evidenceId: 'ev-2' }, await ek(), { jobId: 'job-1' });
    expect(other.signature).not.toBe(ev.signature);
  });

  it('the runner gets only a per-job derived key: it differs from the job key and per job', async () => {
    const k1 = await ek('job-1');
    const k2 = await ek('job-2');
    expect(k1.secret).toHaveLength(32);
    expect(Buffer.from(k1.secret).equals(Buffer.from(k2.secret))).toBe(false);
    expect(Buffer.from(k1.secret).toString('utf8')).not.toContain(String(KEY_A.secret));
    expect(evidenceKeyFromWire(JSON.parse(JSON.stringify(evidenceKeyToWire(k1))))).toEqual(k1);
  });

  it('a derived evidence key cannot sign evidence for another job', async () => {
    await expect(signEvidence(unsigned(), await ek('job-1'), { jobId: 'job-2' })).rejects.toMatchObject({ code: 'invalid_evidence' });
    const relabeled: EvidenceSigningKey = { ...(await ek('job-1')), jobId: 'job-2' };
    const ev = await signEvidence(unsigned(), relabeled, { jobId: 'job-2' });
    expect(await verifyEvidence(ev, [KEY_A], { jobId: 'job-2' })).toMatchObject({ ok: false, reason: 'bad_signature' });
  });

  it('evidence signed directly with the job key does not verify', async () => {
    const raw: EvidenceSigningKey = { kid: KEY_A.kid, jobId: 'job-1', secret: new TextEncoder().encode(String(KEY_A.secret)).slice(0, 32), purpose: 'evidence' };
    const ev = await signEvidence(unsigned(), raw, { jobId: 'job-1' });
    expect((await verifyEvidence(ev, [KEY_A], { jobId: 'job-1' })).ok).toBe(false);
    await expect(signEvidence(unsigned(), KEY_A as never, { jobId: 'job-1' })).rejects.toMatchObject({ code: 'weak_job_key' });
  });

  it('a derived evidence key cannot sign a SignedJob', async () => {
    const k = await ek('job-1');
    const forged = await signJob(
      { job: prepareJob(), jobId: 'job-1', issuedAt: '2026-10-06T10:00:00.000Z', expiresAt: '2026-10-06T10:10:00.000Z', credentialBroker: 'https://a.test/' },
      { kid: k.kid, secret: k.secret },
    );
    expect(await verifySignedJob(forged, [KEY_A], { now: Date.parse('2026-10-06T10:05:00.000Z') })).toMatchObject({ ok: false, reason: 'bad_signature' });
  });
});

