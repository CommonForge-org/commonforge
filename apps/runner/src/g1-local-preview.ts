/** Narrow standalone-module preview backend. No source-provider/control-plane authority. */
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requestIsolatedCandidate } from './g1-local-verifier.js';
export async function startLocalPreview(options: { key: string; port?: number }) {
  const server = createServer((req, res) => { void (async () => {
    if (req.method !== 'POST' || req.url !== '/serve' || req.headers.origin || req.headers.authorization !== `Bearer ${options.key}`) { res.writeHead(403); res.end(); return; }
    let size = 0; const chunks: Buffer[] = []; for await (const chunk of req) { size += (chunk as Buffer).length; if (size > 1600000) throw new Error('preview too large'); chunks.push(chunk as Buffer); }
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { module: string; path: string; method: string; body?: string };
    if (typeof input.module !== 'string' || input.module.length > 1400000 || typeof input.path !== 'string' || typeof input.method !== 'string' || (input.body !== undefined && (typeof input.body !== 'string' || input.body.length > 65536))) throw new Error('invalid preview request');
    const root = await mkdtemp(join(tmpdir(), 'g1-preview-api-'));
    try {
      await writeFile(join(root, 'worker.mjs'), Buffer.from(input.module, 'base64'), { mode: 0o400 });
      const response = await requestIsolatedCandidate(root, input.path, input.method, input.body);
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(response));
    } finally { await rm(root, { recursive: true, force: true }); }
  })().catch(() => { if (!res.headersSent) { res.writeHead(503); res.end('isolated local preview unavailable'); } }); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 0, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${(server.address() as { port:number }).port}`, close: () => new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())) };
}
