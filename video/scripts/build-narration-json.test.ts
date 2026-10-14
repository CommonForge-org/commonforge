import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseNarration } from '../src/data';
import { buildNarration, shiftWords, speechBounds, wordsFromWhisper, writeWordsSidecar } from './build-narration-json';
import type { SceneText } from './script-text';

const FFMPEG = process.env.FFMPEG ?? 'ffmpeg';

const SCENES: SceneText[] = [
  { number: 0, id: 's00-title', text: 'Title line.' },
  { number: 1, id: 's01-mess', text: 'The mess.' },
  { number: 2, id: 's02-client-update', text: 'Client update.' },
];

let publicDir: string;
let audioDir: string;
let logs: string[];
const log = (message: string): void => {
  logs.push(message);
};

/** A sine tone of exactly `seconds`, encoded by the file extension's default codec. */
function tone(name: string, seconds: number): string {
  const file = join(audioDir, name);
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, file]);
  return file;
}

/** Digital silence of `seconds`, like the placeholders `pnpm placeholders` writes. */
function silence(name: string, seconds: number): string {
  const file = join(audioDir, name);
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', String(seconds), file]);
  return file;
}

/** `seconds` of tone with `pad` seconds of digital silence before and after it. */
function padded(name: string, seconds: number, pad: number): string {
  const file = join(audioDir, name);
  execFileSync(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
    '-af', `adelay=${pad * 1000}:all=1,apad=pad_dur=${pad}`, file,
  ]);
  return file;
}

beforeEach(() => {
  publicDir = mkdtempSync(join(tmpdir(), 'cf-narration-test-'));
  audioDir = join(publicDir, 'audio');
  mkdirSync(audioDir);
  logs = [];
});

afterEach(() => {
  rmSync(publicDir, { recursive: true, force: true });
});

describe('buildNarration', () => {
  it('measures each file, orders scenes by number and falls back to words: []', () => {
    // Created out of order, in three containers.
    tone('scene-02.m4a', 0.8);
    tone('scene-00.wav', 1.5);
    tone('scene-01.mp3', 2.25);

    const { narration, silentScenes } = buildNarration({ publicDir, scenes: SCENES, log });

    expect(silentScenes).toEqual([]);
    expect(narration.scenes.map((s) => [s.id, s.audio])).toEqual([
      ['s00-title', 'audio/scene-00.wav'],
      ['s01-mess', 'audio/scene-01.mp3'],
      ['s02-client-update', 'audio/scene-02.m4a'],
    ]);
    const [title, mess, update] = narration.scenes.map((s) => s.durationSec);
    expect(title).toBeCloseTo(1.5, 2);
    // Lossy encoders add a few ms of padding; never less than the content.
    expect(mess).toBeGreaterThanOrEqual(2.25);
    expect(mess).toBeLessThan(2.35);
    expect(update).toBeGreaterThanOrEqual(0.8);
    expect(update).toBeLessThan(0.9);
    expect(narration.scenes.map((s) => s.text)).toEqual(['Title line.', 'The mess.', 'Client update.']);
    expect(narration.scenes.every((s) => s.words.length === 0)).toBe(true);
    expect(() => parseNarration(narration)).not.toThrow();
  });

  it('keeps each scene\'s hand-set minDurationSec from the narration.json it replaces', () => {
    tone('scene-00.m4a', 1);
    tone('scene-01.mp3', 1);
    tone('scene-02.wav', 1);
    const previous = parseNarration({
      scenes: [
        { id: 's01-mess', audio: 'audio/old.m4a', durationSec: 9, minDurationSec: 45, text: 'old', words: [] },
        { id: 's02-client-update', audio: 'audio/old.m4a', durationSec: 9, text: 'old', words: [] },
      ],
    });
    const { narration } = buildNarration({ publicDir, scenes: SCENES, previous, log });
    expect(narration.scenes.map((s) => s.minDurationSec)).toEqual([undefined, 45, undefined]);
    expect(narration.scenes[1]!.durationSec).toBeLessThan(2);
  });

  it('uses a words sidecar only while it matches the audio file', () => {
    const wav = tone('scene-00.wav', 1);
    tone('scene-01.wav', 1);
    tone('scene-02.wav', 1);
    const words = [
      { w: 'Title', start: 0.1, end: 0.4 },
      { w: 'line.', start: 0.45, end: 0.8 },
    ];
    writeWordsSidecar(wav, 'elevenlabs', words);
    expect(buildNarration({ publicDir, scenes: SCENES, log }).narration.scenes[0]!.words).toEqual(words);

    // The owner re-records scene 0 under the same name: the old timings no longer apply.
    tone('scene-00.wav', 1.2);
    const rebuilt = buildNarration({ publicDir, scenes: SCENES, log }).narration;
    expect(rebuilt.scenes[0]!.words).toEqual([]);
    expect(logs.join('\n')).toMatch(/scene-00\.words\.json.*does not match/);
  });

  it('picks the recording over a silent placeholder even when the placeholder is newer', () => {
    const recording = tone('scene-00.wav', 2);
    silence('scene-00.m4a', 1); // regenerated placeholder: the newest file
    utimesSync(recording, new Date('2026-01-01'), new Date('2026-01-01'));
    tone('scene-01.wav', 1);
    tone('scene-02.wav', 1);

    const { narration, silentScenes } = buildNarration({ publicDir, scenes: SCENES, log });
    expect(narration.scenes[0]!.audio).toBe('audio/scene-00.wav');
    expect(narration.scenes[0]!.durationSec).toBeCloseTo(2, 2);
    expect(silentScenes).toEqual([]);
    expect(logs.join('\n')).toMatch(/scene-00\.wav: chosen; ignoring silent scene-00\.m4a/);
  });

  it('fails listing the files when a scene has several non-silent files', () => {
    tone('scene-00.mp3', 1);
    tone('scene-00.wav', 1);
    silence('scene-00.m4a', 1);
    tone('scene-01.wav', 1);
    tone('scene-02.wav', 1);
    expect(() => buildNarration({ publicDir, scenes: SCENES, log })).toThrow(
      /s00-title has several non-silent audio files.*scene-00\.mp3, scene-00\.wav\. Delete or rename/,
    );
  });

  it('warns when a scene only has silent audio', () => {
    silence('scene-00.m4a', 1.5);
    tone('scene-01.wav', 1);
    tone('scene-02.wav', 1);
    const { narration, silentScenes } = buildNarration({ publicDir, scenes: SCENES, log });
    expect(narration.scenes[0]!.durationSec).toBeCloseTo(1.5, 2);
    expect(silentScenes).toEqual(['s00-title']);
    expect(logs.join('\n')).toMatch(/WARNING: s00-title uses silent audio scene-00\.m4a/);
  });

  it('fails naming the scene when its audio is missing', () => {
    tone('scene-00.wav', 1);
    tone('scene-01.wav', 1);
    expect(() => buildNarration({ publicDir, scenes: SCENES, log })).toThrow(/s02-client-update.*scene-02\./);
  });

  it('skips word timestamps with a message when the whisper CLI is not installed', () => {
    tone('scene-00.wav', 1);
    tone('scene-01.wav', 1);
    tone('scene-02.wav', 1);
    const { narration } = buildNarration({
      publicDir,
      scenes: SCENES,
      log,
      whisper: { command: 'cf-no-such-whisper-binary', model: 'base.en' },
    });
    expect(narration.scenes.every((s) => s.words.length === 0)).toBe(true);
    expect(logs.join('\n')).toMatch(/cf-no-such-whisper-binary.*not found/);
  });

  it('ignores files that are not scene audio', () => {
    tone('scene-00.wav', 1);
    tone('scene-01.wav', 1);
    tone('scene-02.wav', 1);
    tone('bed.mp3', 1);
    writeFileSync(join(audioDir, 'notes.txt'), 'x');
    expect(buildNarration({ publicDir, scenes: SCENES, log }).narration.scenes).toHaveLength(3);
  });
});

describe('wordsFromWhisper', () => {
  it('flattens segment words, trimming whisper’s leading spaces and dropping blanks', () => {
    const json = {
      text: ' One project. Many sources.',
      segments: [
        { words: [{ word: ' One', start: 0.0, end: 0.32 }, { word: ' project.', start: 0.32, end: 0.9 }] },
        { words: [{ word: ' Many', start: 1.2, end: 1.5 }, { word: ' ', start: 1.5, end: 1.5 }, { word: ' sources.', start: 1.5, end: 2.1 }] },
      ],
    };
    expect(wordsFromWhisper(json)).toEqual([
      { w: 'One', start: 0, end: 0.32 },
      { w: 'project.', start: 0.32, end: 0.9 },
      { w: 'Many', start: 1.2, end: 1.5 },
      { w: 'sources.', start: 1.5, end: 2.1 },
    ]);
  });

  it('returns no words for a transcript without word timestamps', () => {
    expect(wordsFromWhisper({ text: '', segments: [] })).toEqual([]);
    expect(wordsFromWhisper({ text: 'x', segments: [{ text: 'x' }] })).toEqual([]);
  });
});

describe('--trim-silence', () => {
  it('cuts 1 s of leading and trailing silence into audio/trimmed/ and measures the trimmed copy', () => {
    const wav = padded('scene-00.wav', 1, 1);
    tone('scene-01.wav', 1.5); // no padding: left as it is
    silence('scene-02.m4a', 2); // placeholder: never trimmed
    writeWordsSidecar(wav, 'elevenlabs', [
      { w: 'Title', start: 1.1, end: 1.4 },
      { w: 'line.', start: 1.5, end: 1.95 },
    ]);

    const untrimmed = buildNarration({ publicDir, scenes: SCENES, log }).narration;
    expect(untrimmed.scenes[0]!.durationSec).toBeCloseTo(3, 1);

    const { narration } = buildNarration({ publicDir, scenes: SCENES, log, trimSilence: true });
    const [title, mess, update] = narration.scenes;
    expect(title!.audio).toBe('audio/trimmed/scene-00.wav');
    expect(existsSync(join(audioDir, 'trimmed', 'scene-00.wav'))).toBe(true);
    // 3 s → about 1 s: both pads removed (silencedetect lands within a few ms of the tone edges)
    expect(title!.durationSec).toBeGreaterThan(0.95);
    expect(title!.durationSec).toBeLessThan(1.1);
    expect(title!.words[0]!.start).toBeCloseTo(0.1, 1);
    expect(title!.words[1]!.end).toBeCloseTo(0.95, 1);
    expect(mess!.audio).toBe('audio/scene-01.wav');
    expect(mess!.durationSec).toBeCloseTo(1.5, 2);
    expect(update!.audio).toBe('audio/scene-02.m4a');
    expect(logs.join('\n')).toMatch(/scene-00\.wav: trimmed 1\.\d\d s lead and 1\.\d\d s tail/);
  });

  it('finds the speech between the silent pads', () => {
    const bounds = speechBounds(padded('scene-00.wav', 0.5, 1), FFMPEG);
    expect(bounds.duration).toBeCloseTo(2.5, 1);
    expect(bounds.start).toBeCloseTo(1, 1);
    expect(bounds.end).toBeCloseTo(1.5, 1);
  });

  it('shifts word timings by the trimmed lead and clamps them to the new length', () => {
    expect(shiftWords([{ w: 'a', start: 0.8, end: 1.2 }, { w: 'b', start: 1.5, end: 2.6 }, { w: 'c', start: 2.7, end: 2.9 }], 1, 1.5)).toEqual([
      { w: 'a', start: 0, end: 0.2 },
      { w: 'b', start: 0.5, end: 1.5 },
    ]);
  });
});
