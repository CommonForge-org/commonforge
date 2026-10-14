import type { RunnerFailureCode, ValidationEvidence } from '@commonforge-org/core';

/** A job ends with a typed failure (plan §B.8 RunnerResult `ok: false`). */
export class JobFailure extends Error {
  constructor(
    readonly code: RunnerFailureCode,
    readonly detail: string,
    readonly evidence?: ValidationEvidence,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'JobFailure';
  }
}
