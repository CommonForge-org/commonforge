/** Real Linux verifier. The supervisor owns scenarios; only candidate code enters the sandbox. */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cases } from './g1-scheduling-harness.js';

export interface LocalScenarioResult { scenarioId: string; result: 'pass' | 'fail' | 'error'; detail: string }
export interface LocalVerification {
  verifierDigest: string;
  sourceDigest: string;
  execution: 'bubblewrap-linux-http';
  network: 'none';
  controlPlaneMounted: false;
  results: LocalScenarioResult[];
}

const hostPath = fileURLToPath(new URL('../src/g1-candidate-host.mjs', import.meta.url));
export async function schedulingVerifierDigest(): Promise<string> {
  // Bind the supervisor's comparison, isolation and timeout logic too, not just the examples.
  // Source-mode and compiled supervisors intentionally have different verifier definitions.
  return createHash('sha256').update('cf.scheduling-verifier/2\0').update(JSON.stringify(cases))
    .update(await readFile(hostPath)).update(await readFile(new URL(import.meta.url))).digest('hex');
}

interface SocketResponse { status: number; headers: Record<string,string>; body: string }
function socketResponse(socketPath: string, path: string, method: string, body?: string): Promise<SocketResponse> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method, headers: { 'content-type': 'application/json' }, timeout: 2000 }, (res) => {
      const chunks: Buffer[] = []; let bytes = 0;
      res.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 64 * 1024) res.destroy(new Error('response too large')); else chunks.push(chunk); });
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode ?? 500, headers: Object.fromEntries(Object.entries(res.headers).filter((e): e is [string,string] => typeof e[1] === 'string')), body: Buffer.concat(chunks).toString('base64') }));
    });
    req.on('timeout', () => req.destroy(new Error('candidate timeout'))); req.on('error', reject);
    req.end(method === 'GET' ? undefined : body);
  });
}
async function socketRequest(socketPath: string, body: unknown, path = '/reschedule', method = 'POST'): Promise<unknown> {
  const response = await socketResponse(socketPath, path, method, JSON.stringify(body));
  if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
  return JSON.parse(Buffer.from(response.body,'base64').toString('utf8'));
}

/** No unsafe fallback. Missing namespaces/bwrap is an unavailable environmental check. */
async function withCandidateSandbox<T>(candidateDir: string, observe: (socketPath: string, sourceDigest: string) => Promise<T>): Promise<T> {
  const dir = await realpath(candidateDir);
  const worker = join(dir, 'worker.mjs');
  const handle = await open(worker, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024) throw new Error('candidate worker must be a bounded plain file');
    bytes = await handle.readFile();
    if (bytes.length > 1024 * 1024) throw new Error('candidate grew beyond size bound');
  } finally { await handle.close(); }
  const sourceDigest = createHash('sha256').update(bytes).digest('hex');
  const scratch = await mkdtemp(join(tmpdir(), 'commonforge-g1-sandbox-'));
  await chmod(scratch, 0o700);
  const snapshot = join(scratch, 'worker.mjs');
  const socketDir = join(scratch, 'socket');
  await writeFile(snapshot, bytes, { mode: 0o400 });
  await mkdir(socketDir, { mode: 0o700 });
  const node = await realpath(process.execPath);
  const child = spawn('bwrap', [
    '--unshare-all', '--die-with-parent', '--new-session', '--cap-drop', 'ALL',
    '--ro-bind', '/usr', '/usr', '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64',
    '--ro-bind', node, '/node', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
    '--ro-bind', snapshot, '/candidate/worker.mjs', '--ro-bind', hostPath, '/host.mjs',
    '--bind', socketDir, '/scratch', '--chdir', '/candidate', '/node', '/host.mjs',
  ], { env: { PATH: '/usr/bin:/bin', HOME: '/tmp', TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let stderr = '';
  child.stderr.on('data', (b: Buffer) => { stderr = (stderr + b.toString()).slice(-2000); });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('candidate startup timed out')), 5000);
      child.once('error', (e) => { clearTimeout(timer); reject(e); });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`candidate exited ${code}: ${stderr}`)); });
      child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
    });
    return await observe(join(socketDir, 'preview.sock'), sourceDigest);
  } finally {
    try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already exited */ }
    if (child.exitCode === null && child.signalCode === null) await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function verifySchedulingCandidate(candidateDir: string): Promise<LocalVerification> {
  return withCandidateSandbox(candidateDir, async (socketPath, sourceDigest) => {
    const results: LocalScenarioResult[] = [];
    for (const [scenarioId, input, expected] of cases) {
      try {
        const actual = await socketRequest(socketPath, { now: '2026-10-17T12:00:00.000Z', ...input });
        const same = JSON.stringify(actual) === JSON.stringify(expected);
        results.push({ scenarioId, result: same ? 'pass' : 'fail', detail: same ? 'expected HTTP behavior observed' : 'HTTP response differs from trusted expectation' });
      } catch { results.push({ scenarioId, result: 'error', detail: 'candidate HTTP request failed' }); }
    }
    return { verifierDigest: await schedulingVerifierDigest(), sourceDigest, execution: 'bubblewrap-linux-http', network: 'none', controlPlaneMounted: false, results };
  });
}

/** Supplemental real HTTP observation; does not claim to replace signed required scenarios. */
export async function inspectIsolatedHealth(candidateDir: string): Promise<unknown> {
  return withCandidateSandbox(candidateDir, socket => socketRequest(socket, undefined, '/health', 'GET'));
}

/** One bounded real preview HTTP request in a fresh isolated candidate process. */
export async function requestIsolatedCandidate(candidateDir: string, path: string, method: string, body?: string): Promise<SocketResponse> {
  if (!['GET','POST'].includes(method) || !path.startsWith('/') || /[\r\n\0]/.test(path) || path.length > 2048) throw new Error('unsupported preview request');
  return withCandidateSandbox(candidateDir, socket => socketResponse(socket, path, method, body));
}
