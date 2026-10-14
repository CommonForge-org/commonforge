/**
 * A `RunnerSubmit` (core) over this runner, for dev setups and tests where one process both issues
 * and runs jobs (e.g. a LocalGitProvider project, the conformance suite). It plays the issuer:
 * signs each bare job with `jobKey`, derives the per-job evidence key, and hands the delivery to
 * the runner. Production issues jobs from the Worker instead.
 */
import { randomUUID } from 'node:crypto';
import type { RunnerSubmit } from '@commonforge-org/core';
import { deriveEvidenceKey, evidenceKeyToWire, IntegrationJobSchema, signJob, type JobSigningKey } from '@commonforge-org/runner-protocol';
import type { Runner } from './runner.js';

export interface RunnerSubmitOptions {
  runner: Runner;
  jobKey: JobSigningKey;
  /** broker URL written into each job (default `http://127.0.0.1/api/runner/credential`, unused with static credentials) */
  credentialBroker?: string;
  /** job lifetime (default 15 min) */
  lifetimeSeconds?: number;
  now?: () => Date;
  newJobId?: () => string;
}

export function createRunnerSubmit(options: RunnerSubmitOptions): RunnerSubmit {
  const now = options.now ?? (() => new Date());
  return (async (request: unknown) => {
    const job = IntegrationJobSchema.parse(request);
    // an integrate job's integrationRef already embeds the jobId it was built for
    const jobId = job.kind === 'integrate' ? job.integrationRef.split('/').pop()! : (options.newJobId?.() ?? `job-${randomUUID()}`);
    const issued = now();
    const signedJob = await signJob(
      {
        job,
        jobId,
        issuedAt: issued.toISOString(),
        expiresAt: new Date(issued.getTime() + (options.lifetimeSeconds ?? 900) * 1000).toISOString(),
        credentialBroker: options.credentialBroker ?? 'http://127.0.0.1/api/runner/credential',
      },
      options.jobKey,
    );
    const evidenceKey = evidenceKeyToWire(await deriveEvidenceKey(options.jobKey, jobId));
    return options.runner.execute({ signedJob, evidenceKey });
  }) as RunnerSubmit;
}
