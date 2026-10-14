import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { World, type CanonicalRepo } from './helpers.js';

let w: World;
let site: CanonicalRepo;

beforeAll(async () => {
  w = await World.create();
  site = await w.canonical('res-website', {
    'src/index.html': '<h1>Preview</h1>\n',
    'scripts/build.mjs': "import { mkdirSync, copyFileSync, symlinkSync } from 'node:fs';\nmkdirSync('dist/assets', { recursive: true });\ncopyFileSync('src/index.html', 'dist/index.html');\nsymlinkSync('/etc/passwd', 'dist/assets/leak');\n",
    'scripts/fail.mjs': "console.error('build exploded');\nprocess.exit(3);\n",
    'scripts/env-build.mjs': "import { mkdirSync, writeFileSync } from 'node:fs';\nmkdirSync('dist', { recursive: true });\nmkdirSync('bundle', { recursive: true });\nwriteFileSync('dist/index.html', `api=${process.env.VITE_QUOTE_API_URL}\\n`);\nwriteFileSync('bundle/index.js', 'export default { fetch() { return new Response(\"ok\"); } };\\n');\n",
    // hostile recipes: redirect the output (or the whole mount) to a directory outside the checkout
    'scripts/swap-out.mjs': "import { symlinkSync } from 'node:fs';\nsymlinkSync(process.argv[2], 'dist');\n",
    'scripts/swap-mount.mjs': "import { mkdirSync, renameSync, symlinkSync } from 'node:fs';\nprocess.chdir('..');\nrenameSync('website', 'website-moved');\nsymlinkSync(process.argv[2], 'website');\n",
    'scripts/hardlink.mjs': "import { linkSync, mkdirSync } from 'node:fs';\nmkdirSync('dist');\nlinkSync(process.argv[2], 'dist/stolen.txt');\n",
  });
});
afterAll(() => w?.close());

const job = (command: string, output = true) => ({
  kind: 'preview-build' as const,
  previewId: `pv-${command.length}`,
  integrationSha: { 'res-website': site.sha },
  sources: [{ resourceId: 'res-website', mountName: 'website', canonical: site.coords }],
  recipe: { recipeId: 'site', revision: 1, steps: [{ stepId: 'build', mountName: 'website', command }], ...(output ? { output: { mountName: 'website', path: 'dist' } } : {}) },
  ttlSeconds: 600,
});

describe('preview-build (minimal)', () => {
  it('builds at the integration sha and publishes the static output (no symlinks)', async () => {
    const j = job('node scripts/build.mjs');
    const r = await w.runner({ previewBaseUrl: 'https://preview.example.dev/p' }).execute(await w.delivery(j));
    expect(r).toMatchObject({ ok: true, receipt: { url: `https://preview.example.dev/p/${j.previewId}/`, recipe: { recipeId: 'site', revision: 1 } } });
    expect(await readFile(w.blobPath(`previews/${j.previewId}/site/index.html`), 'utf8')).toBe('<h1>Preview</h1>\n');
    await expect(readFile(w.blobPath(`previews/${j.previewId}/site/assets/leak`))).rejects.toThrow();
  });

  it('publishes bundles under the job prefix and passes the step env (Task 22)', async () => {
    const j = {
      ...job('node scripts/env-build.mjs'),
      previewId: 'pv-bundles',
      outputPrefix: 'org/o-1/previews/pv-bundles/',
      bundles: [{ name: 'api', mountName: 'website', path: 'bundle' }],
    };
    j.recipe.steps[0] = { ...j.recipe.steps[0]!, env: { VITE_QUOTE_API_URL: './api' } } as never;
    const r = await w.runner({ previewBaseUrl: 'https://preview.example.dev/p' }).execute(await w.delivery(j));
    expect(r).toMatchObject({ ok: true });
    expect(await readFile(w.blobPath('org/o-1/previews/pv-bundles/site/index.html'), 'utf8')).toBe('api=./api\n');
    expect(await readFile(w.blobPath('org/o-1/previews/pv-bundles/bundles/api/index.js'), 'utf8')).toContain('export default');
  });

  it('refuses a step env that could change the toolchain', async () => {
    const j = { ...job('node scripts/env-build.mjs'), previewId: 'pv-badenv' };
    j.recipe.steps[0] = { ...j.recipe.steps[0]!, env: { NODE_OPTIONS: '--require=/tmp/x.js' } } as never;
    const r = await w.runner({ previewBaseUrl: 'https://preview.example.dev/p' }).execute(await w.delivery(j));
    expect(r).toMatchObject({ ok: false, code: 'scope_violation' });
  });

  it('a failing step is check_failed with the log tail; no base URL is provider_unavailable', async () => {
    const r = await w.runner({ previewBaseUrl: 'https://preview.example.dev/p' }).execute(await w.delivery(job('node scripts/fail.mjs')));
    expect(r).toMatchObject({ ok: false, code: 'check_failed' });
    if (!r.ok) expect(r.detail).toContain('build exploded');
    expect(await w.runner().execute(await w.delivery(job('node scripts/build.mjs')))).toMatchObject({ ok: false, code: 'provider_unavailable' });
  });

  describe('never publishes files outside the checkout (review I-3)', () => {
    let outside: string;
    beforeAll(async () => {
      const { mkdir, writeFile } = await import('node:fs/promises');
      outside = w.dir('outside');
      await mkdir(join(outside, 'dist'), { recursive: true });
      await writeFile(join(outside, 'secret.txt'), 'TOP-SECRET-DEV-VARS\n');
      await writeFile(join(outside, 'dist', 'secret.txt'), 'TOP-SECRET-DEV-VARS\n');
    });

    it.each([
      ['output dir swapped for a symlink', (o: string) => `node scripts/swap-out.mjs ${o}`],
      ['mount swapped for a symlink', (o: string) => `node scripts/swap-mount.mjs ${o}`],
      ['hard link to an outside file', (o: string) => `node scripts/hardlink.mjs ${o}/secret.txt`],
    ])('%s', async (_label, cmd) => {
      const j = { ...job(cmd(outside)), previewId: `pv-evil-${_label.length}` };
      const r = await w.runner({ previewBaseUrl: 'https://preview.example.dev/p' }).execute(await w.delivery(j));
      expect(r.ok).toBe(false);
      expect(r).toMatchObject({ ok: false, code: 'scope_violation' });
      const { readdir } = await import('node:fs/promises');
      const published = await readdir(w.blobPath(`previews/${j.previewId}`), { recursive: true }).catch(() => []);
      expect(published).toEqual([]);
    });
  });
});
