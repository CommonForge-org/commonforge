import { z } from 'zod';
import mediaJson from '../media.json';
import narrationJson from '../narration.json';

const WordSchema = z.object({
  w: z.string(),
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
});

const NarrationSceneSchema = z.object({
  id: z.string().min(1),
  /** Path under `public/`, resolved with `staticFile()`. */
  audio: z.string().min(1),
  durationSec: z.number().positive(),
  /**
   * The scene lasts at least this long (seconds): `max(durationSec, minDurationSec)`. Narration
   * starts at the scene start and the footage fills the rest. Hand-set; `pnpm narration:build`
   * keeps it. Default: 3 s for the title and close, none for the others.
   */
  minDurationSec: z.number().nonnegative().optional(),
  text: z.string(),
  words: z.array(WordSchema),
});

export const NarrationSchema = z.object({
  scenes: z.array(NarrationSceneSchema).min(1),
});

const fraction = z.number().min(0).max(1);

/** Tolerance for fractions that sum to exactly 1 in decimal but not in binary floating point. */
const EDGE_EPSILON = 1e-9;

const CalloutSchema = z
  .object({
    /**
     * Seconds after the clip or screenshot carrying the callout appears on screen (composition
     * time, measured from the Browser's mount, not from the scene start or the source footage).
     */
    t: z.number().nonnegative(),
    x: fraction,
    y: fraction,
    w: fraction,
    h: fraction,
    label: z.string().min(1),
  })
  .superRefine((c, ctx) => {
    if (c.x + c.w > 1 + EDGE_EPSILON) {
      ctx.addIssue({ code: 'custom', path: ['w'], message: `x + w must be at most 1 (got ${c.x + c.w})` });
    }
    if (c.y + c.h > 1 + EDGE_EPSILON) {
      ctx.addIssue({ code: 'custom', path: ['h'], message: `y + h must be at most 1 (got ${c.y + c.h})` });
    }
  });

/** Source-time window of a clip or cast, in seconds of the source file. */
const windowFields = {
  /** First source second shown (default 0). */
  from: z.number().nonnegative().optional(),
  /** Last source second shown; the pane holds this frame (clips) or state (casts) after it. */
  to: z.number().positive().optional(),
  /** Playback rate for this file; default the scene's `speed`. > 1 shows the speed badge. */
  speed: z.number().positive().optional(),
};

function checkWindow(w: { from?: number | undefined; to?: number | undefined }, ctx: z.RefinementCtx): void {
  if (w.to !== undefined && w.to <= (w.from ?? 0)) ctx.addIssue({ code: 'custom', path: ['to'], message: `to (${w.to}) must be after from (${w.from ?? 0})` });
}

/** A clip: a path, or `{ src, from?, to?, speed? }` to show part of it. */
const ClipRefSchema = z
  .union([z.string().min(1), z.object({ src: z.string().min(1), ...windowFields }).strict()])
  .transform((v) => (typeof v === 'string' ? { src: v } : v))
  .superRefine(checkWindow);

/**
 * A cast: a path, or `{ src, from?, to?, speed?, maxIdleGapSec? }`. `maxIdleGapSec` collapses
 * every silence longer than it to that length (event order and content kept); the pane then
 * shows the speed badge, as for speed > 1.
 */
const CastRefSchema = z
  .union([z.string().min(1), z.object({ src: z.string().min(1), ...windowFields, maxIdleGapSec: z.number().positive().optional() }).strict()])
  .transform((v) => (typeof v === 'string' ? { src: v } : v))
  .superRefine(checkWindow);

const MediaSceneSchema = z.object({
  clip: ClipRefSchema.optional(),
  /** Scene 3 only: the owner's screen recording of the external-tool edit, shown before `clip`. */
  insert: ClipRefSchema.optional(),
  shots: z.array(z.string()).optional(),
  casts: z.array(CastRefSchema).optional(),
  /** Time-compression factor for the scene's footage (default for every clip and cast); > 1 shows a speed badge. */
  speed: z.number().positive().optional(),
  /**
   * Scene 4 only: cast seconds at the lanes clip's first frame, so the agent panes run in step
   * with the clip (`pnpm align-lanes` writes it from orchestrator.log and the clip's marks).
   */
  castOffsetSec: z.number().optional(),
  callouts: z.array(CalloutSchema).optional(),
});

export const MediaSchema = z.object({
  scenes: z.record(z.string(), MediaSceneSchema),
  /** Path under `public/` of the captured proposal hashes (`hashes.json`, written by `pnpm capture`). */
  hashes: z.string().min(1).optional(),
  /**
   * Hand-made files (paths under `public/`) the owner vouches for: the Finder screenshot, the
   * scene 3 screen recording. Exempt from the capture-marks check of the render guard and
   * `pnpm evidence`; never from the placeholder check.
   */
  manual: z.array(z.string().min(1)).optional(),
});

/** `hashes.json`: the review codes of the contract-failure proposal and its repair. */
const HashEntrySchema = z.object({
  hash: z.string().min(1),
  proposalId: z.string().optional(),
  mode: z.string().optional(),
  capturedAt: z.string().optional(),
});
export const HashesSchema = z.object({ blocked: HashEntrySchema.optional(), fixed: HashEntrySchema.optional() });

export type Word = z.infer<typeof WordSchema>;
export type NarrationScene = z.infer<typeof NarrationSceneSchema>;
export type Narration = z.infer<typeof NarrationSchema>;
export type Callout = z.infer<typeof CalloutSchema>;
export type MediaScene = z.infer<typeof MediaSceneSchema>;
export type Media = z.infer<typeof MediaSchema>;
export type ClipRef = z.infer<typeof ClipRefSchema>;
export type CastRef = z.infer<typeof CastRefSchema>;
export type Hashes = z.infer<typeof HashesSchema>;

/** Every file under `public/` that media.json names (clips, inserts, shots, casts, hashes). */
export function mediaPaths(media: Media): string[] {
  const paths = Object.values(media.scenes).flatMap((s) => [
    ...(s.insert ? [s.insert.src] : []),
    ...(s.clip ? [s.clip.src] : []),
    ...(s.shots ?? []),
    ...(s.casts ?? []).map((c) => c.src),
  ]);
  return [...new Set([...paths, ...(media.hashes ? [media.hashes] : [])])];
}

export function parseHashes(raw: unknown, file = 'hashes.json'): Hashes {
  const result = HashesSchema.safeParse(raw);
  if (!result.success) throw readable(file, result.error);
  return result.data;
}

function readable(file: string, error: z.ZodError): Error {
  const issues = error.issues.map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`);
  return new Error(`${file} is invalid:\n${issues.join('\n')}`);
}

export function parseNarration(raw: unknown): Narration {
  const result = NarrationSchema.safeParse(raw);
  if (!result.success) throw readable('narration.json', result.error);
  const seen = new Set<string>();
  for (const scene of result.data.scenes) {
    if (seen.has(scene.id)) throw new Error(`narration.json has a duplicate scene id "${scene.id}"`);
    seen.add(scene.id);
  }
  return result.data;
}

/** Validates media.json and checks that every narrated scene has an entry. */
export function parseMedia(raw: unknown, narration: Narration): Media {
  const result = MediaSchema.safeParse(raw);
  if (!result.success) throw readable('media.json', result.error);
  for (const scene of narration.scenes) {
    if (!(scene.id in result.data.scenes)) {
      throw new Error(`media.json has no entry for scene "${scene.id}" (use {} for scenes without footage)`);
    }
  }
  return result.data;
}

export interface VideoData {
  narration: Narration;
  media: Media;
}

/** Loads and validates the project's narration.json and media.json. */
export function loadVideoData(): VideoData {
  const narration = parseNarration(narrationJson);
  return { narration, media: parseMedia(mediaJson, narration) };
}
