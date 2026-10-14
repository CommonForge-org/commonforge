import type { Narration, NarrationScene } from './data';

/** Default `minDurationSec` of the title (first) and close (last) scenes. */
export const BOOKEND_MIN_SEC = 3;

/** Length of the cross-fade between consecutive scenes. */
export const TRANSITION_FRAMES = 12;

export interface SceneTiming {
  id: string;
  /** First frame of the scene (and of its narration) on the composition timeline. */
  from: number;
  durationInFrames: number;
}

/** Seconds to whole frames, rounding up so narration is never cut, ignoring float noise. */
function toFrames(seconds: number, fps: number): number {
  return Math.ceil(seconds * fps - 1e-6);
}

/** The scene's minimum length: its own `minDurationSec`, else 3 s for the title and close. */
export function minDurationSec(scene: NarrationScene, index: number, count: number): number {
  const isBookend = index === 0 || index === count - 1;
  return scene.minDurationSec ?? (isBookend ? BOOKEND_MIN_SEC : 0);
}

/** A scene's length in seconds: its narration audio, or its minimum when that is longer. */
export function sceneSeconds(scene: NarrationScene, index: number, count: number): number {
  return Math.max(scene.durationSec, minDurationSec(scene, index, count));
}

/**
 * Scene placement derived from narration audio durations (`max(audio, minDurationSec)`).
 *
 * Each scene but the last is padded by `overlapFrames`, the length of the
 * transition into the next scene. Overlapping transitions consume exactly that
 * padding, so each scene's narration ends where the next one's starts and the
 * total equals the summed scene lengths.
 */
export function sceneFrames(narration: Narration, fps: number, overlapFrames = 0): SceneTiming[] {
  const count = narration.scenes.length;
  let from = 0;
  return narration.scenes.map((scene, index) => {
    const contentFrames = toFrames(sceneSeconds(scene, index, count), fps);
    const timing = {
      id: scene.id,
      from,
      durationInFrames: contentFrames + (index === count - 1 ? 0 : overlapFrames),
    };
    from += contentFrames;
    return timing;
  });
}

/** Composition length for scenes laid out by `sceneFrames`. */
export function totalFrames(timings: SceneTiming[]): number {
  const last = timings.at(-1);
  return last ? last.from + last.durationInFrames : 0;
}
