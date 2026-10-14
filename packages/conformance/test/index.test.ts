import { describe, expect, it } from 'vitest';
import { LEDGER_CONFORMANCE_SCENARIOS, PACKAGE_NAME, describeLedgerConformance } from '../src/index.js';
import { createReferenceRunner, describeProviderConformance, revisionForCoords } from '../src/provider.js';

describe('@commonforge-org/conformance', () => {
  it('exports its package name and both suites', () => {
    expect(PACKAGE_NAME).toBe('@commonforge-org/conformance');
    expect(typeof describeLedgerConformance).toBe('function');
    expect(typeof describeProviderConformance).toBe('function');
    expect(typeof createReferenceRunner).toBe('function');
  });

  it('wraps every ledger scenario', () => {
    expect(LEDGER_CONFORMANCE_SCENARIOS.length).toBeGreaterThan(10);
  });

  it('builds revision ids from repository coordinates', () => {
    const sha = 'a'.repeat(40);
    expect(revisionForCoords({ kind: 'local-git', namespace: 'n', repoName: 'r', repoId: 'r1', remoteUrl: 'file:///tmp/r' }, sha)).toBe(`local:r1:${sha}`);
    expect(revisionForCoords({ kind: 'artifacts', namespace: 'n', repoName: 'r', repoId: 'r1', remoteUrl: 'https://x/r' }, sha)).toBe(`art:r1:${sha}`);
  });
});
