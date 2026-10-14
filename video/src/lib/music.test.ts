import { describe, expect, it } from 'vitest';
import { MUSIC_GAIN, musicGain, type MusicPlan } from './music';

const plan: MusicPlan = { fps: 30, totalFrames: 900, speech: [[60, 300], [400, 600]] };

describe('musicGain', () => {
  it('plays at full bed gain between narration', () => {
    expect(musicGain(0, plan)).toBeCloseTo(MUSIC_GAIN);
    expect(musicGain(350, plan)).toBeCloseTo(MUSIC_GAIN);
  });

  it('ducks by 6 dB under narration, ramping in and out', () => {
    expect(musicGain(150, plan)).toBeCloseTo(MUSIC_GAIN * 10 ** (-6 / 20));
    expect(musicGain(150, plan) / MUSIC_GAIN).toBeCloseTo(0.501, 3);
    const rampMid = musicGain(56, plan);
    expect(rampMid).toBeLessThan(MUSIC_GAIN);
    expect(rampMid).toBeGreaterThan(musicGain(150, plan));
  });

  it('fades out over the last 1.5 s to silence at the end', () => {
    expect(musicGain(855, plan)).toBeCloseTo(MUSIC_GAIN);
    expect(musicGain(877.5, plan)).toBeCloseTo(MUSIC_GAIN / 2);
    expect(musicGain(900, plan)).toBe(0);
  });
});
