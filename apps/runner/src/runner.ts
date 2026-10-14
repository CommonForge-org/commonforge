/**
 * The integration runner: verifies a delivered SignedJob, dedupes by jobId, obtains short-lived
 * credentials, executes the job with real git, signs evidence in this (supervisor) process,
 * redacts and self-checks the result, and revokes every token.
 *
 * Job authenticity: the runner never holds the job-signing key (runner-protocol review I-3), so
 * by default it pre-checks shape, lifetime and expiry only; authenticity is enforced where it
 * matters — the credential broker verifies the job before minting any token, the Worker verifies
 * it again (and the evidence) before applying a result. A trusted runner (dev, tests, a
 * developer-controlled Node runner) can be given `jobKeyring` and then verifies signatures too.
 */
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  defaultMaxLifetimeSeconds,
  evidenceKeyFromWire,
  parseRunnerResultForJob,
  redactDeep,
  RunnerJobDeliverySchema,
  SignedJobSchema,
  verifySignedJob,
  type EvidenceSigningKey,
  type IntegrationJobKind,
  type JobKeyring,
  type JobVerifyResult,
  type RunnerResult,
  type SignedJob,
} from '@commonforge-org/runner-protocol';
import { IdSegmentSchema, type RevisionId, type RunnerKind } from '@commonforge-org/core';
import { jobRepoAccess } from '@commonforge-org/runner-protocol';
import type { BlobStoreFactory } from './blob-store.js';
import { JobContext, type CommandSettings, type DeploySettings } from './context.js';
import type { CredentialSource } from './credentials.js';
import { JobFailure } from './errors.js';
import { createGit, KeyedMutex, type GitConfig } from './git.js';
import { assertSeparateCheckUid, linuxProcessOps, type ProcessOps } from './procs.js';
import { JOB_HANDLERS } from './jobs/index.js';

export interface RunnerOptions {
  /** scratch root; every job gets its own directory below it, removed afterwards */
  workDir: string;
  /** root for check checkouts/HOME/TMPDIR (default `<workDir>-checks`); never inside a job dir */
  checksDir?: string;
  /**
   * The Worker origin this runner trusts (review I-2). When set, a job whose `credentialBroker`
   * has another origin is refused before any network call, so an unverified job can never choose
   * where the runner's credentials, results or uploads go. REQUIRED with broker credentials:
   * `createRunner` refuses to construct a broker-mode runner without it (review R-2).
   */
  trustedWorkerOrigin?: string;
  /** process listing/killing for check reaping (tests inject a fake) */
  procs?: ProcessOps;
  credentials: CredentialSource;
  /** verify job signatures (trusted runners only; the runner otherwise never holds job keys) */
  jobKeyring?: JobKeyring;
  /** object storage for uploads, exports, previews */
  blobStore?: BlobStoreFactory;
  /** ledger heads for stale checks (never canonical refs/heads/main) */
  currentHeads?: (signedJob: SignedJob) => Promise<Record<string, RevisionId | null> | null>;
  /** evidence key when the delivery did not carry one */
  evidenceKey?: (signedJob: SignedJob) => Promise<EvidenceSigningKey | null>;
  runnerId?: string;
  runnerKind?: RunnerKind;
  git?: GitConfig;
  commands?: CommandSettings;
  push?: { attempts?: number; baseDelayMs?: number; sleep?: (ms: number) => Promise<void> };
  /** base URL previews are served from (`<base>/<previewId>/`) */
  previewBaseUrl?: string;
  /** release-deploy jobs: pinned wrangler + credential source (without it those jobs fail) */
  deploy?: DeploySettings;
  /** extra strings that must never appear in a built edition (tripwire, e.g. canary secrets) */
  canaries?: readonly string[];
  /** persist results by jobId so a re-delivered job is answered without re-running */
  journalDir?: string;
  now?: () => Date;
  clockSkewSeconds?: number;
  /** extra secrets to redact everywhere (e.g. the runner's own Worker bearer) */
  secrets?: readonly string[];
  log?: (line: string) => void;
  /** keep job directories (debugging) */
  keepWorkDirs?: boolean;
}

export interface Runner {
  /** Execute a delivery (`{signedJob, evidenceKey?}`) or a bare SignedJob. Never throws. */
  execute(delivery: unknown): Promise<RunnerResult>;
  /** The verified SignedJob of a delivery, or null (for result posting). */
  readonly lastVerified: Map<string, SignedJob>;
}

const INVALID_JOB_ID = 'invalid-job';

/** Shape, lifetime and expiry checks without a key (see module doc). Mirrors verifySignedJob's order. */
export function precheckSignedJob(value: unknown, now: number, skewSeconds = 30): JobVerifyResult {
  const parsed = SignedJobSchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, reason: 'malformed', code: 'scope_violation', detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  }
  const job = parsed.data;
  const issued = Date.parse(job.issuedAt);
  const expires = Date.parse(job.expiresAt);
  if (expires - issued > defaultMaxLifetimeSeconds(job.job.kind) * 1000) {
    return { ok: false, reason: 'lifetime_too_long', code: 'scope_violation', detail: `job lifetime ${(expires - issued) / 1000}s exceeds maximum` };
  }
  const skew = skewSeconds * 1000;
  if (now + skew < issued) return { ok: false, reason: 'not_yet_valid', code: 'scope_violation', detail: `issued at ${job.issuedAt}` };
  if (now - skew >= expires) return { ok: false, reason: 'expired', code: 'job_expired', detail: `expired at ${job.expiresAt}` };
  return { ok: true, signedJob: job };
}

function jobIdOf(value: unknown): string {
  const id = (value as { jobId?: unknown } | null)?.jobId;
  return IdSegmentSchema.safeParse(id).success ? (id as string) : INVALID_JOB_ID;
}

export function createRunner(options: RunnerOptions): Runner {
  if (options.credentials.kind === 'broker' && !options.trustedWorkerOrigin) {
    throw new Error('broker credentials need trustedWorkerOrigin (the only origin the runner may send credentials to)');
  }
  if (options.trustedWorkerOrigin !== undefined) new URL(options.trustedWorkerOrigin); // throws on garbage
  if (options.commands?.uid !== undefined) {
    if (options.commands.unsafeSameUid) throw new Error('commands.uid and commands.unsafeSameUid are mutually exclusive');
    assertSeparateCheckUid(options.commands.uid, options.commands.gid ?? options.commands.uid);
  }
  const git = createGit(options.git);
  const now = options.now ?? (() => new Date());
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const inFlight = new Map<string, Promise<RunnerResult>>();
  const lastVerified = new Map<string, SignedJob>();
  const pushMutex = new KeyedMutex();
  const services = {
    git,
    pushMutex,
    runnerId: options.runnerId ?? 'node-runner',
    runnerKind: options.runnerKind ?? 'node-runner',
    ...(options.blobStore ? { blobStore: options.blobStore } : {}),
    ...(options.currentHeads ? { currentHeads: options.currentHeads } : {}),
    commands: options.commands ?? {},
    checksRoot: options.checksDir ?? `${options.workDir.replace(/\/+$/, '')}-checks`,
    procs: options.procs ?? linuxProcessOps,
    push: options.push ?? {},
    ...(options.previewBaseUrl ? { previewBaseUrl: options.previewBaseUrl } : {}),
    ...(options.deploy ? { deploy: options.deploy } : {}),
    canaries: options.canaries ?? [],
    now,
    log,
  };

  const journalPath = (jobId: string) => (options.journalDir ? join(options.journalDir, `${jobId}.json`) : null);

  async function readJournal(jobId: string): Promise<RunnerResult | null> {
    const p = journalPath(jobId);
    if (!p) return null;
    try {
      return JSON.parse(await readFile(p, 'utf8')) as RunnerResult;
    } catch {
      return null;
    }
  }

  async function writeJournal(jobId: string, result: RunnerResult): Promise<void> {
    const p = journalPath(jobId);
    if (!p || jobId === INVALID_JOB_ID) return;
    await mkdir(options.journalDir!, { recursive: true });
    const tmp = `${p}.tmp-${process.pid}`;
    await writeFile(tmp, JSON.stringify(result), { mode: 0o600 });
    await rename(tmp, p);
  }

  async function verify(raw: unknown): Promise<JobVerifyResult> {
    if (options.jobKeyring) {
      return verifySignedJob(raw, options.jobKeyring, { now: now(), clockSkewSeconds: options.clockSkewSeconds ?? 30 });
    }
    return precheckSignedJob(raw, now().getTime(), options.clockSkewSeconds ?? 30);
  }

  async function run(signedJob: SignedJob, evidenceKey: EvidenceSigningKey | null): Promise<RunnerResult> {
    const jobId = signedJob.jobId;
    await mkdir(options.workDir, { recursive: true });
    const jobDir = await mkdtemp(join(options.workDir, `job-${jobId.slice(0, 40)}-`));
    const session = options.credentials.open(signedJob);
    const extraSecrets = [...(options.secrets ?? []), ...(evidenceKey ? [Buffer.from(evidenceKey.secret).toString('hex')] : [])];
    const ctx = new JobContext(signedJob, jobDir, session, services, evidenceKey, extraSecrets);
    let result: RunnerResult;
    try {
      const handler = JOB_HANDLERS[signedJob.job.kind] as (c: JobContext) => Promise<unknown>;
      ctx.log(`start ${signedJob.job.kind}`);
      const receipt = await handler(ctx);
      result = { jobId, ok: true, receipt } as RunnerResult;
    } catch (e) {
      if (e instanceof JobFailure) {
        result = { jobId, ok: false, code: e.code, detail: e.detail.slice(0, 16_000), ...(e.evidence ? { evidence: e.evidence } : {}) };
      } else {
        result = { jobId, ok: false, code: 'provider_unavailable', detail: `runner error: ${(e as Error)?.message ?? String(e)}`.slice(0, 16_000) };
      }
    } finally {
      await ctx.assertNoCheckProcesses().catch((e: Error) => ctx.log(`check reaping: ${e.message}`));
      await session.close();
      if (!options.keepWorkDirs) {
        await rm(jobDir, { recursive: true, force: true }).catch(() => undefined);
        await ctx.cleanupChecks();
      }
    }
    // Everything leaving the runner is redacted with every secret this job saw.
    result = redactDeep(result, ...session.secrets(), ...extraSecrets);
    try {
      parseRunnerResultForJob(signedJob as never, result);
    } catch (e) {
      result = { jobId, ok: false, code: 'provider_unavailable', detail: redactDeep(`runner produced an inconsistent result: ${(e as Error).message}`.slice(0, 4000), ...session.secrets()) };
    }
    ctx.log(result.ok ? 'ok' : `failed ${result.code}`);
    return result;
  }

  async function execute(delivery: unknown): Promise<RunnerResult> {
    let raw: unknown = delivery;
    let wireKey: unknown;
    if (delivery && typeof delivery === 'object' && 'signedJob' in delivery) {
      const d = RunnerJobDeliverySchema.safeParse(delivery);
      if (!d.success) return { jobId: jobIdOf((delivery as { signedJob?: unknown }).signedJob), ok: false, code: 'scope_violation', detail: 'malformed job delivery' };
      raw = d.data.signedJob;
      wireKey = d.data.evidenceKey;
    }
    const v = await verify(raw);
    if (!v.ok) return { jobId: jobIdOf(raw), ok: false, code: v.code, detail: v.detail };
    const signedJob = v.signedJob;
    const jobId = signedJob.jobId;
    const destination = checkDestinations(signedJob, options);
    if (destination) return { jobId, ok: false, code: 'scope_violation', detail: destination };
    lastVerified.set(jobId, signedJob);

    const cached = await readJournal(jobId);
    if (cached) return cached;
    const pending = inFlight.get(jobId);
    if (pending) return pending;

    const p = (async () => {
      let key: EvidenceSigningKey | null = null;
      if (wireKey !== undefined) {
        try {
          key = evidenceKeyFromWire(wireKey);
        } catch {
          key = null;
        }
        if (key && key.jobId !== jobId) return { jobId, ok: false as const, code: 'scope_violation' as const, detail: 'evidence key belongs to another job' };
      } else if (options.evidenceKey && needsEvidence(signedJob.job.kind)) {
        key = await options.evidenceKey(signedJob).catch(() => null);
      }
      const result = await run(signedJob, key);
      await writeJournal(jobId, result).catch(() => undefined);
      return result;
    })();
    inFlight.set(jobId, p);
    try {
      return await p;
    } finally {
      inFlight.delete(jobId);
    }
  }

  return { execute, lastVerified };
}

function needsEvidence(kind: IntegrationJobKind): boolean {
  return kind === 'integrate';
}

/**
 * Where an (unverified) job may make the runner connect (review I-2): the broker must be the
 * trusted Worker origin, and `file:`/`http:` remotes are refused unless the runner was explicitly
 * configured for local repositories / plain-http dev servers.
 */
function checkDestinations(signedJob: SignedJob, options: RunnerOptions): string | null {
  if (options.trustedWorkerOrigin !== undefined) {
    let origin = '';
    try {
      origin = new URL(signedJob.credentialBroker).origin;
    } catch {
      /* refused below */
    }
    if (origin !== new URL(options.trustedWorkerOrigin).origin) return `credential broker ${origin || '(invalid)'} is not this runner's Worker`;
  }
  for (const a of jobRepoAccess(signedJob.job)) {
    const scheme = a.coords.remoteUrl.split(':', 1)[0]!.toLowerCase();
    if (scheme === 'file' && !options.git?.allowFile) return `file remotes are not enabled on this runner (${a.coords.repoName})`;
    if (scheme === 'http' && !options.git?.allowHttp) return `plain http remotes are not enabled on this runner (${a.coords.repoName})`;
    if (scheme !== 'https' && scheme !== 'http' && scheme !== 'file') return `unsupported remote scheme ${scheme}`;
  }
  return null;
}
