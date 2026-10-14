/**
 * Does the footage fit the scenes? For every scene: how long each pane is on screen, the source
 * window it plays (media.json from/to/speed, maxIdleGapSec) against the source length (ffprobe for
 * clips, the last event for casts), and each clip's `.marks.json` beats inside or outside that
 * window. Flags a clip that stops before its pane does (it freezes on its last frame), marks that
 * fall outside the shown window, casts whose output runs past the pane, and missing files.
 *
 * Usage: pnpm check:fit   (exit 1 when anything is flagged)
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseMedia, parseNarration, type Media, type Narration } from '../src/data';
import { parseCast, type Cast } from '../src/lib/asciinema';
import { castLengthSec, visibleWindow, windowCast } from '../src/lib/media-window';
import { sceneSlots, type Slot } from '../src/scenes/layout';
import { VIDEO } from '../src/theme';
import { sceneFrames, TRANSITION_FRAMES } from '../src/timing';
import { VIDEO_ROOT } from './placeholder-manifest';

export interface Mark {
  name: string;
  t: number;
}

/** What check-fit reads from disk; injected in tests. */
export interface FitProbe {
  /** Clip length in seconds, or null when the file is missing. */
  clipSec: (src: string) => number | null;
  /** The clip's `.marks.json` beats (seconds from the clip's first frame), or null without one. */
  marks: (src: string) => Mark[] | null;
  /** The parsed cast, or null when the file is missing. */
  cast: (src: string) => Cast | null;
  /** Whether a screenshot exists. */
  exists: (src: string) => boolean;
}

export interface FitLine {
  scene: string;
  src: string;
  text: string;
  problems: string[];
}

const s = (n: number) => `${n.toFixed(1)} s`;

function fitClip(scene: string, slot: Slot, probe: FitProbe): FitLine {
  const w = slot.window!;
  const sourceSec = probe.clipSec(slot.src);
  const shown = `on screen ${s(slot.startSec)}–${s(slot.startSec + slot.durationSec)}`;
  if (sourceSec === null) return { scene, src: slot.src, text: `${shown}; MISSING`, problems: [`${slot.src} is missing`] };
  const vis = visibleWindow(w, slot.durationSec, sourceSec);
  const problems: string[] = [];
  if (vis.stopsAtSec !== null) {
    const at = slot.startSec + vis.stopsAtSec;
    const held = slot.durationSec - vis.stopsAtSec;
    problems.push(
      vis.runsOut
        ? `${slot.src} ends (source ${s(sourceSec)}) ${s(held)} before its pane does: frozen from ${s(at)} of the scene; trim with from/to, raise speed or capture longer`
        : `${slot.src} holds its frame at to=${s(w.to!)} for the last ${s(held)} of its pane (from ${s(at)} of the scene)`,
    );
  }
  const marks = probe.marks(slot.src);
  const markText =
    marks === null
      ? 'no marks'
      : marks
          .map((m) => {
            const inside = m.t >= vis.start - 1e-6 && m.t <= vis.end + 1e-6;
            if (!inside) problems.push(`${slot.src} mark "${m.name}" at ${s(m.t)} is outside the shown window ${s(vis.start)}–${s(vis.end)}`);
            // callout t is seconds after the clip appears: (mark - from) / speed
            return inside ? `${m.name}@${s(m.t)} (callout t ${s((m.t - w.from) / w.speed)})` : `${m.name}@${s(m.t)} OUTSIDE`;
          })
          .join(', ');
  return {
    scene,
    src: slot.src,
    text: `${shown}; source ${s(sourceSec)}; shows ${s(vis.start)}–${s(vis.end)} at ${w.speed}×; marks: ${markText || 'none'}`,
    problems,
  };
}

function fitCast(scene: string, slot: Slot, probe: FitProbe): FitLine {
  const w = slot.window!;
  const cast = probe.cast(slot.src);
  const shown = `on screen ${s(slot.startSec)}–${s(slot.startSec + slot.durationSec)}`;
  if (cast === null) return { scene, src: slot.src, text: `${shown}; MISSING`, problems: [`${slot.src} is missing`] };
  const windowed = windowCast(cast, { from: w.from, to: w.to, maxIdleGapSec: slot.maxIdleGapSec });
  const needSec = castLengthSec(windowed.cast) / w.speed;
  const problems: string[] = [];
  if (needSec > slot.durationSec + 1e-6) {
    const lastShown = windowed.toSourceSec(slot.durationSec * w.speed);
    problems.push(`${slot.src} output after source ${s(lastShown)} is never shown (needs ${s(needSec)} on screen, has ${s(slot.durationSec)}); raise speed, set maxIdleGapSec or to`);
  }
  const gap = slot.maxIdleGapSec !== undefined ? `, idle gaps > ${s(slot.maxIdleGapSec)} cut` : '';
  return {
    scene,
    src: slot.src,
    text: `${shown}; source ${s(castLengthSec(cast))} (last event); window from ${s(w.from)}${w.to !== undefined ? ` to ${s(w.to)}` : ''} at ${w.speed}×${gap} → ${s(needSec)} of output`,
    problems,
  };
}

/** One line per pane of every scene, with what is wrong with it. */
export function checkFit(narration: Narration, media: Media, probe: FitProbe, fps: number = VIDEO.fps): FitLine[] {
  const timings = sceneFrames(narration, fps, TRANSITION_FRAMES);
  return narration.scenes.flatMap((scene, i) => {
    const sceneSec = timings[i]!.durationInFrames / fps;
    return sceneSlots(scene.id, media.scenes[scene.id] ?? {}, sceneSec).map((slot): FitLine => {
      if (slot.kind === 'clip' || slot.kind === 'insert') return fitClip(scene.id, slot, probe);
      if (slot.kind === 'cast') return fitCast(scene.id, slot, probe);
      const ok = probe.exists(slot.src);
      return { scene: scene.id, src: slot.src, text: `on screen ${s(slot.startSec)}–${s(slot.startSec + slot.durationSec)}${ok ? '' : '; MISSING'}`, problems: ok ? [] : [`${slot.src} is missing`] };
    });
  });
}

/** Clip length: the container duration, else the last video packet (Playwright WebMs may lack one). */
export function probeClipSec(file: string, ffprobe = process.env.FFPROBE ?? 'ffprobe'): number {
  const format = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file], { encoding: 'utf8' });
  const duration = Number.parseFloat(format.stdout?.trim() ?? '');
  if (format.status === 0 && Number.isFinite(duration) && duration > 0) return duration;
  const packets = spawnSync(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const times = (packets.stdout ?? '').split('\n').map(Number.parseFloat).filter(Number.isFinite);
  if (packets.status !== 0 || times.length === 0) throw new Error(`ffprobe cannot read the length of ${file}`);
  return Math.max(...times);
}

function diskProbe(publicDir: string): FitProbe {
  const path = (src: string) => join(publicDir, src);
  return {
    clipSec: (src) => (existsSync(path(src)) ? probeClipSec(path(src)) : null),
    marks: (src) => {
      const file = path(src).replace(/\.[^./]+$/, '.marks.json');
      if (!existsSync(file)) return null;
      return ((JSON.parse(readFileSync(file, 'utf8')) as { marks?: Mark[] }).marks ?? []).filter((m) => typeof m.t === 'number');
    },
    cast: (src) => (existsSync(path(src)) ? parseCast(readFileSync(path(src), 'utf8')) : null),
    exists: (src) => existsSync(path(src)),
  };
}

function main(): void {
  const narration = parseNarration(JSON.parse(readFileSync(join(VIDEO_ROOT, 'narration.json'), 'utf8')));
  const media = parseMedia(JSON.parse(readFileSync(join(VIDEO_ROOT, 'media.json'), 'utf8')), narration);
  const lines = checkFit(narration, media, diskProbe(join(VIDEO_ROOT, 'public')));
  let scene = '';
  for (const line of lines) {
    if (line.scene !== scene) {
      scene = line.scene;
      console.log(scene);
    }
    console.log(`  ${line.src}: ${line.text}`);
    for (const problem of line.problems) console.log(`    FLAG: ${problem}`);
  }
  const flagged = lines.flatMap((l) => l.problems);
  if (flagged.length > 0) {
    console.error(`check:fit: ${flagged.length} problem(s); see FLAG lines`);
    process.exitCode = 1;
  } else {
    console.log('check:fit: every pane has footage for its whole time on screen');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(`check-fit: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
