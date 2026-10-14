/**
 * Schema and resolver for scripts/selectors.json, the only place the capture scripts couple to
 * the web app's markup. Scene code asks for selectors and texts by key; this module turns them
 * into Playwright locators and string/RegExp matchers.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Locator, Page } from 'playwright';
import { z } from 'zod';

const ROLES = ['alert', 'button', 'dialog', 'heading', 'link', 'navigation', 'note', 'status', 'textbox', 'tree'] as const;
const BASES = ['testid', 'role', 'label', 'css', 'text'] as const;

export const SelectorSchema = z
  .object({
    testid: z.string().min(1).optional(),
    role: z.enum(ROLES).optional(),
    name: z.string().min(1).optional(),
    exact: z.boolean().optional(),
    level: z.number().int().min(1).max(6).optional(),
    label: z.string().min(1).optional(),
    css: z.string().min(1).optional(),
    text: z.string().min(1).optional(),
    hasText: z.string().min(1).optional(),
    within: z.string().min(1).optional(),
    first: z.boolean().optional(),
  })
  .strict()
  .superRefine((s, ctx) => {
    const bases = BASES.filter((b) => s[b] !== undefined);
    if (bases.length !== 1) {
      ctx.addIssue({ code: 'custom', message: `needs exactly one of ${BASES.join(', ')} (got ${bases.join(', ') || 'none'})` });
    }
    if (s.role === undefined && (s.name !== undefined || s.level !== undefined)) {
      ctx.addIssue({ code: 'custom', message: 'name and level apply to role selectors only' });
    }
    for (const key of ['name', 'text', 'hasText'] as const) {
      const value = s[key];
      if (value !== undefined) checkPattern(value, key, ctx);
    }
  });

const GroupSchema = z
  .object({
    selectors: z.record(z.string(), SelectorSchema),
    texts: z.record(z.string(), z.string().min(1)).default({}),
  })
  .strict();

export const SelectorsFileSchema = z
  .object({
    $comment: z.string().optional(),
    shared: GroupSchema,
    scenes: z.record(z.string(), GroupSchema),
  })
  .strict()
  .superRefine((file, ctx) => {
    for (const [sceneId, group] of [['shared', file.shared] as const, ...Object.entries(file.scenes)]) {
      for (const [key, value] of Object.entries(group.texts)) checkPattern(value, `${sceneId}.texts.${key}`, ctx);
      for (const key of Object.keys(group.selectors)) {
        const seen = new Set<string>();
        let current: string | undefined = key;
        while (current !== undefined) {
          if (seen.has(current)) {
            ctx.addIssue({ code: 'custom', path: [sceneId, key], message: `"within" chain loops at "${current}"` });
            break;
          }
          seen.add(current);
          const found: Selector | undefined = lookup(file, sceneId === 'shared' ? null : sceneId, current);
          if (!found) {
            ctx.addIssue({ code: 'custom', path: [sceneId, key], message: `"within" names unknown selector "${current}"` });
            break;
          }
          current = found.within;
        }
      }
    }
  });

export type Selector = z.infer<typeof SelectorSchema>;
export type SelectorsFile = z.infer<typeof SelectorsFileSchema>;

const PATTERN = /^\/(.+)\/([a-z]*)$/s;

/** `/re/flags` becomes a RegExp; anything else is a literal string. */
export function pattern(value: string): string | RegExp {
  const m = PATTERN.exec(value);
  return m ? new RegExp(m[1]!, m[2]) : value;
}

function checkPattern(value: string, where: string, ctx: z.RefinementCtx): void {
  try {
    pattern(value);
  } catch (error) {
    ctx.addIssue({ code: 'custom', message: `${where}: invalid regular expression ${value} (${(error as Error).message})` });
  }
}

function lookup(file: SelectorsFile, sceneId: string | null, key: string): Selector | undefined {
  return (sceneId ? file.scenes[sceneId]?.selectors[key] : undefined) ?? file.shared.selectors[key];
}

export const SELECTORS_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'selectors.json');

export function parseSelectors(raw: unknown): SelectorsFile {
  const result = SelectorsFileSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`selectors.json is invalid:\n${issues.join('\n')}`);
  }
  return result.data;
}

export function loadSelectors(path = SELECTORS_PATH): SelectorsFile {
  return parseSelectors(JSON.parse(readFileSync(path, 'utf8')));
}

/** Locators and texts for one scene (falling back to the shared group) on one page. */
export class Ui {
  constructor(
    readonly page: Page,
    private readonly file: SelectorsFile,
    private readonly sceneId: string,
  ) {}

  sel(key: string): Locator {
    const s = lookup(this.file, this.sceneId, key);
    if (!s) throw new Error(`selectors.json has no selector "${key}" for ${this.sceneId} or shared`);
    const root: Page | Locator = s.within ? this.sel(s.within) : this.page;
    let loc: Locator;
    if (s.testid !== undefined) loc = root.getByTestId(s.testid);
    else if (s.role !== undefined) {
      loc = root.getByRole(s.role, {
        ...(s.name !== undefined ? { name: pattern(s.name) } : {}),
        ...(s.exact !== undefined ? { exact: s.exact } : {}),
        ...(s.level !== undefined ? { level: s.level } : {}),
      });
    } else if (s.label !== undefined) loc = root.getByLabel(s.label);
    else if (s.css !== undefined) loc = root.locator(s.css);
    else loc = root.getByText(pattern(s.text!));
    if (s.hasText !== undefined) loc = loc.filter({ hasText: pattern(s.hasText) });
    return s.first ? loc.first() : loc;
  }

  text(key: string): string | RegExp {
    const value = this.file.scenes[this.sceneId]?.texts[key] ?? this.file.shared.texts[key];
    if (value === undefined) throw new Error(`selectors.json has no text "${key}" for ${this.sceneId} or shared`);
    return pattern(value);
  }
}
