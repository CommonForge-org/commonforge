/**
 * Generates placeholder media for every file referenced by narration.json and
 * media.json so the composition renders end to end before real capture:
 *   - clips (.webm): coloured frame with "PLACEHOLDER" burned in plus a progress bar
 *   - screenshots (.png): same label, single frame
 *   - narration (.m4a/.mp3/.wav): silence of the scene's durationSec
 *   - casts (.cast): a short asciinema v2 sample labelled PLACEHOLDER
 *   - hashes.json: PLACEHOLDER review codes
 * Every generated file carries an intrinsic marker (scripts/placeholder-marker.ts: WebM title,
 * PNG tEXt comment, cast title, hash text; silence for audio) and is recorded (size, sha256) in
 * .placeholder-manifest.json; the final-render guard and `pnpm evidence` check both.
 * Existing files are kept (they may be real captures). --force regenerates only files that are
 * still placeholders (recorded or marked; silent narration audio) and never a file beside a
 * cookie-mode `.marks.json` (a live capture).
 *
 * Usage: pnpm placeholders [--force]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseMedia, parseNarration, type Media, type Narration } from '../src/data';
import { sceneSlots } from '../src/scenes/layout';
import { ffmpegColour, hexToRgb, theme, VIDEO } from '../src/theme';
import { sceneFrames, TRANSITION_FRAMES } from '../src/timing';
import { isSilent } from './build-narration-json';
import { Canvas } from './pixel-font';
import { isRecordedPlaceholder, readPlaceholderManifest, recordPlaceholder, writePlaceholderManifest, type PlaceholderManifest } from './placeholder-manifest';
import { hasPlaceholderMarker, markPng, MARKER } from './placeholder-marker';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FFMPEG = process.env.FFMPEG ?? 'ffmpeg';

const CLIP_SIZE = { width: 1280, height: 720 };
const SHOT_SIZE = { width: 1920, height: 1080 };
/** Extra clip length beyond what the scene can show, so footage never runs out. */
const CLIP_MARGIN_SEC = 2;

const amber = hexToRgb(theme.color.amber);
const label = hexToRgb(theme.color.text);

function ffmpeg(args: string[]): void {
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
}

function labelFrame(size: { width: number; height: number }, colour: string, file: string, sceneId: string): Canvas {
  const canvas = new Canvas(size.width, size.height, hexToRgb(colour));
  const band = Math.round(size.height * 0.035);
  // Amber bands top and bottom make the frame unmistakable even when scaled down.
  canvas.fillRect(0, 0, size.width, band, amber);
  canvas.fillRect(0, size.height - band, size.width, band, amber);
  const unit = size.height / 720;
  canvas.textCentered('PLACEHOLDER', size.height * 0.38, Math.round(16 * unit), label);
  canvas.textCentered('NOT REAL FOOTAGE', size.height * 0.54, Math.round(5 * unit), amber);
  canvas.textCentered(basename(file), size.height * 0.66, Math.round(4 * unit), label);
  canvas.textCentered(sceneId, size.height * 0.74, Math.round(3 * unit), label);
  return canvas;
}

function writeClip(target: string, durationSec: number, colour: string, sceneId: string, scratch: string): void {
  const frame = join(scratch, 'frame.ppm');
  writeFileSync(frame, labelFrame(CLIP_SIZE, colour, target, sceneId).toPpm());
  const d = durationSec.toFixed(2);
  // A bar sweeps left to right over the clip's length, so playback speed and position are visible.
  ffmpeg([
    '-loop', '1', '-framerate', '30', '-i', frame,
    '-f', 'lavfi', '-i', `color=c=${ffmpegColour(theme.color.accent)}:s=${CLIP_SIZE.width / 16}x24:r=30`,
    '-filter_complex', `[0:v][1:v]overlay=x='(W-w)*t/${d}':y=H-80,format=yuv420p`,
    '-t', d, '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '400k', '-an',
    '-metadata', `title=${MARKER}`,
    target,
  ]);
}

function writeShot(target: string, colour: string, sceneId: string, scratch: string): void {
  const frame = join(scratch, 'shot.ppm');
  writeFileSync(frame, labelFrame(SHOT_SIZE, colour, target, sceneId).toPpm());
  ffmpeg(['-i', frame, '-frames:v', '1', target]);
  markPng(target);
}

function writeSilence(target: string, durationSec: number): void {
  const ext = extname(target);
  // WAV is uncompressed PCM: no codec choice, no bitrate.
  const codec = ext === '.wav' ? [] : [...(ext === '.mp3' ? ['-c:a', 'libmp3lame'] : ['-c:a', 'aac']), '-b:a', '96k'];
  ffmpeg(['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', durationSec.toFixed(3), ...codec, target]);
}

function writeCast(target: string): void {
  const name = basename(target);
  const lines: Array<[number, string]> = [
    [0.5, `$ \x1b[1mecho\x1b[0m "sample cast: ${name}"\r\n`],
    [1.5, '\x1b[1;33mPLACEHOLDER\x1b[0m replace with a real asciinema recording\r\n'],
    [3.0, '$ git clone https://example.invalid/canonical/website.git\r\n'],
    [4.5, "\x1b[31mfatal: repository access denied (placeholder)\x1b[0m\r\n"],
    [6.0, '$ git clone https://example.invalid/edition/website.git\r\n'],
    [7.5, "\x1b[32mCloning into 'website'... done (placeholder)\x1b[0m\r\n"],
    [9.0, '$ git log --oneline | wc -l\r\n'],
    [10.0, '\x1b[38;5;45m1\x1b[0m\r\n'],
    [11.0, '$ '],
  ];
  const header = { version: 2, width: 80, height: 18, title: `PLACEHOLDER ${name}` };
  writeFileSync(target, [JSON.stringify(header), ...lines.map(([t, data]) => JSON.stringify([t, 'o', data]))].join('\n') + '\n');
}

function writeHashes(target: string): void {
  writeFileSync(target, `${JSON.stringify({ blocked: { hash: `${MARKER}-BLOCKED` }, fixed: { hash: `${MARKER}-FIXED` } }, null, 2)}\n`);
}

export type Decision = { make: true } | { make: false; reason: string };

export interface DecideContext {
  force: boolean;
  publicDir: string;
  manifest: PlaceholderManifest;
  /** Narration audio: silent audio counts as a placeholder. */
  audio?: boolean;
  isSilent: (file: string) => boolean;
  hasMarker: (file: string) => boolean;
}

/** `<name>.marks.json` beside `file` records a cookie-mode (live) capture. */
export function hasCookieMarks(file: string): boolean {
  const marks = file.replace(/\.[^./]+$/, '.marks.json');
  if (marks === file || !existsSync(marks)) return false;
  try {
    return (JSON.parse(readFileSync(marks, 'utf8')) as { mode?: unknown }).mode === 'cookie';
  } catch {
    return false;
  }
}

/**
 * Whether to (re)generate the placeholder at `relPath`: always when missing; with --force only
 * while the file is still a placeholder, never a live capture or other real media.
 */
export function decide(relPath: string, c: DecideContext): Decision {
  const file = join(c.publicDir, relPath);
  if (!existsSync(file)) return { make: true };
  if (!c.force) return { make: false, reason: 'exists' };
  if (hasCookieMarks(file)) return { make: false, reason: 'live capture (cookie-mode .marks.json); --force never overwrites it' };
  if (isRecordedPlaceholder(c.manifest, c.publicDir, relPath) || c.hasMarker(file)) return { make: true };
  if (c.audio && c.isSilent(file)) return { make: true };
  return { make: false, reason: `${c.audio ? 'real narration' : 'real media'} (not a placeholder); --force never overwrites it` };
}

export interface Writers {
  silence: (target: string, seconds: number) => void;
  clip: (target: string, seconds: number, colour: string, sceneId: string) => void;
  shot: (target: string, colour: string, sceneId: string) => void;
  cast: (target: string) => void;
  hashes: (target: string) => void;
}

export interface PlaceholderOptions {
  publicDir: string;
  narration: Narration;
  media: Media;
  manifest: PlaceholderManifest;
  force: boolean;
  writers: Writers;
  isSilent?: (file: string) => boolean;
  hasMarker?: (file: string) => boolean;
  log?: (line: string) => void;
}

/** Source seconds a clip needs so it never runs out on screen (window end plus a margin). */
function clipSeconds(window: { from: number; to: number | undefined; speed: number }, durationSec: number): number {
  return (window.to ?? window.from + durationSec * window.speed) + CLIP_MARGIN_SEC;
}

/** Generates the missing (or, with force, still-placeholder) media; returns the counts. */
export function makePlaceholders(o: PlaceholderOptions): { made: number; kept: number } {
  const log = o.log ?? console.log;
  const timings = sceneFrames(o.narration, VIDEO.fps, TRANSITION_FRAMES);
  let made = 0;
  let kept = 0;
  const ctx = { force: o.force, publicDir: o.publicDir, manifest: o.manifest, isSilent: o.isSilent ?? ((f: string) => isSilent(f)), hasMarker: o.hasMarker ?? ((f: string) => hasPlaceholderMarker(f)) };
  const ensure = (path: string, make: (target: string) => void, audio = false): void => {
    const decision = decide(path, { ...ctx, audio });
    if (!decision.make) {
      kept += 1;
      if (o.force) log(`  kept ${path} (${decision.reason})`);
      return;
    }
    const target = join(o.publicDir, path);
    mkdirSync(dirname(target), { recursive: true });
    make(target);
    recordPlaceholder(o.manifest, o.publicDir, path);
    made += 1;
    log(`  made ${path}`);
  };

  o.narration.scenes.forEach((scene, index) => {
    const colour = theme.placeholderScenes[index % theme.placeholderScenes.length]!;
    const entry = o.media.scenes[scene.id] ?? {};
    const sceneSec = timings[index]!.durationInFrames / VIDEO.fps;
    ensure(scene.audio, (t) => o.writers.silence(t, scene.durationSec), true);
    for (const slot of sceneSlots(scene.id, entry, sceneSec)) {
      if (slot.kind === 'clip' || slot.kind === 'insert') ensure(slot.src, (t) => o.writers.clip(t, clipSeconds(slot.window!, slot.durationSec), colour, scene.id));
      else if (slot.kind === 'shot') ensure(slot.src, (t) => o.writers.shot(t, colour, scene.id));
      else ensure(slot.src, o.writers.cast);
    }
  });
  if (o.media.hashes) ensure(o.media.hashes, o.writers.hashes);
  return { made, kept };
}

function main(): void {
  const force = process.argv.includes('--force');
  const publicDir = join(ROOT, 'public');
  const narration = parseNarration(JSON.parse(readFileSync(join(ROOT, 'narration.json'), 'utf8')));
  const media = parseMedia(JSON.parse(readFileSync(join(ROOT, 'media.json'), 'utf8')), narration);
  const manifest = readPlaceholderManifest();
  const scratch = mkdtempSync(join(tmpdir(), 'cf-placeholders-'));
  let counts = { made: 0, kept: 0 };
  try {
    counts = makePlaceholders({
      publicDir,
      narration,
      media,
      manifest,
      force,
      writers: {
        silence: writeSilence,
        clip: (t, seconds, colour, sceneId) => writeClip(t, seconds, colour, sceneId, scratch),
        shot: (t, colour, sceneId) => writeShot(t, colour, sceneId, scratch),
        cast: writeCast,
        hashes: writeHashes,
      },
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    // drop entries whose file was deleted or replaced by real media
    for (const path of Object.keys(manifest.files)) {
      if (!isRecordedPlaceholder(manifest, publicDir, path)) delete manifest.files[path];
    }
    writePlaceholderManifest(manifest);
  }
  const remaining = Object.keys(manifest.files).length;
  console.log(`placeholders: ${counts.made} generated, ${counts.kept} existing kept${force ? '' : ' (use --force to regenerate placeholders)'}; ${remaining} placeholder file(s) recorded in .placeholder-manifest.json`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(`make-placeholders: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
