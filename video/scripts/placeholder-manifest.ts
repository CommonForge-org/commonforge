/**
 * The record of generated placeholder media. `pnpm placeholders` writes `.placeholder-manifest.json`
 * (path, size and sha256 of every file it generated); the final-render guard and `pnpm evidence`
 * use it to recognise placeholders by content, wherever they were copied or renamed to.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const VIDEO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PLACEHOLDER_MANIFEST = join(VIDEO_ROOT, '.placeholder-manifest.json');

const EntrySchema = z.object({ bytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[0-9a-f]{64}$/), generatedAt: z.string() });
const ManifestSchema = z.object({
  schema: z.literal('commonforge.video.placeholders/1'),
  /** Keyed by path relative to `public/`. */
  files: z.record(z.string(), EntrySchema),
});

export type PlaceholderEntry = z.infer<typeof EntrySchema>;
export type PlaceholderManifest = z.infer<typeof ManifestSchema>;

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function emptyPlaceholderManifest(): PlaceholderManifest {
  return { schema: 'commonforge.video.placeholders/1', files: {} };
}

/** The manifest at `path`, or an empty one when none has been written yet. */
export function readPlaceholderManifest(path = PLACEHOLDER_MANIFEST): PlaceholderManifest {
  if (!existsSync(path)) return emptyPlaceholderManifest();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${path} is not valid JSON (${(error as Error).message}); delete it and run pnpm placeholders --force`);
  }
  const parsed = ManifestSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`${path} is not a placeholder manifest; delete it and run pnpm placeholders --force`);
  return parsed.data;
}

export function writePlaceholderManifest(manifest: PlaceholderManifest, path = PLACEHOLDER_MANIFEST): void {
  const files = Object.fromEntries(Object.entries(manifest.files).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(path, `${JSON.stringify({ ...manifest, files }, null, 2)}\n`);
}

/** Records a freshly generated placeholder. */
export function recordPlaceholder(manifest: PlaceholderManifest, publicDir: string, relPath: string, now = new Date()): void {
  const file = join(publicDir, relPath);
  manifest.files[relPath] = { bytes: statSync(file).size, sha256: sha256File(file), generatedAt: now.toISOString() };
}

/** True when the file at `relPath` is still the placeholder the manifest recorded there. */
export function isRecordedPlaceholder(manifest: PlaceholderManifest, publicDir: string, relPath: string): boolean {
  const entry = manifest.files[relPath];
  const file = join(publicDir, relPath);
  if (!entry || !existsSync(file)) return false;
  return statSync(file).size === entry.bytes && sha256File(file) === entry.sha256;
}

/** A generated placeholder cast: its header title starts with PLACEHOLDER. */
export function isPlaceholderCast(text: string): boolean {
  try {
    const header = JSON.parse(text.split('\n', 1)[0] ?? '') as { title?: unknown };
    return String(header.title ?? '').startsWith('PLACEHOLDER');
  } catch {
    return false;
  }
}

/** Matches files by content against every recorded placeholder (size first, so most files are never hashed). */
export class PlaceholderIndex {
  private readonly bySize = new Map<number, Set<string>>();

  constructor(manifest: PlaceholderManifest) {
    for (const entry of Object.values(manifest.files)) {
      const hashes = this.bySize.get(entry.bytes) ?? new Set<string>();
      hashes.add(entry.sha256);
      this.bySize.set(entry.bytes, hashes);
    }
  }

  matches(file: string): boolean {
    const hashes = this.bySize.get(statSync(file).size);
    return hashes !== undefined && hashes.has(sha256File(file));
  }
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith('.')) return [];
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : entry.isFile() ? [path] : [];
  });
}

/**
 * Generated placeholders under `publicDir/<dir>` for each of `dirs` (paths relative to
 * `publicDir`, sorted): files matching a recorded placeholder, casts titled PLACEHOLDER and files
 * `hasMarker` recognises (scripts/placeholder-marker.ts).
 */
export function findPlaceholders(publicDir: string, dirs: string[], manifest: PlaceholderManifest, hasMarker: (file: string) => boolean = () => false): string[] {
  const index = new PlaceholderIndex(manifest);
  const found: string[] = [];
  for (const file of dirs.flatMap((d) => walk(join(publicDir, d)))) {
    const placeholder = index.matches(file) || (file.endsWith('.cast') && isPlaceholderCast(readFileSync(file, 'utf8'))) || hasMarker(file);
    if (placeholder) found.push(relative(publicDir, file));
  }
  return found.sort();
}
