import { describe, expect, it } from 'vitest';
import { runRealLocal } from '../src/g1-real-local.js';
describe('G1 real local source/runner/preview rehearsal', () => {
  it('uses real local Git, a signed Node runner, disk blobs, HTTP preview, and isolated trusted scenarios', async () => {
    const local = await runRealLocal();
    try {
      expect(local.report.gates).toMatchObject({ realGit: 'pass', signedNodeRunner: 'pass', localBlobStore: 'pass', httpPreview: 'pass', trustedIsolatedScenarios: 'pass', workerWorkflow: 'not_run', cloudRelease: 'not_run' });
      const capabilities = await (await fetch(`${local.report.bridgeUrl}/capabilities`)).json() as { mode: string };
      expect(capabilities.mode).toBe('real-local');
      expect((await fetch(`${local.report.bridgeUrl}/verify`, { method: 'POST', body: '{}' })).status).toBe(400);
      expect((await fetch(`${local.report.bridgeUrl}/capabilities`, { headers: { origin: 'https://hostile.example' } })).status).toBe(403);
      expect(local.report.verification.evidence.every(e => e.provenance === 'runner-verified')).toBe(true);
    } finally { await local.close(); }
  });
});
