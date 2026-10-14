/**
 * Narration text per scene, extracted from docs/DEMO-SCRIPT.md:
 *   - S00 (title): the "One-line thesis to say first" line
 *   - S01–S08: the **Say:** line(s) of each Timeline time block
 *   - S09 (close): the **Close:** line in the last block
 * Scene ids match narration.json and the scene components in src/DemoVideo.tsx;
 * the scene list follows docs/VIDEO-PRODUCTION.md §3.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type TextSource = 'thesis' | 'close' | { block: string };

export interface SceneDef {
  number: number;
  id: string;
  source: TextSource;
}

export interface SceneText {
  number: number;
  id: string;
  text: string;
}

export const SCENES: readonly SceneDef[] = [
  { number: 0, id: 's00-title', source: 'thesis' },
  { number: 1, id: 's01-mess', source: { block: '0:00–0:45' } },
  { number: 2, id: 's02-client-update', source: { block: '0:45–1:30' } },
  { number: 3, id: 's03-own-tool', source: { block: '1:30–2:30' } },
  { number: 4, id: 's04-three-agents', source: { block: '2:30–4:00' } },
  { number: 5, id: 's05-collision', source: { block: '4:00–5:00' } },
  { number: 6, id: 's06-repair-preview', source: { block: '5:00–6:00' } },
  { number: 7, id: 's07-approve-publish', source: { block: '6:00–7:15' } },
  { number: 8, id: 's08-restore-export', source: { block: '7:15–8:00' } },
  { number: 9, id: 's09-close', source: 'close' },
];

export const DEMO_SCRIPT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'DEMO-SCRIPT.md');

const BLOCK_HEADING = /^###\s+(\d+:\d{2})\s*[–-]\s*(\d+:\d{2})\b/;

/** The text between the first and last double quote after a bold label, e.g. `**Say:** "…"`. */
function quoted(line: string, label: string): string | undefined {
  if (!line.startsWith(`**${label}:**`)) return undefined;
  const first = line.indexOf('"');
  const last = line.lastIndexOf('"');
  return first >= 0 && last > first ? line.slice(first + 1, last) : undefined;
}

/** Spoken form: a spaced em dash becomes a comma pause; whitespace is collapsed. */
function spoken(text: string): string {
  return text.replace(/\s+—\s+/g, ', ').replace(/\s+/g, ' ').trim();
}

/** Lines of the `## Timeline` section only (Option B and the cut list have their own Say-like text). */
function timelineLines(lines: string[]): string[] {
  const start = lines.findIndex((line) => /^##\s+Timeline\b/.test(line));
  if (start < 0) throw new Error('DEMO-SCRIPT.md has no "## Timeline" section');
  const end = lines.findIndex((line, i) => i > start && /^##\s/.test(line));
  return lines.slice(start + 1, end < 0 ? undefined : end);
}

/**
 * Say lines grouped by time block, keyed "0:00–0:45" (en dash). A quote may span several lines of
 * its paragraph (`**Say:** "…` up to the line with the closing `"`); a Say line without an opening
 * quote, or a quote still open at a blank line, the next `**Label:**` or the end of its block,
 * throws naming the block instead of being dropped.
 */
function sayByBlock(timeline: string[]): Map<string, string[]> {
  const blocks = new Map<string, string[]>();
  let current: string[] | undefined;
  let block = '';
  let open: string[] | null = null;
  const unclosed = () => new Error(`DEMO-SCRIPT.md: block ${block}: a **Say:** quote is never closed (no closing " before the paragraph ends)`);
  for (const raw of timeline) {
    const line = raw.trim();
    const heading = BLOCK_HEADING.exec(line);
    if (heading) {
      if (open) throw unclosed();
      block = `${heading[1]}–${heading[2]}`;
      current = [];
      blocks.set(block, current);
      continue;
    }
    if (open) {
      // a quote continues within its paragraph only: a blank line or the next **Label:** ends it
      if (line === '' || line.startsWith('**')) throw unclosed();
      const close = line.lastIndexOf('"');
      if (close < 0) {
        open.push(line);
        continue;
      }
      open.push(line.slice(0, close));
      current?.push(open.join(' '));
      open = null;
      continue;
    }
    if (!line.startsWith('**Say:**') || !current) continue;
    const say = quoted(line, 'Say');
    if (say !== undefined) {
      current.push(say);
      continue;
    }
    const first = line.indexOf('"');
    if (first < 0) throw new Error(`DEMO-SCRIPT.md: block ${block}: a **Say:** line has no quoted text: ${line}`);
    open = [line.slice(first + 1)];
  }
  if (open) throw unclosed();
  return blocks;
}

function single(lines: string[], label: string, scene: SceneDef): string {
  const found = lines.map((line) => quoted(line.trim(), label)).filter((text) => text !== undefined);
  if (found.length !== 1) {
    throw new Error(`DEMO-SCRIPT.md: scene ${scene.id} needs exactly one **${label}:** "…" line, found ${found.length}`);
  }
  return found[0]!;
}

/** Narration text for every scene, in scene order. Throws naming the scene when its text is missing. */
export function extractSceneTexts(markdown: string): SceneText[] {
  const lines = markdown.split(/\r?\n/);
  const timeline = timelineLines(lines);
  const blocks = sayByBlock(timeline);

  return SCENES.map((scene) => {
    let raw: string;
    if (scene.source === 'thesis') raw = single(lines, 'One-line thesis to say first', scene);
    else if (scene.source === 'close') raw = single(timeline, 'Close', scene);
    else {
      const says = blocks.get(scene.source.block);
      if (!says) throw new Error(`DEMO-SCRIPT.md: scene ${scene.id} needs a "### ${scene.source.block}" time block`);
      if (says.length === 0) {
        throw new Error(`DEMO-SCRIPT.md: scene ${scene.id} (block ${scene.source.block}) has no **Say:** "…" line`);
      }
      raw = says.join(' ');
    }
    return { number: scene.number, id: scene.id, text: spoken(raw) };
  });
}

/** Reads docs/DEMO-SCRIPT.md (or `path`) and extracts every scene's text. */
export function readSceneTexts(path: string = DEMO_SCRIPT_PATH): SceneText[] {
  return extractSceneTexts(readFileSync(path, 'utf8'));
}

/** `scene-NN` file stem for a scene number. */
export function sceneStem(number: number): string {
  return `scene-${String(number).padStart(2, '0')}`;
}
