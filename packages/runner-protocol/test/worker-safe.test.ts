import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from '../src/index.js';

const SRC = join(import.meta.dirname, '..', 'src');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

describe('Worker safety of the main entry', () => {
  it('exports its package name', () => {
    expect(PACKAGE_NAME).toBe('@commonforge-org/runner-protocol');
  });

  it('no module outside src/node imports node builtins or uses Node globals', () => {
    const main = files(SRC).filter((f) => !relative(SRC, f).startsWith('node/'));
    expect(main.length).toBeGreaterThan(5);
    for (const f of main) {
      const code = readFileSync(f, 'utf8');
      expect(code, f).not.toMatch(/from\s+['"]node:|require\(|\bBuffer\b|\bprocess\./);
      expect(code, f).not.toMatch(/from\s+['"]\.{1,2}\/node\//);
    }
  });
});
