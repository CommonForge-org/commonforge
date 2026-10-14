import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseMedia, parseNarration } from '../src/data';
import { makePlaceholders, type Writers } from './make-placeholders';
import { emptyPlaceholderManifest, recordPlaceholder, type PlaceholderManifest } from './placeholder-manifest';
import { hasPlaceholderMarker, markPng, pngTextChunks } from './placeholder-marker';

const FFMPEG = process.env.FFMPEG ?? 'ffmpeg';

let publicDir: string;
let manifest: PlaceholderManifest;

const narration = parseNarration({
  scenes: [
    { id: 's00-title', audio: 'audio/scene-00.m4a', durationSec: 5, text: 'x', words: [] },
    { id: 's01-mess', audio: 'audio/scene-01.m4a', durationSec: 40, text: 'x', words: [] },
  ],
});
const media = parseMedia(
  {
    hashes: 'clips/hashes.json',
    scenes: {
      's00-title': {},
      's01-mess': { clip: 'clips/clip-01-intake.webm', shots: ['clips/shot-01-client-folder.png'], casts: ['clips/cast-intake.cast'] },
    },
  },
  narration,
);

const generated: string[] = [];
const writers: Writers = {
  silence: (t) => gen(t),
  clip: (t) => gen(t),
  shot: (t) => gen(t),
  cast: (t) => gen(t),
  hashes: (t) => gen(t),
};
function gen(target: string): void {
  generated.push(target.slice(publicDir.length + 1));
  writeFileSync(target, `GENERATED ${target}`);
}

function put(rel: string, content: string): void {
  mkdirSync(dirname(join(publicDir, rel)), { recursive: true });
  writeFileSync(join(publicDir, rel), content);
}
const read = (rel: string) => readFileSync(join(publicDir, rel), 'utf8');

beforeEach(() => {
  publicDir = mkdtempSync(join(tmpdir(), 'cf-placeholders-test-'));
  manifest = emptyPlaceholderManifest();
  generated.length = 0;
});
afterEach(() => rmSync(publicDir, { recursive: true, force: true }));

const run = (force: boolean) =>
  makePlaceholders({ publicDir, narration, media, manifest, force, writers, isSilent: (f) => f.includes('scene-00'), log: () => undefined });

describe('makePlaceholders', () => {
  it('generates every missing file media.json and narration.json name, hashes included', () => {
    expect(run(false)).toEqual({ made: 6, kept: 0 });
    expect(generated.sort()).toEqual(
      ['audio/scene-00.m4a', 'audio/scene-01.m4a', 'clips/cast-intake.cast', 'clips/clip-01-intake.webm', 'clips/hashes.json', 'clips/shot-01-client-folder.png'].sort(),
    );
    expect(Object.keys(manifest.files)).toHaveLength(6);
  });

  it('--force regenerates placeholders but leaves real captures, screenshots, casts and narration alone', () => {
    run(false);
    // real media replaces some placeholders: a live clip (cookie marks), a hand-made screenshot,
    // a real cast and real narration; the hashes file and silent scene-00 audio stay placeholders
    put('clips/clip-01-intake.webm', 'captured footage');
    put('clips/clip-01-intake.marks.json', JSON.stringify({ mode: 'cookie', marks: [] }));
    put('clips/shot-01-client-folder.png', 'owner screenshot');
    put('clips/cast-intake.cast', `${JSON.stringify({ version: 2, width: 80, height: 24, title: 'intake' })}\n[1,"o","real"]\n`);
    put('audio/scene-01.m4a', 'owner voice');
    generated.length = 0;

    const counts = run(true);
    expect(generated.sort()).toEqual(['audio/scene-00.m4a', 'clips/hashes.json']);
    expect(counts).toEqual({ made: 2, kept: 4 });
    expect(read('clips/clip-01-intake.webm')).toBe('captured footage');
    expect(read('clips/shot-01-client-folder.png')).toBe('owner screenshot');
    expect(read('clips/cast-intake.cast')).toContain('"intake"');
    expect(read('audio/scene-01.m4a')).toBe('owner voice');
  });

  it('--force never touches a file beside cookie-mode marks, even one matching a recorded placeholder', () => {
    put('clips/clip-01-intake.webm', 'same bytes');
    recordPlaceholder(manifest, publicDir, 'clips/clip-01-intake.webm');
    put('clips/clip-01-intake.marks.json', JSON.stringify({ mode: 'cookie', marks: [] }));
    run(true);
    expect(generated).not.toContain('clips/clip-01-intake.webm');
    expect(read('clips/clip-01-intake.webm')).toBe('same bytes');
  });

  it('--force regenerates a placeholder recognised by its marker when the manifest lost it', () => {
    put('clips/cast-intake.cast', `${JSON.stringify({ version: 2, width: 80, height: 18, title: 'PLACEHOLDER cast-intake.cast' })}\n[1,"o","x"]\n`);
    run(true);
    expect(generated).toContain('clips/cast-intake.cast');
  });
});

describe('placeholder markers', () => {
  it('marks a PNG with a tEXt Comment=PLACEHOLDER chunk and finds it again', () => {
    const png = join(publicDir, 'shot.png');
    execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=64x36', '-frames:v', '1', png]);
    expect(hasPlaceholderMarker(png)).toBe(false);
    markPng(png);
    expect(pngTextChunks(readFileSync(png)).get('Comment')).toBe('PLACEHOLDER');
    expect(hasPlaceholderMarker(png)).toBe(true);
    // still a valid PNG
    execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', png, '-f', 'null', '-']);
  });

  it('reads the WebM title=PLACEHOLDER tag, and not on real footage', () => {
    const marked = join(publicDir, 'marked.webm');
    const real = join(publicDir, 'real.webm');
    const encode = (file: string, extra: string[]) =>
      execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=64x36:d=0.2', '-c:v', 'libvpx', ...extra, file]);
    encode(marked, ['-metadata', 'title=PLACEHOLDER']);
    encode(real, []);
    expect(hasPlaceholderMarker(marked)).toBe(true);
    expect(hasPlaceholderMarker(real)).toBe(false);
  });

  it('recognises placeholder hashes', () => {
    const file = join(publicDir, 'hashes.json');
    writeFileSync(file, JSON.stringify({ blocked: { hash: 'PLACEHOLDER-BLOCKED' } }));
    expect(hasPlaceholderMarker(file)).toBe(true);
    writeFileSync(file, JSON.stringify({ blocked: { hash: 'a'.repeat(64) }, fixed: { hash: 'b'.repeat(64) } }));
    expect(hasPlaceholderMarker(file)).toBe(false);
  });
});
