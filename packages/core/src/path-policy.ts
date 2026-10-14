/**
 * Shared path policy (plan §B.13, §F "Path/symlink attacks").
 *
 * All resource-relative paths in CommonForge are POSIX-style, relative, NFC-normalized, with no
 * `..` segments. Used by edition mapping, task-scope checks, intake and materialization verification.
 */
import { PathPolicyError, type PathViolation } from './errors.js';

export interface NormalizePathOptions {
  /** Lower-case the result (Unicode default case folding via `toLowerCase` after NFC). */
  caseFold?: boolean;
  /** Allow the empty path (resource root). Default false. */
  allowEmpty?: boolean;
  /** Maximum length in UTF-16 code units after normalization. Default 4096. */
  maxLength?: number;
}

export type PathCheckResult = { ok: true; path: string } | { ok: false; violation: PathViolation };

// C0 controls (except NUL handled separately) and DEL.
const CONTROL_RE = /[\u0001-\u001f\u007f]/;
const DRIVE_RE = /^[A-Za-z]:/;

/**
 * Non-throwing form of {@link normalizePath}.
 *
 * Rules, in order: NUL → `nul`; other C0/DEL → `control_char`; `\` → `backslash`;
 * leading `/` → `absolute`; `X:` prefix → `drive_letter`; NFC; split on `/`, drop empty and `.`
 * segments; any `..` segment → `dot_dot`; empty result → `empty` unless allowed.
 */
export function checkPath(input: string, options: NormalizePathOptions = {}): PathCheckResult {
  if (input.includes('\0')) return { ok: false, violation: 'nul' };
  if (CONTROL_RE.test(input)) return { ok: false, violation: 'control_char' };
  if (input.includes('\\')) return { ok: false, violation: 'backslash' };
  if (input.startsWith('/')) return { ok: false, violation: 'absolute' };
  if (DRIVE_RE.test(input)) return { ok: false, violation: 'drive_letter' };
  const nfc = input.normalize('NFC');
  const segments: string[] = [];
  for (const seg of nfc.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') return { ok: false, violation: 'dot_dot' };
    segments.push(seg);
  }
  let path = segments.join('/');
  if (options.caseFold) path = path.toLowerCase();
  if (path === '' && !options.allowEmpty) return { ok: false, violation: 'empty' };
  if (path.length > (options.maxLength ?? 4096)) return { ok: false, violation: 'too_long' };
  return { ok: true, path };
}

/** Normalize a resource-relative path or throw {@link PathPolicyError}. */
export function normalizePath(input: string, options: NormalizePathOptions = {}): string {
  const r = checkPath(input, options);
  if (!r.ok) throw new PathPolicyError(r.violation, input);
  return r.path;
}

/** True when `input` is already in normalized form (no rewriting needed). */
export function isNormalizedPath(input: string, options: Omit<NormalizePathOptions, 'caseFold'> = {}): boolean {
  const r = checkPath(input, options);
  return r.ok && r.path === input;
}

/** Case-fold key used for collision detection. */
export function caseFoldKey(path: string): string {
  return path.normalize('NFC').toLowerCase();
}

/**
 * Groups of distinct paths that collide when case-folded (e.g. `README.md` and `readme.MD`),
 * which would clobber each other on a case-insensitive filesystem. Each group is sorted;
 * groups are sorted by their first member. Paths are compared after NFC normalization, so
 * composed/decomposed spellings of the same name are reported too.
 */
export function findCaseFoldCollisions(paths: Iterable<string>): string[][] {
  const byKey = new Map<string, Set<string>>();
  for (const p of paths) {
    const key = caseFoldKey(p);
    let set = byKey.get(key);
    if (!set) byKey.set(key, (set = new Set()));
    set.add(p);
  }
  const groups: string[][] = [];
  for (const set of byKey.values()) if (set.size > 1) groups.push([...set].sort());
  return groups.sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0));
}

/**
 * Segment-aware prefix test on normalized paths: `isWithinPrefix('src/a.ts', 'src')` is true,
 * `isWithinPrefix('srcx/a.ts', 'src')` is false. The empty prefix contains everything.
 */
export function isWithinPrefix(path: string, prefix: string): boolean {
  if (prefix === '') return true;
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** Join normalized path segments; the result is re-normalized (so it can still throw). */
export function joinPath(...parts: string[]): string {
  return normalizePath(parts.filter((p) => p !== '').join('/'), { allowEmpty: true });
}

/** Git tree entry modes that are not regular files or directories. */
export const GIT_MODE_SYMLINK = '120000';
export const GIT_MODE_SUBMODULE = '160000';

export type EntryKind = 'file' | 'dir' | 'symlink' | 'submodule';

export interface EntryPolicyOptions {
  allowSymlinks?: boolean; // default false
  allowSubmodules?: boolean; // default false
}

export type EntryCheckResult =
  | { ok: true; path: string }
  | { ok: false; violation: PathViolation | 'symlink' | 'submodule' };

/**
 * Check a tree/archive entry: the path must normalize, and symlinks/submodules are refused unless
 * explicitly allowed. `mode` (a git mode string) is honored in addition to `type`.
 */
export function checkEntry(
  entry: { path: string; type: EntryKind; mode?: string },
  options: EntryPolicyOptions = {},
): EntryCheckResult {
  const isSymlink = entry.type === 'symlink' || entry.mode === GIT_MODE_SYMLINK;
  const isSubmodule = entry.type === 'submodule' || entry.mode === GIT_MODE_SUBMODULE;
  if (isSymlink && !options.allowSymlinks) return { ok: false, violation: 'symlink' };
  if (isSubmodule && !options.allowSubmodules) return { ok: false, violation: 'submodule' };
  const r = checkPath(entry.path);
  return r.ok ? { ok: true, path: r.path } : { ok: false, violation: r.violation };
}

/**
 * Minimal glob matcher over normalized paths. Supports `**` (any number of segments, including
 * none), `*` (any run of characters within one segment) and `?` (one character within a segment).
 * A pattern without glob characters matches the path itself and anything beneath it.
 */
export function matchesPathPattern(path: string, pattern: string): boolean {
  const pat = normalizePath(pattern, { allowEmpty: true });
  if (!/[*?]/.test(pat)) return isWithinPrefix(path, pat);
  const ps = path === '' ? [] : path.split('/');
  const gs = pat.split('/');
  return matchSegments(ps, 0, gs, 0);
}

function matchSegments(ps: string[], i: number, gs: string[], j: number): boolean {
  if (j === gs.length) return i === ps.length;
  const g = gs[j]!;
  if (g === '**') {
    for (let k = i; k <= ps.length; k++) if (matchSegments(ps, k, gs, j + 1)) return true;
    return false;
  }
  if (i === ps.length) return false;
  return segmentGlob(g).test(ps[i]!) && matchSegments(ps, i + 1, gs, j + 1);
}

function segmentGlob(g: string): RegExp {
  let re = '^';
  for (const ch of g) {
    if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${re}$`, 'u');
}

/**
 * Paths that are always protected regardless of policy: VCS internals and CommonForge/VibeControl
 * control directories anywhere in the tree.
 */
export const ALWAYS_PROTECTED_SEGMENTS: readonly string[] = ['.git', '.commonforge', '.vibecontrol'];

export function hasAlwaysProtectedSegment(path: string): boolean {
  return path.split('/').some((s) => ALWAYS_PROTECTED_SEGMENTS.includes(s.toLowerCase()));
}
