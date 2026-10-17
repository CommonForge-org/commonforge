import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { startLocalPreview } from '../src/g1-local-preview.js';
it('serves a real API module in namespaces with no candidate-controlled supervisor or network', async () => {
  const preview = await startLocalPreview({ key: 'local-preview-auth-key' });
  try {
    const module = (await readFile(new URL('../../../fixtures/scheduling/worker.mjs', import.meta.url))).toString('base64');
    const response = await fetch(`${preview.url}/serve`, { method: 'POST', headers: { authorization: 'Bearer local-preview-auth-key', 'content-type': 'application/json' }, body: JSON.stringify({ module, path: '/reschedule', method: 'POST', body: JSON.stringify({ actor: 'manager', appointment: '2026-10-17T13:00:00.000Z', reason: 'Preview emergency' }) }) });
    expect(response.status).toBe(200);
    const result = await response.json() as { status: number; body: string };
    expect(result.status).toBe(200);
    expect(JSON.parse(Buffer.from(result.body,'base64').toString('utf8'))).toMatchObject({ allowed: true, override: { actor: 'manager', reason: 'Preview emergency' } });
    expect((await fetch(`${preview.url}/serve`, { method: 'POST', body: '{}' })).status).toBe(403);
  } finally { await preview.close(); }
});
