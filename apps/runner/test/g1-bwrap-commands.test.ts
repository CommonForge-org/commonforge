import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { localNamespaceCommands } from '../src/g1-bwrap-commands.js';
import { runIsolated } from '../src/commands.js';
it('real runner Node entrypoints cannot read controller state or reach host networking', async () => {
  const root = await mkdtemp(join(tmpdir(), 'g1-command-boundary-'));
  try {
    const candidate = join(root, 'candidate'); await mkdir(candidate);
    const secret = join(root, 'controller-key'); await writeFile(secret, 'controller must remain isolated');
    const commands = await localNamespaceCommands(join(root, 'bin'));
    await writeFile(join(candidate, 'test.mjs'), `import {existsSync,writeFileSync} from 'node:fs'; import {networkInterfaces} from 'node:os'; if (existsSync(${JSON.stringify(secret)}) || Object.values(networkInterfaces()).flat().some(x=>x&&!x.internal)) process.exit(1); writeFileSync('passed.txt','isolated');`);
    const result = await runIsolated({ argv: [join(root, 'bin/node'), 'test.mjs'], cwd: candidate, env: { PATH: commands.path!, HOME: '/tmp' }, timeoutMs: 5000 });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(commands.allowlist).toEqual([['node', '{path}', '{args*}']]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
