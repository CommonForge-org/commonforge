import { describe, expect, it } from 'vitest';
import { mediaPaths, parseMedia, parseNarration } from './data';

const validNarration = {
  scenes: [
    { id: 's00-title', audio: 'audio/scene-00.m4a', durationSec: 10, text: 'Hello', words: [] },
    {
      id: 's01-mess',
      audio: 'audio/scene-01.m4a',
      durationSec: 40,
      text: 'Clients send us this.',
      words: [{ w: 'Clients', start: 0, end: 0.4 }],
    },
  ],
};

describe('parseNarration', () => {
  it('accepts a valid narration file', () => {
    expect(parseNarration(validNarration).scenes).toHaveLength(2);
  });

  it('rejects invalid narration with a message naming the bad field', () => {
    const bad = structuredClone(validNarration) as { scenes: Array<Record<string, unknown>> };
    bad.scenes[1]!.durationSec = 'forty';
    expect(() => parseNarration(bad)).toThrow(/narration\.json.*scenes\.1\.durationSec/s);
  });

  it('rejects duplicate scene ids', () => {
    const dup = { scenes: [validNarration.scenes[0], validNarration.scenes[0]] };
    expect(() => parseNarration(dup)).toThrow(/duplicate scene id "s00-title"/);
  });
});

describe('parseMedia', () => {
  const narration = parseNarration(validNarration);

  it('accepts media covering every narrated scene', () => {
    const media = parseMedia(
      {
        scenes: {
          's00-title': {},
          's01-mess': {
            clip: 'clips/clip-01-intake.webm',
            callouts: [{ t: 2, x: 0.1, y: 0.2, w: 0.3, h: 0.1, label: 'nested repo' }],
          },
        },
      },
      narration,
    );
    expect(media.scenes['s01-mess']?.clip).toEqual({ src: 'clips/clip-01-intake.webm' });
  });

  it('accepts clip and cast windows, the scene 3 insert, castOffsetSec and the hashes file', () => {
    const media = parseMedia(
      {
        hashes: 'clips/hashes.json',
        scenes: {
          's00-title': {},
          's01-mess': {
            insert: { src: 'clips/clip-03-tool-insert.mov', to: 40 },
            clip: { src: 'clips/clip-04-lanes.webm', from: 12, to: 300, speed: 8 },
            casts: ['clips/a.cast', { src: 'clips/b.cast', from: 3, maxIdleGapSec: 2 }],
            castOffsetSec: -4.5,
          },
        },
      },
      narration,
    );
    const scene = media.scenes['s01-mess']!;
    expect(scene.clip).toEqual({ src: 'clips/clip-04-lanes.webm', from: 12, to: 300, speed: 8 });
    expect(scene.casts).toEqual([{ src: 'clips/a.cast' }, { src: 'clips/b.cast', from: 3, maxIdleGapSec: 2 }]);
    expect(mediaPaths(media)).toEqual(['clips/clip-03-tool-insert.mov', 'clips/clip-04-lanes.webm', 'clips/a.cast', 'clips/b.cast', 'clips/hashes.json']);
  });

  it('rejects a window that ends before it starts, and unknown window keys', () => {
    const bad = (clip: unknown) => parseMedia({ scenes: { 's00-title': {}, 's01-mess': { clip } } }, narration);
    expect(() => bad({ src: 'c.webm', from: 10, to: 5 })).toThrow(/clip\.to: to \(5\) must be after from \(10\)/);
    expect(() => bad({ src: 'c.webm', start: 1 })).toThrow(/media\.json is invalid/);
  });

  it('treats a missing media entry for a scene as an error', () => {
    expect(() => parseMedia({ scenes: { 's00-title': {} } }, narration)).toThrow(
      /media\.json has no entry for scene "s01-mess"/,
    );
  });

  it('rejects callouts outside the 0-1 frame', () => {
    const media = {
      scenes: {
        's00-title': {},
        's01-mess': { callouts: [{ t: 1, x: 1.5, y: 0, w: 0.1, h: 0.1, label: 'off-screen' }] },
      },
    };
    expect(() => parseMedia(media, narration)).toThrow(/media\.json.*callouts\.0\.x/s);
  });

  it.each([
    ['x + w', { x: 0.7, y: 0.1, w: 0.4, h: 0.1 }, /callouts\.0.*x \+ w/s],
    ['y + h', { x: 0.1, y: 0.95, w: 0.2, h: 0.1 }, /callouts\.0.*y \+ h/s],
  ])('rejects a callout whose %s runs past the frame edge', (_edge, box, message) => {
    const media = {
      scenes: { 's00-title': {}, 's01-mess': { callouts: [{ t: 1, ...box, label: 'overflow' }] } },
    };
    expect(() => parseMedia(media, narration)).toThrow(message);
  });

  it('accepts a callout that ends exactly on the frame edge', () => {
    const media = {
      scenes: { 's00-title': {}, 's01-mess': { callouts: [{ t: 1, x: 0.6, y: 0.7, w: 0.4, h: 0.3, label: 'edge' }] } },
    };
    expect(parseMedia(media, narration).scenes['s01-mess']?.callouts).toHaveLength(1);
  });
});
