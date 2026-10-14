/**
 * SignedJob signing and verification (plan §B.8). HMAC-SHA256 over canonical JSON via WebCrypto,
 * so the same code runs in the Worker (issuer, capability broker) and in the runner.
 */
import { canonicalJson, type RunnerFailureCode } from '@commonforge-org/core';
import { RunnerProtocolError } from './errors.js';
import { KID_RE, hmacSha256Hex, resolveKey, verifyHmacSha256Hex, type JobKeyring, type JobSigningKey } from './hmac.js';
import { CANONICAL_WRITE_KINDS, SignedJobSchema, UnsignedJobSchema, type IntegrationJobKind, type SignedJob, type UnsignedJobInput } from './jobs.js';
import { containsSecret } from './redact.js';

/** Domain/version tag inside the signed payload. */
export const JOB_SIGNATURE_TAG = 'cf.signed-job/1';

/** The object whose canonical JSON is signed: every field except `sig`, plus the domain tag. */
export function canonicalSignedJobPayload(signedOrUnsigned: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const { sig: _sig, ...rest } = signedOrUnsigned;
  return { ...rest, $t: JOB_SIGNATURE_TAG };
}

/**
 * Sign a job. The job is parsed first (defaults applied) so the signed bytes equal what a
 * verifier parses; jobs containing secret-looking values are refused.
 */
export async function signJob(unsigned: UnsignedJobInput, key: JobSigningKey): Promise<SignedJob> {
  const parsed = UnsignedJobSchema.safeParse(unsigned);
  if (!parsed.success) throw new RunnerProtocolError('invalid_job', parsed.error.message);
  const body = { ...parsed.data, kid: key.kid };
  if (containsSecret(canonicalJson(body))) throw new RunnerProtocolError('secret_in_job', 'jobs carry coordinates only, never credentials');
  const sig = await hmacSha256Hex(key, canonicalJson(canonicalSignedJobPayload(body)));
  return { ...body, sig };
}

export type JobVerifyFailureReason =
  | 'malformed'
  | 'unknown_key'
  | 'bad_signature'
  | 'expired'
  | 'not_yet_valid'
  | 'lifetime_too_long'
  | 'job_id_mismatch'
  | 'kind_not_allowed';

export type JobVerifyResult =
  | { ok: true; signedJob: SignedJob }
  | { ok: false; reason: JobVerifyFailureReason; code: RunnerFailureCode; detail: string };

export interface VerifySignedJobOptions {
  /** current time (default `Date.now()`) */
  now?: Date | number;
  /** tolerated clock difference applied to issuedAt (not-before) and expiresAt; default 30 s */
  clockSkewSeconds?: number;
  /**
   * refuse jobs valid for longer than this; default {@link defaultMaxLifetimeSeconds}
   * (1 h for canonical-write kinds, 24 h otherwise)
   */
  maxLifetimeSeconds?: number;
  /** the jobId the caller expects (e.g. from a queue message or a credential request) */
  expectedJobId?: string;
  /** job kinds this verifier serves (e.g. the broker's write-capable kinds) */
  allowedKinds?: readonly IntegrationJobKind[];
}

/**
 * Default maximum job lifetime: 3 600 s for canonical-write kinds and `seed-workspace` (short-lived
 * because the broker mints a canonical read token for it, and seeding happens inline with task
 * creation), 86 400 s for the rest.
 */
export function defaultMaxLifetimeSeconds(kind: IntegrationJobKind): number {
  // release-deploy: the account deploy credential exists only while the job is open
  return (CANONICAL_WRITE_KINDS as readonly string[]).includes(kind) || kind === 'seed-workspace' || kind === 'release-deploy' ? 3_600 : 86_400;
}

function fail(reason: JobVerifyFailureReason, detail: string): JobVerifyResult {
  return { ok: false, reason, code: reason === 'expired' ? 'job_expired' : 'scope_violation', detail };
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

/**
 * Verify a SignedJob received over the wire.
 *
 * Consumers must act on the returned `signedJob` only, never on a re-parse of the raw body by
 * another JSON parser (duplicate keys are last-wins only under `JSON.parse`). Verification is
 * stateless: there is no replay guard here, so the broker and the ledger dedupe by `jobId`
 * (results are applied once, plan §F) and tokens are minted with `ttl <= expiresAt`.
 * Order: shape → key id → signature over the raw
 * fields (so any added, removed or changed field fails) → schema → time window → bindings.
 * Never throws for bad input; throws only for a misconfigured key (`weak_job_key`).
 */
export async function verifySignedJob(value: unknown, keyring: JobKeyring, options: VerifySignedJobOptions = {}): Promise<JobVerifyResult> {
  if (!isPlainObject(value)) return fail('malformed', 'not a SignedJob object');
  const { kid, sig } = value;
  if (typeof kid !== 'string' || !KID_RE.test(kid)) return fail('malformed', 'missing or invalid kid');
  if (typeof sig !== 'string') return fail('malformed', 'missing sig');
  const key = await resolveKey(keyring, kid);
  if (!key) return fail('unknown_key', `unknown key id ${kid}`);

  let message: string;
  try {
    message = canonicalJson(canonicalSignedJobPayload(value));
  } catch {
    return fail('malformed', 'payload is not canonical JSON');
  }
  if (!(await verifyHmacSha256Hex(key, message, sig))) return fail('bad_signature', 'bad signature');

  const parsed = SignedJobSchema.safeParse(value);
  if (!parsed.success) return fail('malformed', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  const job = parsed.data;

  const now = options.now === undefined ? Date.now() : typeof options.now === 'number' ? options.now : options.now.getTime();
  const skewMs = (options.clockSkewSeconds ?? 30) * 1000;
  const issued = Date.parse(job.issuedAt);
  const expires = Date.parse(job.expiresAt);
  if (expires - issued > (options.maxLifetimeSeconds ?? defaultMaxLifetimeSeconds(job.job.kind)) * 1000) {
    return fail('lifetime_too_long', `job lifetime ${(expires - issued) / 1000}s exceeds maximum`);
  }
  if (now + skewMs < issued) return fail('not_yet_valid', `issued at ${job.issuedAt}`);
  if (now - skewMs >= expires) return fail('expired', `expired at ${job.expiresAt}`);
  if (options.expectedJobId !== undefined && options.expectedJobId !== job.jobId) {
    return fail('job_id_mismatch', `expected ${options.expectedJobId}, got ${job.jobId}`);
  }
  if (options.allowedKinds && !options.allowedKinds.includes(job.job.kind)) {
    return fail('kind_not_allowed', `job kind ${job.job.kind} not allowed here`);
  }
  return { ok: true, signedJob: job };
}
