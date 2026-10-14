/**
 * Source-time windows for clips and casts (media.json `from` / `to` / `speed` / `maxIdleGapSec`).
 * Pure functions: the composition, `pnpm check:fit` and the tests share them.
 */
import type { Cast, CastEvent } from './asciinema';

export interface WindowSpec {
  from?: number | undefined;
  to?: number | undefined;
  speed?: number | undefined;
}

export interface ResolvedWindow {
  /** First source second shown. May be negative for an aligned cast: the pane waits that long. */
  from: number;
  /** Last source second shown, or undefined for "until the source ends". */
  to: number | undefined;
  speed: number;
}

/** The window of one file, its speed defaulting to the scene's. */
export function resolveWindow(spec: WindowSpec | undefined, sceneSpeed = 1): ResolvedWindow {
  return { from: spec?.from ?? 0, to: spec?.to, speed: spec?.speed ?? sceneSpeed };
}

/** Source second shown `t` composition seconds after the pane appears (held at `to`). */
export function sourceTimeAt(w: ResolvedWindow, t: number): number {
  const s = w.from + Math.max(0, t) * w.speed;
  return w.to === undefined ? s : Math.min(s, w.to);
}

/** Composition seconds the window plays before it reaches `to` (Infinity without `to`). */
export function playSeconds(w: ResolvedWindow): number {
  return w.to === undefined ? Number.POSITIVE_INFINITY : (w.to - w.from) / w.speed;
}

export interface VisibleWindow {
  /** Source seconds shown, first and last. */
  start: number;
  end: number;
  /** Composition seconds after the pane appears at which the picture stops moving, or null. */
  stopsAtSec: number | null;
  /** True when it stops because the source ran out (not at a chosen `to`). */
  runsOut: boolean;
}

/** What a pane shown for `durationSec` composition seconds plays of a `sourceSec`-long file. */
export function visibleWindow(w: ResolvedWindow, durationSec: number, sourceSec: number): VisibleWindow {
  const wanted = w.from + durationSec * w.speed;
  const limit = Math.min(w.to ?? Number.POSITIVE_INFINITY, sourceSec);
  const end = Math.min(wanted, limit);
  const stops = wanted > limit + 1e-6;
  return {
    start: Math.max(0, w.from),
    end,
    stopsAtSec: stops ? Math.max(0, (limit - w.from) / w.speed) : null,
    runsOut: stops && sourceSec < (w.to ?? Number.POSITIVE_INFINITY),
  };
}

/** Badge text for a compressed pane: "8× speed", "idle > 2 s cut", or both. */
export function badgeLabel(speed: number, maxIdleGapSec?: number): string | null {
  const parts = [
    ...(speed > 1 ? [`${Number(speed.toFixed(2))}× speed`] : []),
    ...(maxIdleGapSec !== undefined ? [`idle > ${Number(maxIdleGapSec.toFixed(2))} s cut`] : []),
  ];
  return parts.length > 0 ? parts.join(' · ') : null;
}

export interface CastWindowSpec {
  /** Source second shown first; output before it is applied at once. May be negative (delay). */
  from?: number | undefined;
  /** Events after this source second are dropped. */
  to?: number | undefined;
  /** Every silence longer than this is shortened to it. */
  maxIdleGapSec?: number | undefined;
}

export interface WindowedCast {
  /** The cast on the pane's own timeline (seconds from the pane's start, before speed). */
  cast: Cast;
  /** Source seconds (in the original cast) shown at `t` seconds of the windowed timeline. */
  toSourceSec: (t: number) => number;
}

/**
 * Re-times a cast for a pane: output before `from` is shown at once, output after `to` is dropped,
 * and idle gaps longer than `maxIdleGapSec` are shortened to it. Event order and content are kept.
 */
export function windowCast(cast: Cast, spec: CastWindowSpec): WindowedCast {
  const from = spec.from ?? 0;
  const cap = spec.maxIdleGapSec;
  const kept = cast.events.filter((e) => spec.to === undefined || e.time <= spec.to);
  // anchors: [windowed time, shifted source time] at each event
  const anchors: Array<[number, number]> = [];
  let prevShifted = 0;
  let prevNew = 0;
  const events: CastEvent[] = kept.map((e) => {
    const shifted = Math.max(0, e.time - from);
    const gap = shifted - prevShifted;
    const time = prevNew + (cap === undefined ? gap : Math.min(gap, cap));
    anchors.push([time, shifted]);
    prevShifted = shifted;
    prevNew = time;
    return { ...e, time };
  });
  const toSourceSec = (t: number): number => {
    let lo = 0;
    let hi = anchors.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (anchors[mid]![0] <= t) lo = mid + 1;
      else hi = mid;
    }
    const i = lo - 1;
    if (i < 0) return from + t;
    const [newAt, shiftedAt] = anchors[i]!;
    const next = anchors[i + 1];
    const elapsed = t - newAt;
    // inside a shortened gap the clock runs at real speed, then jumps to the next event
    const shifted = next ? shiftedAt + Math.min(elapsed, next[1] - shiftedAt) : shiftedAt + elapsed;
    return from + shifted;
  };
  return { cast: { header: cast.header, events }, toSourceSec };
}

const windowed = new WeakMap<Cast, Map<string, WindowedCast>>();

/** `windowCast`, cached per cast and spec so the incremental player keeps its state across frames. */
export function windowCastCached(cast: Cast, spec: CastWindowSpec): WindowedCast {
  const key = `${spec.from ?? 0}|${spec.to ?? ''}|${spec.maxIdleGapSec ?? ''}`;
  let byKey = windowed.get(cast);
  if (!byKey) {
    byKey = new Map();
    windowed.set(cast, byKey);
  }
  let hit = byKey.get(key);
  if (!hit) {
    hit = windowCast(cast, spec);
    byKey.set(key, hit);
  }
  return hit;
}

/** Last event time of a cast (its source length in seconds). */
export function castLengthSec(cast: Cast): number {
  return cast.events.at(-1)?.time ?? 0;
}

/** `HH:MM:SS UTC` for an epoch millisecond (render hosts differ in time zone). */
export function wallClock(epochMs: number): string {
  return `${new Date(epochMs).toISOString().slice(11, 19)} UTC`;
}
