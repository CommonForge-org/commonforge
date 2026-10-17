import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { verifySchedulingCandidate } from '../src/g1-local-verifier.js';
const dirs: string[] = [];
afterAll(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); });
async function candidate(source: string) { const d = await mkdtemp(join(tmpdir(), 'commonforge-g1-test-')); dirs.push(d); await writeFile(join(d, 'worker.mjs'), source); return d; }
const fixture = new URL('../../../fixtures/scheduling/worker.mjs', import.meta.url);

describe('trusted real scheduling verifier', () => {
  it('executes HTTP behavior across the exact cutoff, travel and retained manager reason', async () => {
    const r = await verifySchedulingCandidate(await candidate(await readFile(fixture, 'utf8')));
    expect(r.results).toHaveLength(9);
    expect(r.results.every((r) => r.result === 'pass')).toBe(true);
    expect(r).toMatchObject({ network: 'none', controlPlaneMounted: false });
  });
  it('candidate-owned tests cannot weaken the independently pinned harness', async () => {
    const d = await candidate('export default { fetch() { return Response.json({allowed:true,override:null}); } };');
    await writeFile(join(d, 'test.mjs'), 'process.exit(0)');
    const r = await verifySchedulingCandidate(d);
    expect(r.results.some((r) => r.result === 'fail')).toBe(true);
  });
  it('candidate cannot read a controlling-instance secret or reach its network', async () => {
    const secretDir = await mkdtemp(join(tmpdir(), 'commonforge-control-')); dirs.push(secretDir);
    const secret = join(secretDir, 'supervisor-key'); await writeFile(secret, 'must-not-be-readable');
    const source = `import {existsSync} from 'node:fs';\nimport {networkInterfaces} from 'node:os';\nconst isolated = !existsSync(${JSON.stringify(secret)}) && !Object.values(networkInterfaces()).flat().some(x => x && !x.internal);\n${await readFile(fixture, 'utf8')}`.replace('return Response.json(reschedule(await request.json()))', "return Response.json(isolated ? reschedule(await request.json()) : {allowed:false,code:'isolation_broken'})");
    const r = await verifySchedulingCandidate(await candidate(source));
    expect(r.results.every((r) => r.result === 'pass')).toBe(true);
  });
});
