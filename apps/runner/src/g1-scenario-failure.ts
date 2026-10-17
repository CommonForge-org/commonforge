/** Only supervisors that observed namespace startup may classify a candidate execution error.
 * Messages are fixed/redacted: candidate diagnostics, file paths and stacks never enter evidence. */
export class CandidateExecutionError extends Error {
  constructor(readonly sourceDigest?: string) { super('isolated candidate execution failed or timed out'); this.name = 'CandidateExecutionError'; }
}
export const candidateErrorResults = (ids: readonly string[]) => ids.map(scenarioId => ({
  scenarioId, result: 'error' as const, detail: 'Isolated candidate execution failed or timed out; no passing behavior was established.',
}));
