/**
 * Lines the scene 4 agent panes up with the lanes clip: the clip's `.marks.json` records
 * `startedAtMs` (epoch ms of its first frame) and the lane casts start at the orchestrator log's
 * first line (its whole second, log-to-casts.ts `castEpochMs`). The difference, in seconds, is the
 * cast time at the clip's first frame: written to media.json as scene 4 `castOffsetSec`, so the
 * panes show what the agents printed at the moment the clip shows (negative: the agents started
 * after the clip, the panes wait).
 *
 * Usage: pnpm align-lanes [--log public/clips/orchestrator.log] [--dry-run]
 */
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { parseMedia, parseNarration } from '../src/data';
import { castEpochMs, parseLog } from './log-to-casts';
import { VIDEO_ROOT } from './placeholder-manifest';

export const LANES_SCENE = 's04-three-agents';

/** Cast seconds at the clip's first frame. */
export function laneOffsetSec(logText: string, marksText: string): number {
  const first = parseLog(logText).lines[0];
  if (!first) throw new Error('the orchestrator log has no timestamped lines');
  const marks = JSON.parse(marksText) as { startedAtMs?: unknown };
  if (typeof marks.startedAtMs !== 'number') throw new Error('the lanes clip marks have no startedAtMs (recapture scene 4 with pnpm capture)');
  return Math.round(marks.startedAtMs - castEpochMs(first.ms)) / 1000;
}

/** media.json text with scene 4's `castOffsetSec` set, the rest of the file unchanged. */
export function setCastOffset(mediaText: string, offsetSec: number): string {
  const head = `"${LANES_SCENE}": {`;
  const at = mediaText.indexOf(head);
  if (at < 0) throw new Error(`media.json has no "${LANES_SCENE}" scene`);
  const close = mediaText.indexOf('\n    }', at);
  const block = mediaText.slice(at, close < 0 ? undefined : close);
  const existing = /"castOffsetSec":\s*-?[\d.]+(e-?\d+)?/;
  const updated = existing.test(block)
    ? block.replace(existing, `"castOffsetSec": ${offsetSec}`)
    : block.replace(head, `${head}\n      "castOffsetSec": ${offsetSec},`);
  return mediaText.slice(0, at) + updated + (close < 0 ? '' : mediaText.slice(close));
}

function main(): void {
  const { values } = parseArgs({
    options: {
      log: { type: 'string', default: join(VIDEO_ROOT, 'public', 'clips', 'orchestrator.log') },
      'dry-run': { type: 'boolean' },
    },
    strict: true,
  });
  const mediaPath = join(VIDEO_ROOT, 'media.json');
  const narration = parseNarration(JSON.parse(readFileSync(join(VIDEO_ROOT, 'narration.json'), 'utf8')));
  const mediaText = readFileSync(mediaPath, 'utf8');
  const clip = parseMedia(JSON.parse(mediaText), narration).scenes[LANES_SCENE]?.clip;
  if (!clip) throw new Error(`media.json scene ${LANES_SCENE} has no clip`);
  const marks = join(VIDEO_ROOT, 'public', clip.src.replace(/\.[^./]+$/, '.marks.json'));
  for (const file of [values.log, marks]) if (!existsSync(file)) throw new Error(`${file} does not exist`);
  const offset = laneOffsetSec(readFileSync(values.log, 'utf8'), readFileSync(marks, 'utf8'));
  const next = setCastOffset(mediaText, offset);
  parseMedia(JSON.parse(next), narration);
  console.log(`align-lanes: the lane casts are at ${offset} s when the lanes clip starts`);
  if (values['dry-run']) return;
  writeFileSync(mediaPath, next);
  console.log(`  wrote "castOffsetSec": ${offset} to media.json scene ${LANES_SCENE}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(`align-lanes: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
