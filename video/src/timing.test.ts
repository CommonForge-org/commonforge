import { describe, expect, it } from 'vitest';
import { BOOKEND_MIN_SEC, sceneFrames, totalFrames } from './timing';
import type { Narration } from './data';

const scene = (id: string, durationSec: number) => ({
  id,
  audio: `audio/${id}.m4a`,
  durationSec,
  text: 'x',
  words: [],
});

const narration = (...durations: number[]): Narration => ({
  scenes: durations.map((d, i) => scene(`s${i}`, d)),
});

const withMin = (n: Narration, mins: Record<number, number>): Narration => ({
  scenes: n.scenes.map((s, i) => (i in mins ? { ...s, minDurationSec: mins[i] } : s)),
});

describe('sceneFrames', () => {
  it('lays scenes end to end and sums their durations', () => {
    const timings = sceneFrames(narration(4, 10, 5), 30);
    expect(timings).toEqual([
      { id: 's0', from: 0, durationInFrames: 120 },
      { id: 's1', from: 120, durationInFrames: 300 },
      { id: 's2', from: 420, durationInFrames: 150 },
    ]);
    expect(totalFrames(timings)).toBe(570);
  });

  it('rounds partial frames up so narration is never cut off', () => {
    const [, middle] = sceneFrames(narration(4, 1.01, 4), 30);
    expect(middle?.durationInFrames).toBe(31);
    // floating point noise (0.1 * 30 = 3.0000000000000004) must not add a frame
    const [, tiny] = sceneFrames(narration(4, 0.1, 4), 30);
    expect(tiny?.durationInFrames).toBe(3);
  });

  it('holds the title and close scenes for at least 3 s', () => {
    const timings = sceneFrames(narration(1, 2, 0.5), 30);
    expect(BOOKEND_MIN_SEC).toBe(3);
    expect(timings[0]?.durationInFrames).toBe(90);
    expect(timings[1]?.durationInFrames).toBe(60);
    expect(timings[2]?.durationInFrames).toBe(90);
  });

  it('pads every scene but the last by the transition overlap so audio never overlaps', () => {
    const timings = sceneFrames(narration(4, 10, 5), 30, 12);
    expect(timings).toEqual([
      { id: 's0', from: 0, durationInFrames: 132 },
      { id: 's1', from: 120, durationInFrames: 312 },
      { id: 's2', from: 420, durationInFrames: 150 },
    ]);
    // overlapping transitions cancel the padding: total equals the narration length
    expect(totalFrames(timings)).toBe(570);
  });

  it('holds a scene for its minDurationSec when the narration is shorter, and never cuts longer narration', () => {
    const timings = sceneFrames(withMin(narration(4, 10, 5, 4), { 1: 45, 2: 2 }), 30);
    expect(timings.map((t) => t.durationInFrames)).toEqual([120, 45 * 30, 150, 120]);
    // narration starts at the scene start: the next scene begins after the held length
    expect(timings[2]?.from).toBe(120 + 45 * 30);
  });

  it('lets minDurationSec override the 3 s bookend default for the title and close', () => {
    const timings = sceneFrames(withMin(narration(1, 2, 0.5), { 0: 8, 2: 0 }), 30);
    expect(timings[0]?.durationInFrames).toBe(240);
    expect(timings[2]?.durationInFrames).toBe(15);
  });
});
