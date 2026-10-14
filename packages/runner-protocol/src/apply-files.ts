// packages/runner-protocol/src/apply-files.ts
/**
 * Shared Git LFS primitives for folders with uploads (spec 2026-10-07 §4–§7): the limits of a file
 * change, the LFS pointer format, git's binary heuristic, `.gitattributes` LFS matching (the root
 * file only), the exact-path entry added for large files, and content/code classification. Used by
 * the runner (`apply-files`), the Worker, and the Worker's fake runner, so all three agree.
 */

/**
 * maxEditBytes: one edit; maxEditTotalBytes: all edits of one change together (the resolved ops
 * travel as an R2 manifest, so the cap bounds what the Worker stores and the runner reads).
 */
export const APPLY_FILES_LIMITS = { maxOps: 1000, maxFileBytes: 5_000_000_000, maxChangeBytes: 20_000_000_000, maxEditBytes: 1_048_576, maxEditTotalBytes: 16_777_216, maxChangedPaths: 5_000 } as const;

/** Files above this size are always stored in LFS (`COMMONFORGE_LFS_THRESHOLD_BYTES`). */
export const DEFAULT_LFS_THRESHOLD_BYTES = 1_048_576;

/** A pointer is ~130 bytes; anything larger is never read as one. */
export const LFS_POINTER_MAX_BYTES = 200;

/** The branch `apply-files` creates in its fresh task repository (must not exist yet). */
export const APPLY_FILES_BRANCH_REF = 'refs/heads/main';

const POINTER_RE = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:([0-9a-f]{64})\nsize (0|[1-9][0-9]*)\n$/;

export function lfsPointer(sha256: string, size: number): string {
  return `version https://git-lfs.github.com/spec/v1\noid sha256:${sha256}\nsize ${size}\n`;
}

export function parseLfsPointer(text: string): { sha256: string; size: number } | null {
  const m = POINTER_RE.exec(text);
  if (!m) return null;
  const size = Number(m[2]);
  return Number.isSafeInteger(size) ? { sha256: m[1]!, size } : null;
}

/** git's heuristic: a NUL byte in the first 8000 bytes means binary. */
export function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8000);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

/** PDF and Office documents are content even when small (spec §7). */
export const CONTENT_EXTENSIONS: readonly string[] = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'key', 'pages', 'numbers'];

/**
 * The LFS patterns of a new folder's `.gitattributes` (folders phase 4, ruling P4-5), in file order:
 * video, audio, images (not `svg`: it is text), archives, fonts, then PDF and Office. Lower-case
 * only; a binary file under another spelling (`.JPG`) still goes to LFS by `apply-files`' binary
 * sniff and gets its exact-path entry.
 */
export const DEFAULT_LFS_PATTERNS: readonly string[] = [
  ...['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v'],
  ...['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac'],
  ...['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'heic', 'tif', 'tiff', 'psd', 'ai', 'ico'],
  ...['zip', 'gz', 'tgz', 'tar', '7z', 'rar'],
  ...['woff', 'woff2', 'ttf', 'otf'],
  ...CONTENT_EXTENSIONS,
].map((ext) => `*.${ext}`);

/** A new folder's `.gitattributes`: byte for byte the same every time (its first commit id depends on it, P4-3). */
export function defaultGitattributes(): string {
  const lines = ['# Stored in Git LFS: media, archives, fonts, PDF and Office files', ...DEFAULT_LFS_PATTERNS.map((p) => `${p} filter=lfs diff=lfs merge=lfs -text`)];
  return `${lines.join('\n')}\n`;
}

export function classifyPath(path: string, lfs: boolean): 'code' | 'content' {
  if (lfs) return 'content';
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  return CONTENT_EXTENSIONS.includes(ext) ? 'content' : 'code';
}

// --- .gitattributes matching -------------------------------------------------------------------
// `.gitattributes` is repository-controlled input that is parsed in the Worker and the runner, so
// matching must be faithful to git AND safe: no regex compilation (catastrophic backtracking), just
// a port of git's `wildmatch.c` `dowild` with WM_PATHNAME, including recursive star branches and abort
// optimisation (WM_ABORT_ALL / WM_ABORT_TO_STARSTAR). Like git it works on UTF-8 bytes.

const WM_MATCH = 0;
const WM_NOMATCH = 1;
const WM_ABORT_ALL = -1;
const WM_ABORT_TO_STARSTAR = -2;

const NUL = 0;
const SLASH = 0x2f;
const STAR = 0x2a;
const QMARK = 0x3f;
const LBRACKET = 0x5b;
const RBRACKET = 0x5d;
const BACKSLASH = 0x5c;
const COLON = 0x3a;
const BANG = 0x21;
const CARET = 0x5e;
const DASH = 0x2d;

const isGlobSpecial = (c: number): boolean => c === STAR || c === QMARK || c === LBRACKET || c === BACKSLASH;

const isDigit = (c: number) => c >= 0x30 && c <= 0x39;
const isUpper = (c: number) => c >= 0x41 && c <= 0x5a;
const isLower = (c: number) => c >= 0x61 && c <= 0x7a;
const isAlpha = (c: number) => isUpper(c) || isLower(c);
const isGraph = (c: number) => c >= 0x21 && c <= 0x7e;

/** git's POSIX classes (ASCII only, as in wildmatch.c). `space` is git's own: space, \t, \n, \r. */
const POSIX_CLASSES: Record<string, (c: number) => boolean> = {
  alnum: (c) => isAlpha(c) || isDigit(c),
  alpha: isAlpha,
  blank: (c) => c === 0x20 || c === 0x09,
  cntrl: (c) => c < 0x20 || c === 0x7f,
  digit: isDigit,
  graph: isGraph,
  lower: isLower,
  print: (c) => c >= 0x20 && c <= 0x7e,
  punct: (c) => isGraph(c) && !isAlpha(c) && !isDigit(c),
  space: (c) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d,
  upper: isUpper,
  xdigit: (c) => isDigit(c) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66),
};

/** Port of git's `dowild` with WM_PATHNAME. `p`/`t` are NUL-terminated by convention (reads past the end give 0). */
function dowild(p: Uint8Array, pStart: number, t: Uint8Array, tStart: number): number {
  const P = (i: number): number => (i >= 0 && i < p.length ? p[i]! : NUL);
  const T = (i: number): number => (i < t.length ? t[i]! : NUL);
  const patternStart = pStart;
  let pi = pStart;
  let ti = tStart;
  let pCh: number;

  for (; (pCh = P(pi)) !== NUL; ti++, pi++) {
    let tCh = T(ti);
    if (tCh === NUL && pCh !== STAR) return WM_ABORT_ALL;
    switch (pCh) {
      case BACKSLASH:
        // Literal match with the following character (a trailing `\` compares against NUL and fails).
        pCh = P(++pi);
        if (tCh !== pCh) return WM_NOMATCH;
        continue;
      case QMARK:
        if (tCh === SLASH) return WM_NOMATCH;
        continue;
      case STAR: {
        let matchSlash: boolean;
        pi++;
        if (P(pi) === STAR) {
          const prev = pi - 2;
          pi++;
          while (P(pi) === STAR) pi++;
          if ((prev < patternStart || P(prev) === SLASH) && (P(pi) === NUL || P(pi) === SLASH || (P(pi) === BACKSLASH && P(pi + 1) === SLASH))) {
            // `**/` may match nothing: `foo/**/bar` matches both `foo/bar` and `foo/a/bar`.
            if (P(pi) === SLASH && dowild(p, pi + 1, t, ti) === WM_MATCH) return WM_MATCH;
            matchSlash = true;
          } else matchSlash = false;
        } else matchSlash = false;
        if (P(pi) === NUL) {
          // Trailing `**` matches everything; a trailing `*` only when no slash remains.
          if (!matchSlash) for (let k = ti; k < t.length; k++) if (t[k] === SLASH) return WM_NOMATCH;
          return WM_MATCH;
        } else if (!matchSlash && P(pi) === SLASH) {
          // One `*` followed by a slash matches up to the next directory separator.
          let slash = -1;
          for (let k = ti; k < t.length; k++) if (t[k] === SLASH) { slash = k; break; }
          if (slash < 0) return WM_NOMATCH;
          ti = slash; // the slash is consumed by the loop increment
          break;
        }
        for (;;) {
          if (tCh === NUL) break;
          // Advance faster when the star is followed by a literal: what precedes it belongs to the star.
          if (!isGlobSpecial(P(pi))) {
            pCh = P(pi);
            while ((tCh = T(ti)) !== NUL && (matchSlash || tCh !== SLASH)) {
              if (tCh === pCh) break;
              ti++;
            }
            if (tCh !== pCh) return WM_NOMATCH;
          }
          const matched = dowild(p, pi, t, ti);
          if (matched !== WM_NOMATCH) {
            if (!matchSlash || matched !== WM_ABORT_TO_STARSTAR) return matched;
          } else if (!matchSlash && tCh === SLASH) return WM_ABORT_TO_STARSTAR;
          tCh = T(++ti);
        }
        return WM_ABORT_ALL;
      }
      case LBRACKET: {
        pCh = P(++pi);
        if (pCh === CARET) pCh = BANG;
        const negated = pCh === BANG;
        if (negated) pCh = P(++pi);
        let prevCh = 0;
        let matched = false;
        do {
          if (pCh === NUL) return WM_ABORT_ALL;
          if (pCh === BACKSLASH) {
            pCh = P(++pi);
            if (pCh === NUL) return WM_ABORT_ALL;
            if (tCh === pCh) matched = true;
          } else if (pCh === DASH && prevCh !== 0 && P(pi + 1) !== NUL && P(pi + 1) !== RBRACKET) {
            pCh = P(++pi);
            if (pCh === BACKSLASH) {
              pCh = P(++pi);
              if (pCh === NUL) return WM_ABORT_ALL;
            }
            if (tCh <= pCh && tCh >= prevCh) matched = true;
            pCh = 0; // makes prevCh 0
          } else if (pCh === LBRACKET && P(pi + 1) === COLON) {
            const s = pi + 2;
            pi = s;
            while ((pCh = P(pi)) !== NUL && pCh !== RBRACKET) pi++;
            if (pCh === NUL) return WM_ABORT_ALL;
            const len = pi - s - 1;
            if (len < 0 || P(pi - 1) !== COLON) {
              // No `:]` — treat the `[` as an ordinary set member.
              pi = s - 2;
              pCh = LBRACKET;
              if (tCh === pCh) matched = true;
              continue;
            }
            let name = '';
            for (let k = 0; k < len; k++) name += String.fromCharCode(P(s + k));
            const cls = Object.hasOwn(POSIX_CLASSES, name) ? POSIX_CLASSES[name]! : null;
            if (!cls) return WM_ABORT_ALL; // malformed [:class:]
            if (cls(tCh)) matched = true;
            pCh = 0;
          } else if (tCh === pCh) matched = true;
        } while (((prevCh = pCh), (pCh = P(++pi)) !== RBRACKET));
        if (matched === negated || tCh === SLASH) return WM_NOMATCH;
        continue;
      }
      default:
        if (tCh !== pCh) return WM_NOMATCH;
        continue;
    }
  }
  return T(ti) !== NUL ? WM_NOMATCH : WM_MATCH;
}

const encoder = new TextEncoder();

/**
 * git ignores an attributes line of ATTR_MAX_LINE_LENGTH (2,048) bytes or more, measured without the
 * newline and one trailing CR (checked against git 2.54: 2,047 bytes is honoured, 2,048 is not).
 */
const ATTR_MAX_LINE_LENGTH = 2048;

function lineTooLong(raw: string): boolean {
  const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
  if (line.length * 3 < ATTR_MAX_LINE_LENGTH) return false; // cheap bound: at most 3 UTF-8 bytes per UTF-16 unit
  return encoder.encode(line).length >= ATTR_MAX_LINE_LENGTH;
}

/** git's attribute-file blanks: space, tab, CR, LF only (not NBSP, \v or \f). */
const isBlank = (c: string) => c === ' ' || c === '\t' || c === '\r' || c === '\n';

function splitBlanks(line: string): string[] {
  const out: string[] = [];
  let start = -1;
  for (let i = 0; i <= line.length; i++) {
    if (i === line.length || isBlank(line[i]!)) {
      if (start >= 0) out.push(line.slice(start, i));
      start = -1;
    } else if (start < 0) start = i;
  }
  return out;
}

/** One attribute token as git's `parse_attr`: `name`, `-name`, `!name` or `name=value`; null when the name is invalid. */
function parseAttribute(token: string): { name: string; state: 'set' | 'unset' | 'unspecified' | 'value'; value: string } | null {
  let state: 'set' | 'unset' | 'unspecified' | 'value' = 'set';
  let rest = token;
  if (rest[0] === '-') {
    state = 'unset';
    rest = rest.slice(1);
  } else if (rest[0] === '!') {
    state = 'unspecified';
    rest = rest.slice(1);
  }
  const eq = rest.indexOf('=');
  const name = eq >= 0 ? rest.slice(0, eq) : rest;
  const value = eq >= 0 ? rest.slice(eq + 1) : '';
  if (!/^[A-Za-z0-9._][A-Za-z0-9._-]*$/.test(name)) return null;
  if (state === 'set' && eq >= 0) state = 'value';
  return { name, state, value };
}

function compilePattern(pattern: string): ((path: string) => boolean) | null {
  if (pattern.endsWith('/')) return null; // directory patterns never apply to files in .gitattributes
  if (pattern.startsWith('!')) return null; // git ignores negative patterns in attributes
  if (pattern.includes('\0')) return null;
  const anchored = pattern.includes('/');
  const body = encoder.encode(pattern.startsWith('/') ? pattern.slice(1) : pattern);
  if (body.length === 0) return null;
  return (path) => {
    const name = anchored ? path : path.slice(path.lastIndexOf('/') + 1);
    return dowild(body, 0, encoder.encode(name), 0) === WM_MATCH;
  };
}

/**
 * Whether the ROOT `.gitattributes` text stores `path` in LFS (`filter=lfs`). The last line that
 * matches and mentions `filter` wins; `-filter`, `!filter`, `filter` or `filter=<other>` mean no.
 * Matching ports git's byte-oriented wildmatch and its star-abort pruning; it does not compile globs to regex.
 * Not supported (such lines are skipped): quoted patterns, macro attributes (`[attr]`), negative
 * patterns, lines git itself ignores (2,048 bytes or more), malformed globs (unclosed `[`, trailing `\`).
 */
export function lfsAttributesMatcher(text: string): (path: string) => boolean {
  const rules: Array<{ match: (p: string) => boolean; lfs: boolean }> = [];
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // git skips a UTF-8 BOM
  for (const raw of body.split('\n')) {
    if (lineTooLong(raw)) continue; // git ignores such a line too
    const [pattern, ...attrs] = splitBlanks(raw);
    if (!pattern || pattern.startsWith('#') || pattern.startsWith('"') || pattern.startsWith('[attr]')) continue;
    let lfs: boolean | null = null;
    let valid = true;
    for (const a of attrs) {
      const attr = parseAttribute(a);
      if (!attr) {
        valid = false; // git ignores a whole line that names an invalid attribute
        break;
      }
      if (attr.name === 'filter') lfs = attr.state === 'value' && attr.value === 'lfs';
    }
    if (!valid || lfs === null) continue;
    const match = compilePattern(pattern);
    if (match) rules.push({ match, lfs });
  }
  return (path) => {
    let out = false;
    for (const r of rules) if (r.match(path)) out = r.lfs;
    return out;
  };
}

/** The `.gitattributes` line that stores exactly `path` in LFS (anchored, glob characters escaped). */
export function gitattributesLfsEntry(path: string): string {
  const escaped = path.replace(/[\\*?[]/g, (c) => `\\${c}`).replace(/[ \t\n\r]/g, '[[:space:]]');
  return `/${escaped} filter=lfs diff=lfs merge=lfs -text`;
}

/**
 * True when git reads {@link gitattributesLfsEntry}`(path)`: git ignores attribute lines of 2,048
 * bytes or more (UTF-8, without the newline). Spaces become `[[:space:]]` and non-ASCII takes up to
 * 3 bytes per character, so some paths well under 1,024 characters cannot be tracked by an exact
 * entry; the Worker refuses them up front and `apply-files` fails them with `limit_exceeded`.
 */
export function lfsEntryFits(path: string): boolean {
  return encoder.encode(gitattributesLfsEntry(path)).length < ATTR_MAX_LINE_LENGTH;
}
