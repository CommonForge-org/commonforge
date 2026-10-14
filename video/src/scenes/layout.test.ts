import { describe, expect, it } from 'vitest';
import { parseMedia, parseNarration } from '../data';
import { laneWindow, sceneSlots } from './layout';

const narration = parseNarration({ scenes: [{ id: 's04-three-agents', audio: 'a.m4a', durationSec: 80, text: 'x', words: [] }] });
const scene = (raw: unknown) => parseMedia({ scenes: { 's04-three-agents': raw } }, narration).scenes['s04-three-agents']!;

describe('scene layout', () => {
  it('runs scene 4 lanes in step with the clip when castOffsetSec is set', () => {
    const media = scene({ clip: { src: 'clips/clip-04-lanes.webm', from: 30 }, casts: ['clips/a.cast'], speed: 8, castOffsetSec: -12.5 });
    // the clip starts at source 30 s: the casts start 30 s later in their own time too
    expect(laneWindow(media, media.casts![0]!)).toEqual({ from: 17.5, to: undefined, speed: 8 });
    expect(laneWindow(scene({ clip: 'c.webm', casts: [{ src: 'a.cast', from: 3 }], speed: 4 }), { src: 'a.cast', from: 3 })).toEqual({ from: 3, to: undefined, speed: 4 });
  });

  it('shows the scene 3 insert before the return clip, for its window or half the scene', () => {
    const own = (raw: unknown) => sceneSlots('s03-own-tool', parseMedia({ scenes: { 's04-three-agents': {}, 's03-own-tool': raw } }, narration).scenes['s03-own-tool']!, 60);
    expect(own({ clip: 'c.webm', insert: { src: 'i.mov', from: 10, to: 40, speed: 2 } }).map((s) => [s.kind, s.startSec, s.durationSec])).toEqual([
      ['insert', 0, 15],
      ['clip', 15, 45],
    ]);
    expect(own({ clip: 'c.webm', insert: 'i.mov' }).map((s) => [s.kind, s.startSec, s.durationSec])).toEqual([
      ['insert', 0, 30],
      ['clip', 30, 30],
    ]);
    expect(own({ clip: 'c.webm' }).map((s) => [s.kind, s.startSec])).toEqual([['clip', 0]]);
  });
});
