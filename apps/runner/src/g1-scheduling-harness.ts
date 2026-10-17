// Trusted supervisor fixture, mounted read-only OUTSIDE the candidate tree.
// Candidate code runs only in the sibling process; it cannot change these expectations.
const cases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
  ['exact-cutoff', { appointment: '2026-10-18T12:00:00.000Z', actor: 'customer' }, { allowed: true, override: null }],
  ['inside-cutoff', { appointment: '2026-10-18T11:59:59.999Z', actor: 'customer' }, { allowed: false, code: 'cutoff' }],
  ['outside-cutoff', { appointment: '2026-10-18T12:00:00.001Z', actor: 'customer' }, { allowed: true, override: null }],
  ['travel-block', { appointment: '2026-10-19T12:00:00.000Z', actor: 'customer', traveling: true }, { allowed: false, code: 'technician_traveling' }],
  ['unauthorized-override', { appointment: '2026-10-17T13:00:00.000Z', actor: 'customer', reason: 'Please' }, { allowed: false, code: 'cutoff' }],
  ['manager-reason-required', { appointment: '2026-10-17T13:00:00.000Z', actor: 'manager', reason: '  ' }, { allowed: false, code: 'override_reason_required' }],
  ['manager-reason-retained', { appointment: '2026-10-17T13:00:00.000Z', actor: 'manager', reason: '  Customer emergency  ' }, { allowed: true, override: { actor: 'manager', reason: 'Customer emergency', recordedAt: '2026-10-17T12:00:00.000Z' } }],
  ['manager-no-travel-bypass', { appointment: '2026-10-17T13:00:00.000Z', actor: 'manager', reason: 'Emergency', traveling: true }, { allowed: false, code: 'technician_traveling' }],
  ['explicit-offset', { appointment: '2026-10-18T07:00:00.000-05:00', actor: 'customer' }, { allowed: true, override: null }],
];
export { cases };
