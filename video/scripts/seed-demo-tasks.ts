/**
 * The three demo tasks a staging-mode seed lands in staging (`seed-demo.ts --staging --stage-tasks`),
 * as the client's agent makes them (spec docs/superpowers/specs/2026-10-07-always-on-preview-promotion-design.md
 * §12; the same edits as scripts/ci-live/staging.ts, proven live on CI in staging Phase 4-1):
 *
 *   copy    website/index.html heading            → promotion gate `self`: the client ships it
 *   phone   api code + additive migration 0002     → `classify`: Jev decides, or a developer
 *   rename  api code + destructive migration 0003  → refused by the migration veto, sent back
 *
 * The rename patch applies on top of the phone patch, so the tasks land in this order.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const COPY_FROM = '<h1>Customer Portal</h1>';
export const COPY_TO = '<h1>Customer Portal: quotes in seconds</h1>';

export type DemoTaskKey = 'copy' | 'phone' | 'rename';

export interface DemoTask {
  key: DemoTaskKey;
  title: string;
  request: string;
  mounts: Array<'website' | 'api'>;
}

export const DEMO_TASKS: readonly DemoTask[] = [
  { key: 'copy', title: 'Update the home page heading', request: 'Say quotes take seconds.', mounts: ['website'] },
  { key: 'phone', title: 'Add a phone field to the contacts', request: 'Add a phone number to the contacts, saved and listed.', mounts: ['api'] },
  { key: 'rename', title: 'Rename the contact email column', request: 'Call the email column email_address.', mounts: ['api'] },
];

/** Make task `key`'s edit in a checked-out workspace `ws` (`<ws>/<mount>/…`), from `fixtures/demo-tasks`. */
export function applyDemoTask(key: DemoTaskKey, ws: string, repoRoot: string): void {
  const demo = join(repoRoot, 'fixtures', 'demo-tasks');
  if (key === 'copy') {
    const f = join(ws, 'website', 'index.html');
    const html = readFileSync(f, 'utf8');
    if (!html.includes(COPY_FROM)) throw new Error('copy: the heading is not in website/index.html');
    writeFileSync(f, html.replace(COPY_FROM, COPY_TO));
    return;
  }
  const dir = key === 'phone' ? 'phone-field' : 'rename-column';
  const migration = key === 'phone' ? '0002_phone.sql' : '0003_rename_email.sql';
  execFileSync('git', ['apply', join(demo, dir, 'api-code.patch')], { cwd: join(ws, 'api'), stdio: ['ignore', 'ignore', 'pipe'] });
  mkdirSync(join(ws, 'api', 'migrations'), { recursive: true });
  copyFileSync(join(demo, dir, 'migrations', migration), join(ws, 'api', 'migrations', migration));
}
