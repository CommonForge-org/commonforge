/**
 * A small unified text diff (`---`/`+++`/`@@` hunks, 3 lines of context) for the risk classifier's
 * input. Lines split on `\n` only, so a CRLF file keeps its `\r` inside each line. The line LCS is
 * O(n·m) after trimming the common prefix and suffix, so an edit of a file over 2,000 lines, or
 * whose two sides together exceed 512 KiB, is replaced by a size line; an added or deleted file
 * needs no LCS and is always diffed.
 */

export const DIFF_CONTEXT_LINES = 3;
export const DIFF_MAX_LINES = 2000;
/** UTF-8 bytes of both sides together above which an edit is not diffed line by line. */
export const DIFF_MAX_INPUT_BYTES = 512 * 1024;

const TRUNCATED_MARK = '(diff truncated)\n';
const NO_EOL = '\\ No newline at end of file';

interface Lines {
  lines: string[];
  /** The last line has no trailing newline. */
  noEol: boolean;
}

function splitLines(text: string | null): Lines {
  if (text === null || text === '') return { lines: [], noEol: false };
  const lines = text.split('\n');
  const noEol = lines[lines.length - 1] !== '';
  if (!noEol) lines.pop();
  return { lines, noEol };
}

type Op = { tag: ' ' | '-' | '+'; line: string; a: number; b: number };

/** Edit script between `a` and `b` (indices are 0-based positions in each side). */
function editScript(a: string[], b: string[], aKey: string[], bKey: string[]): Op[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && aKey[pre] === bKey[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && aKey[a.length - 1 - suf] === bKey[b.length - 1 - suf]) suf++;
  const n = a.length - pre - suf;
  const m = b.length - pre - suf;
  // lcs[i][j] = LCS length of a[pre+i..] and b[pre+j..], flattened.
  const w = m + 1;
  const lcs = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] = aKey[pre + i] === bKey[pre + j] ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
    }
  }
  const ops: Op[] = [];
  for (let k = 0; k < pre; k++) ops.push({ tag: ' ', line: a[k]!, a: k, b: k });
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && aKey[pre + i] === bKey[pre + j]) {
      ops.push({ tag: ' ', line: a[pre + i]!, a: pre + i, b: pre + j });
      i++;
      j++;
    } else if (i < n && (j === m || lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!)) {
      // On a tie, removals print before additions.
      ops.push({ tag: '-', line: a[pre + i]!, a: pre + i, b: pre + j });
      i++;
    } else {
      ops.push({ tag: '+', line: b[pre + j]!, a: pre + i, b: pre + j });
      j++;
    }
  }
  for (let k = 0; k < suf; k++) ops.push({ tag: ' ', line: a[pre + n + k]!, a: pre + n + k, b: pre + m + k });
  return ops;
}

function range(start: number, count: number): string {
  // GNU convention: an empty range names the line before it; a count of 1 is omitted.
  if (count === 0) return `${start},0`;
  return count === 1 ? `${start + 1}` : `${start + 1},${count}`;
}

function hunks(ops: Op[], before: Lines, after: Lines): string {
  const changed = ops.map((o, k) => (o.tag === ' ' ? -1 : k)).filter((k) => k !== -1);
  let out = '';
  let h = 0;
  while (h < changed.length) {
    let end = h;
    while (end + 1 < changed.length && changed[end + 1]! - changed[end]! - 1 <= 2 * DIFF_CONTEXT_LINES) end++;
    const from = Math.max(0, changed[h]! - DIFF_CONTEXT_LINES);
    const to = Math.min(ops.length, changed[end]! + DIFF_CONTEXT_LINES + 1);
    const slice = ops.slice(from, to);
    const aCount = slice.filter((o) => o.tag !== '+').length;
    const bCount = slice.filter((o) => o.tag !== '-').length;
    out += `@@ -${range(aCount ? slice.find((o) => o.tag !== '+')!.a : slice[0]!.a, aCount)} +${range(bCount ? slice.find((o) => o.tag !== '-')!.b : slice[0]!.b, bCount)} @@\n`;
    for (const o of slice) {
      out += `${o.tag}${o.line}\n`;
      const lastA = o.tag !== '+' && o.a === before.lines.length - 1 && before.noEol;
      const lastB = o.tag !== '-' && o.b === after.lines.length - 1 && after.noEol;
      if (lastA || lastB) out += `${NO_EOL}\n`;
    }
    h = end + 1;
  }
  return out;
}

const encoder = new TextEncoder();

/** `text` cut to at most `maxBytes` UTF-8 bytes at a line boundary, with a closing mark line. */
function truncate(text: string, maxBytes: number): string {
  const budget = maxBytes - encoder.encode(TRUNCATED_MARK).length;
  let used = 0;
  let cut = 0;
  for (const line of text.split(/(?<=\n)/)) {
    const n = encoder.encode(line).length;
    if (used + n > budget) break;
    used += n;
    cut += line.length;
  }
  return text.slice(0, cut) + TRUNCATED_MARK;
}

/**
 * Unified diff of one file. `null` means the file is absent on that side (`/dev/null`).
 * Unchanged content (or both absent) is empty text. `maxBytes` caps the whole text in UTF-8 bytes,
 * cut at a line boundary and ending with `(diff truncated)`.
 */
export function unifiedDiff(path: string, before: string | null, after: string | null, opts: { maxBytes?: number } = {}): { text: string; truncated: boolean } {
  if (before === after) return { text: '', truncated: false };
  const header = `--- ${before === null ? '/dev/null' : `a/${path}`}\n+++ ${after === null ? '/dev/null' : `b/${path}`}\n`;
  const a = splitLines(before);
  const b = splitLines(after);
  let text: string;
  const tooLarge = () => a.lines.length > DIFF_MAX_LINES || b.lines.length > DIFF_MAX_LINES || encoder.encode(before!).length + encoder.encode(after!).length > DIFF_MAX_INPUT_BYTES;
  if (a.lines.length > 0 && b.lines.length > 0 && tooLarge()) {
    text = `${header}(file too large to diff: ${a.lines.length} → ${b.lines.length} lines)\n`;
  } else {
    // A final line without a newline differs from the same line with one.
    const key = (l: Lines) => l.lines.map((s, k) => (l.noEol && k === l.lines.length - 1 ? `${s}\n` : s));
    text = header + hunks(editScript(a.lines, b.lines, key(a), key(b)), a, b);
  }
  if (opts.maxBytes !== undefined && encoder.encode(text).length > opts.maxBytes) return { text: truncate(text, opts.maxBytes), truncated: true };
  return { text, truncated: false };
}
