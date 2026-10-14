import { describe, expect, it } from 'vitest';
import { unifiedDiff } from './text-diff.js';

describe('unifiedDiff', () => {
  it('a new file is all additions against /dev/null', () => {
    expect(unifiedDiff('api/a.sql', null, 'one\ntwo\n')).toEqual({
      text: '--- /dev/null\n+++ b/api/a.sql\n@@ -0,0 +1,2 @@\n+one\n+two\n',
      truncated: false,
    });
  });
  it('a deleted file is all removals against /dev/null', () => {
    expect(unifiedDiff('x.txt', 'gone\n', null).text).toBe('--- a/x.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n');
  });
  it('an edit keeps 3 lines of context and splits distant changes into hunks', () => {
    const before = Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join('\n') + '\n';
    const after = before.replace('l2\n', 'L2\n').replace('l18\n', 'L18\n');
    expect(unifiedDiff('f.txt', before, after).text).toBe(
      [
        '--- a/f.txt',
        '+++ b/f.txt',
        '@@ -1,5 +1,5 @@',
        ' l1',
        '-l2',
        '+L2',
        ' l3',
        ' l4',
        ' l5',
        '@@ -15,6 +15,6 @@',
        ' l15',
        ' l16',
        ' l17',
        '-l18',
        '+L18',
        ' l19',
        ' l20',
        '',
      ].join('\n'),
    );
  });
  it('close changes share one hunk', () => {
    const before = 'a\nb\nc\nd\ne\nf\ng\nh\n';
    const after = 'A\nb\nc\nd\ne\nf\ng\nH\n';
    expect(unifiedDiff('f', before, after).text.match(/^@@/gm)).toHaveLength(1);
  });
  it('unchanged content is empty text', () => {
    expect(unifiedDiff('f', 'same\n', 'same\n')).toEqual({ text: '', truncated: false });
    expect(unifiedDiff('f', null, null)).toEqual({ text: '', truncated: false });
  });
  it('CRLF line endings are preserved inside lines', () => {
    expect(unifiedDiff('w.txt', 'a\r\nb\r\n', 'a\r\nc\r\n').text).toBe('--- a/w.txt\n+++ b/w.txt\n@@ -1,2 +1,2 @@\n a\r\n-b\r\n+c\r\n');
  });
  it('marks a missing final newline', () => {
    expect(unifiedDiff('f', 'a\n', 'a').text).toBe('--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+a\n\\ No newline at end of file\n');
  });
  it('an edit of a file over 2,000 lines falls back to a size line', () => {
    const big = Array.from({ length: 2001 }, (_, i) => `x${i}`).join('\n') + '\n';
    expect(unifiedDiff('big.txt', big, big + 'more\n').text).toBe('--- a/big.txt\n+++ b/big.txt\n(file too large to diff: 2001 → 2002 lines)\n');
  });
  it('maxBytes truncates on a line boundary and says so', () => {
    const after = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n') + '\n';
    const r = unifiedDiff('f', null, after, { maxBytes: 1000 });
    expect(r.truncated).toBe(true);
    expect(new TextEncoder().encode(r.text).length).toBeLessThanOrEqual(1000);
    expect(r.text.endsWith('(diff truncated)\n')).toBe(true);
    expect(r.text.split('\n').slice(0, -2).every((l) => l === '' || /^(---|\+\+\+|@@|\+line \d+$)/.test(l))).toBe(true);
  });
  it('an edit whose two sides exceed 512 KiB together is not diffed line by line', () => {
    const line = 'q'.repeat(299) + '\n';
    const before = line.repeat(900); // 270,000 bytes, 900 lines
    const after = before + 'r\n';
    expect(unifiedDiff('big.txt', before, after).text).toBe('--- a/big.txt\n+++ b/big.txt\n(file too large to diff: 900 → 901 lines)\n');
    // A new file of the same size still diffs (no LCS needed).
    expect(unifiedDiff('new.txt', null, before + before).text.startsWith('--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,1800 @@\n')).toBe(true);
  });
});
