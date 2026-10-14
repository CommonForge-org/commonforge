import { describe, expect, it } from 'vitest';
import type { Narration } from '../src/data';
import { formatLengths, lengthProblem, lengthReport } from './length-policy';

const narration = (durations: number[], mins: Record<number, number> = {}): Narration => ({
  scenes: durations.map((d, i) => ({ id: `s${i}`, audio: `audio/s${i}.m4a`, durationSec: d, text: 'x', words: [], ...(i in mins ? { minDurationSec: mins[i] } : {}) })),
});

describe('length policy (5–10 minutes)', () => {
  it('accepts a total inside the limits and reports per-scene lengths', () => {
    const report = lengthReport(narration([10, 200, 150], { 2: 160 }), 30);
    expect(report.totalSec).toBe(370);
    expect(report.scenes.map((s) => s.lengthSec)).toEqual([10, 200, 160]);
    expect(lengthProblem(report)).toBeNull();
    expect(formatLengths(report)).toMatch(/s2\s+audio\s+150\.00 s\s+min\s+160\.00 s\s+→\s+160\.00 s/);
    expect(formatLengths(report)).toMatch(/total 6:10\.0/);
  });

  it('flags a video under 5 minutes, counting minDurationSec', () => {
    expect(lengthProblem(lengthReport(narration([10, 20, 10]), 30))).toMatch(/0:40\.0, under the 5:00\.0 minimum/);
    expect(lengthProblem(lengthReport(narration([10, 20, 10], { 1: 290 }), 30))).toBeNull();
  });

  it('flags a video over 10 minutes and accepts exactly 5 and 10', () => {
    expect(lengthProblem(lengthReport(narration([300, 300.5]), 30))).toMatch(/over the 10:00\.0 maximum/);
    expect(lengthProblem(lengthReport(narration([150, 150]), 30))).toBeNull();
    expect(lengthProblem(lengthReport(narration([300, 300]), 30))).toBeNull();
  });
});
