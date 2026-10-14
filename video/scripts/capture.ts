/**
 * Browser capture for the demo video (Playwright). Records one clip per DEMO-SCRIPT beat at
 * 1920x1080 (device scale 2 for sharp screenshots) under the names media.json expects.
 *
 *   pnpm capture [--scenes 1,2]     cookie mode against the live app → public/clips/
 *   pnpm capture:dry [--scenes …]   fixture-mode web build, selectors only → public/clips-dry/
 *
 * Environment (see README "Capture day"):
 *   CAPTURE_AUTH_MODE            cookie (default) | fixture (implied by --dry-run)
 *   CAPTURE_BASE_URL             live Worker origin (cookie); optional in fixture mode
 *   CAPTURE_OWNER_SESSION_FILE   owner's cforge session.json (cookie)
 *   CAPTURE_CLIENT_SESSION_FILE  client's cforge session.json (cookie)
 *   CAPTURE_ORG / CAPTURE_PROJECT   default: seed-output.json
 *   CAPTURE_FAIL_PROPOSAL / CAPTURE_FIX_PROPOSAL   default: found through the API
 *   CAPTURE_EDITED_ZIP           where the client's edited working copy will be saved (scene 3)
 *   CAPTURE_RESTORE              resources restored in scene 8 (default website,brand)
 *   CAPTURE_UPDATE_REQUEST       the client's update request text (scene 2)
 *   CAPTURE_FIXTURE_DIR          fixture build to serve (default ../apps/web/dist-fixture)
 *   CAPTURE_DWELL_SEC, CAPTURE_STEP_TIMEOUT_SEC, CAPTURE_HEADED=1
 *   CAPTURE_LONG_TIMEOUT_MIN     integration, previews, releases, agents (default 20; the scene 4
 *                                lanes unit 45); when set it applies to every unit
 *
 * Fixture-mode clips are never final footage: they go to public/clips-dry/ only.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { loadVideoData } from '../src/data';
import { readSession, type Persona, type Session } from './capture/auth';
import { captureUnit, type CaptureConfig } from './capture/run';
import { unitsFor, UNITS } from './capture/scenes';
import { loadSelectors } from './capture/selectors';
import { serveStatic, type StaticServer } from './capture/static-server';
import { FIXTURE_TARGETS, liveTargets } from './capture/targets';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(ROOT, '..');

function seconds(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number`);
  return value;
}

function sceneNumbers(value: string | undefined): number[] {
  if (!value) return [...new Set(UNITS.flatMap((u) => u.scenes.map((s) => Number(s.slice(1, 3)))))];
  return value.split(',').map((s) => {
    const n = Number(s.trim());
    if (!Number.isInteger(n)) throw new Error(`--scenes: "${s}" is not a scene number`);
    return n;
  });
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { scenes: { type: 'string' }, 'dry-run': { type: 'boolean' } }, strict: true });
  const mode = values['dry-run'] ? 'fixture' : (process.env.CAPTURE_AUTH_MODE ?? 'cookie');
  if (mode !== 'fixture' && mode !== 'cookie') throw new Error(`CAPTURE_AUTH_MODE must be fixture or cookie, got ${mode}`);
  const units = unitsFor(sceneNumbers(values.scenes));
  const { media } = loadVideoData();
  const selectors = loadSelectors();
  const fixture = mode === 'fixture';

  let server: StaticServer | null = null;
  let baseUrl = process.env.CAPTURE_BASE_URL;
  if (fixture && !baseUrl) {
    const dir = resolve(process.env.CAPTURE_FIXTURE_DIR ?? join(REPO, 'apps', 'web', 'dist-fixture'));
    if (!existsSync(join(dir, 'index.html'))) {
      throw new Error(
        `no fixture build at ${dir}. Build it from the repo root:\n` +
          '  pnpm install --frozen-lockfile --filter "@commonforge-org/web..."\n' +
          '  pnpm --filter @commonforge-org/web run build:fixture\n' +
          'or point CAPTURE_FIXTURE_DIR at a build, or CAPTURE_BASE_URL at a running fixture server (port 4317).',
      );
    }
    server = await serveStatic(dir);
    baseUrl = server.url;
  }
  if (!baseUrl) throw new Error('set CAPTURE_BASE_URL to the live Worker origin');

  const sessions: Partial<Record<Persona, Session>> = {};
  if (!fixture) {
    const needed = new Set(units.flatMap((u) => u.personas));
    for (const persona of needed) {
      const variable = `CAPTURE_${persona.toUpperCase()}_SESSION_FILE`;
      const file = process.env[variable];
      if (!file) throw new Error(`set ${variable} to the ${persona}'s cforge session.json`);
      const session = readSession(file);
      if (new URL(session.apiUrl).origin !== new URL(baseUrl).origin) {
        throw new Error(`${variable} was issued for ${new URL(session.apiUrl).origin}, not ${new URL(baseUrl).origin}`);
      }
      if (Date.parse(session.expiresAt) < Date.now()) throw new Error(`${variable}: the session expired at ${session.expiresAt}; log in again`);
      sessions[persona] = session;
    }
  }

  const config: CaptureConfig = {
    mode,
    baseUrl,
    outDir: join(ROOT, 'public', fixture ? 'clips-dry' : 'clips'),
    workDir: resolve(process.env.CAPTURE_WORK_DIR ?? join(ROOT, '.capture', fixture ? 'dry' : 'live')),
    timeouts: {
      stepMs: seconds('CAPTURE_STEP_TIMEOUT_SEC', fixture ? 10 : 30) * 1000,
      longMs: seconds('CAPTURE_LONG_TIMEOUT_MIN', fixture ? 0.5 : 20) * 60_000,
      longFromEnv: (process.env.CAPTURE_LONG_TIMEOUT_MIN ?? '') !== '',
    },
    dwellMs: seconds('CAPTURE_DWELL_SEC', fixture ? 0 : 3) * 1000,
    sessions,
    targets: fixture ? FIXTURE_TARGETS : liveTargets(process.env, join(ROOT, 'seed-output.json')),
    media,
    selectors,
    log: (line) => console.log(line),
  };

  console.log(`capture: ${mode} mode against ${baseUrl}; writing to ${config.outDir}${fixture ? ' (dry run: never final footage)' : ''}`);
  const browser = await chromium.launch({ headless: process.env.CAPTURE_HEADED !== '1' });
  const written: string[] = [];
  try {
    for (const unit of units) written.push(...(await captureUnit(browser, config, unit)));
  } finally {
    await browser.close();
    await server?.close();
  }
  console.log(`capture: ${units.length} unit(s) done, ${written.length} file(s) written`);
}

main().catch((error: unknown) => {
  console.error(`capture: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
