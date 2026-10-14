/**
 * When each scene shows each of its media.json files, in seconds from the scene start. The scene
 * components place their panes with it and `pnpm check:fit` checks the footage against it, so the
 * two cannot drift. Pure module: no React, no Remotion.
 */
import type { CastRef, ClipRef, MediaScene } from '../data';
import { resolveWindow, type ResolvedWindow } from '../lib/media-window';

/** Scene 1: the client's folder is shown this long before the intake inventory and the project tree. */
export const FOLDER_SEC = 8;
/** Scene 5: the evidence-panel screenshot takes over for the last this-many seconds (at most half the scene). */
export const ZOOM_SEC = 16;
/** Scene 7: the split-screen hash comparison runs this long (at most half the scene) before the publish clip. */
export const SPLIT_SEC = 25;
/** Scene 8: fractions of the scene at which each terminal pane appears (release, then export). */
export const RELEASE_AT = 0.3;
export const EXPORT_AT = 0.6;
/** Scene 3: share of the scene the owner's insert gets when its window has no `to`. */
export const INSERT_SHARE = 0.5;

export interface Slot {
  kind: 'clip' | 'insert' | 'cast' | 'shot';
  src: string;
  /** Seconds from the scene start at which the pane appears, and how long it stays. */
  startSec: number;
  durationSec: number;
  /** Clips and casts: the source window played. */
  window?: ResolvedWindow;
  /** Casts: idle-gap cap. */
  maxIdleGapSec?: number;
}

function clipSlot(kind: 'clip' | 'insert', ref: ClipRef, sceneSpeed: number, startSec: number, durationSec: number): Slot {
  return { kind, src: ref.src, startSec, durationSec, window: resolveWindow(ref, sceneSpeed) };
}

function castSlot(ref: CastRef, sceneSpeed: number, startSec: number, durationSec: number): Slot {
  return {
    kind: 'cast',
    src: ref.src,
    startSec,
    durationSec,
    window: resolveWindow(ref, sceneSpeed),
    ...(ref.maxIdleGapSec !== undefined ? { maxIdleGapSec: ref.maxIdleGapSec } : {}),
  };
}

/** Seconds the scene 3 insert stays before the return clip. */
export function insertSeconds(insert: ClipRef, sceneSpeed: number, sceneSec: number): number {
  const w = resolveWindow(insert, sceneSpeed);
  const own = w.to === undefined ? sceneSec * INSERT_SHARE : (w.to - w.from) / w.speed;
  return Math.min(own, sceneSec);
}

/**
 * Scene 4's agent lanes: aligned to the lanes clip when `castOffsetSec` is set (each cast starts at
 * the clip's wall-clock time and plays at the clip's speed), otherwise their own windows.
 */
export function laneWindow(media: MediaScene, cast: CastRef): ResolvedWindow {
  const speed = media.speed ?? 1;
  if (media.castOffsetSec === undefined) return resolveWindow(cast, speed);
  const clip = resolveWindow(media.clip, speed);
  return { from: media.castOffsetSec + clip.from, to: cast.to, speed: clip.speed };
}

/** The panes of a scene `sceneSec` long. */
export function sceneSlots(sceneId: string, media: MediaScene, sceneSec: number): Slot[] {
  const speed = media.speed ?? 1;
  const clip = media.clip;
  const casts = media.casts ?? [];
  switch (sceneId) {
    case 's01-mess': {
      const folder = media.shots?.[0];
      const paneFrom = folder ? Math.min(FOLDER_SEC, sceneSec) : 0;
      return [
        ...(folder ? [{ kind: 'shot' as const, src: folder, startSec: 0, durationSec: paneFrom }] : []),
        ...casts.slice(0, 1).map((c) => castSlot(c, speed, paneFrom, sceneSec - paneFrom)),
        ...(clip ? [clipSlot('clip', clip, speed, paneFrom, sceneSec - paneFrom)] : []),
      ];
    }
    case 's03-own-tool': {
      const insert = media.insert;
      const insertSec = insert ? insertSeconds(insert, speed, sceneSec) : 0;
      return [
        ...(insert ? [clipSlot('insert', insert, speed, 0, insertSec)] : []),
        ...(clip ? [clipSlot('clip', clip, speed, insertSec, sceneSec - insertSec)] : []),
      ];
    }
    case 's04-three-agents':
      return [
        ...(clip ? [clipSlot('clip', clip, speed, 0, sceneSec)] : []),
        ...casts.map((c) => ({ ...castSlot(c, speed, 0, sceneSec), window: laneWindow(media, c) })),
      ];
    case 's05-collision': {
      const shot = media.shots?.[0];
      const zoomSec = shot ? Math.min(ZOOM_SEC, sceneSec / 2) : 0;
      return [
        ...(clip ? [clipSlot('clip', clip, speed, 0, sceneSec - zoomSec)] : []),
        ...(shot ? [{ kind: 'shot' as const, src: shot, startSec: sceneSec - zoomSec, durationSec: zoomSec }] : []),
      ];
    }
    case 's07-approve-publish': {
      const splitSec = Math.min(SPLIT_SEC, sceneSec / 2);
      return [
        ...(media.shots ?? []).slice(0, 2).map((src) => ({ kind: 'shot' as const, src, startSec: 0, durationSec: splitSec })),
        ...(clip ? [clipSlot('clip', clip, speed, splitSec, sceneSec - splitSec)] : []),
      ];
    }
    case 's08-restore-export': {
      const at = [RELEASE_AT, EXPORT_AT];
      return [
        ...(clip ? [clipSlot('clip', clip, speed, 0, sceneSec)] : []),
        ...casts.slice(0, 2).map((c, i) => castSlot(c, speed, sceneSec * at[i]!, sceneSec * (1 - at[i]!))),
      ];
    }
    default:
      // s02, s06 and any scene showing its clip and casts for the whole scene
      return [
        ...(clip ? [clipSlot('clip', clip, speed, 0, sceneSec)] : []),
        ...casts.map((c) => castSlot(c, speed, 0, sceneSec)),
        ...(media.shots ?? []).map((src) => ({ kind: 'shot' as const, src, startSec: 0, durationSec: sceneSec })),
      ];
  }
}
