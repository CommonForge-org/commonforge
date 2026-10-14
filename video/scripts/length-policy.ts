/**
 * Competition rule: the video runs 5 to 10 minutes. Scene lengths come from narration.json
 * (`max(audio, minDurationSec)`, src/timing.ts); `pnpm narration:build` warns when the total is
 * outside the limits and the final-render guard (check-no-placeholders.ts) refuses.
 */
import type { Narration } from '../src/data';
import { VIDEO } from '../src/theme';
import { sceneFrames, sceneSeconds, totalFrames, TRANSITION_FRAMES } from '../src/timing';

export const LENGTH_LIMITS_SEC = { min: 5 * 60, max: 10 * 60 } as const;

export interface LengthReport {
  scenes: Array<{ id: string; audioSec: number; minSec: number | undefined; lengthSec: number }>;
  /** Composition length (seconds) as rendered: whole frames, cross-fades included. */
  totalSec: number;
}

export function lengthReport(narration: Narration, fps: number = VIDEO.fps): LengthReport {
  const count = narration.scenes.length;
  return {
    scenes: narration.scenes.map((s, i) => ({ id: s.id, audioSec: s.durationSec, minSec: s.minDurationSec, lengthSec: sceneSeconds(s, i, count) })),
    totalSec: totalFrames(sceneFrames(narration, fps, TRANSITION_FRAMES)) / fps,
  };
}

/** `m:ss.s` */
export function clock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  return `${m}:${(seconds - m * 60).toFixed(1).padStart(4, '0')}`;
}

/** Why the total breaks the competition limits, or null when it is within them. */
export function lengthProblem(report: LengthReport): string | null {
  const { min, max } = LENGTH_LIMITS_SEC;
  if (report.totalSec < min) return `the video is ${clock(report.totalSec)}, under the ${clock(min)} minimum`;
  if (report.totalSec > max) return `the video is ${clock(report.totalSec)}, over the ${clock(max)} maximum`;
  return null;
}

/** One line per scene: audio, minimum and resulting length, then the total. */
export function formatLengths(report: LengthReport): string {
  const rows = report.scenes.map(
    (s) =>
      `  ${s.id.padEnd(22)} audio ${s.audioSec.toFixed(2).padStart(7)} s  min ${s.minSec === undefined ? '      -' : `${s.minSec.toFixed(2).padStart(7)} s`}  → ${s.lengthSec.toFixed(2).padStart(7)} s`,
  );
  return [...rows, `  total ${clock(report.totalSec)} (limits ${clock(LENGTH_LIMITS_SEC.min)}–${clock(LENGTH_LIMITS_SEC.max)})`].join('\n');
}
