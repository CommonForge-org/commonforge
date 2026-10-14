import { describe, expect, it } from 'vitest';
import { castStateAt, type Cast } from './asciinema';
import { badgeLabel, playSeconds, resolveWindow, sourceTimeAt, visibleWindow, wallClock, windowCast } from './media-window';

const cast = (events: Array<[number, string]>): Cast => ({
  header: { version: 2, width: 80, height: 24, timestamp: 1_759_750_000 },
  events: events.map(([time, data]) => ({ time, type: 'o', data })),
});

describe('clip windows', () => {
  it('defaults to the whole clip at the scene speed, and a clip speed overrides it', () => {
    expect(resolveWindow(undefined, 8)).toEqual({ from: 0, to: undefined, speed: 8 });
    expect(resolveWindow({ from: 12, to: 40, speed: 2 }, 8)).toEqual({ from: 12, to: 40, speed: 2 });
  });

  it('maps composition seconds to source seconds and holds at to', () => {
    const w = resolveWindow({ from: 10, to: 30, speed: 4 });
    expect(sourceTimeAt(w, 0)).toBe(10);
    expect(sourceTimeAt(w, 2.5)).toBe(20);
    expect(sourceTimeAt(w, 100)).toBe(30);
    expect(playSeconds(w)).toBe(5);
    expect(playSeconds(resolveWindow({}))).toBe(Number.POSITIVE_INFINITY);
  });

  it('reports the visible source range and when a too-short clip stops moving', () => {
    // 60 s pane at 8×: wants 480 s of source; the clip has 300 s
    expect(visibleWindow(resolveWindow({}, 8), 60, 300)).toEqual({ start: 0, end: 300, stopsAtSec: 37.5, runsOut: true });
    // a chosen window ending early holds on purpose, not because the source ran out
    expect(visibleWindow(resolveWindow({ from: 5, to: 15 }), 20, 300)).toEqual({ start: 5, end: 15, stopsAtSec: 10, runsOut: false });
    expect(visibleWindow(resolveWindow({ from: 5 }), 20, 300)).toEqual({ start: 5, end: 25, stopsAtSec: null, runsOut: false });
  });

  it('labels compressed panes', () => {
    expect(badgeLabel(1)).toBeNull();
    expect(badgeLabel(8)).toBe('8× speed');
    expect(badgeLabel(1, 2)).toBe('idle > 2 s cut');
    expect(badgeLabel(4, 1.5)).toBe('4× speed · idle > 1.5 s cut');
  });
});

describe('windowCast', () => {
  it('caps a 200 s idle gap to 2 s, keeping event order and the whole content', () => {
    const source = cast([[1, 'a\r\n'], [2, 'b\r\n'], [202, 'c\r\n'], [203, 'd\r\n']]);
    const { cast: out, toSourceSec } = windowCast(source, { maxIdleGapSec: 2 });
    expect(out.events.map((e) => e.time)).toEqual([1, 2, 4, 5]);
    expect(out.events.map((e) => e.data).join('')).toBe(source.events.map((e) => e.data).join(''));
    expect(castStateAt(out, 5_000).lines).toEqual(castStateAt(source, 203_000).lines);
    // the clock runs during the kept 2 s of the gap, then jumps to the next event
    expect(toSourceSec(3)).toBe(3);
    expect(toSourceSec(4)).toBe(202);
    expect(toSourceSec(5.5)).toBe(203.5);
  });

  it('shows output before from at once and drops output after to', () => {
    const { cast: out, toSourceSec } = windowCast(cast([[1, 'a'], [10, 'b'], [20, 'c'], [30, 'd']]), { from: 10, to: 20 });
    expect(out.events.map((e) => [e.time, e.data])).toEqual([[0, 'a'], [0, 'b'], [10, 'c']]);
    expect(toSourceSec(5)).toBe(15);
  });

  it('delays the cast for a negative from (an aligned lane that starts after the clip)', () => {
    const { cast: out, toSourceSec } = windowCast(cast([[0, 'a'], [3, 'b']]), { from: -4 });
    expect(out.events.map((e) => e.time)).toEqual([4, 7]);
    expect(toSourceSec(0)).toBe(-4);
    expect(toSourceSec(7)).toBe(3);
  });

  it('formats wall-clock labels in UTC', () => {
    expect(wallClock(Date.UTC(2026, 9, 12, 14, 3, 27, 900))).toBe('14:03:27 UTC');
  });
});
