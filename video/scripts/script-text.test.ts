import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { extractSceneTexts, readSceneTexts, SCENES } from './script-text';

const DEMO_SCRIPT = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'DEMO-SCRIPT.md'),
  'utf8',
);

const fixture = (blocks: string): string => `# Script

**One-line thesis to say first:** "One project — many sources."

## Timeline

${blocks}

## Cut order

**Say:** "Not part of any scene."
`;

const allBlocks = SCENES.flatMap((scene) =>
  typeof scene.source === 'object' ? [`### ${scene.source.block} — Beat ${scene.number}\n\n**Say:** "Line ${scene.number}."\n`] : [],
).join('\n');

describe('extractSceneTexts (docs/DEMO-SCRIPT.md)', () => {
  const scenes = extractSceneTexts(DEMO_SCRIPT);

  it('returns the ten scenes S00–S09 in order with their narration.json ids', () => {
    expect(scenes.map((s) => s.number)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(scenes.map((s) => s.id)).toEqual([
      's00-title',
      's01-mess',
      's02-client-update',
      's03-own-tool',
      's04-three-agents',
      's05-collision',
      's06-repair-preview',
      's07-approve-publish',
      's08-restore-export',
      's09-close',
    ]);
  });

  it('has non-empty narration without double quotes for every scene', () => {
    for (const scene of scenes) {
      expect(scene.text, scene.id).not.toBe('');
      expect(scene.text, scene.id).not.toContain('"');
    }
  });

  it('takes S00 from the thesis line and S09 from the Close line of the document', () => {
    const line = (label: string): string => {
      const match = new RegExp(`^\\*\\*${label}:\\*\\*\\s*"(.+)"\\s*$`, 'm').exec(DEMO_SCRIPT);
      expect(match, `${label} line`).not.toBeNull();
      return match![1]!.replace(/\s+—\s+/g, ', ').replace(/\s+/g, ' ').trim();
    };
    expect(scenes[0]!.text).toBe(line('One-line thesis to say first'));
    expect(scenes[9]!.text).toBe(line('Close'));
  });
});

describe('extractSceneTexts (inline fixture)', () => {
  const FIXTURE_MD = `# Demo

**One-line thesis to say first:** "One project — many sources. Stay calm."

## Timeline

### 0:00–0:45 — Opening beat

**Say:** "First line of the opening."

### 0:45–1:30 — Second beat

**Say:** "Second beat, part one."
**Say:** "Second beat — part two."
**Say:** "Second beat, part three."

### 1:30–2:30 — Third beat

**Do:** click something.

**Say:** "Third beat only."

**Close:** "Thanks — goodbye."

## Cut order

**Say:** "Not part of any scene."
`;

  const dir = mkdtempSync(join(tmpdir(), 'script-text-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  // Only three of the ten time blocks exist in the fixture, so read it through the extractor with
  // a script that has all blocks: reuse the fixture text for S00, S01–S03 and S09.
  const full = (): string => {
    const blocks = SCENES.filter((scene) => typeof scene.source === 'object' && scene.number > 3)
      .map((scene) => `### ${(scene.source as { block: string }).block} — Filler ${scene.number}\n\n**Say:** "Filler ${scene.number}."\n`)
      .join('\n');
    return FIXTURE_MD.replace('\n## Cut order', `\n${blocks}\n## Cut order`);
  };

  it('reads the script from a file and joins several Say lines with one space', () => {
    const path = join(dir, 'script.md');
    writeFileSync(path, full(), 'utf8');
    const scenes = readSceneTexts(path);
    expect(scenes.map((s) => s.number)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(scenes[1]!.text).toBe('First line of the opening.');
    expect(scenes[2]!.text).toBe('Second beat, part one. Second beat, part two. Second beat, part three.');
    expect(scenes[3]!.text).toBe('Third beat only.');
    expect(scenes[4]!.text).toBe('Filler 4.');
  });

  it('speaks spaced em dashes as commas in the thesis and Close lines', () => {
    const scenes = extractSceneTexts(full());
    expect(scenes[0]!.text).toBe('One project, many sources. Stay calm.');
    expect(scenes[9]!.text).toBe('Thanks, goodbye.');
  });
});

describe('extractSceneTexts (errors and edge cases)', () => {
  const close = '**Close:** "Goodbye."';

  it('joins several Say lines in one block', () => {
    const blocks = allBlocks.replace('**Say:** "Line 3."', '**Say:** "Line 3a."\n**Say:** "Line 3b."');
    const scenes = extractSceneTexts(fixture(`${blocks}\n${close}`));
    expect(scenes[3]!.text).toBe('Line 3a. Line 3b.');
    expect(scenes[0]!.text).toBe('One project, many sources.');
    expect(scenes[9]!.text).toBe('Goodbye.');
  });

  it('ignores Say lines outside the Timeline section', () => {
    const scenes = extractSceneTexts(fixture(`${allBlocks}\n${close}`));
    expect(scenes.map((s) => s.text).join(' ')).not.toContain('Not part of any scene');
  });

  it('names the scene and block when a block has no Say line', () => {
    const blocks = allBlocks.replace('**Say:** "Line 2."', '**Do:** something');
    expect(() => extractSceneTexts(fixture(`${blocks}\n${close}`))).toThrow(/s02-client-update.*0:45–1:30.*Say/);
  });

  it('names the scene when its time block is missing', () => {
    const blocks = allBlocks.replace('### 4:00–5:00', '### 4:00–5:30');
    expect(() => extractSceneTexts(fixture(`${blocks}\n${close}`))).toThrow(/s05-collision.*4:00–5:00/);
  });

  it('requires the Close line', () => {
    expect(() => extractSceneTexts(fixture(allBlocks))).toThrow(/s09-close.*Close/);
  });

  it('joins a Say quote that spans several lines', () => {
    const blocks = allBlocks.replace('**Say:** "Line 4."', '**Say:** "Line 4 starts here\n  and ends — here."');
    expect(extractSceneTexts(fixture(`${blocks}\n${close}`))[4]!.text).toBe('Line 4 starts here and ends, here.');
  });

  it('throws naming the block when a Say quote is never closed, instead of dropping it', () => {
    const blocks = allBlocks.replace('**Say:** "Line 6."', '**Say:** "Line 6 never closes.\n**Do:** something');
    expect(() => extractSceneTexts(fixture(`${blocks}\n${close}`))).toThrow(/block 5:00–6:00: a \*\*Say:\*\* quote is never closed/);
    const last = allBlocks.replace('**Say:** "Line 8."', '**Say:** "Line 8 runs off the end');
    expect(() => extractSceneTexts(fixture(`${last}\n${close}`))).toThrow(/block 7:15–8:00: a \*\*Say:\*\* quote is never closed/);
  });

  it('throws naming the block for a Say line without quoted text', () => {
    const blocks = allBlocks.replace('**Say:** "Line 2."', '**Say:** Line 2 without quotes');
    expect(() => extractSceneTexts(fixture(`${blocks}\n${close}`))).toThrow(/block 0:45–1:30: a \*\*Say:\*\* line has no quoted text/);
  });
});
