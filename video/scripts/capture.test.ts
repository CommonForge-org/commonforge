import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mediaJson from '../media.json';
import narrationJson from '../narration.json';
import { mediaPaths, parseMedia, parseNarration } from '../src/data';
import { readSession } from './capture/auth';
import { MEDIA_SOURCES, UNITS, unitsFor } from './capture/scenes';
import { captureUnit, gettingStartedDismissedKey, isFinalClipsDir, mergeHashes, moveFile, prevName, readHash, type CaptureConfig, type CaptureUnit } from './capture/run';
import { ensurePreviewReady, newestCurrentPreview, previewFailureMessage, watchPreview, withPreviewWatch, type PreviewEntry } from './capture/preview-watch';
import { loadSelectors, parseSelectors, pattern } from './capture/selectors';
import { serveStatic } from './capture/static-server';
import { FIXTURE_TARGETS, parseRestore, pickProposals } from './capture/targets';

const media = parseMedia(mediaJson, parseNarration(narrationJson));

function mediaFiles(): string[] {
  return mediaPaths(media);
}

describe('selectors.json', () => {
  const selectors = loadSelectors();

  it('parses against the schema', () => {
    expect(Object.keys(selectors.scenes).length).toBeGreaterThan(0);
  });

  it('only names scenes that media.json has', () => {
    for (const id of Object.keys(selectors.scenes)) expect(Object.keys(media.scenes)).toContain(id);
  });

  it('matches the publish step\'s Live pill exactly, never "Not live"', () => {
    const live = pattern(selectors.scenes['s07-approve-publish']!.selectors.livePill!.hasText!) as RegExp;
    expect(live.test('Live')).toBe(true);
    expect(live.test('Not live')).toBe(false);
  });

  it('turns /re/flags strings into regular expressions and leaves other strings alone', () => {
    expect(pattern('/^Changes/i')).toEqual(/^Changes/i);
    expect(pattern('Production is unchanged')).toBe('Production is unchanged');
  });

  it('rejects a selector with two bases, an unknown role or a dangling "within"', () => {
    const base = { shared: { selectors: {}, texts: {} }, scenes: {} };
    const withSel = (sel: unknown) => ({ ...base, scenes: { 's01-mess': { selectors: { a: sel }, texts: {} } } });
    expect(() => parseSelectors(withSel({ testid: 'x', css: '.x' }))).toThrow(/exactly one of/);
    expect(() => parseSelectors(withSel({ role: 'banana' }))).toThrow(/selectors\.json is invalid/);
    expect(() => parseSelectors(withSel({ css: '.x', within: 'nope' }))).toThrow(/unknown selector "nope"/);
    expect(() => parseSelectors(withSel({ css: '.x', within: 'a' }))).toThrow(/loops/);
  });
});

describe('capture plan', () => {
  it('names a source for exactly the files media.json expects', () => {
    expect(Object.keys(MEDIA_SOURCES).sort()).toEqual([...new Set(mediaFiles())].sort());
  });

  it('has selectors for every scene captured in the browser', () => {
    const selectors = loadSelectors();
    const browserScenes = new Set(Object.values(MEDIA_SOURCES).filter((s) => s.source === 'browser').map((s) => s.scene));
    for (const scene of browserScenes) expect(Object.keys(selectors.scenes)).toContain(scene);
  });

  it('assigns every browser-captured file to exactly one unit', () => {
    const produced = UNITS.flatMap((u) => u.outputs(media));
    const browserFiles = Object.entries(MEDIA_SOURCES).filter(([, s]) => s.source === 'browser').map(([f]) => f);
    expect(produced.sort()).toEqual(browserFiles.sort());
  });

  it('selects units by scene number, keeping scenes 2 and 3 together', () => {
    expect(unitsFor([1]).map((u) => u.id)).toEqual(['files']);
    expect(unitsFor([3]).map((u) => u.id)).toEqual(['edition']);
    expect(unitsFor([2, 3]).map((u) => u.id)).toEqual(['edition']);
    expect(() => unitsFor([9])).toThrow(/no browser capture for scene 9/);
  });
});

describe('live targets', () => {
  const at = (iso: string) => ({ createdAt: iso, updatedAt: iso });

  it('picks the contract failure and the later passing proposal of the same Change', () => {
    const picked = pickProposals([
      { proposalId: 'p-other', changeId: 'c2', ...at('2026-10-06T10:00:00Z'), lastAttempt: { state: 'succeeded', code: null } },
      { proposalId: 'p-fail', changeId: 'c1', ...at('2026-10-06T10:01:00Z'), lastAttempt: { state: 'failed', code: 'contract_failed' } },
      { proposalId: 'p-fix', changeId: 'c1', ...at('2026-10-06T10:05:00Z'), lastAttempt: { state: 'succeeded', code: null } },
      { proposalId: 'p-early', changeId: 'c1', ...at('2026-10-06T09:00:00Z'), lastAttempt: { state: 'succeeded', code: null } },
    ]);
    expect(picked).toEqual({ fail: 'p-fail', fix: 'p-fix' });
  });

  it('finds nothing before the agents have produced a contract failure', () => {
    expect(pickProposals([{ proposalId: 'p', changeId: 'c', ...at('2026-10-06T10:00:00Z'), lastAttempt: null }])).toEqual({});
  });

  it('maps CAPTURE_RESTORE names to Versions-screen resources', () => {
    expect(parseRestore('website, brand')).toEqual(['resourceWebsite', 'resourceBrand']);
    expect(() => parseRestore('api')).toThrow(/unknown resource "api"/);
  });
});

describe('readSession', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cf-session-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('reads the CLI session token and user', () => {
    const file = join(dir, 'session.json');
    writeFileSync(file, JSON.stringify({ apiUrl: 'https://w.example', sessionToken: 'cfs_secret123', expiresAt: '2099-01-01T00:00:00Z', user: { userId: 'u1', email: 'owner@example.com' } }));
    expect(readSession(file)).toEqual({ token: 'cfs_secret123', email: 'owner@example.com', apiUrl: 'https://w.example', expiresAt: '2099-01-01T00:00:00Z' });
  });

  it('rejects a non-session token without echoing it', () => {
    const file = join(dir, 'bad.json');
    writeFileSync(file, JSON.stringify({ apiUrl: 'https://w.example', sessionToken: 'cfl_leaktoken', expiresAt: '2099-01-01T00:00:00Z', user: { userId: 'u1', email: 'a@b.c' } }));
    let message = '';
    try {
      readSession(file);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/not a CLI session/);
    expect(message).not.toContain('leaktoken');
  });
});

/** A static stand-in for the fixture web build: just enough markup for scene 1. */
const STATIC_FIXTURE = `<!doctype html><html><head><title>fixture</title></head><body>
<div role="note">Fixture mode <span>Not a live run.</span> View as <button class="seg seg-active">Developer</button><button class="seg">Client</button></div>
<a href="#project" id="project">Customer Portal</a>
<main hidden id="shell"><h1>Customer Portal</h1>
<ul role="tree" aria-label="Project files">
  <li role="treeitem"><button type="button" data-kind="Artifacts repository · Coordinates">Website</button></li>
  <li role="treeitem"><button type="button" data-kind="R2 asset collection">Brand and media</button></li>
</ul>
<aside class="browser-inspector">Select a folder</aside></main>
<script>
document.getElementById('project').addEventListener('click', () => { document.getElementById('shell').hidden = false; });
for (const b of document.querySelectorAll('[role=tree] button')) b.addEventListener('click', () => {
  document.querySelector('.browser-inspector').textContent = b.textContent + ': ' + b.dataset.kind;
});
</script></body></html>`;

describe('dry run against a static fixture page', () => {
  let browser: Browser;
  let server: Awaited<ReturnType<typeof serveStatic>>;
  const root = mkdtempSync(join(tmpdir(), 'cf-capture-'));

  beforeAll(async () => {
    const site = join(root, 'site');
    mkdirSync(site);
    writeFileSync(join(site, 'index.html'), STATIC_FIXTURE);
    server = await serveStatic(site);
    browser = await chromium.launch();
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('serves index.html for app routes (SPA fallback) and 404s missing assets', async () => {
    expect((await fetch(`${server.url}/o/x/p/y/files`)).status).toBe(200);
    expect(await (await fetch(`${server.url}/o/x/p/y/files`)).text()).toContain('Project files');
    expect((await fetch(`${server.url}/assets/missing.js`)).status).toBe(404);
  });

  const fixtureConfig = (name: string, lines: string[] = []): CaptureConfig => ({
    mode: 'fixture',
    baseUrl: server.url,
    outDir: join(root, name, 'clips-dry'),
    workDir: join(root, name, 'work'),
    timeouts: { stepMs: 5_000, longMs: 5_000 },
    dwellMs: 0,
    sessions: {},
    targets: FIXTURE_TARGETS,
    media,
    selectors: loadSelectors(),
    log: (line) => lines.push(line),
  });

  it('runs scene 1 and writes its clip and marks to the dry-run directory', async () => {
    const lines: string[] = [];
    const config = fixtureConfig('scene1', lines);
    const started = Date.now();
    const written = await captureUnit(browser, config, unitsFor([1])[0]!);
    const clip = join(config.outDir, 'clip-01-intake.webm');
    expect(written).toContain(clip);
    expect(existsSync(clip) && statSync(clip).size).toBeGreaterThan(0);
    const marks = JSON.parse(readFileSync(join(config.outDir, 'clip-01-intake.marks.json'), 'utf8')) as { startedAtMs: number; marks: Array<{ name: string; t: number }> };
    expect(marks.marks.map((m) => m.name)).toEqual(expect.arrayContaining(['inspector-website', 'inspector-brand']));
    expect(marks.startedAtMs).toBeGreaterThanOrEqual(started);
    expect(marks.startedAtMs).toBeLessThanOrEqual(Date.now());
    expect(lines.join('\n')).toMatch(/clip-01-intake\.webm/);

    // a rerun keeps the previous take's clip and marks in the work dir instead of overwriting them
    const firstClip = readFileSync(clip);
    await captureUnit(browser, config, unitsFor([1])[0]!);
    expect(readFileSync(join(config.workDir, 'clip-01-intake.prev.webm')).equals(firstClip)).toBe(true);
    expect(existsSync(join(config.workDir, 'clip-01-intake.prev.marks.json'))).toBe(true);
    expect(existsSync(clip)).toBe(true);
  }, 60_000);

  const shotThenFail = (error: string, sabotage?: (config: CaptureConfig) => void): CaptureUnit => ({
    id: 'shot-then-fail',
    personas: ['owner'],
    scenes: ['s05-collision'],
    outputs: () => [],
    async run(run) {
      const page = await run.page('owner', { record: true });
      await page.goto(server.url);
      await run.screenshot(page, 'clips/shot-05-contract-fail.png');
      sabotage?.(run.config);
      throw new Error(error);
    },
  });

  it('publishes no screenshot from a unit that fails after taking it', async () => {
    const config = fixtureConfig('failed-shot');
    await expect(captureUnit(browser, config, shotThenFail('evidence panel never appeared'))).rejects.toThrow(/shot-then-fail: evidence panel never appeared/);
    expect(existsSync(join(config.outDir, 'shot-05-contract-fail.png'))).toBe(false);
    expect(existsSync(join(config.outDir, 'shot-05-contract-fail.marks.json'))).toBe(false);
    expect(existsSync(join(config.workDir, 'shot-then-fail.staged'))).toBe(false);
    expect(existsSync(join(config.workDir, 'shot-then-fail.failed.webm'))).toBe(true);
  }, 60_000);

  it('reports the unit\'s own error when cleanup after it fails too', async () => {
    const lines: string[] = [];
    const config = fixtureConfig('failed-cleanup', lines);
    // the work dir becomes a file: saving the failed recording there fails during cleanup
    const sabotage = (c: CaptureConfig) => {
      rmSync(c.workDir, { recursive: true, force: true });
      writeFileSync(c.workDir, 'not a directory');
    };
    await expect(captureUnit(browser, config, shotThenFail('the original failure', sabotage))).rejects.toThrow(/shot-then-fail: the original failure/);
    expect(lines.join('\n')).toMatch(/cleanup after the failure also failed/);
  }, 60_000);

  it('publishes nothing when saving the second segment fails: the previous take stays whole', async () => {
    const config = fixtureConfig('failed-segment');
    mkdirSync(config.outDir, { recursive: true });
    const old: Record<string, string> = {
      'clip-02-edition.webm': 'old take clip 2',
      'clip-02-edition.marks.json': '{"old":2}',
      'clip-03-own-tool.webm': 'old take clip 3',
      'clip-03-own-tool.marks.json': '{"old":3}',
      'shot-05-contract-fail.png': 'old shot',
    };
    for (const [file, text] of Object.entries(old)) writeFileSync(join(config.outDir, file), text);
    const unit: CaptureUnit = {
      id: 'two-segments',
      personas: ['client'],
      scenes: ['s02-client-update', 's03-own-tool'],
      outputs: () => ['clips/clip-02-edition.webm', 'clips/clip-03-own-tool.webm'],
      // the first segment cuts fine; the second names a mark the run never set
      segments: () => [{ clip: 'clips/clip-02-edition.webm', to: 'middle' }, { clip: 'clips/clip-03-own-tool.webm', from: 'never-marked' }],
      async run(run) {
        const page = await run.page('client', { record: true });
        await page.goto(server.url);
        await run.screenshot(page, 'clips/shot-05-contract-fail.png');
        await page.waitForTimeout(300);
        run.mark('middle');
        await page.waitForTimeout(300);
      },
    };
    await expect(captureUnit(browser, config, unit)).rejects.toThrow(/^two-segments: saving the take failed, nothing was published: no mark "never-marked"/);
    for (const [file, text] of Object.entries(old)) expect(readFileSync(join(config.outDir, file), 'utf8'), file).toBe(text);
    expect(readdirSync(config.outDir).sort()).toEqual(Object.keys(old).sort());
    expect(readdirSync(config.workDir).filter((f) => f.includes('.prev'))).toEqual([]);
    expect(existsSync(join(config.workDir, 'two-segments.staged'))).toBe(false);
    expect(existsSync(join(config.workDir, 'two-segments.failed.webm'))).toBe(true);
    expect(existsSync(join(config.workDir, 'two-segments.raw.webm'))).toBe(false);
  }, 60_000);

  const HASH_A = 'a'.repeat(64);
  const HASH_B = '0123456789abcdef'.repeat(4);
  const hashUnit = (fail: boolean): CaptureUnit => ({
    id: 'hash-unit',
    personas: ['owner'],
    scenes: ['s06-repair-preview'],
    outputs: () => [],
    async run(run) {
      const page = await run.page('owner', { record: true });
      await page.setContent(`<div data-testid="proposal-hash" data-hash="${HASH_B}">review code</div>`);
      run.recordHash('fixed', await readHash(page.getByTestId('proposal-hash'), 5_000), 'prop-fix');
      if (fail) throw new Error('preview never became ready');
    },
  });

  it('merges the hash a unit reads off the page into hashes.json, keeping the other proposal\'s', async () => {
    const config = fixtureConfig('hashes');
    mkdirSync(config.outDir, { recursive: true });
    writeFileSync(join(config.outDir, 'hashes.json'), JSON.stringify({ blocked: { hash: HASH_A, proposalId: 'prop-fail' } }));
    const written = await captureUnit(browser, config, hashUnit(false));
    expect(written).toContain(join(config.outDir, 'hashes.json'));
    const hashes = JSON.parse(readFileSync(join(config.outDir, 'hashes.json'), 'utf8')) as Record<string, { hash: string; proposalId: string; mode: string }>;
    expect(hashes.blocked).toEqual({ hash: HASH_A, proposalId: 'prop-fail' });
    expect(hashes.fixed).toMatchObject({ hash: HASH_B, proposalId: 'prop-fix', mode: 'fixture' });
  }, 60_000);

  it('writes no hash from a unit that fails', async () => {
    const config = fixtureConfig('hashes-failed');
    await expect(captureUnit(browser, config, hashUnit(true))).rejects.toThrow(/preview never became ready/);
    expect(existsSync(join(config.outDir, 'hashes.json'))).toBe(false);
  }, 60_000);

  it('refuses a proposal-hash element without a real hash', async () => {
    const page = await browser.newPage();
    await page.setContent('<div data-testid="proposal-hash" data-hash="PLACEHOLDER">x</div>');
    await expect(readHash(page.getByTestId('proposal-hash'), 2_000)).rejects.toThrow(/not a 64-hex hash \(PLACEHOLDER\)/);
    await page.close();
  });

  it('refuses a fixture capture aimed at public/clips', async () => {
    const config = { ...fixtureConfig('guard'), outDir: join(root, 'guard', 'public', 'clips') };
    await expect(captureUnit(browser, config, unitsFor([1])[0]!)).rejects.toThrow(/fixture-mode capture must not write to .*public\/clips/);
    expect(existsSync(config.outDir)).toBe(false);
  });
});

describe('preview build watch', () => {
  const never = new Promise<never>(() => undefined);
  const failed = (detail: string): PreviewEntry => ({ previewId: 'pv-2', state: 'failed', createdAt: '2026-10-06T10:00:20Z', forCurrentHash: true, error: { code: 'build_failed', detail } });

  it('aborts at once on a failed preview, with the error code and the first 300 characters of the detail', async () => {
    const detail = `${'x'.repeat(300)}TAIL-NOT-SHOWN`;
    let polls = 0;
    const list = async () => {
      polls += 1;
      return polls < 2 ? [{ previewId: 'pv-2', state: 'building', createdAt: '2026-10-06T10:00:20Z' }] : [failed(detail)];
    };
    const started = Date.now();
    // the UI wait never finishes: only the watcher can end this
    const err = await withPreviewWatch(never, list, { intervalMs: 5 }).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe(`the preview build failed (build_failed): ${'x'.repeat(300)}`);
    expect(err.message).not.toContain('TAIL-NOT-SHOWN');
    expect(polls).toBe(2);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('leaves the outcome to the UI wait once the preview is ready', async () => {
    const ready: PreviewEntry = { previewId: 'pv-2', state: 'ready', createdAt: '2026-10-06T10:00:20Z', forCurrentHash: true, error: null };
    expect(await watchPreview(async () => [ready], { intervalMs: 5 })).toBe('ready');
    let uiDone: (v: string) => void = () => undefined;
    const ui = new Promise<string>((resolve) => { uiDone = resolve; });
    const waiting = withPreviewWatch(ui, async () => [ready], { intervalMs: 5 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    uiDone('open-preview shown');
    expect(await waiting).toBe('open-preview shown');
  });

  it('stops polling when the UI wait wins, and skips a poll that errors', async () => {
    let polls = 0;
    const list = async (): Promise<PreviewEntry[]> => {
      polls += 1;
      throw new Error('network down');
    };
    const ui = new Promise<string>((resolve) => setTimeout(() => resolve('shown'), 30));
    expect(await withPreviewWatch(ui, list, { intervalMs: 5 })).toBe('shown');
    const after = polls;
    expect(after).toBeGreaterThan(1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(polls).toBe(after);
  });

  it('judges only the newest preview for the current hash, not an older or stale-hash failure', () => {
    const old: PreviewEntry = { previewId: 'pv-1', state: 'failed', createdAt: '2026-10-06T09:00:00Z', forCurrentHash: true, error: { code: 'e' } };
    const stale: PreviewEntry = { previewId: 'pv-3', state: 'failed', createdAt: '2026-10-06T11:00:00Z', forCurrentHash: false, error: { code: 'e' } };
    const building: PreviewEntry = { previewId: 'pv-2', state: 'building', createdAt: '2026-10-06T10:00:00Z', forCurrentHash: true };
    expect(newestCurrentPreview([old, stale, building])?.previewId).toBe('pv-2');
    expect(newestCurrentPreview([old, building], new Set(['pv-2']))?.previewId).toBe('pv-1');
    expect(newestCurrentPreview([stale])).toBeUndefined();
    expect(previewFailureMessage({ previewId: 'x', state: 'failed', error: { code: 'no_detail' } })).toBe('the preview build failed (no_detail)');
  });
});

describe('capture helpers', () => {
  it("hides the demo project's Getting started checklist with the web app's own key", () => {
    const onboarding = readFileSync(new URL('../../apps/web/src/lib/onboarding.ts', import.meta.url), 'utf8');
    const prefix = /const DISMISS_PREFIX = "([^"]+)";/.exec(onboarding)?.[1];
    expect(prefix).toBe('cf-getting-started-dismissed:');
    expect(onboarding).toContain('`${DISMISS_PREFIX}${org}/${pid}`');
    expect(gettingStartedDismissedKey(FIXTURE_TARGETS)).toBe(`${prefix}${FIXTURE_TARGETS.org}/${FIXTURE_TARGETS.project}`);
  });

  it('merges hashes over an unreadable or partial file', () => {
    expect(mergeHashes('not json', { fixed: { hash: 'h' } })).toEqual({ fixed: { hash: 'h' } });
    expect(mergeHashes({ blocked: { hash: 'b' }, fixed: { hash: 'old' } }, { fixed: { hash: 'new' } })).toEqual({ blocked: { hash: 'b' }, fixed: { hash: 'new' } });
  });

  it('names the kept previous take', () => {
    expect(prevName('/x/clip-01-intake.webm')).toBe('clip-01-intake.prev.webm');
    expect(prevName('shot-05-contract-fail.marks.json')).toBe('shot-05-contract-fail.prev.marks.json');
    expect(prevName('shot-07-client-view.png')).toBe('shot-07-client-view.prev.png');
  });

  it('moves across volumes by copy and unlink when rename fails with EXDEV', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cf-move-'));
    const from = join(dir, 'a.webm');
    writeFileSync(from, 'bytes');
    const exdev = () => {
      throw Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' });
    };
    moveFile(from, join(dir, 'b.webm'), exdev);
    expect(readFileSync(join(dir, 'b.webm'), 'utf8')).toBe('bytes');
    expect(existsSync(from)).toBe(false);
    writeFileSync(from, 'x');
    const eacces = () => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    };
    expect(() => moveFile(from, join(dir, 'c.webm'), eacces)).toThrow(/permission denied/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('recognises the final-footage directory', () => {
    expect(isFinalClipsDir('/repo/video/public/clips')).toBe(true);
    expect(isFinalClipsDir('/repo/video/public/clips/')).toBe(true);
    expect(isFinalClipsDir('/repo/video/public/clips-dry')).toBe(false);
    expect(isFinalClipsDir('/repo/video/.capture/rehearsal/clips')).toBe(false);
  });
});

describe('ensurePreviewReady (developer side of the preview unit)', () => {
  const pv = (previewId: string, state: string, createdAt: string): PreviewEntry => ({ previewId, state, createdAt, forCurrentHash: true, error: state === 'failed' ? { code: 'build_failed', detail: 'boom' } : null });
  const setup = (opts: { initial: PreviewEntry[]; click?: 'ok' | 'throws'; clickCreates?: boolean; api?: 'ok' | 'throws'; after?: PreviewEntry }) => {
    const calls: string[] = [];
    const logs: string[] = [];
    let previews = [...opts.initial];
    const created = opts.after ?? pv('pv-new', 'queued', '2026-10-06T10:05:00Z');
    let polls = 0;
    const deps = {
      list: async () => {
        polls++;
        // once a build was requested it moves to ready after a few polls
        if (previews.includes(created) && polls > 6) previews = previews.map((p) => (p === created ? { ...created, state: opts.after?.state ?? 'ready' } : p));
        return previews;
      },
      clickBuild: async () => {
        calls.push('click');
        if (opts.click === 'throws') throw new Error('locator.click: Timeout 15000ms exceeded\n  waiting for getByTestId');
        if (opts.clickCreates) previews = [...previews, created];
      },
      requestApi: async () => {
        calls.push('api');
        if (opts.api === 'throws') throw new Error('requesting a preview failed: 409');
        previews = [...previews, created];
      },
      log: (line: string) => logs.push(line),
      intervalMs: 5,
      settleMs: 40,
      timeoutMs: 2_000,
    };
    return { deps, calls, logs };
  };

  it('uses a preview that is already ready without requesting another', async () => {
    const { deps, calls } = setup({ initial: [pv('pv-1', 'ready', '2026-10-06T10:00:00Z')] });
    expect(await ensurePreviewReady(deps)).toBe('existing');
    expect(calls).toEqual([]);
  });

  it('only waits for a preview that is already building', async () => {
    const building = pv('pv-1', 'building', '2026-10-06T10:00:00Z');
    let polls = 0;
    const { deps, calls } = setup({ initial: [] });
    deps.list = async () => [polls++ < 3 ? building : { ...building, state: 'ready' }];
    expect(await ensurePreviewReady(deps)).toBe('existing');
    expect(calls).toEqual([]);
  });

  it('counts the UI click when it produces a new preview, and does not call the API', async () => {
    const { deps, calls, logs } = setup({ initial: [], clickCreates: true });
    expect(await ensurePreviewReady(deps)).toBe('ui');
    expect(calls).toEqual(['click']);
    expect(logs).toContain('  preview requested via UI');
  });

  it('falls back to the API when the button is missing, and logs it', async () => {
    const { deps, calls, logs } = setup({ initial: [], click: 'throws' });
    expect(await ensurePreviewReady(deps)).toBe('api');
    expect(calls).toEqual(['click', 'api']);
    expect(logs.some((l) => /Build preview button not usable/.test(l))).toBe(true);
    expect(logs).toContain('  preview requested via API');
  });

  it('falls back to the API when the click silently produces no preview', async () => {
    const { deps, calls } = setup({ initial: [] });
    expect(await ensurePreviewReady(deps)).toBe('api');
    expect(calls).toEqual(['click', 'api']);
  });

  it('ignores a preview that failed before this run and requests a new one', async () => {
    const { deps, calls } = setup({ initial: [pv('pv-old', 'failed', '2026-10-06T09:00:00Z')], click: 'throws' });
    expect(await ensurePreviewReady(deps)).toBe('api');
    expect(calls).toEqual(['click', 'api']);
  });

  it('aborts at once when the newly requested build fails', async () => {
    const { deps } = setup({ initial: [], click: 'throws', after: pv('pv-new', 'failed', '2026-10-06T10:05:00Z') });
    await expect(ensurePreviewReady(deps)).rejects.toThrow('the preview build failed (build_failed): boom');
  });

  it('surfaces a refused API request', async () => {
    const { deps } = setup({ initial: [], click: 'throws', api: 'throws' });
    await expect(ensurePreviewReady(deps)).rejects.toThrow('requesting a preview failed: 409');
  });

  it('gives up when the preview never becomes ready within the bound', async () => {
    const { deps } = setup({ initial: [], click: 'throws', after: pv('pv-new', 'building', '2026-10-06T10:05:00Z') });
    await expect(ensurePreviewReady({ ...deps, timeoutMs: 60 })).rejects.toThrow(/did not become ready within/);
  });
});
