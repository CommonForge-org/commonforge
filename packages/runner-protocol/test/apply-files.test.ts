// packages/runner-protocol/test/apply-files.test.ts
import { beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { byteWorkMatcher, type ByteWorkMatcher } from './byte-work.js';
import {
  APPLY_FILES_LIMITS,
  CONTENT_EXTENSIONS,
  DEFAULT_LFS_PATTERNS,
  classifyPath,
  defaultGitattributes,
  gitattributesLfsEntry,
  lfsAttributesMatcher,
  lfsEntryFits,
  lfsPointer,
  looksBinary,
  parseLfsPointer,
} from '../src/apply-files.js';

const SHA = 'a'.repeat(64);

describe('LFS pointers', () => {
  it('writes the git-lfs v1 pointer text and parses it back', () => {
    const p = lfsPointer(SHA, 150_000_000);
    expect(p).toBe(`version https://git-lfs.github.com/spec/v1\noid sha256:${SHA}\nsize 150000000\n`);
    expect(parseLfsPointer(p)).toEqual({ sha256: SHA, size: 150_000_000 });
  });
  it('refuses anything that is not exactly a pointer', () => {
    expect(parseLfsPointer('hello\n')).toBeNull();
    expect(parseLfsPointer(lfsPointer(SHA, 1).replace('size 1', 'size 01'))).toBeNull();
    expect(parseLfsPointer(lfsPointer(SHA, 1) + 'extra\n')).toBeNull();
  });
  it('refuses a size beyond Number.MAX_SAFE_INTEGER', () => {
    expect(parseLfsPointer(lfsPointer(SHA, Number.MAX_SAFE_INTEGER))).toEqual({ sha256: SHA, size: Number.MAX_SAFE_INTEGER });
    const huge = `version https://git-lfs.github.com/spec/v1\noid sha256:${SHA}\nsize 9007199254740993\n`;
    expect(parseLfsPointer(huge)).toBeNull();
  });
  it('the limits are the spec values', () => {
    expect(APPLY_FILES_LIMITS).toEqual({ maxOps: 1000, maxFileBytes: 5_000_000_000, maxChangeBytes: 20_000_000_000, maxEditBytes: 1_048_576, maxEditTotalBytes: 16_777_216, maxChangedPaths: 5_000 });
  });
});

describe('binary sniff (git heuristic: NUL in the first 8000 bytes)', () => {
  it('flags a NUL early, not one past 8000 bytes', () => {
    expect(looksBinary(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00]))).toBe(true);
    const late = new Uint8Array(9000).fill(0x61);
    late[8500] = 0;
    expect(looksBinary(late)).toBe(false);
    expect(looksBinary(new TextEncoder().encode('{"a":1}\n'))).toBe(false);
  });
});

describe('classification (spec §7)', () => {
  it('LFS files, PDFs and Office documents are content; everything else is code', () => {
    expect(classifyPath('videos/demo.mp4', true)).toBe('content');
    expect(classifyPath('brief/Plan.PDF', false)).toBe('content');
    expect(classifyPath('docs/deck.pptx', false)).toBe('content');
    expect(classifyPath('src/app.ts', false)).toBe('code');
    expect(classifyPath('config.json', false)).toBe('code');
  });
});

describe('.gitattributes matcher', () => {
  const attrs = [
    '# media',
    '*.mp4 filter=lfs diff=lfs merge=lfs -text',
    'assets/**/*.png filter=lfs diff=lfs merge=lfs -text',
    '/root-only.bin filter=lfs -text',
    'keep.mp4 -filter',
    'docs/ text',
  ].join('\n');
  const isLfs = lfsAttributesMatcher(attrs);
  it('a pattern without a slash matches the file name at any depth', () => {
    expect(isLfs('demo.mp4')).toBe(true);
    expect(isLfs('videos/2026/demo.mp4')).toBe(true);
    expect(isLfs('videos/demo.mp4.txt')).toBe(false);
  });
  it('a pattern with a slash is anchored; ** spans folders', () => {
    expect(isLfs('assets/logo.png')).toBe(true);
    expect(isLfs('assets/a/b/logo.png')).toBe(true);
    expect(isLfs('other/assets/logo.png')).toBe(false);
    expect(isLfs('root-only.bin')).toBe(true);
    expect(isLfs('sub/root-only.bin')).toBe(false);
  });
  it('the last matching line wins; unset/other filters are not LFS; directory patterns match no file', () => {
    expect(isLfs('keep.mp4')).toBe(false);
    expect(isLfs('docs/readme.md')).toBe(false);
  });
  it('an empty file marks nothing', () => {
    expect(lfsAttributesMatcher('')('a.mp4')).toBe(false);
  });
});

describe('.gitattributes exact-path entry', () => {
  it('matches exactly its path, including spaces and glob characters', () => {
    for (const path of ['Demo Videos/Final cut (v2).mov', 'a[1]/b*?.bin', 'x\\y.dat', 'plain.iso']) {
      const entry = gitattributesLfsEntry(path);
      expect(entry.endsWith(' filter=lfs diff=lfs merge=lfs -text')).toBe(true);
      const isLfs = lfsAttributesMatcher(entry);
      expect(isLfs(path)).toBe(true);
      expect(isLfs(`sub/${path}`)).toBe(false);
      expect(isLfs(path.replace(/.$/, 'Z'))).toBe(false);
    }
    expect(gitattributesLfsEntry('Demo Videos/a b.mov')).toBe('/Demo[[:space:]]Videos/a[[:space:]]b.mov filter=lfs diff=lfs merge=lfs -text');
  });
});

// Each row: [.gitattributes text, path, stored in LFS?]. Every row was confirmed against real
// `git check-attr filter` (git 2.54, core.ignorecase=false) in a scratch repository.
// BEGIN-CASES
const GIT_VERIFIED: Array<[string, string, boolean]> = [
  ['**/x filter=lfs', 'x', true],
  ['**/x filter=lfs', 'a/b/x', true],
  ['**/x filter=lfs', 'a/bx', false],
  ['a/** filter=lfs', 'a/b', true],
  ['a/** filter=lfs', 'a/b/c', true],
  ['a/** filter=lfs', 'b/a/c', false],
  ['a/**/b filter=lfs', 'a/b', true],
  ['a/**/b filter=lfs', 'a/x/y/b', true],
  ['a/**/b filter=lfs', 'a/xb', false],
  ['*.mp4 filter=lfs', 'a/b.mp4', true],
  ['a/*/b filter=lfs', 'a/x/b', true],
  ['a/*/b filter=lfs', 'a/x/y/b', false],
  ['*x filter=lfs', 'a/x', true],
  ['/a*b filter=lfs', 'a/b', false],
  ['/a*b filter=lfs', 'aXb', true],
  ['/a?b filter=lfs', 'a/b', false],
  ['file[0-9].bin filter=lfs', 'file7.bin', true],
  ['file[0-9].bin filter=lfs', 'filex.bin', false],
  ['file[!0-9].bin filter=lfs', 'filex.bin', true],
  ['file[!0-9].bin filter=lfs', 'file7.bin', false],
  ['file[^0-9].bin filter=lfs', 'filex.bin', true],
  ['/a[!b]c filter=lfs', 'a/c', false],
  ['/a[^b]c filter=lfs', 'a/c', false],
  ['/a[/]c filter=lfs', 'a/c', false],
  ['/a[a-z/]c filter=lfs', 'a/c', false],
  ['\\*.bin filter=lfs', '*.bin', true],
  ['\\*.bin filter=lfs', 'x.bin', false],
  ['a[\\]]b filter=lfs', 'a]b', true],
  ['a[\\]]b filter=lfs', 'a\\b', false],
  ['a[]]b filter=lfs', 'a]b', true],
  ['a[!]]b filter=lfs', 'axb', true],
  ['a[!]]b filter=lfs', 'a]b', false],
  ['v[[:digit:]] filter=lfs', 'v7', true],
  ['v[[:digit:]] filter=lfs', 'vx', false],
  ['[[:alpha:]] filter=lfs', 'a', true],
  ['[[:alpha:]] filter=lfs', 'é', false],
  ['[[:alnum:]] filter=lfs', '7', true],
  ['[[:blank:]] filter=lfs', ' ', true],
  ['x[[:blank:]]y filter=lfs', 'x\ny', false],
  ['[[:cntrl:]] filter=lfs', '\u0001', true],
  ['[[:graph:]] filter=lfs', '!', true],
  ['[[:graph:]] filter=lfs', ' ', false],
  ['[[:lower:]] filter=lfs', 'a', true],
  ['[[:lower:]] filter=lfs', 'A', false],
  ['[[:print:]] filter=lfs', ' ', true],
  ['[[:punct:]] filter=lfs', '!', true],
  ['[[:punct:]] filter=lfs', 'a', false],
  ['[[:upper:]] filter=lfs', 'A', true],
  ['[[:xdigit:]] filter=lfs', 'f', true],
  ['[[:xdigit:]] filter=lfs', 'g', false],
  ['x[[:space:]]y filter=lfs', 'x y', true],
  ['x[[:space:]]y filter=lfs', 'x\ny', true],
  ['x[[:space:]]y filter=lfs', 'x\ry', true],
  ['x[[:space:]]y filter=lfs', 'x\u000by', false],
  ['x[[:space:]]y filter=lfs', 'x y', false],
  ['x[[:bogus:]]y filter=lfs', 'xay', false],
  ['x[[:alpha:]y filter=lfs', 'xay', false],
  ['a[b filter=lfs', 'a[b', false],
  ['a\\ filter=lfs', 'a\\', false],
  ['a\\ filter=lfs', 'a', false],
  ['!*.mp4 filter=lfs', 'a.mp4', false],
  ['!*.mp4 filter=lfs', '!a.mp4', false],
  ['\\!a.mp4 filter=lfs', '!a.mp4', true],
  ['*.mp4 -filter', 'a.mp4', false],
  ['*.mp4 filter=lfs\n*.mp4 -filter', 'a.mp4', false],
  ['*.mp4 filter=lfs\n*.mp4 !filter', 'a.mp4', false],
  ['*.mp4 filter=lfs\n*.mp4 filter', 'a.mp4', false],
  ['*.mp4 filter=lfs\n*.mp4 filter=other', 'a.mp4', false],
  ['*.mp4 filter=other\n*.mp4 filter=lfs', 'a.mp4', true],
  ['*.mp4 filter=lfs -filter', 'a.mp4', false],
  ['*.mp4 -filter filter=lfs', 'a.mp4', true],
  ['*.mp4 -filter=lfs', 'a.mp4', false],
  ['*.mp4 filter=lfs bad/name', 'a.mp4', false],
  ['*.mp4 filter=lfs diff=lfs merge=lfs -text', 'a.mp4', true],
  ['dir/ filter=lfs', 'dir/a.mp4', false],
  ['dir/ filter=lfs', 'dir', false],
  ['*.mp4 filter=lfs', 'a.mp4', false],
  ['*.mp4 filter=lfs\r', 'a.mp4', true],
  ['*.mp4\tfilter=lfs', 'a.mp4', true],
  ['a\u000bb filter=lfs', 'a\u000bb', true],
  ['﻿*.mp4 filter=lfs', 'a.mp4', true],
  ['?.bin filter=lfs', 'é.bin', false],
  ['??.bin filter=lfs', 'é.bin', true],
  ['é.bin filter=lfs', 'é.bin', true],
  ['[ab]/* filter=lfs', 'a/x', true],
];
// END-CASES

describe('.gitattributes matcher agrees with git check-attr', () => {
  it.each(GIT_VERIFIED)('%j  %j -> %s', (attrs, path, expected) => {
    expect(lfsAttributesMatcher(attrs + '\n')(path)).toBe(expected);
  });
});

describe('.gitattributes matcher is safe on hostile input', () => {
  const hostile = [
    `${'*a'.repeat(8)}*b`,
    '*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*b',
    '*?*?*?*?*?*?*?*?*?*?*?*?x',
    '**/*a**/*a**/*a**/*a**/*b',
    '/*a/*a/*a/*a/*b',
    '*[a]*[a]*[a]*[a]*[a]*[a]*[a]*b',
    `${'*a'.repeat(1000)}*b`,
    `${'*?'.repeat(1000)}x`,
    `${'**/*a'.repeat(400)}b`,
  ];
  const names = ['a'.repeat(255), 'a/'.repeat(127) + 'a', 'ab'.repeat(127) + 'a', 'a'.repeat(4096)];
  const cases = hostile.flatMap((pattern) => names.map((name) => ({ pattern, name })));
  let work: ByteWorkMatcher;
  beforeAll(async () => { work = await byteWorkMatcher(new URL('../src/apply-files.ts', import.meta.url)); });

  it('counts reads of every encoded array, including nested and out-of-bounds reads', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'cforge-byte-work-coverage-'));
    try {
      const fixture = join(scratch, 'fixture.ts');
      await writeFile(fixture, `
        export function lfsAttributesMatcher(attributes: string) {
          const pattern = new TextEncoder().encode(attributes);
          return (name: string) => {
            const arrays = [pattern, new TextEncoder().encode(name)];
            return arrays[0].length + arrays[1].length + arrays[0][0] + arrays[1][0] + (arrays[1][99] ?? 0) === 196;
          };
        }
      `);
      const probe = await byteWorkMatcher(pathToFileURL(fixture));
      const match = probe.matcher('a');
      probe.resetBudget(5);
      expect(match('a')).toBe(true);
      expect(probe.reads()).toBe(5);
      probe.resetBudget(4);
      expect(() => match('a')).toThrow('wildmatch byte work exceeded 4');
      expect(probe.reads()).toBe(5);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it('instrumented source preserves every Git-verified matcher result', () => {
    work.resetBudget(Infinity);
    for (const [attributes, name, expected] of GIT_VERIFIED) {
      expect(work.matcher(attributes + '\n')(name), `${attributes} / ${name}`).toBe(expected);
    }
  });

  it('interrupts matching immediately when the byte budget is exhausted', () => {
    work.resetBudget(Infinity);
    const match = work.matcher('*a*a*b filter=lfs');
    work.resetBudget(1);
    expect(() => match('a'.repeat(255))).toThrow('wildmatch byte work exceeded 1');
    expect(work.reads()).toBe(2);
  });

  it('abort-pruned wildmatch bounds byte work for every hostile pattern/name pair', { timeout: 60_000 }, () => {
    for (const { pattern, name } of cases) {
      // These rejecting cases rescan suffixes: quadratic work is expected, exponential
      // backtracking across repeated stars is not. Allow eight byte/length/branch probes
      // per possible input byte pair; (pattern + name + 1)^2 also covers suffix pairs.
      // This corpus bound is independent of CPU speed and scheduler pauses, and the counter
      // interrupts excessive work immediately rather than waiting for the call to return.
      const budget = 8 * (Buffer.byteLength(pattern) + Buffer.byteLength(name) + 1) ** 2;
      work.resetBudget(budget);
      expect(work.matcher(`${pattern} filter=lfs`)(name), `${pattern.length}/${name.length}`).toBe(false);
      expect(work.reads()).toBeGreaterThan(0);
      expect(work.reads()).toBeLessThanOrEqual(budget);
    }
  });

  it('the uninstrumented hostile corpus completes in a killable child process', { timeout: 30_000 }, async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'cforge-wildmatch-'));
    const exec = promisify(execFile);
    const source = fileURLToPath(new URL('../src/apply-files.ts', import.meta.url));
    const tsc = fileURLToPath(new URL('../node_modules/.bin/tsc', import.meta.url));
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin' };
    try {
      // Compile the current source, rather than relying on a possibly stale dist artifact or
      // Node's version-specific TypeScript stripping support. TypeScript is already a dev dependency.
      await exec(tsc, ['--ignoreConfig', '--target', 'ES2023', '--module', 'ESNext', '--moduleResolution', 'Bundler', '--skipLibCheck', '--outDir', scratch, source], { env, timeout: 10_000 });
      const modulePath = join(scratch, 'apply-files.mjs');
      await rename(join(scratch, 'apply-files.js'), modulePath);
      const script = `
        const { lfsAttributesMatcher } = await import(process.argv[1]);
        const cases = JSON.parse(process.argv[2]);
        for (const { pattern, name } of cases) {
          if (lfsAttributesMatcher(pattern + ' filter=lfs')(name) !== false) throw new Error('hostile pattern unexpectedly matched');
        }
        process.stdout.write(String(cases.length));
      `;
      // This is a termination tripwire, not a microbenchmark. A hung matcher is SIGKILLed
      // without blocking Vitest's own event loop; deterministic work bounds are tested above.
      const result = await exec(process.execPath, ['--input-type=module', '-e', script, pathToFileURL(modulePath).href, JSON.stringify(cases)], { env, timeout: 5_000, killSignal: 'SIGKILL' });
      expect(result.stdout).toBe(String(cases.length));
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
  // Confirmed against git 2.54: a line of 2,047 bytes (not counting the newline or one trailing CR)
  // is honoured, 2,048 is ignored with a warning; the limit is in bytes, not characters.
  it('ignores a line of 2,048 bytes or more, exactly as git does', () => {
    const rule = (pad: number, tail = '') => `${'a'.repeat(pad)} filter=lfs${tail}`;
    const name = (pad: number) => 'a'.repeat(pad);
    expect(rule(2036)).toHaveLength(2047);
    expect(lfsAttributesMatcher(rule(2036))(name(2036))).toBe(true);
    expect(lfsAttributesMatcher(rule(2037))(name(2037))).toBe(false);
    expect(lfsAttributesMatcher(rule(2036, '\r'))(name(2036))).toBe(true); // one CR is not counted
    expect(lfsAttributesMatcher(rule(2037, '\r'))(name(2037))).toBe(false);
    expect(lfsAttributesMatcher(rule(2036, '\r\r'))(name(2036))).toBe(false);
    const wide = (n: number) => 'é'.repeat(n); // 2 bytes each
    expect(lfsAttributesMatcher(`${wide(1018)} filter=lfs`)(wide(1018))).toBe(true); // 2,047 bytes
    expect(lfsAttributesMatcher(`${wide(1019)} filter=lfs`)(wide(1019))).toBe(false); // 2,049 bytes
  });
  it('a long exact entry (about 2,000 bytes) still matches its path', () => {
    const path = `${'d/'.repeat(950)}f.bin`;
    expect(lfsAttributesMatcher(gitattributesLfsEntry(path))(path)).toBe(true);
  });
});

describe('lfsEntryFits', () => {
  it('is true exactly when git reads the exact entry (under 2,048 bytes)', () => {
    const spaced = `${'A B C D E F G H/'.repeat(25)}x.mov`; // 405 characters, a 2,192-byte entry
    expect(spaced).toHaveLength(405);
    expect(new TextEncoder().encode(gitattributesLfsEntry(spaced)).length).toBe(2192);
    expect(lfsEntryFits(spaced)).toBe(false);
    expect(lfsAttributesMatcher(gitattributesLfsEntry(spaced))(spaced)).toBe(false);
    expect(lfsEntryFits('Demo Videos/final cut.mov')).toBe(true);
    // the boundary, in bytes (CJK: 3 bytes per character)
    const overhead = new TextEncoder().encode(gitattributesLfsEntry('')).length;
    const fits = 'x'.repeat(2047 - overhead);
    expect(lfsEntryFits(fits)).toBe(true);
    expect(lfsAttributesMatcher(gitattributesLfsEntry(fits))(fits)).toBe(true);
    expect(lfsEntryFits(`${fits}x`)).toBe(false);
    const cjk = '動'.repeat(Math.floor((2047 - overhead) / 3));
    expect(lfsEntryFits(cjk)).toBe(true);
    expect(lfsEntryFits(`${cjk}動`)).toBe(false);
  });
});

describe('.gitattributes exact-path entry, special characters', () => {
  it('rewrites line breaks as [[:space:]] so the entry stays on one line', () => {
    const path = 'dir/a\nb\r\nc\td e.bin';
    const entry = gitattributesLfsEntry(path);
    expect(entry).toBe('/dir/a[[:space:]]b[[:space:]][[:space:]]c[[:space:]]d[[:space:]]e.bin filter=lfs diff=lfs merge=lfs -text');
    expect(entry.split('\n')).toHaveLength(1);
    expect(lfsAttributesMatcher(entry)(path)).toBe(true);
    expect(lfsAttributesMatcher(entry)('dir/aXb\r\nc\td e.bin')).toBe(false);
  });
  it('is exact for paths with #, !, quotes and non-ASCII (confirmed against git check-attr)', () => {
    for (const path of ['#hash.bin', '!bang.bin', '"quoted".bin', 'café/é.mov', 'a#b/c!d"e.bin']) {
      const isLfs = lfsAttributesMatcher(gitattributesLfsEntry(path));
      expect(isLfs(path)).toBe(true);
      expect(isLfs(`sub/${path}`)).toBe(false);
      expect(isLfs(`${path}Z`)).toBe(false);
    }
  });
});

describe('default .gitattributes of a new folder (phase 4)', () => {
  it('is stable text: one comment line, then one LFS line per default pattern, in order', () => {
    const text = defaultGitattributes();
    expect(defaultGitattributes()).toBe(text);
    const lines = text.split('\n');
    expect(lines.pop()).toBe(''); // ends with a newline
    expect(lines[0]).toMatch(/^# /);
    expect(lines.slice(1)).toEqual(DEFAULT_LFS_PATTERNS.map((p) => `${p} filter=lfs diff=lfs merge=lfs -text`));
    expect(DEFAULT_LFS_PATTERNS.slice(0, 2)).toEqual(['*.mp4', '*.mov']);
    for (const ext of CONTENT_EXTENSIONS) expect(DEFAULT_LFS_PATTERNS).toContain(`*.${ext}`);
    expect(new Set(DEFAULT_LFS_PATTERNS).size).toBe(DEFAULT_LFS_PATTERNS.length);
    for (const p of DEFAULT_LFS_PATTERNS) expect(p).toBe(p.toLowerCase());
  });
  it('stores media, documents, fonts and archives in LFS; not text, code or the platform files', () => {
    const isLfs = lfsAttributesMatcher(defaultGitattributes());
    for (const path of ['a/b.mp4', 'x.pdf', 'deck.pptx', 'font.woff2', 'x.tar', 'photos/IMG_1.heic', 'b.tgz']) expect(isLfs(path)).toBe(true);
    for (const path of ['README.md', '.lfsconfig', '.gitattributes', 'logo.svg', 'src/app.ts', 'x.JPG']) expect(isLfs(path)).toBe(false);
  });
});
