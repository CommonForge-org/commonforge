// This file and candidate code execute together in a namespace with no control-plane mounts.
import { createServer } from 'node:http';
import worker from '/candidate/worker.mjs';
const server = createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = new Request('http://fixture' + req.url, { method: req.method, ...(req.method === 'POST' ? { body: Buffer.concat(chunks), headers: { 'content-type': 'application/json' } } : {}) });
    const response = await worker.fetch(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch { res.writeHead(500); res.end('candidate exception'); }
});
// Separate socket handed to the trusted supervisor; no host network exists inside the namespace.
server.listen('/scratch/preview.sock', () => process.stdout.write('READY\n'));
