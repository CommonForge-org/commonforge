import { describe, expect, it } from 'vitest';
import { PathPolicyError } from './errors.js';
import {
  checkEntry,
  checkPath,
  findCaseFoldCollisions,
  isNormalizedPath,
  isWithinPrefix,
  matchesPathPattern,
  normalizePath,
} from './path-policy.js';

describe('normalizePath', () => {
  it('NFC-normalizes', () => {
    const decomposed = 'cafe\u0301/menu.md';
    expect(normalizePath(decomposed)).toBe('caf\u00e9/menu.md');
    expect(normalizePath(decomposed)).toBe(normalizePath('caf\u00e9/menu.md'));
  });
  it('collapses empty and "." segments and trailing slashes', () => {
    expect(normalizePath('./a//b/./c/')).toBe('a/b/c');
  });
  it.each([
    ['../x', 'dot_dot'],
    ['a/../b', 'dot_dot'],
    ['a/..', 'dot_dot'],
    ['/etc/passwd', 'absolute'],
    ['a\\b', 'backslash'],
    ['..\\x', 'backslash'],
    ['a\0b', 'nul'],
    ['a\nb', 'control_char'],
    ['C:/x', 'drive_letter'],
    ['', 'empty'],
    ['./', 'empty'],
  ] as const)('rejects %j as %s', (input, violation) => {
    expect(checkPath(input)).toEqual({ ok: false, violation });
    try {
      normalizePath(input);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(PathPolicyError);
      expect((e as PathPolicyError).violation).toBe(violation);
      expect((e as PathPolicyError).code).toBe('invalid_path');
    }
  });
  it('allows "..." and dotfiles (not traversal)', () => {
    expect(normalizePath('a/.../.env')).toBe('a/.../.env');
  });
  it('case-folds when asked', () => {
    expect(normalizePath('Src/README.md', { caseFold: true })).toBe('src/readme.md');
  });
  it('allowEmpty permits the root', () => {
    expect(normalizePath('.', { allowEmpty: true })).toBe('');
  });
  it('isNormalizedPath', () => {
    expect(isNormalizedPath('a/b')).toBe(true);
    expect(isNormalizedPath('a//b')).toBe(false);
    expect(isNormalizedPath('cafe\u0301')).toBe(false);
  });
});

describe('findCaseFoldCollisions', () => {
  it('reports case and NFC collisions, nothing else', () => {
    expect(findCaseFoldCollisions(['README.md', 'readme.MD', 'src/a.ts', 'src/b.ts', 'caf\u00e9', 'CAFE\u0301'])).toEqual([
      ['CAFE\u0301', 'caf\u00e9'],
      ['README.md', 'readme.MD'],
    ]);
    expect(findCaseFoldCollisions(['a', 'b'])).toEqual([]);
  });
});

describe('isWithinPrefix / matchesPathPattern', () => {
  it('is segment-aware', () => {
    expect(isWithinPrefix('src/a.ts', 'src')).toBe(true);
    expect(isWithinPrefix('src', 'src')).toBe(true);
    expect(isWithinPrefix('srcx/a.ts', 'src')).toBe(false);
    expect(isWithinPrefix('anything', '')).toBe(true);
  });
  it('globs', () => {
    expect(matchesPathPattern('package.json', 'package.json')).toBe(true);
    expect(matchesPathPattern('.github/workflows/ci.yml', '.github/workflows')).toBe(true);
    expect(matchesPathPattern('apps/web/.env.local', '**/.env*')).toBe(true);
    expect(matchesPathPattern('.env', '**/.env*')).toBe(true);
    expect(matchesPathPattern('src/auth/login.ts', 'src/*/login.ts')).toBe(true);
    expect(matchesPathPattern('src/a/b/login.ts', 'src/*/login.ts')).toBe(false);
    expect(matchesPathPattern('src/index.ts', '**/*.sql')).toBe(false);
  });
});

describe('checkEntry (symlink flags)', () => {
  it('rejects symlinks and submodules by type or git mode', () => {
    expect(checkEntry({ path: 'a', type: 'symlink' })).toEqual({ ok: false, violation: 'symlink' });
    expect(checkEntry({ path: 'a', type: 'file', mode: '120000' })).toEqual({ ok: false, violation: 'symlink' });
    expect(checkEntry({ path: 'a', type: 'submodule' })).toEqual({ ok: false, violation: 'submodule' });
    expect(checkEntry({ path: 'a', type: 'symlink' }, { allowSymlinks: true })).toEqual({ ok: true, path: 'a' });
    expect(checkEntry({ path: '../a', type: 'file' })).toEqual({ ok: false, violation: 'dot_dot' });
    expect(checkEntry({ path: 'x/./y', type: 'file', mode: '100644' })).toEqual({ ok: true, path: 'x/y' });
  });
});
