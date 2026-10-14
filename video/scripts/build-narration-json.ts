/**
 * Builds narration.json from the narration audio actually on disk:
 *   - audio: public/audio/scene-NN.<m4a|mp3|wav|aac|ogg|opus|flac> (owner voice or
 *     ElevenLabs). When a scene has several files, silent ones (the placeholders) are
 *     dropped; more than one non-silent file is an error. A scene left with only silent
 *     audio gets a WARNING.
 *   - text: the scene's lines from docs/DEMO-SCRIPT.md (scripts/script-text.ts)
 *   - durationSec: measured with ffprobe, never typed in
 *   - words: scene-NN.words.json beside the audio when it was made for exactly that
 *     file (ElevenLabs writes one; --whisper transcribes the rest); otherwise []
 *
 *   - --trim-silence: leading and trailing silence (below -45 dB for at least 0.3 s) is cut into a
 *     copy under public/audio/trimmed/; durations are measured from, and narration.json points at,
 *     the trimmed copies, and word timings shift by the trimmed lead
 *
 * Usage: pnpm narration:build [--whisper] [--trim-silence]
 *   WHISPER=/path/to/whisper  WHISPER_MODEL=small.en  FFPROBE=/path/to/ffprobe  FFMPEG=/path/to/ffmpeg
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { parseNarration, type Narration, type Word } from '../src/data';
import { clock, formatLengths, lengthProblem, lengthReport } from './length-policy';
import { readSceneTexts, sceneStem, type SceneText } from './script-text';

export const VIDEO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PUBLIC_DIR = join(VIDEO_ROOT, 'public');
export const NARRATION_PATH = join(VIDEO_ROOT, 'narration.json');

const AUDIO_EXTENSIONS = ['m4a', 'mp3', 'wav', 'aac', 'ogg', 'opus', 'flac'];
/** Peak level at or below this counts as silence (placeholders are digital silence, -91 dB). */
const SILENCE_MAX_DB = -80;
const AUDIO_FILE = new RegExp(`^scene-(\\d{2})\\.(${AUDIO_EXTENSIONS.join('|')})$`, 'i');

type Log = (message: string) => void;

export interface WhisperOptions {
  command: string;
  model: string;
}

export interface BuildOptions {
  /** Directory holding `audio/`; narration paths are written relative to it. */
  publicDir: string;
  scenes: SceneText[];
  /** Transcribe scenes without matching word timings using the whisper CLI. */
  whisper?: WhisperOptions;
  ffprobe?: string;
  ffmpeg?: string;
  /** Cut leading and trailing silence into public/audio/trimmed/ and use those copies. */
  trimSilence?: boolean;
  /** The narration.json being replaced: each scene's hand-set `minDurationSec` is kept. */
  previous?: Narration;
  log?: Log;
}

export interface BuildResult {
  narration: Narration;
  /** Ids of scenes whose chosen audio is silent (placeholders). */
  silentScenes: string[];
}

// ── word timings sidecar ─────────────────────────────────────────────────────

const WordsSidecarSchema = z.object({
  audio: z.string(),
  sha256: z.string(),
  source: z.enum(['elevenlabs', 'whisper']),
  words: z.array(z.object({ w: z.string(), start: z.number().nonnegative(), end: z.number().nonnegative() })),
});
export type WordsSource = z.infer<typeof WordsSidecarSchema>['source'];

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** `public/audio/scene-03.mp3` → `public/audio/scene-03.words.json` */
export function sidecarPath(audioFile: string): string {
  return join(dirname(audioFile), `${basename(audioFile, extname(audioFile))}.words.json`);
}

/** Records word timings for exactly this audio file (by content hash). */
export function writeWordsSidecar(audioFile: string, source: WordsSource, words: Word[]): void {
  const sidecar = { audio: basename(audioFile), sha256: sha256(audioFile), source, words };
  writeFileSync(sidecarPath(audioFile), `${JSON.stringify(sidecar, null, 2)}\n`);
}

/** Word timings for this audio file, or undefined when there are none or they belong to other audio. */
function readWordsSidecar(audioFile: string, log: Log): Word[] | undefined {
  const path = sidecarPath(audioFile);
  if (!existsSync(path)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    raw = undefined;
  }
  const parsed = WordsSidecarSchema.safeParse(raw);
  if (!parsed.success) {
    log(`  ${basename(path)} is not a valid words file; ignoring it`);
    return undefined;
  }
  if (parsed.data.audio !== basename(audioFile) || parsed.data.sha256 !== sha256(audioFile)) {
    log(`  ${basename(path)} does not match ${basename(audioFile)} (audio replaced?); ignoring its timings`);
    return undefined;
  }
  return parsed.data.words;
}

// ── whisper ──────────────────────────────────────────────────────────────────

const WhisperJsonSchema = z.object({
  segments: z.array(
    z.object({
      words: z.array(z.object({ word: z.string(), start: z.number(), end: z.number() })).optional(),
    }),
  ),
});

/** Word timings from openai-whisper's `--output_format json --word_timestamps True` output. */
export function wordsFromWhisper(json: unknown): Word[] {
  const parsed = WhisperJsonSchema.parse(json);
  return parsed.segments.flatMap((segment) =>
    (segment.words ?? [])
      .map((word) => ({ w: word.word.trim(), start: Math.max(0, word.start), end: Math.max(0, word.end) }))
      .filter((word) => word.w.length > 0),
  );
}

function whisperAvailable(command: string): boolean {
  const result = spawnSync(command, ['--help'], { stdio: 'ignore' });
  return !result.error;
}

function transcribe(audioFile: string, whisper: WhisperOptions, log: Log): Word[] {
  const out = mkdtempSync(join(tmpdir(), 'cf-whisper-'));
  try {
    const result = spawnSync(
      whisper.command,
      [audioFile, '--model', whisper.model, '--language', 'en', '--word_timestamps', 'True',
        '--output_format', 'json', '--output_dir', out, '--fp16', 'False'],
      { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' },
    );
    const json = join(out, `${basename(audioFile, extname(audioFile))}.json`);
    if (result.status !== 0 || !existsSync(json)) {
      const reason = result.error?.message || result.stderr?.trim().split('\n').at(-1) || `exit ${result.status}`;
      log(`  whisper failed on ${basename(audioFile)} (${reason}); words left empty`);
      return [];
    }
    return wordsFromWhisper(JSON.parse(readFileSync(json, 'utf8')));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

// ── audio ────────────────────────────────────────────────────────────────────

/** Audio length in seconds, rounded up to the millisecond so narration is never cut. */
export function measureDuration(file: string, ffprobe = process.env.FFPROBE ?? 'ffprobe'): number {
  const output = execFileSync(
    ffprobe,
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file],
    { encoding: 'utf8' },
  );
  const seconds = Number.parseFloat(output.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`ffprobe reports no duration for ${file}: "${output.trim()}"`);
  return Math.ceil(seconds * 1000 - 1e-6) / 1000;
}

/** True when the file's peak level is at or below SILENCE_MAX_DB (one ffmpeg volumedetect pass). */
export function isSilent(file: string, ffmpeg = process.env.FFMPEG ?? 'ffmpeg'): boolean {
  const result = spawnSync(ffmpeg, ['-hide_banner', '-nostats', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'], {
    encoding: 'utf8',
  });
  const match = /max_volume:\s*(-?inf|-?[\d.]+)\s*dB/.exec(result.stderr ?? '');
  if (result.status !== 0 || !match) {
    throw new Error(`ffmpeg volumedetect failed on ${file}: ${result.error?.message || result.stderr?.trim().split('\n').at(-1)}`);
  }
  const peak = match[1]!.endsWith('inf') ? Number.NEGATIVE_INFINITY : Number(match[1]);
  return peak <= SILENCE_MAX_DB;
}

/** Silence trimmed by --trim-silence: quieter than this for at least this long. */
export const TRIM_SILENCE = { thresholdDb: -45, minSec: 0.3 } as const;
export const TRIMMED_DIR = 'trimmed';

/** Seconds of speech in the file: after its leading silence and before its trailing silence. */
export function speechBounds(file: string, ffmpeg = process.env.FFMPEG ?? 'ffmpeg', ffprobe?: string): { start: number; end: number; duration: number } {
  const duration = measureDuration(file, ffprobe);
  const result = spawnSync(
    ffmpeg,
    ['-hide_banner', '-nostats', '-i', file, '-af', `silencedetect=n=${TRIM_SILENCE.thresholdDb}dB:d=${TRIM_SILENCE.minSec}`, '-f', 'null', '-'],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error(`ffmpeg silencedetect failed on ${file}: ${result.error?.message || result.stderr?.trim().split('\n').at(-1)}`);
  const silences: Array<{ start: number; end: number }> = [];
  for (const line of (result.stderr ?? '').split('\n')) {
    const started = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (started) silences.push({ start: Math.max(0, Number(started[1])), end: duration });
    const ended = /silence_end:\s*([\d.]+)/.exec(line);
    if (ended && silences.length > 0) silences.at(-1)!.end = Number(ended[1]);
  }
  const EDGE = 0.02;
  const lead = silences[0] && silences[0].start <= EDGE ? silences[0].end : 0;
  const last = silences.at(-1);
  const tail = last && last.end >= duration - EDGE && last.start > lead ? last.start : duration;
  return { start: lead, end: tail, duration };
}

function encoderArgs(file: string): string[] {
  switch (extname(file).toLowerCase()) {
    case '.m4a':
    case '.aac':
      return ['-c:a', 'aac', '-b:a', '192k'];
    case '.mp3':
      return ['-c:a', 'libmp3lame', '-q:a', '2'];
    default:
      return [];
  }
}

/**
 * Writes `audio/trimmed/<name>` without the file's leading and trailing silence and returns it
 * with the seconds cut from the start, or null when there is nothing to trim (or only silence).
 */
function trimSilence(file: string, publicDir: string, ffmpeg: string | undefined, ffprobe: string | undefined, log: Log): { file: string; lead: number } | null {
  const { start, end, duration } = speechBounds(file, ffmpeg, ffprobe);
  if (end - start < 0.05 || (start === 0 && end === duration)) return null;
  const dir = join(publicDir, 'audio', TRIMMED_DIR);
  mkdirSync(dir, { recursive: true });
  const target = join(dir, basename(file));
  execFileSync(
    ffmpeg ?? process.env.FFMPEG ?? 'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-af', `atrim=start=${start.toFixed(3)}:end=${end.toFixed(3)},asetpts=PTS-STARTPTS`, ...encoderArgs(file), target],
  );
  log(`  ${basename(file)}: trimmed ${start.toFixed(2)} s lead and ${(duration - end).toFixed(2)} s tail → audio/${TRIMMED_DIR}/${basename(file)}`);
  return { file: target, lead: start };
}

/** Word timings moved to a copy that starts `lead` seconds later and lasts `duration` seconds. */
export function shiftWords(words: Word[], lead: number, duration: number): Word[] {
  const round = (n: number) => Math.round(n * 1000) / 1000;
  return words
    .map((w) => ({ w: w.w, start: round(Math.max(0, w.start - lead)), end: round(Math.min(duration, Math.max(0, w.end - lead))) }))
    .filter((w) => w.start < duration);
}

/** Scene number → every scene-NN audio file name for it. */
function findSceneAudio(audioDir: string): Map<number, string[]> {
  const byScene = new Map<number, string[]>();
  const names = existsSync(audioDir) ? readdirSync(audioDir).sort() : [];
  for (const name of names) {
    const match = AUDIO_FILE.exec(name);
    if (!match) continue;
    const number = Number(match[1]);
    byScene.set(number, [...(byScene.get(number) ?? []), name]);
  }
  return byScene;
}

/**
 * The scene's audio by content, never by file date: silent files (placeholders) are
 * dropped when any non-silent file exists, and several non-silent files are an error.
 */
function chooseAudio(sceneId: string, audioDir: string, names: string[], ffmpeg: string | undefined, log: Log): { name: string; silent: boolean } {
  const candidates = names.map((name) => ({ name, silent: isSilent(join(audioDir, name), ffmpeg) }));
  const voiced = candidates.filter((c) => !c.silent);
  const remaining = voiced.length > 0 ? voiced : candidates;
  if (remaining.length > 1) {
    throw new Error(
      `Scene ${sceneId} has several ${voiced.length > 0 ? 'non-silent' : 'silent'} audio files in ${audioDir}: ` +
        `${remaining.map((c) => c.name).join(', ')}. Delete or rename all but the one to use (and its .words.json).`,
    );
  }
  const chosen = remaining[0]!;
  const ignored = candidates.filter((c) => c !== chosen);
  if (ignored.length > 0) log(`  ${chosen.name}: chosen; ignoring silent ${ignored.map((c) => c.name).join(', ')}`);
  return chosen;
}

// ── build ────────────────────────────────────────────────────────────────────

/** Narration for every scene, validated against the composition's schema. */
export function buildNarration(options: BuildOptions): BuildResult {
  const log = options.log ?? console.log;
  const audioDir = join(options.publicDir, 'audio');
  const files = findSceneAudio(audioDir);

  const known = new Set(options.scenes.map((scene) => scene.number));
  for (const [number, names] of files) {
    if (!known.has(number)) log(`  ${names.join(', ')}: no scene ${sceneStem(number)} in the script; ignored`);
  }

  let whisper = options.whisper;
  if (whisper && !whisperAvailable(whisper.command)) {
    log(
      `  whisper CLI "${whisper.command}" not found; skipping word timestamps (captions show each scene's text). ` +
        'Install with `pipx install openai-whisper` or set WHISPER=/path/to/whisper.',
    );
    whisper = undefined;
  }

  const silentScenes: string[] = [];
  const minimums = new Map((options.previous?.scenes ?? []).flatMap((s) => (s.minDurationSec === undefined ? [] : [[s.id, s.minDurationSec] as const])));
  const keepMin = (id: string) => (minimums.has(id) ? { minDurationSec: minimums.get(id)! } : {});
  const scenes = options.scenes.map((scene) => {
    const names = files.get(scene.number);
    if (!names) {
      throw new Error(
        `No audio for scene ${scene.id}: expected ${join(audioDir, sceneStem(scene.number))}.<${AUDIO_EXTENSIONS.join('|')}>`,
      );
    }
    const { name, silent } = chooseAudio(scene.id, audioDir, names, options.ffmpeg, log);
    if (silent) {
      silentScenes.push(scene.id);
      log(`  WARNING: ${scene.id} uses silent audio ${name} (placeholder?); record or generate real narration`);
    }
    const file = join(audioDir, name);
    let words = readWordsSidecar(file, log);
    if (!words && whisper) {
      log(`  transcribing ${name} with whisper (${whisper.model})…`);
      words = transcribe(file, whisper, log);
      if (words.length > 0) writeWordsSidecar(file, 'whisper', words);
    }
    // never trim placeholders: all silence, nothing to keep
    const trimmed = options.trimSilence && !silent ? trimSilence(file, options.publicDir, options.ffmpeg, options.ffprobe, log) : null;
    if (!trimmed) {
      return { id: scene.id, audio: `audio/${name}`, durationSec: measureDuration(file, options.ffprobe), ...keepMin(scene.id), text: scene.text, words: words ?? [] };
    }
    const durationSec = measureDuration(trimmed.file, options.ffprobe);
    return { id: scene.id, audio: `audio/${TRIMMED_DIR}/${name}`, durationSec, ...keepMin(scene.id), text: scene.text, words: shiftWords(words ?? [], trimmed.lead, durationSec) };
  });

  return { narration: parseNarration({ scenes }), silentScenes };
}

export function writeNarration(narration: Narration, path = NARRATION_PATH): void {
  writeFileSync(path, `${JSON.stringify(narration, null, 2)}\n`);
}

/** Builds and writes narration.json from public/audio, printing a per-scene summary. */
export function buildAndWrite(whisper?: WhisperOptions, opts: { trimSilence?: boolean } = {}): Narration {
  const previous = existsSync(NARRATION_PATH) ? parseNarration(JSON.parse(readFileSync(NARRATION_PATH, 'utf8'))) : undefined;
  const { narration, silentScenes } = buildNarration({ publicDir: PUBLIC_DIR, scenes: readSceneTexts(), whisper, trimSilence: opts.trimSilence, previous });
  writeNarration(narration);
  let total = 0;
  for (const scene of narration.scenes) {
    total += scene.durationSec;
    console.log(`  ${scene.id.padEnd(22)} ${scene.audio.padEnd(22)} ${scene.durationSec.toFixed(2).padStart(7)} s  ${scene.words.length} words`);
  }
  console.log(`narration.json: ${narration.scenes.length} scenes, ${clock(total)} of narration`);
  const lengths = lengthReport(narration);
  console.log(`scene lengths (max(audio, minDurationSec)):\n${formatLengths(lengths)}`);
  const problem = lengthProblem(lengths);
  if (problem) console.warn(`WARNING: ${problem}; the competition allows 5–10 minutes and \`pnpm render\` refuses. Expand the narration or set minDurationSec in narration.json.`);
  if (silentScenes.length > 0) {
    console.warn(
      `WARNING: ${silentScenes.length} of ${narration.scenes.length} scenes use SILENT audio (placeholders): ${silentScenes.join(', ')}. ` +
        'Do not ship a final render until real narration replaces them.',
    );
  }
  return narration;
}

function main(): void {
  const useWhisper = process.argv.includes('--whisper');
  const whisper = useWhisper
    ? { command: process.env.WHISPER ?? 'whisper', model: process.env.WHISPER_MODEL ?? 'base.en' }
    : undefined;
  const narration = buildAndWrite(whisper, { trimSilence: process.argv.includes('--trim-silence') });
  if (!useWhisper && narration.scenes.some((scene) => scene.words.length === 0)) {
    console.log('Scenes with 0 words caption their whole text; `pnpm narration:build --whisper` adds word timings.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
