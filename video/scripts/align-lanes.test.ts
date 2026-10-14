import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseMedia, parseNarration } from '../src/data';
import { laneOffsetSec, setCastOffset } from './align-lanes';
import { VIDEO_ROOT } from './placeholder-manifest';

const T0 = 1_759_750_000_400;
const LOG = [`${T0} created 3 task(s)`, `${T0 + 4_000} agent-1: checked out t-1`].join('\n');

describe('align-lanes', () => {
  it('computes the cast time at the clip\'s first frame from the log and the clip marks', () => {
    // the casts start at the log's whole second (…000 000); the clip started 12.5 s later
    expect(laneOffsetSec(LOG, JSON.stringify({ startedAtMs: 1_759_750_012_500, marks: [] }))).toBe(12.5);
    // a clip that started before the agents: the panes wait
    expect(laneOffsetSec(LOG, JSON.stringify({ startedAtMs: 1_759_749_990_000 }))).toBe(-10);
  });

  it('refuses marks without startedAtMs and a log without stamps', () => {
    expect(() => laneOffsetSec(LOG, '{"marks":[]}')).toThrow(/no startedAtMs/);
    expect(() => laneOffsetSec('no stamps here', '{"startedAtMs":1}')).toThrow(/no timestamped lines/);
  });

  it('writes castOffsetSec into scene 4 of media.json and replaces it on a rerun, leaving the rest alone', () => {
    // a copy in a temp dir, stripped of any castOffsetSec a live capture has written, so the repo's media.json is never the subject
    const dir = mkdtempSync(join(tmpdir(), 'align-lanes-'));
    try {
      const copy = join(dir, 'media.json');
      copyFileSync(join(VIDEO_ROOT, 'media.json'), copy);
      const stripped = readFileSync(copy, 'utf8').replace(/\n?[ \t]*"castOffsetSec": [^,\n]*,?/g, '');
      writeFileSync(copy, stripped);
      expect(stripped).not.toContain('castOffsetSec');
      const text = readFileSync(copy, 'utf8');
      const narration = parseNarration(JSON.parse(readFileSync(join(VIDEO_ROOT, 'narration.json'), 'utf8')));
      const once = setCastOffset(text, 12.5);
      const twice = setCastOffset(once, -3.25);
      expect(parseMedia(JSON.parse(once), narration).scenes['s04-three-agents']?.castOffsetSec).toBe(12.5);
      expect(parseMedia(JSON.parse(twice), narration).scenes['s04-three-agents']?.castOffsetSec).toBe(-3.25);
      expect(twice.replace(/\s*"castOffsetSec": -3\.25,/, '')).toBe(text);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
