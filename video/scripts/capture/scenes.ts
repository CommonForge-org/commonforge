/**
 * The capture plan: where every media.json file comes from, and the browser units that record
 * the DEMO-SCRIPT beats. Units, not scenes, own a browser session because the client's edition
 * session (scenes 2 and 3) lives in page state: it is recorded once and cut into two clips.
 */
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Media } from '../../src/data';
import { atLeast, hasText, readHash, visible, type CaptureUnit, type SceneRun } from './run';
import { ensurePreviewReady, type PreviewEntry } from './preview-watch';
import { discoverProposals } from './targets';

/** `browser-data`: values a browser unit reads off the page (not footage). */
export type Source = 'browser' | 'browser-data' | 'agent-log' | 'terminal-script' | 'manual';

/** Every file media.json names, with its producer. */
export const MEDIA_SOURCES: Record<string, { scene: string; source: Source; how: string }> = {
  'clips/clip-01-intake.webm': { scene: 's01-mess', source: 'browser', how: 'capture unit "files": project tree and source inspector (intake itself is API-only; see cast-intake.cast)' },
  'clips/cast-intake.cast': { scene: 's01-mess', source: 'terminal-script', how: 'record-cast + terminal/intake.sh: ZIP intake dry-run inventory (stops before confirming)' },
  'clips/shot-01-client-folder.png': { scene: 's01-mess', source: 'manual', how: 'owner screenshot of the client hand-off folder (Finder), 1920x1080 or larger' },
  'clips/clip-02-edition.webm': { scene: 's02-client-update', source: 'browser', how: 'capture unit "edition", first segment: Start an update, download the working copy' },
  'clips/cast-02-clone.cast': { scene: 's02-client-update', source: 'terminal-script', how: 'record-cast + terminal/clone.sh: the client\'s edition token is denied on the canonical repo, clones the edition, one commit' },
  'clips/clip-03-own-tool.webm': { scene: 's03-own-tool', source: 'browser', how: 'capture unit "edition", second segment: send back the edited ZIP, return result' },
  'clips/clip-04-lanes.webm': { scene: 's04-three-agents', source: 'browser', how: 'capture unit "lanes" while capture:terminals runs the orchestrator' },
  'clips/cast-04-agent-a.cast': { scene: 's04-three-agents', source: 'agent-log', how: 'log-to-casts: agent-1 lines of orchestrator.log' },
  'clips/cast-04-agent-b.cast': { scene: 's04-three-agents', source: 'agent-log', how: 'log-to-casts: agent-2 lines of orchestrator.log' },
  'clips/cast-04-agent-c.cast': { scene: 's04-three-agents', source: 'agent-log', how: 'log-to-casts: agent-3 lines of orchestrator.log' },
  'clips/clip-05-collision.webm': { scene: 's05-collision', source: 'browser', how: 'capture unit "collision": blocked banner and evidence of the failed proposal' },
  'clips/shot-05-contract-fail.png': { scene: 's05-collision', source: 'browser', how: 'capture unit "collision": evidence panel screenshot' },
  'clips/clip-06-preview.webm': { scene: 's06-repair-preview', source: 'browser', how: 'capture unit "preview": repair proposal, Open preview as the client' },
  'clips/clip-07-publish.webm': { scene: 's07-approve-publish', source: 'browser', how: 'capture unit "publish": developer accepts, prepares, approves publishing, publishes' },
  'clips/shot-07-client-view.png': { scene: 's07-approve-publish', source: 'browser', how: 'capture unit "publish": client view of the repair proposal' },
  'clips/shot-07-developer-view.png': { scene: 's07-approve-publish', source: 'browser', how: 'capture unit "publish": developer view of the same proposal' },
  'clips/clip-08-restore.webm': { scene: 's08-restore-export', source: 'browser', how: 'capture unit "restore": restore earlier versions, export' },
  'clips/cast-release.cast': { scene: 's08-restore-export', source: 'terminal-script', how: 'record-cast + terminal/release-after-restore.sh: the restored version through the release gate' },
  'clips/hashes.json': { scene: 's06-repair-preview', source: 'browser-data', how: 'capture units "collision" (blocked) and "preview" (fixed): data-hash of the proposal-hash element, merged into hashes.json' },
  'clips/cast-08-bundle-verify.cast': { scene: 's08-restore-export', source: 'terminal-script', how: 'record-cast + terminal/bundle-verify.sh: cforge export, git bundle verify' },
};

function clipOf(media: Media, scene: string): string {
  const clip = media.scenes[scene]?.clip;
  if (!clip) throw new Error(`media.json scene ${scene} has no clip`);
  return clip.src;
}

function shotOf(media: Media, scene: string, index: number): string {
  const shot = media.scenes[scene]?.shots?.[index];
  if (!shot) throw new Error(`media.json scene ${scene} has no shots[${index}]`);
  return shot;
}

/** Waits until `path` exists and its size has stopped changing (a ZIP still being written is not ready). */
async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  for (;;) {
    const size = existsSync(path) ? statSync(path).size : -1;
    if (size > 0 && size === last) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    last = size;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

/** The path the owner will save the edited working copy to; it must not exist yet, or an old copy would be sent. */
function freshEditedZip(path: string | undefined): string {
  if (!path) throw new Error('scene 3 needs CAPTURE_EDITED_ZIP: the path where you will save the edited working copy (ZIP)');
  if (existsSync(path)) throw new Error(`${path} already exists; move it away so an old copy is not sent back`);
  return path;
}

/** The web app polls every 3 s; wait this long before concluding something is not there yet. */
const APP_POLL_MS = 4_000;

/** How often the preview unit asks the API about the preview build. */
const PREVIEW_WATCH_MS = 3_000;

/** How long a click on Build preview gets to show up as a new preview before the API is asked instead. */
const PREVIEW_UI_SETTLE_MS = 10_000;

/** Proposal ids for scenes 5-7: fixed in fixture mode, from env or the API in cookie mode. */
async function proposals(run: SceneRun): Promise<{ fail: string; fix: string }> {
  let { failProposal: fail, fixProposal: fix } = run.targets;
  if (!fail || !fix) {
    const page = await run.page('owner', { record: false });
    const found = await discoverProposals(page.context().request, run.config.baseUrl, run.targets.org, run.targets.project);
    fail ??= found.fail;
    fix ??= found.fix;
  }
  if (!fail || !fix) throw new Error('could not find the contract-failure proposal and its repair; set CAPTURE_FAIL_PROPOSAL and CAPTURE_FIX_PROPOSAL');
  return { fail, fix };
}

const files: CaptureUnit = {
  id: 'files',
  personas: ['owner'],
  scenes: ['s01-mess'],
  outputs: (media) => [clipOf(media, 's01-mess')],
  async run(run) {
    const page = await run.page('owner', { record: true });
    const ui = run.ui(page, 's01-mess');
    await run.goto(page, run.projectPath('files'));
    await visible(ui.sel('tree'), run.long);
    run.mark('files');
    await run.dwell(page);
    await ui.sel('websiteFolder').click({ timeout: run.step });
    await hasText(ui.sel('inspector'), ui.text('artifactsRepo'), run.step);
    await hasText(ui.sel('inspector'), ui.text('coordinates'), run.step);
    run.mark('inspector-website');
    await run.dwell(page);
    await ui.sel('brandFolder').click({ timeout: run.step });
    await hasText(ui.sel('inspector'), ui.text('r2Collection'), run.step);
    run.mark('inspector-brand');
    await run.dwell(page);
  },
};

const edition: CaptureUnit = {
  id: 'edition',
  personas: ['client'],
  scenes: ['s02-client-update', 's03-own-tool'],
  outputs: (media) => [clipOf(media, 's02-client-update'), clipOf(media, 's03-own-tool')],
  segments: (media) => [
    { clip: clipOf(media, 's02-client-update'), to: 's02-end' },
    { clip: clipOf(media, 's03-own-tool'), from: 's03-start', leadSec: 1 },
  ],
  async run(run) {
    const edited = run.fixture ? null : freshEditedZip(run.targets.editedZip);
    const page = await run.page('client', { record: true });
    await run.goto(page, run.projectPath('files'));
    const s2 = run.ui(page, 's02-client-update');
    await s2.sel('startUpdate').click({ timeout: run.step });
    await visible(s2.sel('dialogHeading'), run.step);
    // the request field renders only once the client's published working copy has loaded
    await visible(s2.sel('request'), run.long);
    run.mark('start-update');
    await s2.sel('request').fill(run.targets.updateRequest, { timeout: run.step });
    await s2.sel('getCopy').click({ timeout: run.step });
    await visible(s2.sel('download'), run.long);
    run.mark('working-copy-ready');
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: run.long }), s2.sel('download').click({ timeout: run.step })]);
    const copy = join(run.config.workDir, 'working-copy.zip');
    await download.saveAs(copy);
    run.config.log(`  saved the working copy to ${copy}`);
    await run.dwell(page);
    run.mark('s02-end');

    const s3 = run.ui(page, 's03-own-tool');
    let zip: string | { name: string; mimeType: string; buffer: Buffer };
    if (edited === null) {
      // the fixture accepts any ZIP; this is an empty archive
      zip = { name: 'website-pages.zip', mimeType: 'application/zip', buffer: Buffer.from(`PK\u0005\u0006${'\0'.repeat(18)}`, 'binary') };
    } else {
      run.config.log(`  edit ${copy} in your own tool, then save the edited ZIP as ${edited}; waiting…`);
      await waitForFile(edited, run.long);
      zip = edited;
    }
    run.mark('s03-start');
    await s3.sel('zipInput').setInputFiles(zip, { timeout: run.step });
    await s3.sel('send').click({ timeout: run.step });
    await hasText(s3.sel('returnRow'), s3.text('returnSettled'), run.long);
    const result = (await s3.sel('returnRow').innerText()).trim();
    const ready = s3.text('readyForReview');
    if (typeof ready === 'string' ? !result.includes(ready) : !ready.test(result)) {
      throw new Error(`the returned copy did not become a proposal: ${result.split('\n')[0]}`);
    }
    run.mark('return-ready');
    await run.dwell(page);
  },
};

const lanes: CaptureUnit = {
  id: 'lanes',
  personas: ['owner'],
  scenes: ['s04-three-agents'],
  outputs: (media) => [clipOf(media, 's04-three-agents')],
  // three agents, each with a gate retry, can run well past the default 20 minutes (capture-briefing.md)
  liveLongTimeoutMin: 45,
  async run(run) {
    const page = await run.page('owner', { record: true });
    const ui = run.ui(page, 's04-three-agents');
    await run.goto(page, run.projectPath('changes'));
    if (!run.fixture) run.config.log('  waiting for agents; start `pnpm capture:terminals` now if it is not running');
    await hasText(ui.sel('lanes'), ui.text('someWorking'), run.long);
    run.mark('agents-working');
    await atLeast(ui.sel('changeRow'), 3, run.long);
    run.mark('three-changes');
    // fixture only: the in-page story has one agent that runs until told to finish
    if (run.fixture) await run.ui(page, 'shared').sel('finishRunningAgent').click({ timeout: run.step });
    await hasText(ui.sel('lanes'), ui.text('noneWorking'), run.long);
    await hasText(ui.sel('lanes'), ui.text('agentsAtOnce'), run.step);
    run.mark('agents-done');
    await run.dwell(page);
  },
};

const collision: CaptureUnit = {
  id: 'collision',
  personas: ['owner'],
  scenes: ['s05-collision'],
  outputs: (media) => [clipOf(media, 's05-collision'), shotOf(media, 's05-collision', 0)],
  async run(run) {
    const { fail } = await proposals(run);
    const page = await run.page('owner', { record: true });
    const ui = run.ui(page, 's05-collision');
    await run.goto(page, run.proposalPath(fail));
    await hasText(ui.sel('blocked'), ui.text('productionUnchanged'), run.long);
    run.recordHash('blocked', await readHash(ui.sel('proposalHash'), run.step), fail);
    run.mark('blocked');
    await run.dwell(page);
    await ui.sel('runnerOutput').click({ timeout: run.step });
    run.mark('runner-output');
    await run.dwell(page);
    await ui.sel('evidence').first().scrollIntoViewIfNeeded({ timeout: run.step });
    await visible(ui.sel('evidence'), run.step);
    run.mark('evidence');
    await run.screenshot(page, shotOf(run.config.media, 's05-collision', 0));
    await run.dwell(page);
  },
};

const preview: CaptureUnit = {
  id: 'preview',
  personas: ['owner', 'client'],
  scenes: ['s06-repair-preview'],
  outputs: (media) => [clipOf(media, 's06-repair-preview')],
  async run(run) {
    const { fix } = await proposals(run);
    // building a preview is a developer action; the scene shows the client opening it
    const owner = await run.page('owner', { record: false });
    const prep = run.ui(owner, 's06-repair-preview');
    await run.goto(owner, run.proposalPath(fix));
    await visible(prep.sel('fixed'), run.long);
    const previewsUrl = new URL(`/api/orgs/${encodeURIComponent(run.targets.org)}/proposals/${encodeURIComponent(fix)}/previews`, run.config.baseUrl).toString();
    const api = owner.context().request;
    if (run.fixture) {
      // the fixture's in-page story has no previews API; its view keeps the UI flow
      const ready = await visible(prep.sel('openPreview'), APP_POLL_MS).then(
        () => true,
        () => false,
      );
      if (!ready) {
        await prep.sel('buildPreview').click({ timeout: run.long });
        await visible(prep.sel('openPreview'), run.long);
      }
    } else {
      // developers see the Change storyboard, which has no "Open preview" element: go by the previews API
      await ensurePreviewReady({
        list: async () => {
          const res = await api.get(previewsUrl, { failOnStatusCode: false });
          if (!res.ok()) throw new Error(`listing previews failed: ${res.status()}`);
          return ((await res.json()) as { previews: PreviewEntry[] }).previews;
        },
        clickBuild: () => prep.sel('buildPreview').click({ timeout: run.step }),
        requestApi: async () => {
          const res = await api.post(previewsUrl, { data: {}, headers: { 'content-type': 'application/json' }, failOnStatusCode: false });
          if (!res.ok()) throw new Error(`requesting a preview failed: ${res.status()}`);
        },
        log: run.config.log,
        intervalMs: PREVIEW_WATCH_MS,
        settleMs: PREVIEW_UI_SETTLE_MS,
        timeoutMs: run.long,
      });
    }

    const page = await run.page('client', { record: true });
    const ui = run.ui(page, 's06-repair-preview');
    await run.goto(page, run.proposalPath(fix));
    await hasText(ui.sel('fixed'), ui.text('fixed'), run.long);
    await visible(ui.sel('proposalHash'), run.step);
    run.recordHash('fixed', await readHash(ui.sel('proposalHash'), run.step), fix);
    run.mark('new-hash');
    await run.dwell(page);
    await visible(ui.sel('openPreview'), run.long);
    run.mark('preview-ready');
    const href = await ui.sel('openPreview').getAttribute('href', { timeout: run.step });
    if (!href || !/^https:\/\//.test(href)) throw new Error(`Open preview has no https link (${href ?? 'none'})`);
    if (run.fixture) {
      // fixture preview links point at a .invalid host; the live preview is checked in cookie mode
      run.config.log(`  fixture preview link ${new URL(href).origin} (not opened)`);
      return;
    }
    // follow the link in the recorded tab so the separate preview origin is on camera
    await page.goto(href);
    run.mark('preview-open');
    await ui.sel('previewSubmit').click({ timeout: run.long });
    await hasText(ui.sel('previewResult'), /\S/, run.long);
    run.mark('preview-quote');
    await run.dwell(page);
  },
};

const publish: CaptureUnit = {
  id: 'publish',
  personas: ['owner', 'client'],
  scenes: ['s07-approve-publish'],
  outputs: (media) => [clipOf(media, 's07-approve-publish'), shotOf(media, 's07-approve-publish', 0), shotOf(media, 's07-approve-publish', 1)],
  async run(run) {
    const { fix } = await proposals(run);
    const media = run.config.media;
    const client = await run.page('client', { record: false });
    const c = run.ui(client, 's07-approve-publish');
    await run.goto(client, run.proposalPath(fix));
    await visible(c.sel('proposalHash'), run.long);
    await c.sel('showFullCode').click({ timeout: run.step });
    await run.screenshot(client, shotOf(media, 's07-approve-publish', 0));
    await c.sel('approve').click({ timeout: run.long });
    await visible(client.getByText(c.text('approvedByClient')), run.long);

    const page = await run.page('owner', { record: true });
    const ui = run.ui(page, 's07-approve-publish');
    await run.goto(page, run.proposalPath(fix));
    await hasText(ui.sel('stepApprove'), ui.text('approvedByClient'), run.long);
    await run.screenshot(page, shotOf(media, 's07-approve-publish', 1));
    run.mark('approved');
    await run.dwell(page);
    await ui.sel('accept').click({ timeout: run.long });
    await hasText(ui.sel('stepAccept'), ui.text('newVersion'), run.long);
    run.mark('accepted');
    await run.dwell(page);
    await ui.sel('prepare').click({ timeout: run.step });
    await ui.sel('approvePublish').click({ timeout: run.long });
    run.mark('publish-approved');
    await ui.sel('publish').click({ timeout: run.long });
    await visible(ui.sel('livePill'), run.long);
    await hasText(ui.sel('trail'), ui.text('liveTrail'), run.long);
    await visible(ui.sel('releaseRecord'), run.step);
    run.mark('live');
    await run.dwell(page);
  },
};

const restore: CaptureUnit = {
  id: 'restore',
  personas: ['owner'],
  scenes: ['s08-restore-export'],
  outputs: (media) => [clipOf(media, 's08-restore-export')],
  async run(run) {
    const page = await run.page('owner', { record: true });
    const ui = run.ui(page, 's08-restore-export');
    if (run.fixture && run.targets.prepAcceptProposal) {
      // fixture only: the story starts with one version per resource; accept the brand refresh first
      await run.goto(page, run.proposalPath(run.targets.prepAcceptProposal));
      await ui.sel('runValidation').click({ timeout: run.step });
      await ui.sel('approve').click({ timeout: run.long });
      await ui.sel('accept').click({ timeout: run.long });
      await hasText(ui.sel('stepAccept'), ui.text('newVersion'), run.long);
    }
    await run.goto(page, run.projectPath('versions'));
    for (const key of run.targets.restore) {
      await ui.sel(key).click({ timeout: run.step });
      await atLeast(ui.sel('version'), 2, run.long);
      run.mark(`versions-${key}`);
      await run.dwell(page);
      await ui.sel('restoreRow').click({ timeout: run.step });
      await ui.sel('confirmRestore').click({ timeout: run.step });
      await visible(ui.sel('restored'), run.long);
      run.mark(`restored-${key}`);
      await run.dwell(page);
    }
    await ui.sel('exportButton').click({ timeout: run.step });
    await ui.sel('startExport').click({ timeout: run.step });
    await hasText(ui.sel('exportDialog'), ui.text('exportReady'), run.long);
    await visible(ui.sel('bundleLink'), run.step);
    run.mark('export-ready');
    await run.dwell(page);
  },
};

export const UNITS: CaptureUnit[] = [files, edition, lanes, collision, preview, publish, restore];

/** Units covering the given scene numbers (`--scenes 1,2`), in script order. */
export function unitsFor(sceneNumbers: number[]): CaptureUnit[] {
  const wanted = new Set(sceneNumbers);
  for (const n of wanted) {
    if (!UNITS.some((u) => u.scenes.some((s) => Number(s.slice(1, 3)) === n))) throw new Error(`no browser capture for scene ${n}`);
  }
  return UNITS.filter((u) => u.scenes.some((s) => wanted.has(Number(s.slice(1, 3)))));
}
