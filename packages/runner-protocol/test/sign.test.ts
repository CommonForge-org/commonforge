import { describe, expect, it } from 'vitest';
import {
  JOB_SIGNATURE_TAG,
  SignedJobSchema,
  canonicalSignedJobPayload,
  constantTimeEqual,
  defaultMaxLifetimeSeconds,
  signJob,
  verifySignedJob,
  type SignedJob,
} from '../src/index.js';
import { KEY_A, KEY_B, artifactsCoords, prepareJob } from './fixtures.js';

const ISSUED = '2026-10-06T10:00:00.000Z';
const EXPIRES = '2026-10-06T10:15:00.000Z';
const NOW = Date.parse('2026-10-06T10:05:00.000Z');

async function signed(): Promise<SignedJob> {
  return signJob(
    { job: prepareJob(), jobId: 'job-1', issuedAt: ISSUED, expiresAt: EXPIRES, credentialBroker: 'https://api.example.test/api/runner/credential' },
    KEY_A,
  );
}

/** Every leaf path in a JSON value, as key arrays. */
function leafPaths(value: unknown, prefix: (string | number)[] = []): (string | number)[][] {
  if (Array.isArray(value)) return value.flatMap((v, i) => leafPaths(v, [...prefix, i]));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => leafPaths(v, [...prefix, k]));
  }
  return [prefix];
}

function mutateAt(obj: unknown, path: (string | number)[], fn: (v: unknown) => unknown): unknown {
  const copy = structuredClone(obj) as Record<string | number, unknown>;
  let cur: Record<string | number, unknown> = copy;
  for (const key of path.slice(0, -1)) cur = cur[key] as Record<string | number, unknown>;
  const last = path[path.length - 1]!;
  cur[last] = fn(cur[last]);
  return copy;
}

function tweak(v: unknown): unknown {
  if (typeof v === 'string') return v.length > 0 ? (v[0] === 'x' ? 'y' : 'x') + v.slice(1) : 'x';
  if (typeof v === 'number') return v + 1;
  if (typeof v === 'boolean') return !v;
  return 'x';
}

describe('signJob / verifySignedJob', () => {
  it('round-trips a valid job and returns the parsed SignedJob', async () => {
    const s = await signed();
    expect(s.kid).toBe(KEY_A.kid);
    expect(s.sig).toMatch(/^[0-9a-f]{64}$/);
    expect(SignedJobSchema.parse(s)).toEqual(s);
    const r = await verifySignedJob(s, [KEY_A], { now: NOW });
    expect(r).toEqual({ ok: true, signedJob: s });
  });

  it('survives a JSON round trip (wire form)', async () => {
    const s = await signed();
    const r = await verifySignedJob(JSON.parse(JSON.stringify(s)), [KEY_A], { now: NOW });
    expect(r.ok).toBe(true);
  });

  it('signs a domain-tagged canonical payload that excludes only sig', async () => {
    const s = await signed();
    const payload = canonicalSignedJobPayload(s);
    expect(payload.$t).toBe(JOB_SIGNATURE_TAG);
    expect(payload).not.toHaveProperty('sig');
    expect(payload).toHaveProperty('kid', KEY_A.kid);
  });

  it('rejects tampering with ANY leaf field', async () => {
    const s = await signed();
    const paths = leafPaths(s).filter((p) => p[0] !== 'sig');
    expect(paths.length).toBeGreaterThan(20);
    for (const p of paths) {
      const tampered = mutateAt(s, p, tweak);
      const r = await verifySignedJob(tampered, [KEY_A, KEY_B], { now: NOW });
      expect(r.ok, `tamper at ${p.join('.')}`).toBe(false);
    }
  });

  it('rejects an added field (top level and nested) and a removed field', async () => {
    const s = await signed();
    const added = { ...s, extra: 'x' };
    expect((await verifySignedJob(added, [KEY_A], { now: NOW })).ok).toBe(false);
    const nested = structuredClone(s) as unknown as { job: Record<string, unknown> };
    nested.job.injected = 'refs/heads/main';
    const rn = await verifySignedJob(nested, [KEY_A], { now: NOW });
    expect(rn).toMatchObject({ ok: false, reason: 'bad_signature', code: 'scope_violation' });
    const { credentialBroker: _drop, ...removed } = s;
    expect((await verifySignedJob(removed, [KEY_A], { now: NOW })).ok).toBe(false);
  });

  it('rejects a tampered signature, including case and length changes', async () => {
    const s = await signed();
    for (const sig of [s.sig.toUpperCase(), s.sig.slice(1), `${s.sig}0`, '', 'zz'.repeat(32)]) {
      const r = await verifySignedJob({ ...s, sig }, [KEY_A], { now: NOW });
      expect(r.ok, sig).toBe(false);
    }
  });

  it('rejects a job signed with another key under the same kid', async () => {
    const forged = await signJob(
      { job: prepareJob(), jobId: 'job-1', issuedAt: ISSUED, expiresAt: EXPIRES, credentialBroker: 'https://evil.test/' },
      { kid: KEY_A.kid, secret: KEY_B.secret },
    );
    const r = await verifySignedJob(forged, [KEY_A], { now: NOW });
    expect(r).toMatchObject({ ok: false, reason: 'bad_signature' });
  });

  it('rejects an unknown or wrong key id', async () => {
    const s = await signed();
    expect(await verifySignedJob(s, [KEY_B], { now: NOW })).toMatchObject({ ok: false, reason: 'unknown_key', code: 'scope_violation' });
    // Relabeling the kid to one the verifier knows does not help: kid is covered by the signature.
    expect(await verifySignedJob({ ...s, kid: KEY_B.kid }, [KEY_A, KEY_B], { now: NOW })).toMatchObject({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('supports key rotation: verifies with any key in the ring, or with a resolver', async () => {
    const s = await signed();
    expect((await verifySignedJob(s, [KEY_B, KEY_A], { now: NOW })).ok).toBe(true);
    const resolver = async (kid: string) => (kid === KEY_A.kid ? KEY_A : undefined);
    expect((await verifySignedJob(s, resolver, { now: NOW })).ok).toBe(true);
  });

  it('rejects an expired job with job_expired', async () => {
    const s = await signed();
    const r = await verifySignedJob(s, [KEY_A], { now: Date.parse(EXPIRES) + 60_000 });
    expect(r).toMatchObject({ ok: false, reason: 'expired', code: 'job_expired' });
  });

  it('applies the clock skew to expiry and not-before', async () => {
    const s = await signed();
    const justExpired = Date.parse(EXPIRES) + 10_000;
    expect((await verifySignedJob(s, [KEY_A], { now: justExpired, clockSkewSeconds: 30 })).ok).toBe(true);
    expect(await verifySignedJob(s, [KEY_A], { now: justExpired, clockSkewSeconds: 0 })).toMatchObject({ ok: false, reason: 'expired' });
    expect(await verifySignedJob(s, [KEY_A], { now: Date.parse(EXPIRES), clockSkewSeconds: 0 })).toMatchObject({ ok: false, reason: 'expired' });
    const early = Date.parse(ISSUED) - 10_000;
    expect((await verifySignedJob(s, [KEY_A], { now: early, clockSkewSeconds: 30 })).ok).toBe(true);
    expect(await verifySignedJob(s, [KEY_A], { now: early, clockSkewSeconds: 0 })).toMatchObject({ ok: false, reason: 'not_yet_valid' });
  });

  it('rejects jobs whose lifetime exceeds the maximum', async () => {
    const long = await signJob(
      { job: prepareJob(), jobId: 'job-2', issuedAt: ISSUED, expiresAt: '2026-10-08T10:00:00.000Z', credentialBroker: 'https://a.test/' },
      KEY_A,
    );
    expect(await verifySignedJob(long, [KEY_A], { now: NOW })).toMatchObject({ ok: false, reason: 'lifetime_too_long' });
    expect((await verifySignedJob(long, [KEY_A], { now: NOW, maxLifetimeSeconds: 3 * 86_400 })).ok).toBe(true);
  });

  it('defaults to a 1 h maximum lifetime for canonical-write kinds and 24 h otherwise', async () => {
    const twoHours = '2026-10-06T12:00:00.000Z';
    const prep = await signJob({ job: prepareJob(), jobId: 'job-3', issuedAt: ISSUED, expiresAt: twoHours, credentialBroker: 'https://a.test/' }, KEY_A);
    expect(await verifySignedJob(prep, [KEY_A], { now: NOW })).toMatchObject({ ok: false, reason: 'lifetime_too_long' });
    const seed = await signJob(
      {
        job: {
          kind: 'seed-workspace',
          taskWorkspaceId: 'tw-1',
          resourceId: 'res-site',
          canonical: artifactsCoords('site'),
          baseSha: 'a'.repeat(40),
          taskFork: artifactsCoords('ws-tw-1', 'commonforge-org1-tasks'),
          ref: 'refs/heads/main',
        },
        jobId: 'job-seed',
        issuedAt: ISSUED,
        expiresAt: twoHours,
        credentialBroker: 'https://a.test/',
      },
      KEY_A,
    );
    expect(await verifySignedJob(seed, [KEY_A], { now: NOW })).toMatchObject({ ok: false, reason: 'lifetime_too_long' });
    const inv = await signJob(
      {
        job: { kind: 'inventory', intakeId: 'in-1', upload: { r2Key: 'k' }, limits: {} },
        jobId: 'job-4',
        issuedAt: ISSUED,
        expiresAt: twoHours,
        credentialBroker: 'https://a.test/',
      },
      KEY_A,
    );
    expect((await verifySignedJob(inv, [KEY_A], { now: NOW })).ok).toBe(true);
    expect(defaultMaxLifetimeSeconds('reconcile-ref')).toBe(3600);
  });

  it('binds the jobId: expectedJobId mismatch rejects', async () => {
    const s = await signed();
    expect((await verifySignedJob(s, [KEY_A], { now: NOW, expectedJobId: 'job-1' })).ok).toBe(true);
    expect(await verifySignedJob(s, [KEY_A], { now: NOW, expectedJobId: 'job-2' })).toMatchObject({ ok: false, reason: 'job_id_mismatch' });
  });

  it('restricts job kinds when asked', async () => {
    const s = await signed();
    expect(await verifySignedJob(s, [KEY_A], { now: NOW, allowedKinds: ['integrate'] })).toMatchObject({ ok: false, reason: 'kind_not_allowed' });
  });

  it('rejects malformed input without throwing', async () => {
    for (const v of [null, 1, 'x', [], {}, { sig: 'a'.repeat(64), kid: KEY_A.kid }]) {
      const r = await verifySignedJob(v, [KEY_A], { now: NOW });
      expect(r.ok).toBe(false);
    }
  });

  it('refuses to sign a job containing a secret, a weak key, or an invalid job', async () => {
    const job = prepareJob() as { kind: 'prepare-candidate'; candidate: { tool?: string } };
    job.candidate.tool = 'Bearer abcdefghijklmnopqrstuvwxyz0123456789';
    await expect(
      signJob({ job: job as never, jobId: 'job-1', issuedAt: ISSUED, expiresAt: EXPIRES, credentialBroker: 'https://a.test/' }, KEY_A),
    ).rejects.toMatchObject({ code: 'secret_in_job' });
    await expect(
      signJob({ job: prepareJob(), jobId: 'job-1', issuedAt: ISSUED, expiresAt: EXPIRES, credentialBroker: 'https://a.test/' }, { kid: 'k', secret: 'short' }),
    ).rejects.toMatchObject({ code: 'weak_job_key' });
    await expect(
      signJob({ job: { kind: 'nope' } as never, jobId: 'job-1', issuedAt: ISSUED, expiresAt: EXPIRES, credentialBroker: 'https://a.test/' }, KEY_A),
    ).rejects.toMatchObject({ code: 'invalid_job' });
  });

  it('refuses a credential broker URL with embedded credentials', async () => {
    await expect(
      signJob({ job: prepareJob(), jobId: 'job-1', issuedAt: ISSUED, expiresAt: EXPIRES, credentialBroker: 'https://u:p@a.test/' }, KEY_A),
    ).rejects.toMatchObject({ code: 'invalid_job' });
  });
});

describe('constantTimeEqual', () => {
  it('compares bytes', () => {
    const a = new Uint8Array([1, 2, 3]);
    expect(constantTimeEqual(a, new Uint8Array([1, 2, 3]))).toBe(true);
    expect(constantTimeEqual(a, new Uint8Array([1, 2, 4]))).toBe(false);
    expect(constantTimeEqual(a, new Uint8Array([1, 2]))).toBe(false);
  });
});
