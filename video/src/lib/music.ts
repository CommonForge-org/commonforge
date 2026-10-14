/** Music bed level over the composition: ducked under narration, faded out at the end. */

/** Base gain of the bed (no narration). */
export const MUSIC_GAIN = 0.08;
/** Ducking under narration: −6 dB. */
export const DUCK_DB = -6;
/** Fade-out at the end of the video. */
export const FADE_OUT_SEC = 1.5;
/** Ramp into and out of a duck, so the bed does not jump. */
export const DUCK_RAMP_SEC = 0.25;

export interface MusicPlan {
  fps: number;
  totalFrames: number;
  /** Frames [from, to) during which narration audio plays. */
  speech: Array<[number, number]>;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** 0 outside narration, 1 inside it, ramping linearly over DUCK_RAMP_SEC at each edge. */
function speechAmount(frame: number, plan: MusicPlan): number {
  const ramp = Math.max(1, DUCK_RAMP_SEC * plan.fps);
  let amount = 0;
  for (const [from, to] of plan.speech) {
    const into = clamp01((frame - (from - ramp)) / ramp);
    const outOf = clamp01((to + ramp - frame) / ramp);
    amount = Math.max(amount, Math.min(into, outOf));
  }
  return amount;
}

/** The bed's volume at `frame`: MUSIC_GAIN, −6 dB under narration, fading to 0 over the last 1.5 s. */
export function musicGain(frame: number, plan: MusicPlan): number {
  const duck = 10 ** (DUCK_DB / 20);
  const level = 1 + (duck - 1) * speechAmount(frame, plan);
  const fade = clamp01((plan.totalFrames - frame) / (FADE_OUT_SEC * plan.fps));
  return MUSIC_GAIN * level * fade;
}
