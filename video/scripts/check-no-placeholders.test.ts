import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseMedia, parseNarration } from '../src/data';
import { hashesProblem, lengthRefusal, remainingPlaceholders, unverifiedMedia } from './check-no-placeholders';
import { emptyPlaceholderManifest, isRecordedPlaceholder, recordPlaceholder, type PlaceholderManifest } from './placeholder-manifest';

let publicDir: string;
let manifest: PlaceholderManifest;

function put(rel: string, content: string): void {
  mkdirSync(join(publicDir, rel, '..'), { recursive: true });
  writeFileSync(join(publicDir, rel), content);
}

const realCast = `${JSON.stringify({ version: 2, width: 80, height: 24, title: 'agent-1' })}\n[0.5,"o","hi"]\n`;
const placeholderCast = `${JSON.stringify({ version: 2, width: 80, height: 18, title: 'PLACEHOLDER cast-02-clone.cast' })}\n[0.5,"o","x"]\n`;

beforeEach(() => {
  publicDir = mkdtempSync(join(tmpdir(), 'cf-guard-'));
  manifest = emptyPlaceholderManifest();
});
afterEach(() => rmSync(publicDir, { recursive: true, force: true }));

const guard = (narrationAudio: string[] = [], silent: string[] = []) =>
  remainingPlaceholders({ publicDir, manifest, narrationAudio, isSilent: (file) => silent.some((s) => file.endsWith(s)) });

describe('remainingPlaceholders (final render guard)', () => {
  it('passes a take with only real media', () => {
    put('clips/clip-01-intake.webm', 'real footage');
    put('clips/cast-04-agent-a.cast', realCast);
    put('audio/scene-00.mp3', 'real voice');
    expect(guard(['audio/scene-00.mp3'])).toEqual([]);
  });

  it('lists every generated placeholder recorded in the manifest, by content', () => {
    put('clips/clip-01-intake.webm', 'placeholder webm');
    put('clips/shot-05-contract-fail.png', 'placeholder png');
    put('audio/scene-00.m4a', 'placeholder silence');
    for (const rel of ['clips/clip-01-intake.webm', 'clips/shot-05-contract-fail.png', 'audio/scene-00.m4a']) recordPlaceholder(manifest, publicDir, rel);
    // a copy under another name is still the placeholder
    copyFileSync(join(publicDir, 'clips/clip-01-intake.webm'), join(publicDir, 'clips/clip-01-take2.webm'));
    put('clips/clip-02-edition.webm', 'real footage');
    expect(guard()).toEqual(['audio/scene-00.m4a', 'clips/clip-01-intake.webm', 'clips/clip-01-take2.webm', 'clips/shot-05-contract-fail.png']);
  });

  it('stops listing a file once real media replaces it at the same path', () => {
    put('clips/clip-01-intake.webm', 'placeholder webm');
    recordPlaceholder(manifest, publicDir, 'clips/clip-01-intake.webm');
    expect(isRecordedPlaceholder(manifest, publicDir, 'clips/clip-01-intake.webm')).toBe(true);
    put('clips/clip-01-intake.webm', 'captured footage');
    expect(isRecordedPlaceholder(manifest, publicDir, 'clips/clip-01-intake.webm')).toBe(false);
    expect(guard()).toEqual([]);
  });

  it('catches placeholder casts by title even without a manifest entry', () => {
    put('clips/cast-02-clone.cast', placeholderCast);
    expect(guard()).toEqual(['clips/cast-02-clone.cast']);
  });

  it('catches silent narration audio, including trimmed copies in subfolders when recorded', () => {
    put('audio/scene-01.m4a', 'old silence');
    put('audio/trimmed/scene-02.wav', 'generated');
    recordPlaceholder(manifest, publicDir, 'audio/trimmed/scene-02.wav');
    expect(guard(['audio/scene-01.m4a'], ['scene-01.m4a'])).toEqual(['audio/scene-01.m4a', 'audio/trimmed/scene-02.wav']);
  });
});

describe('lengthRefusal (competition rule: 5–10 minutes)', () => {
  const narration = (durations: number[], mins: Record<number, number> = {}) => ({
    scenes: durations.map((d, i) => ({ id: `s${i}`, audio: `audio/s${i}.m4a`, durationSec: d, text: 'x', words: [], ...(i in mins ? { minDurationSec: mins[i] } : {}) })),
  });

  it('refuses a composition under 5 minutes, listing per-scene lengths', () => {
    const message = lengthRefusal(narration([5, 30, 20]));
    expect(message).toMatch(/render refused: the video is 0:55\.0, under the 5:00\.0 minimum/);
    expect(message).toMatch(/s1\s+audio\s+30\.00 s/);
  });

  it('refuses over 10 minutes and passes once minDurationSec brings it inside', () => {
    expect(lengthRefusal(narration([400, 300]))).toMatch(/over the 10:00\.0 maximum/);
    expect(lengthRefusal(narration([5, 30, 20], { 1: 280 }))).toBeNull();
  });
});

describe('render guard: hashes, capture proof and markers', () => {
  const narration = parseNarration({ scenes: [{ id: 's05-collision', audio: 'audio/scene-05.m4a', durationSec: 40, text: 'x', words: [] }] });
  const media = parseMedia(
    {
      hashes: 'clips/hashes.json',
      manual: ['clips/shot-01-client-folder.png'],
      scenes: { 's05-collision': { clip: 'clips/clip-05-collision.webm', shots: ['clips/shot-05-contract-fail.png', 'clips/shot-01-client-folder.png'] } },
    },
    narration,
  );
  const COOKIE = JSON.stringify({ mode: 'cookie', marks: [] });

  it('refuses missing or PLACEHOLDER hashes and passes two captured ones', () => {
    expect(hashesProblem(publicDir, media)).toMatch(/clips\/hashes\.json is missing/);
    put('clips/hashes.json', JSON.stringify({ blocked: { hash: 'PLACEHOLDER-BLOCKED' }, fixed: { hash: 'PLACEHOLDER-FIXED' } }));
    expect(hashesProblem(publicDir, media)).toMatch(/blocked is not a captured hash \(PLACEHOLDER-BLOCKED\); fixed is not a captured hash/);
    put('clips/hashes.json', JSON.stringify({ blocked: { hash: 'a'.repeat(64) } }));
    expect(hashesProblem(publicDir, media)).toMatch(/fixed is missing/);
    put('clips/hashes.json', JSON.stringify({ blocked: { hash: 'a'.repeat(64) }, fixed: { hash: 'b'.repeat(64) } }));
    expect(hashesProblem(publicDir, media)).toBeNull();
  });

  it('refuses media.json clips and screenshots without cookie-mode marks unless manual', () => {
    put('clips/clip-05-collision.webm', 'footage');
    put('clips/shot-05-contract-fail.png', 'shot');
    put('clips/shot-05-contract-fail.marks.json', JSON.stringify({ mode: 'fixture' }));
    put('clips/shot-01-client-folder.png', 'finder screenshot');
    put('clips/old-take.webm', 'not named by media.json');
    expect(unverifiedMedia(publicDir, media)).toEqual([
      'clips/clip-05-collision.webm: no .marks.json (not written by pnpm capture; pass --manual if hand-made)',
      'clips/shot-05-contract-fail.png: captured in mode "fixture", not cookie',
    ]);
    put('clips/clip-05-collision.marks.json', COOKIE);
    put('clips/shot-05-contract-fail.marks.json', COOKIE);
    expect(unverifiedMedia(publicDir, media)).toEqual([]);
  });

  it('catches placeholders by their burned-in marker without a manifest entry', () => {
    put('clips/clip-05-collision.webm', 'marked');
    put('clips/clip-02-edition.webm', 'real');
    const found = remainingPlaceholders({ publicDir, manifest, narrationAudio: [], isSilent: () => false, hasMarker: (f) => f.endsWith('clip-05-collision.webm') });
    expect(found).toEqual(['clips/clip-05-collision.webm']);
  });
});
