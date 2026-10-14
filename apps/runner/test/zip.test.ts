import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { readZip, ZipError } from '../src/zip.js';
import { makeZip } from './zip-writer.js';

const LIMITS = { maxFiles: 100, maxTotalBytes: 10 * 1024 * 1024, maxCompressionRatio: 100 };
const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

describe('readZip', () => {
  it('reads stored and deflated entries, skips directories, sorts by path', () => {
    const z = makeZip([
      { name: 'src/', mode: 0o040755 },
      { name: 'src/b.ts', data: 'export const b = 1;\n', method: 8 },
      { name: 'a.txt', data: 'hello\n', method: 0 },
    ]);
    const r = readZip(z, LIMITS);
    expect(r.rejected).toEqual([]);
    expect(r.entries.map((e) => [e.path, Buffer.from(e.data).toString()])).toEqual([
      ['a.txt', 'hello\n'],
      ['src/b.ts', 'export const b = 1;\n'],
    ]);
  });

  it('rejects traversal, absolute, backslash, symlink, special, duplicate and case-colliding entries', () => {
    const z = makeZip([
      { name: '../evil.txt', data: 'x' },
      { name: 'a/../../evil2.txt', data: 'x' },
      { name: '/etc/passwd', data: 'x' },
      { name: 'C:/win.txt', data: 'x' },
      { name: 'back\\slash.txt', data: 'x' },
      { name: 'link', data: '/etc/passwd', mode: 0o120777 },
      { name: 'fifo', data: '', mode: 0o010644 },
      { name: 'ok.txt', data: 'ok' },
      { name: './ok.txt', data: 'dup' },
      { name: 'OK.TXT', data: 'case' },
    ]);
    const r = readZip(z, LIMITS);
    expect(r.entries.map((e) => e.path)).toEqual(['ok.txt']);
    expect(r.rejected).toEqual([
      { path: '../evil.txt', reason: 'path_escape' },
      { path: 'a/../../evil2.txt', reason: 'path_escape' },
      { path: '/etc/passwd', reason: 'path_escape' },
      { path: 'C:/win.txt', reason: 'path_escape' },
      { path: 'back\\slash.txt', reason: 'invalid_path' },
      { path: 'link', reason: 'symlink' },
      { path: 'fifo', reason: 'special_file' },
      { path: './ok.txt', reason: 'duplicate' },
      { path: 'OK.TXT', reason: 'case_collision' },
    ]);
  });

  it('refuses zip bombs: per-entry ratio, overall ratio, total size, file count', () => {
    const big = new Uint8Array(5 * 1024 * 1024); // zeros: ~1000x compression
    const r = readZip(makeZip([{ name: 'bomb.bin', data: big }, { name: 'ok.txt', data: 'ok' }]), LIMITS);
    expect(r.rejected).toEqual([{ path: 'bomb.bin', reason: 'ratio_exceeded' }]);
    expect(r.entries.map((e) => e.path)).toEqual(['ok.txt']);
    expect(() => readZip(makeZip([{ name: 'a', data: big }]), { ...LIMITS, maxCompressionRatio: 10_000, maxTotalBytes: 1024 })).toThrow(expect.objectContaining({ reason: 'too_large' }));
    // many small bombs: every one refused, nothing inflated
    const chunk = new Uint8Array(20_000).fill(65);
    const many = readZip(makeZip(Array.from({ length: 30 }, (_, i) => ({ name: `f${i}.txt`, data: chunk }))), { ...LIMITS, maxCompressionRatio: 60 });
    expect(many.entries).toEqual([]);
    expect(new Set(many.rejected.map((x) => x.reason))).toEqual(new Set(['ratio_exceeded']));
    expect(() => readZip(makeZip(Array.from({ length: 5 }, (_, i) => ({ name: `f${i}`, data: 'x' }))), { ...LIMITS, maxFiles: 4 })).toThrow(expect.objectContaining({ reason: 'too_many_files' }));
  });

  it('refuses lying headers: understated size, bad CRC, garbage', () => {
    const data = new Uint8Array(4000).fill(66);
    expect(() => readZip(makeZip([{ name: 'a', data, usize: 100 }]), LIMITS)).toThrow(ZipError);
    expect(() => readZip(makeZip([{ name: 'a', data: 'abc', crc: 1 }]), LIMITS)).toThrow(/CRC/);
    expect(() => readZip(new Uint8Array(100), LIMITS)).toThrow(ZipError);
    expect(() => readZip(makeZip([{ name: 'a', data: 'x', flags: 0x1 }]), LIMITS)).toThrow(/encrypted/);
  });

  it('reads archives produced by Info-ZIP `zip` (and still rejects their symlinks)', async () => {
    const d = await mkdtemp(join(tmpdir(), 'cf-zip-'));
    dirs.push(d);
    await mkdir(join(d, 'site', 'src'), { recursive: true });
    await writeFile(join(d, 'site', 'index.html'), '<h1>x</h1>\n');
    await writeFile(join(d, 'site', 'src', 'main.ts'), 'console.log(1)\n'.repeat(50));
    await symlink('/etc/passwd', join(d, 'site', 'passwd-link'));
    try {
      await promisify(execFile)('zip', ['-q', '-r', '--symlinks', join(d, 'out.zip'), 'site'], { cwd: d });
    } catch {
      return; // zip(1) not installed: covered by the writer-based tests
    }
    const r = readZip(new Uint8Array(await readFile(join(d, 'out.zip'))), LIMITS);
    expect(r.entries.map((e) => e.path)).toEqual(['site/index.html', 'site/src/main.ts']);
    expect(r.rejected).toEqual([{ path: 'site/passwd-link', reason: 'symlink' }]);
    expect(Buffer.from(r.entries[1]!.data).toString()).toBe('console.log(1)\n'.repeat(50));
  });
});
