/**
 * Final-render guard (`pnpm render` runs it before rendering; also its `prerender`;
 * `pnpm render:preview` skips it). Refuses, listing every problem, while:
 *   - any file under public/clips or public/audio is generated placeholder media: recognised by
 *     content through .placeholder-manifest.json, by the marker burned into it (WebM title, PNG
 *     text chunk, cast title, hash text) or, for narration, by being digital silence;
 *   - the proposal hashes (media.json `hashes`) are missing or not real 64-hex hashes;
 *   - a clip or screenshot media.json names has no cookie-mode `.marks.json` from `pnpm capture`
 *     and is not listed in media.json `manual` (the `pnpm evidence` audit: also dry-run casts);
 *   - the composition is outside the competition's 5–10 minutes.
 *
 * Usage: pnpm check:placeholders
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mediaPaths, parseMedia, parseNarration, type Media, type Narration } from '../src/data';
import { PROPOSAL_HASH } from '../src/lib/review-code';
import { isSilent } from './build-narration-json';
import { auditTake } from './evidence-manifest';
import { formatLengths, lengthProblem, lengthReport } from './length-policy';
import { findPlaceholders, PlaceholderIndex, readPlaceholderManifest, VIDEO_ROOT, type PlaceholderManifest } from './placeholder-manifest';
import { hasPlaceholderMarker } from './placeholder-marker';

export interface GuardOptions {
  publicDir: string;
  manifest: PlaceholderManifest;
  /** narration.json audio paths (relative to publicDir); silent ones count as placeholders. */
  narrationAudio: string[];
  isSilent: (file: string) => boolean;
  /** Intrinsic placeholder marker check (default: none, for tests). */
  hasMarker?: (file: string) => boolean;
}

/** Placeholder files the final render must not use (paths relative to publicDir, sorted). */
export function remainingPlaceholders(o: GuardOptions): string[] {
  const found = new Set(findPlaceholders(o.publicDir, ['clips', 'audio'], o.manifest, o.hasMarker));
  for (const audio of o.narrationAudio) {
    const file = join(o.publicDir, audio);
    if (!found.has(audio) && existsSync(file) && o.isSilent(file)) found.add(audio);
  }
  return [...found].sort();
}

/** Why the proposal hashes cannot ship, or null when both are real hashes. */
export function hashesProblem(publicDir: string, media: Media): string | null {
  if (!media.hashes) return 'media.json names no "hashes" file (scenes 6 and 7 show the captured review codes)';
  const file = join(publicDir, media.hashes);
  if (!existsSync(file)) return `public/${media.hashes} is missing: capture scenes 5 and 6 (pnpm capture --scenes 5,6)`;
  let raw: Record<string, { hash?: unknown } | undefined>;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8')) as typeof raw;
  } catch {
    return `public/${media.hashes} is not valid JSON`;
  }
  const bad = (['blocked', 'fixed'] as const).filter((key) => !PROPOSAL_HASH.test(String(raw[key]?.hash ?? '')));
  return bad.length > 0 ? `public/${media.hashes}: ${bad.map((k) => `${k} is ${raw[k]?.hash === undefined ? 'missing' : `not a captured hash (${String(raw[k]?.hash)})`}`).join('; ')}` : null;
}

/** Media.json clips and screenshots not proven captured live (no cookie-mode marks, not `manual`). */
export function unverifiedMedia(publicDir: string, media: Media, hasMarker?: (file: string) => boolean): string[] {
  const byDir = new Map<string, Set<string>>();
  for (const path of mediaPaths(media)) {
    const dir = dirname(path);
    byDir.set(dir, (byDir.get(dir) ?? new Set()).add(basename(path)));
  }
  const manual = new Set((media.manual ?? []).map((p) => basename(p)));
  const found: string[] = [];
  for (const [dir, only] of byDir) {
    const abs = join(publicDir, dir);
    if (!existsSync(abs)) continue;
    const files = readdirSync(abs).filter((f) => !f.startsWith('.') && statSync(join(abs, f)).isFile());
    // placeholders are reported by remainingPlaceholders; only the capture proof is checked here
    const audit = auditTake(abs, files, manual, new PlaceholderIndex({ schema: 'commonforge.video.placeholders/1', files: {} }), { only, hasMarker: hasMarker ?? (() => false) });
    found.push(...audit.unverified.map((u) => `${join(dir, basename(u.path))}: ${u.reason}`));
  }
  return found.sort();
}

/** Refusal message when the composition breaks the 5–10 minute competition rule, else null. */
export function lengthRefusal(narration: Narration): string | null {
  const report = lengthReport(narration);
  const problem = lengthProblem(report);
  return problem ? `render refused: ${problem} (competition rule: 5–10 minutes). Scene lengths:\n${formatLengths(report)}` : null;
}

function main(): void {
  const publicDir = join(VIDEO_ROOT, 'public');
  const narration = parseNarration(JSON.parse(readFileSync(join(VIDEO_ROOT, 'narration.json'), 'utf8')));
  const media = parseMedia(JSON.parse(readFileSync(join(VIDEO_ROOT, 'media.json'), 'utf8')), narration);
  const marker = (file: string) => hasPlaceholderMarker(file);
  const refusals: string[] = [];

  const remaining = remainingPlaceholders({
    publicDir,
    manifest: readPlaceholderManifest(),
    narrationAudio: narration.scenes.map((s) => s.audio),
    isSilent: (file) => isSilent(file),
    hasMarker: marker,
  });
  if (remaining.length > 0) {
    refusals.push(
      `render refused: ${remaining.length} placeholder file(s) remain:\n${remaining.map((p) => `  - public/${p}`).join('\n')}\n` +
        'Replace them with real captures and narration (README, "Swapping in real media").',
    );
  }
  const hashes = hashesProblem(publicDir, media);
  if (hashes) refusals.push(`render refused: proposal hashes: ${hashes}`);
  const unverified = unverifiedMedia(publicDir, media).filter((line) => !remaining.some((p) => line.startsWith(`${p}:`)));
  if (unverified.length > 0) {
    refusals.push(
      `render refused: ${unverified.length} file(s) not proven captured live:\n${unverified.map((u) => `  - public/${u}`).join('\n')}\n` +
        'Capture them with `pnpm capture`, or list hand-made files in media.json "manual".',
    );
  }
  const tooLong = lengthRefusal(narration);
  if (tooLong) refusals.push(tooLong);

  if (refusals.length > 0) {
    console.error(`${refusals.join('\n\n')}\n\n\`pnpm render:preview\` renders with placeholders for checking.`);
    process.exitCode = 1;
    return;
  }
  console.log('render guard: no placeholders, hashes captured, every clip and screenshot captured live or manual, length within 5–10 minutes');
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(`check-no-placeholders: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
