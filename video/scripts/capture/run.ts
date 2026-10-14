/**
 * One capture unit's browser session: persona contexts (one recorded), navigation, marks, dwell,
 * screenshots, and saving the recorded video under the names media.json expects.
 *
 * Fixture mode runs everything in one recorded page (the demo story lives in that page, so a
 * second context would not share its state) and switches persona with the banner's "View as".
 * Cookie mode gives each persona its own context with its own session cookie; only the context
 * that shows the scene records video, helpers (the other persona's preparatory clicks) do not.
 *
 * Nothing reaches outDir unless the whole unit succeeds, including saving it: screenshots, cut
 * clips and their marks are all staged in the work dir, and only once every one of them is ready
 * are they moved to outDir together. A file a rerun would replace is kept in the work dir as
 * `<name>.prev.<ext>` (with its marks), so the previous take survives one rerun.
 *
 * Proposal hashes a unit reads off the page (`recordHash`) are merged into media.json's `hashes`
 * file (`hashes.json`) in outDir on the same terms: only when the whole unit succeeds.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { Browser, BrowserContext, Locator, Page } from 'playwright';
import { HashesSchema, type Hashes, type Media } from '../../src/data';
import { PROPOSAL_HASH } from '../../src/lib/review-code';
import { attachSession, verifySession, type Persona, type Session } from './auth';
import { Ui, type SelectorsFile } from './selectors';
import type { Targets } from './targets';

/** apps/web/src/lib/onboarding.ts `writeDismissed`: the key that hides a project's Getting started checklist. */
export function gettingStartedDismissedKey(targets: Pick<Targets, 'org' | 'project'>): string {
  return `cf-getting-started-dismissed:${targets.org}/${targets.project}`;
}

export const VIEWPORT = { width: 1920, height: 1080 } as const;
export const DEVICE_SCALE_FACTOR = 2;

export interface CaptureConfig {
  mode: 'fixture' | 'cookie';
  baseUrl: string;
  /** public/clips for real captures, public/clips-dry for fixture runs. */
  outDir: string;
  /** Downloads, raw videos and failure screenshots. */
  workDir: string;
  /** `longFromEnv`: CAPTURE_LONG_TIMEOUT_MIN was set, so it overrides every unit's own default. */
  timeouts: { stepMs: number; longMs: number; longFromEnv?: boolean };
  /** How long a finished state stays on screen before the next step (footage pacing, not synchronisation). */
  dwellMs: number;
  sessions: Partial<Record<Persona, Session>>;
  targets: Targets;
  media: Media;
  selectors: SelectorsFile;
  log: (line: string) => void;
}

/** A piece of the recorded video saved as one media.json clip; marks bound it (default: all of it). */
export interface Segment {
  clip: string;
  from?: string;
  to?: string;
  /** Seconds kept before the `from` mark. */
  leadSec?: number;
}

export interface CaptureUnit {
  id: string;
  /** media.json scene ids this unit captures footage for. */
  scenes: string[];
  /** Sessions the unit signs in with (cookie mode). */
  personas: Persona[];
  /** media.json paths (clips and shots) this unit writes. */
  outputs: (media: Media) => string[];
  /** Splits the recording into clips; default: the whole recording is the unit's one clip. */
  segments?: (media: Media) => Segment[];
  /** Live-mode long timeout for this unit when CAPTURE_LONG_TIMEOUT_MIN is not set (default: the config's). */
  liveLongTimeoutMin?: number;
  run: (run: SceneRun) => Promise<void>;
}

interface Mark {
  name: string;
  /** Seconds since the recording started (approximate: the page's creation). */
  t: number;
}

export async function visible(locator: Locator, timeout: number): Promise<void> {
  await locator.first().waitFor({ state: 'visible', timeout });
}

export async function hasText(locator: Locator, text: string | RegExp, timeout: number): Promise<void> {
  await locator.filter({ hasText: text }).first().waitFor({ state: 'visible', timeout });
}

/** The full proposal hash of a `proposal-hash` element (`data-hash`), checked to be a real hash. */
export async function readHash(locator: Locator, timeout: number): Promise<string> {
  const hash = await locator.first().getAttribute('data-hash', { timeout });
  if (!hash || !PROPOSAL_HASH.test(hash)) throw new Error(`the proposal hash on the page is not a 64-hex hash (${hash ?? 'none'})`);
  return hash;
}

export type HashKey = 'blocked' | 'fixed';

/** `existing` (a hashes.json's content, or anything unreadable) with `updates` merged in. */
export function mergeHashes(existing: unknown, updates: Partial<Hashes>): Hashes {
  const parsed = HashesSchema.safeParse(existing);
  return { ...(parsed.success ? parsed.data : {}), ...updates };
}

export async function atLeast(locator: Locator, count: number, timeout: number): Promise<void> {
  await locator.nth(count - 1).waitFor({ state: 'visible', timeout });
}

/** `clip-01.webm` → `clip-01.prev.webm`; `shot.marks.json` → `shot.prev.marks.json`. */
export function prevName(file: string): string {
  const m = /^(.*?)(\.marks\.json|\.[^.]+)?$/.exec(basename(file))!;
  return `${m[1]}.prev${m[2] ?? ''}`;
}

/** Moves a file, falling back to copy and unlink across volumes (EXDEV, e.g. CAPTURE_WORK_DIR elsewhere). */
export function moveFile(from: string, to: string, rename: (from: string, to: string) => void = renameSync): void {
  try {
    rename(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    copyFileSync(from, to);
    unlinkSync(from);
  }
}

/** True for `<…>/public/clips`, the final-footage directory fixture captures must never write to. */
export function isFinalClipsDir(dir: string): boolean {
  const abs = resolve(dir);
  return basename(abs) === 'clips' && basename(dirname(abs)) === 'public';
}

export class SceneRun {
  readonly marks: Mark[] = [];
  readonly written: string[] = [];
  /** Screenshots, cut clips and their marks, in the staging dir; moved to outDir only when all are ready. */
  private readonly staged: string[] = [];
  /** Proposal hashes read off the page; written to the hashes file only if the unit succeeds. */
  private readonly hashes: Partial<Hashes> = {};
  private readonly contexts = new Map<string, { context: BrowserContext; page: Page }>();
  private recorded: { context: BrowserContext; page: Page; startedAt: number } | null = null;
  private fixtureRole: Persona | null = null;
  private booted = false;

  constructor(
    private readonly browser: Browser,
    readonly config: CaptureConfig,
    readonly unit: CaptureUnit,
  ) {}

  get fixture(): boolean {
    return this.config.mode === 'fixture';
  }
  get step(): number {
    return this.config.timeouts.stepMs;
  }
  get long(): number {
    const { longMs, longFromEnv } = this.config.timeouts;
    if (this.fixture || longFromEnv || this.unit.liveLongTimeoutMin === undefined) return longMs;
    return this.unit.liveLongTimeoutMin * 60_000;
  }
  get targets(): Targets {
    return this.config.targets;
  }

  ui(page: Page, sceneId: string): Ui {
    return new Ui(page, this.config.selectors, sceneId);
  }

  /** The page a persona acts in. `record` marks the unit's one recorded page. */
  async page(persona: Persona, opts: { record: boolean }): Promise<Page> {
    if (this.fixture) return this.fixturePage(persona);
    const key = `${persona}:${opts.record ? 'rec' : 'helper'}`;
    const existing = this.contexts.get(key);
    if (existing) return existing.page;
    if (opts.record && this.recorded) throw new Error(`${this.unit.id}: only one recorded context per unit`);
    const session = this.config.sessions[persona];
    if (!session) throw new Error(`${this.unit.id} needs the ${persona} session (CAPTURE_${persona.toUpperCase()}_SESSION_FILE)`);
    const context = await this.newContext(opts.record);
    await attachSession(context, this.config.baseUrl, session);
    const me = await verifySession(context, this.config.baseUrl, this.targets.org, persona);
    this.config.log(`  ${persona}: signed in as ${me.email} (${me.role})${opts.record ? ', recording' : ''}`);
    const page = await context.newPage();
    if (opts.record) this.recorded = { context, page, startedAt: Date.now() };
    this.contexts.set(key, { context, page });
    return page;
  }

  private async newContext(record: boolean): Promise<BrowserContext> {
    const context = await this.browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: DEVICE_SCALE_FACTOR,
      acceptDownloads: true,
      ...(record ? { recordVideo: { dir: this.config.workDir, size: VIEWPORT } } : {}),
    });
    // The demo project's Getting started checklist stays out of the take: hidden as the owner's
    // Hide button hides it (apps/web/src/lib/onboarding.ts, a per-browser flag), before any page loads.
    await context.addInitScript((key) => {
      try {
        window.localStorage.setItem(key, '1');
      } catch {
        // storage blocked: the checklist shows, nothing else changes
      }
    }, gettingStartedDismissedKey(this.targets));
    return context;
  }

  private async fixturePage(persona: Persona): Promise<Page> {
    if (!this.recorded) {
      const context = await this.newContext(true);
      const page = await context.newPage();
      this.recorded = { context, page, startedAt: Date.now() };
      this.contexts.set('fixture', { context, page });
      this.fixtureRole = persona;
      return page;
    }
    const { page } = this.recorded;
    if (this.booted && this.fixtureRole !== persona) {
      const ui = this.ui(page, 'shared');
      const button = ui.sel(persona === 'client' ? 'viewAsClient' : 'viewAsDeveloper');
      await button.click({ timeout: this.step });
      await hasText(ui.sel('activeRole'), ui.text(persona === 'client' ? 'activeClient' : 'activeDeveloper'), this.step);
    }
    this.fixtureRole = persona;
    return page;
  }

  /** Opens an app path (e.g. `/o/…/p/…/changes`) as the page's persona and waits for the project heading. */
  async goto(page: Page, path: string): Promise<void> {
    const ui = this.ui(page, 'shared');
    if (this.fixture) {
      if (!this.booted) {
        await page.goto(new URL(`/?role=${this.fixtureRole ?? 'owner'}`, this.config.baseUrl).toString());
        await visible(ui.sel('fixtureBanner'), this.step);
        await ui.sel('projectLink').click({ timeout: this.step });
        await visible(ui.sel('projectHeading'), this.step);
        this.booted = true;
      }
      // the demo story lives in the page: move in-app, never reload
      await page.evaluate((p) => {
        window.history.pushState(null, '', p);
        window.dispatchEvent(new PopStateEvent('popstate'));
      }, path);
    } else {
      await page.goto(new URL(path, this.config.baseUrl).toString());
    }
    await visible(ui.sel('projectHeading'), this.long);
    if (!this.fixture && (await ui.sel('fixtureBanner').count()) > 0) {
      throw new Error(`${this.config.baseUrl} serves the fixture build; cookie mode must record the live app`);
    }
    await page.bringToFront();
    const state = await page.evaluate(() => document.visibilityState);
    if (state !== 'visible') throw new Error(`the recording tab is ${state}; the app pauses polling while hidden`);
  }

  projectPath(tab: 'files' | 'changes' | 'versions'): string {
    return `/o/${encodeURIComponent(this.targets.org)}/p/${encodeURIComponent(this.targets.project)}/${tab}`;
  }

  proposalPath(proposalId: string): string {
    return `${this.projectPath('changes')}/${encodeURIComponent(proposalId)}`;
  }

  mark(name: string): void {
    const t = this.recorded ? (Date.now() - this.recorded.startedAt) / 1000 : 0;
    this.marks.push({ name, t: Math.round(t * 100) / 100 });
    this.config.log(`    mark ${name} @ ${t.toFixed(1)} s`);
  }

  /** Records the review code of the contract-failure proposal (`blocked`) or its repair (`fixed`). */
  recordHash(key: HashKey, hash: string, proposalId: string): void {
    if (!PROPOSAL_HASH.test(hash)) throw new Error(`${key} proposal hash is not a 64-hex hash`);
    this.hashes[key] = { hash, proposalId, mode: this.config.mode, capturedAt: new Date().toISOString() };
    this.config.log(`  ${key} proposal hash ${hash.slice(0, 12)}…`);
  }

  /** Keeps the current state on screen for the footage. */
  async dwell(page: Page): Promise<void> {
    if (this.config.dwellMs > 0) await page.waitForTimeout(this.config.dwellMs);
  }

  private get stagingDir(): string {
    return join(this.config.workDir, `${this.unit.id}.staged`);
  }

  /** Takes a screenshot into the staging dir; it reaches outDir only if the unit succeeds. */
  async screenshot(page: Page, mediaPath: string): Promise<void> {
    mkdirSync(this.stagingDir, { recursive: true });
    const staged = join(this.stagingDir, basename(mediaPath));
    await page.screenshot({ path: staged });
    // the sidecar proves to `pnpm evidence` which mode captured the shot
    const marksFile = staged.replace(/\.png$/, '.marks.json');
    const t = this.recorded ? Math.round(((Date.now() - this.recorded.startedAt) / 1000) * 100) / 100 : null;
    writeFileSync(marksFile, `${JSON.stringify({ shot: basename(staged), mode: this.config.mode, takenAt: new Date().toISOString(), recordingT: t }, null, 2)}\n`);
    this.staged.push(staged, marksFile);
    this.config.log(`  took ${basename(staged)}`);
  }

  /** Moves a file a rerun would overwrite to `<workDir>/<name>.prev.<ext>`, replacing an older one. */
  private keepPrevious(target: string): void {
    if (!existsSync(target)) return;
    const kept = join(this.config.workDir, prevName(target));
    moveFile(target, kept);
    this.config.log(`  kept the previous ${basename(target)} as ${kept}`);
  }

  /** Merges recorded hashes into outDir's hashes file (media.json `hashes`, default hashes.json). */
  private publishHashes(): void {
    if (Object.keys(this.hashes).length === 0) return;
    const target = join(this.config.outDir, basename(this.config.media.hashes ?? 'clips/hashes.json'));
    let existing: unknown = null;
    if (existsSync(target)) {
      try {
        existing = JSON.parse(readFileSync(target, 'utf8'));
      } catch {
        existing = null;
      }
      copyFileSync(target, join(this.config.workDir, prevName(target)));
    }
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(mergeHashes(existing, this.hashes), null, 2)}\n`);
    moveFile(tmp, target);
    this.written.push(target);
    this.config.log(`  wrote ${target}`);
  }

  /** Moves every staged file to outDir, keeping the previous take's files. */
  private publishStaged(): void {
    for (const staged of this.staged) {
      const target = join(this.config.outDir, basename(staged));
      this.keepPrevious(target);
      moveFile(staged, target);
      this.written.push(target);
      this.config.log(`  wrote ${target}`);
    }
  }

  /** Closes every context and, if the unit succeeded, saves its clip(s), screenshots and marks. */
  async close(ok: boolean): Promise<void> {
    const video = this.recorded?.page.video() ?? null;
    if (!ok && this.recorded) {
      await this.recorded.page.screenshot({ path: join(this.config.workDir, `${this.unit.id}.failure.png`) }).catch(() => undefined);
    }
    for (const { context } of this.contexts.values()) await context.close();
    const failed = join(this.config.workDir, `${this.unit.id}.failed.webm`);
    if (!ok) {
      rmSync(this.stagingDir, { recursive: true, force: true });
      if (video) {
        await video.saveAs(failed);
        await video.delete();
        this.config.log(`  kept the failed recording at ${failed}`);
      }
      return;
    }
    let raw: string | null = null;
    try {
      if (video) {
        raw = join(this.config.workDir, `${this.unit.id}.raw.webm`);
        await video.saveAs(raw);
        await video.delete();
        const segments = this.unit.segments?.(this.config.media) ?? this.unit.outputs(this.config.media).filter((p) => p.endsWith('.webm')).map((clip) => ({ clip }));
        // cut every segment before anything reaches outDir: a failing cut leaves the take untouched
        for (const segment of segments) this.stageSegment(raw, segment);
      }
    } catch (error) {
      rmSync(this.stagingDir, { recursive: true, force: true });
      if (raw && existsSync(raw)) {
        moveFile(raw, failed);
        this.config.log(`  saving failed; kept the recording at ${failed}`);
      }
      throw error;
    }
    this.publishStaged();
    this.publishHashes();
    if (raw) rmSync(raw, { force: true });
    rmSync(this.stagingDir, { recursive: true, force: true });
  }

  private markTime(name: string): number {
    const mark = this.marks.find((m) => m.name === name);
    if (!mark) throw new Error(`no mark "${name}" to cut at`);
    return mark.t;
  }

  /** Cuts one segment and writes its marks into the staging dir. */
  private stageSegment(raw: string, segment: Segment): void {
    mkdirSync(this.stagingDir, { recursive: true });
    const name = basename(segment.clip);
    const cut = join(this.stagingDir, name);
    const from = segment.from ? Math.max(0, this.markTime(segment.from) - (segment.leadSec ?? 0)) : 0;
    const to = segment.to ? this.markTime(segment.to) : null;
    if (from === 0 && to === null) copyFileSync(raw, cut);
    else cutClip(raw, cut, from, to);
    const marks = this.marks.filter((m) => m.t >= from && (to === null || m.t <= to)).map((m) => ({ ...m, t: Math.round((m.t - from) * 100) / 100 }));
    const marksCut = cut.replace(/\.webm$/, '.marks.json');
    // startedAtMs: wall-clock epoch ms of this clip's first frame, to line the clip up with
    // orchestrator.log timestamps (scene 4 casts); approximate, the recording starts with the page
    const startedAtMs = this.recorded ? Math.round(this.recorded.startedAt + from * 1000) : null;
    writeFileSync(
      marksCut,
      `${JSON.stringify({ clip: name, mode: this.config.mode, startedAtMs, note: 'seconds from the start of this clip; callout t = (mark - from) / speed of the media.json window (pnpm check:fit)', marks }, null, 2)}\n`,
    );
    this.staged.push(cut, marksCut);
  }
}

/** Re-encodes [from, to) of a WebM (ffmpeg, VP8 at high bitrate so the cut adds little loss). */
export function cutClip(src: string, dst: string, from: number, to: number | null): void {
  const ffmpeg = process.env.FFMPEG ?? 'ffmpeg';
  execFileSync(
    ffmpeg,
    ['-hide_banner', '-loglevel', 'error', '-y', '-ss', from.toFixed(2), '-i', src, ...(to !== null ? ['-t', (to - from).toFixed(2)] : []), '-c:v', 'libvpx', '-b:v', '8M', '-crf', '8', '-an', dst],
    { stdio: 'inherit' },
  );
}

/** Runs one unit end to end; returns the files it wrote. */
export async function captureUnit(browser: Browser, config: CaptureConfig, unit: CaptureUnit): Promise<string[]> {
  if (config.mode === 'fixture' && isFinalClipsDir(config.outDir)) {
    throw new Error(`${unit.id}: fixture-mode capture must not write to ${config.outDir} (final footage); use public/clips-dry`);
  }
  mkdirSync(config.outDir, { recursive: true });
  mkdirSync(config.workDir, { recursive: true });
  config.log(`${unit.id} (${unit.scenes.join(', ')})`);
  const run = new SceneRun(browser, config, unit);
  try {
    await unit.run(run);
  } catch (error) {
    // cleanup must not replace the error that failed the unit
    await run.close(false).catch((closeError: unknown) => {
      config.log(`  cleanup after the failure also failed: ${closeError instanceof Error ? closeError.message : String(closeError)}`);
    });
    throw new Error(`${unit.id}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  try {
    await run.close(true);
  } catch (error) {
    throw new Error(`${unit.id}: saving the take failed, nothing was published: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  return run.written;
}
