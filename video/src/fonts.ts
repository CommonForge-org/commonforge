/**
 * Loads IBM Plex Sans and IBM Plex Mono (Google Fonts, via @remotion/google-fonts metadata)
 * before the first frame renders. Unlike the package's own `loadFont()`, a font that cannot load
 * (offline render host, blocked network) does not stall or fail the render: the warning is logged
 * and the theme's system-font fallbacks in `theme.font` are used.
 */
import { getInfo as plexMonoInfo } from '@remotion/google-fonts/IBMPlexMono';
import { getInfo as plexSansInfo } from '@remotion/google-fonts/IBMPlexSans';
import { useEffect, useState } from 'react';
import { continueRender, delayRender } from 'remotion';

/** Weights the composition uses; anything heavier is clamped to 700 by the browser. */
const FAMILIES = [
  { info: plexSansInfo, weights: ['400', '500', '600', '700'] },
  { info: plexMonoInfo, weights: ['400', '700'] },
] as const;
const SUBSETS = ['latin', 'latin-ext'] as const;
/** Give up on a font well before Remotion's delayRender timeout (30 s). */
const LOAD_TIMEOUT_MS = 12_000;

let started = false;
let settled = false;
const listeners = new Set<() => void>();

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Starts loading the brand fonts once per page; rendering waits until each has loaded or failed. */
export function loadBrandFonts(): void {
  if (started || typeof document === 'undefined' || typeof FontFace === 'undefined') return;
  started = true;
  const handle = delayRender('Loading IBM Plex fonts');
  const loads: Array<Promise<unknown>> = [];
  for (const { info, weights } of FAMILIES) {
    const meta = info();
    for (const weight of weights) {
      for (const subset of SUBSETS) {
        const url = meta.fonts.normal?.[weight]?.[subset];
        if (!url) continue;
        const face = new FontFace(meta.fontFamily, `url(${url}) format('woff2')`, {
          weight,
          style: 'normal',
          unicodeRange: meta.unicodeRanges[subset],
        });
        loads.push(
          withTimeout(face.load(), LOAD_TIMEOUT_MS, `${meta.fontFamily} ${weight} ${subset}`).then(() => document.fonts.add(face)),
        );
      }
    }
  }
  void Promise.allSettled(loads).then((results) => {
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed.length > 0) {
      const reason = failed[0]!.reason instanceof Error ? failed[0]!.reason.message : String(failed[0]!.reason);
      console.warn(`IBM Plex: ${failed.length} of ${results.length} font files did not load (${reason}); using system fonts for those`);
    }
    settled = true;
    for (const listener of listeners) listener();
    // Let components that measured text re-render with the real fonts before the frame is taken.
    setTimeout(() => continueRender(handle), 0);
  });
}

/**
 * True once the brand fonts have loaded or failed. Components that measure text use it as a
 * memo key, so a measurement taken with fallback metrics before the fonts arrived is redone.
 */
export function useBrandFontsSettled(): boolean {
  const [value, setValue] = useState(settled);
  useEffect(() => {
    if (settled) {
      setValue(true);
      return undefined;
    }
    const listener = () => setValue(true);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return value;
}

let canvas: HTMLCanvasElement | null = null;

/** Rendered width in px of one line of text (browser only). */
export function textWidth(text: string, font: { family: string; size: number; weight: number }): number {
  canvas ??= document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) throw new Error('no 2d canvas context to measure text');
  context.font = `${font.weight} ${font.size}px ${font.family}`;
  return context.measureText(text).width;
}
