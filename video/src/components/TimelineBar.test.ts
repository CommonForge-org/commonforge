import { describe, expect, it } from 'vitest';
import { labelledBeats } from './TimelineBar';

/** 10 px per character, like a 16 px label. */
const measure = (label: string) => label.length * 10;

describe('labelledBeats', () => {
  it('labels a segment only when the whole label fits, never truncating it', () => {
    const beats = [
      { label: 'Title', from: 0, durationInFrames: 30 }, // 30/1000 × 1776 = 53 px; needs 60
      { label: 'Three agents', from: 30, durationInFrames: 400 },
      { label: 'Close', from: 430, durationInFrames: 570 },
    ];
    expect(labelledBeats(beats, 1000, 1776, measure)).toEqual([false, true, true]);
  });

  it('never labels a segment narrower than the minimum, even for a short label', () => {
    expect(labelledBeats([{ label: 'A', from: 0, durationInFrames: 20 }], 1000, 1776, measure)).toEqual([false]);
  });
});
