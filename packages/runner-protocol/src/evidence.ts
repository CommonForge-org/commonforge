/**
 * ValidationEvidence signatures (plan §B.7), so agent-written text can never satisfy an evidence
 * requirement.
 *
 * Key separation: the runner never holds a job-signing key. The issuer (Worker) derives a
 * per-job evidence key
 *
 *   evidenceKey = HMAC-SHA256(jobKey[kid], "cf.evidence-key/1|" + jobId)        (32 bytes)
 *
 * and hands only that to the runner (e.g. with the job delivery or the broker response). It can
 * sign evidence for that one job and nothing else: it cannot sign a SignedJob (wrong key) nor
 * evidence for another job (the derivation and the payload both bind the jobId). The verifier
 * re-derives it from its job keyring.
 *
 *   signature = `hs256:<kid>:<hex HMAC-SHA256(evidenceKey, canonicalJson({$t, jobId, kid, evidence}))>`
 *
 * where `evidence` is every field except `signature`. Task 14: sign evidence in the runner
 * supervisor, outside the process that executes candidate check commands.
 */
import { z } from 'zod';
import { bytesToHex, canonicalJson, ValidationEvidenceSchema, type ValidationEvidence } from '@commonforge-org/core';
import { RunnerProtocolError } from './errors.js';
import { KID_RE, hmacSha256, hmacSha256Hex, resolveKey, verifyHmacSha256Hex, type JobKeyring, type JobSigningKey } from './hmac.js';
import { redactDeep } from './redact.js';

export const EVIDENCE_SIGNATURE_TAG = 'cf.validation-evidence/1';
export const EVIDENCE_KEY_DERIVATION_TAG = 'cf.evidence-key/1';

const UnsignedEvidenceSchema = ValidationEvidenceSchema.omit({ signature: true });
export type UnsignedValidationEvidence = z.input<typeof UnsignedEvidenceSchema>;

/** A per-job evidence key: usable only for evidence of `jobId`. Contains a secret. */
export interface EvidenceSigningKey {
  readonly kid: string;
  readonly jobId: string;
  readonly secret: Uint8Array;
  readonly purpose: 'evidence';
}

/** Wire form of an evidence key (secret as lowercase hex). Contains a secret: never log. */
export const EvidenceKeyWireSchema = z.object({
  kid: z.string().regex(KID_RE),
  jobId: z.string().min(1).max(128),
  secret: z.string().regex(/^[0-9a-f]{64}$/),
  purpose: z.literal('evidence'),
});
export type EvidenceKeyWire = z.infer<typeof EvidenceKeyWireSchema>;

/** Derive the per-job evidence key from a job-signing key (issuer and verifier side only). */
export async function deriveEvidenceKey(jobKey: JobSigningKey, jobId: string): Promise<EvidenceSigningKey> {
  const secret = await hmacSha256(jobKey, `${EVIDENCE_KEY_DERIVATION_TAG}|${jobId}`);
  return { kid: jobKey.kid, jobId, secret, purpose: 'evidence' };
}

export function evidenceKeyToWire(key: EvidenceSigningKey): EvidenceKeyWire {
  return { kid: key.kid, jobId: key.jobId, secret: bytesToHex(key.secret), purpose: 'evidence' };
}

export function evidenceKeyFromWire(value: unknown): EvidenceSigningKey {
  const r = EvidenceKeyWireSchema.safeParse(value);
  if (!r.success) throw new RunnerProtocolError('invalid_evidence', 'malformed evidence key');
  const secret = new Uint8Array(32);
  for (let i = 0; i < 32; i++) secret[i] = Number.parseInt(r.data.secret.slice(i * 2, i * 2 + 2), 16);
  return { kid: r.data.kid, jobId: r.data.jobId, secret, purpose: 'evidence' };
}

const SIG_RE = /^hs256:([A-Za-z0-9][A-Za-z0-9._-]{0,63}):([0-9a-f]{64})$/;

function payload(jobId: string, kid: string, evidence: Readonly<Record<string, unknown>>): string {
  const { signature: _s, ...rest } = evidence;
  return canonicalJson({ $t: EVIDENCE_SIGNATURE_TAG, jobId, kid, evidence: rest });
}

/**
 * Sign evidence with the per-job evidence key (runner side). `binding.jobId` must be the key's
 * job. Secrets in commands/details are redacted before signing.
 */
export async function signEvidence(
  unsigned: UnsignedValidationEvidence,
  key: EvidenceSigningKey,
  binding: { jobId: string },
): Promise<ValidationEvidence> {
  if (key.purpose !== 'evidence' || !(key.secret instanceof Uint8Array) || key.secret.length !== 32) {
    throw new RunnerProtocolError('weak_job_key', 'not a derived evidence key (use deriveEvidenceKey)');
  }
  if (!KID_RE.test(key.kid)) throw new RunnerProtocolError('weak_job_key', 'invalid key id');
  if (key.jobId !== binding.jobId) throw new RunnerProtocolError('invalid_evidence', `evidence key is for job ${key.jobId}, not ${binding.jobId}`);
  const parsed = UnsignedEvidenceSchema.safeParse(unsigned);
  if (!parsed.success) throw new RunnerProtocolError('invalid_evidence', parsed.error.message);
  const evidence = redactDeep(parsed.data);
  const mac = await hmacSha256Hex(key, payload(binding.jobId, key.kid, evidence));
  return { ...evidence, signature: `hs256:${key.kid}:${mac}` };
}

export type EvidenceVerifyResult =
  | { ok: true; evidence: ValidationEvidence }
  | { ok: false; reason: 'malformed' | 'unknown_key' | 'bad_signature'; detail: string };

/**
 * Verify evidence against the job it claims to come from (Worker side). `jobKeyring` holds the
 * job-signing keys; the per-job evidence key is re-derived from `kid` and `binding.jobId`.
 */
export async function verifyEvidence(value: unknown, jobKeyring: JobKeyring, binding: { jobId: string }): Promise<EvidenceVerifyResult> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false, reason: 'malformed', detail: 'not an object' };
  const record = value as Record<string, unknown>;
  const m = typeof record.signature === 'string' ? SIG_RE.exec(record.signature) : null;
  if (!m) return { ok: false, reason: 'malformed', detail: 'signature is not hs256:<kid>:<hex>' };
  const kid = m[1]!;
  const jobKey = await resolveKey(jobKeyring, kid);
  if (!jobKey) return { ok: false, reason: 'unknown_key', detail: `unknown key id ${kid}` };
  let message: string;
  try {
    message = payload(binding.jobId, kid, record);
  } catch {
    return { ok: false, reason: 'malformed', detail: 'payload is not canonical JSON' };
  }
  const evidenceKey = await deriveEvidenceKey(jobKey, binding.jobId);
  if (!(await verifyHmacSha256Hex(evidenceKey, message, m[2]!))) return { ok: false, reason: 'bad_signature', detail: 'bad signature' };
  const parsed = ValidationEvidenceSchema.safeParse(value);
  if (!parsed.success) return { ok: false, reason: 'malformed', detail: parsed.error.message };
  return { ok: true, evidence: parsed.data };
}
