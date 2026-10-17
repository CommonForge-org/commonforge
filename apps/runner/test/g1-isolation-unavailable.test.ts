/** Explicit spawn failure double: verifies refusal classification, not real namespace behavior. */
import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
vi.mock('node:child_process', async () => {
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  return { spawn: () => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), exitCode:null, signalCode:null, pid:undefined });
    queueMicrotask(()=>child.emit('error',new Error('isolation unavailable')));
    return child;
  } };
});
import { verifySchedulingCandidate } from '../src/g1-local-verifier.js';
describe('unavailable isolation refusal',()=>{
  it('throws instead of fabricating signed scenario execution and cleans up without an exit event',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'cf-no-isolation-'));
    try {await writeFile(join(dir,'worker.mjs'),'export default {};');await expect(verifySchedulingCandidate(dir)).rejects.toThrow('isolation unavailable');}
    finally {await rm(dir,{recursive:true,force:true});}
  });
});
