import { describe, expect, it } from 'vitest';
import { parseMedia, parseNarration } from '../src/data';
import type { Cast } from '../src/lib/asciinema';
import { checkFit, type FitProbe } from './check-fit';

// scene 1 ends the composition (no transition padding): 60 s
const narration = parseNarration({
  scenes: [
    { id: 's00-title', audio: 'audio/scene-00.m4a', durationSec: 10, text: 'x', words: [] },
    { id: 's06-repair-preview', audio: 'audio/scene-06.m4a', durationSec: 60, text: 'x', words: [] },
  ],
});
const media = (clip: unknown, casts?: unknown[]) => parseMedia({ scenes: { 's00-title': {}, 's06-repair-preview': { clip, ...(casts ? { casts } : {}) } } }, narration);

const cast = (times: number[]): Cast => ({ header: { version: 2, width: 80, height: 24 }, events: times.map((time) => ({ time, type: 'o', data: 'x\r\n' })) });

const probe = (over: Partial<FitProbe> = {}): FitProbe => ({
  clipSec: () => 120,
  marks: () => [
    { name: 'new-hash', t: 10 },
    { name: 'preview-quote', t: 50 },
  ],
  cast: () => cast([1, 20, 40]),
  exists: () => true,
  ...over,
});

const problems = (m: ReturnType<typeof media>, p: FitProbe) => checkFit(narration, m, p, 30).flatMap((l) => l.problems);

describe('checkFit', () => {
  it('passes a clip long enough for its pane, with its marks inside the window', () => {
    const lines = checkFit(narration, media('clips/clip-06-preview.webm'), probe(), 30);
    expect(lines.flatMap((l) => l.problems)).toEqual([]);
    expect(lines[0]!.text).toMatch(/on screen 0\.0 s–60\.0 s; source 120\.0 s; shows 0\.0 s–60\.0 s at 1×; marks: new-hash@10\.0 s \(callout t 10\.0 s\)/);
  });

  it('flags a clip too short for its pane: it would freeze', () => {
    const flagged = problems(media('clips/clip-06-preview.webm'), probe({ clipSec: () => 45, marks: () => [] }));
    expect(flagged).toEqual(['clips/clip-06-preview.webm ends (source 45.0 s) 15.0 s before its pane does: frozen from 45.0 s of the scene; trim with from/to, raise speed or capture longer']);
  });

  it('flags key marks outside the shown window', () => {
    const flagged = problems(media({ src: 'clips/clip-06-preview.webm', from: 20, speed: 0.5 }), probe());
    // shows source 20–50: the 10 s mark is before it
    expect(flagged).toEqual(['clips/clip-06-preview.webm mark "new-hash" at 10.0 s is outside the shown window 20.0 s–50.0 s']);
  });

  it('flags a cast whose output runs past its pane, and a gap cap fixes it', () => {
    const longCast = probe({ cast: () => cast([1, 30, 230]) });
    expect(problems(media('clips/clip-06-preview.webm', ['clips/x.cast']), longCast)).toEqual([
      expect.stringMatching(/clips\/x\.cast output after source 60\.0 s is never shown \(needs 230\.0 s on screen, has 60\.0 s\)/),
    ]);
    expect(problems(media('clips/clip-06-preview.webm', [{ src: 'clips/x.cast', maxIdleGapSec: 2 }]), longCast)).toEqual([]);
  });

  it('flags missing files', () => {
    expect(problems(media('clips/clip-06-preview.webm'), probe({ clipSec: () => null }))).toEqual(['clips/clip-06-preview.webm is missing']);
  });
});
