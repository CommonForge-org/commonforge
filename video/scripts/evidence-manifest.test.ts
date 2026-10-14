import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { writeEvidence, type EvidenceDeps, type Manifest } from './evidence-manifest';
import { emptyPlaceholderManifest, recordPlaceholder } from './placeholder-manifest';
import { createR2Publisher, joinPublicUrl, type Publisher } from './r2-publisher';

const tmp = mkdtempSync(join(tmpdir(), 'cf-evidence-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const NOW = new Date('2026-10-12T15:04:05.678Z');
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const COOKIE_MARKS = JSON.stringify({ mode: 'cookie', marks: [] });
const PLACEHOLDER_CAST = `${JSON.stringify({ version: 2, width: 80, height: 18, title: 'PLACEHOLDER cast-02-clone.cast' })}\n[0.5,"o","x"]\n`;

function setup(name: string, files: Record<string, string>): { clips: string; out: string } {
  const clips = join(tmp, name, 'clips');
  mkdirSync(clips, { recursive: true });
  for (const [file, text] of Object.entries(files)) writeFileSync(join(clips, file), text);
  return { clips, out: join(tmp, name, 'evidence', 'video') };
}

const deps = (over: Partial<EvidenceDeps> = {}): EvidenceDeps => ({
  now: () => NOW,
  git: () => ({ sha: 'abc123', branch: 'video/pipeline', dirty: false }),
  wrangler: () => JSON.stringify([
    { id: 'dep-old', created_on: '2026-10-01T00:00:00Z' },
    { id: 'dep-new', created_on: '2026-10-11T00:00:00Z' },
  ]),
  health: async () => ({ url: 'https://w.example/health', status: 200, body: '{"ok":true,"service":"commonforge-worker"}' }),
  expected: ['clips/clip-01-intake.webm', 'clips/cast-04-agent-a.cast', 'clips/shot-05-contract-fail.png'],
  ...over,
});

describe('writeEvidence', () => {
  it('copies the captures and concurrency.json and writes MANIFEST.json with hashes, git sha and deployment', async () => {
    const { clips, out } = setup('ok', {
      'clip-01-intake.webm': 'webm-bytes',
      'clip-01-intake.marks.json': COOKIE_MARKS,
      'cast-04-agent-a.cast': '{"version":2}\n',
      'orchestrator.log': '1759750000000 agent-1: hi\n',
    });
    const concurrency = join(tmp, 'ok', 'concurrency.json');
    writeFileSync(concurrency, '{"schema":"commonforge.demo.concurrency/1"}');
    const dir = await writeEvidence({ clipsDir: clips, outRoot: out, concurrency, workerName: 'commonforge-worker' }, deps());

    expect(dir).toBe(join(out, '2026-10-12T15-04-05Z'));
    const manifest = JSON.parse(readFileSync(join(dir, 'MANIFEST.json'), 'utf8')) as Manifest;
    expect(manifest.git).toEqual({ sha: 'abc123', branch: 'video/pipeline', dirty: false });
    expect(manifest.worker).toMatchObject({ name: 'commonforge-worker', latestDeploymentId: 'dep-new' });
    expect(manifest.health).toMatchObject({ status: 200 });
    expect(manifest.createdAt).toBe(NOW.toISOString());
    const byPath = Object.fromEntries(manifest.files.map((f) => [f.path, f]));
    expect(byPath['clips/clip-01-intake.webm']).toMatchObject({ bytes: 10, sha256: sha('webm-bytes') });
    expect(byPath['concurrency.json']).toMatchObject({ sha256: sha('{"schema":"commonforge.demo.concurrency/1"}') });
    expect(byPath['clips/orchestrator.log']).toBeDefined();
    expect(readFileSync(join(dir, 'clips', 'clip-01-intake.webm'), 'utf8')).toBe('webm-bytes');
    expect(manifest.missing).toEqual(['clips/shot-05-contract-fail.png']);
    expect(manifest.captureTime.earliest <= manifest.captureTime.latest).toBe(true);
  });

  it('records wrangler as unavailable instead of failing', async () => {
    const { clips, out } = setup('nowrangler', { 'clip-01-intake.webm': 'x', 'clip-01-intake.marks.json': COOKIE_MARKS });
    const dir = await writeEvidence(
      { clipsDir: clips, outRoot: out, workerName: 'commonforge-worker' },
      deps({ wrangler: () => { throw new Error('wrangler: not logged in'); }, health: async () => null }),
    );
    const manifest = JSON.parse(readFileSync(join(dir, 'MANIFEST.json'), 'utf8')) as Manifest;
    expect(manifest.worker).toEqual({ name: 'commonforge-worker', latestDeploymentId: null, deployments: null, error: 'wrangler: not logged in' });
    expect(manifest.health).toBeNull();
    expect(manifest.files.map((f) => f.path)).not.toContain('concurrency.json');
  });

  it('refuses fixture-mode (dry-run) footage', async () => {
    const { clips, out } = setup('dry', { 'clip-01-intake.webm': 'x', 'clip-01-intake.marks.json': JSON.stringify({ mode: 'fixture', marks: [] }) });
    await expect(writeEvidence({ clipsDir: clips, outRoot: out, workerName: 'w' }, deps())).rejects.toThrow(/fixture-mode/);
    expect(existsSync(out)).toBe(false);
  });

  it('refuses the dry-run clips directory outright', async () => {
    const dry = join(tmp, 'clips-dry');
    mkdirSync(dry, { recursive: true });
    await expect(writeEvidence({ clipsDir: dry, outRoot: join(tmp, 'x'), workerName: 'w' }, deps())).rejects.toThrow(/dry-run/);
  });

  it('records a clean take as verified', async () => {
    const { clips, out } = setup('verified', { 'clip-01-intake.webm': 'x', 'clip-01-intake.marks.json': COOKIE_MARKS });
    const dir = await writeEvidence({ clipsDir: clips, outRoot: out, workerName: 'w' }, deps());
    const manifest = JSON.parse(readFileSync(join(dir, 'MANIFEST.json'), 'utf8')) as Manifest;
    expect(manifest).toMatchObject({ verified: true, placeholders: [], unverified: [], manual: [] });
  });

  async function refusal(name: string, files: Record<string, string>, extra: { manual?: string[] } = {}): Promise<string> {
    const { clips, out } = setup(name, files);
    let message = '';
    try {
      await writeEvidence({ clipsDir: clips, outRoot: out, workerName: 'w', ...extra }, deps());
    } catch (error) {
      message = (error as Error).message;
    }
    expect(existsSync(out)).toBe(false);
    return message;
  }

  it('refuses a placeholder cast (header title PLACEHOLDER…), naming it', async () => {
    const message = await refusal('placeholder-cast', { 'cast-02-clone.cast': PLACEHOLDER_CAST });
    expect(message).toMatch(/not a verified take/);
    expect(message).toMatch(/placeholder: clips\/cast-02-clone\.cast/);
  });

  it('refuses a clip without capture marks (placeholder or hand-made, not allowlisted)', async () => {
    const message = await refusal('no-marks', { 'clip-04-lanes.webm': 'x' });
    expect(message).toMatch(/clips\/clip-04-lanes\.webm: no \.marks\.json/);
  });

  it('refuses a screenshot without capture marks', async () => {
    const message = await refusal('shot-no-marks', { 'shot-01-client-folder.png': 'x' });
    expect(message).toMatch(/clips\/shot-01-client-folder\.png: no \.marks\.json/);
  });

  it('refuses marks that do not come from a cookie-mode capture', async () => {
    const message = await refusal('mode', { 'clip-05-collision.webm': 'x', 'clip-05-collision.marks.json': JSON.stringify({ marks: [] }) });
    expect(message).toMatch(/clips\/clip-05-collision\.webm: captured in mode "unknown"/);
  });

  it('refuses a dry-run orchestrator run', async () => {
    const run = JSON.stringify({ exitCode: 0, command: ['node', 'main.js', '--org', 'o', '--dry-run'] });
    const message = await refusal('dry-orchestrator', { 'orchestrator-run.json': run, 'orchestrator.log': '1 agent-1: x\n' });
    expect(message).toMatch(/clips\/orchestrator-run\.json: the orchestrator ran with --dry-run/);
  });

  it('accepts hand-made media named in the manual allowlist and records it', async () => {
    const { clips, out } = setup('manual', { 'shot-01-client-folder.png': 'png', 'clip-03-tool-insert.mov': 'mov' });
    const dir = await writeEvidence({ clipsDir: clips, outRoot: out, workerName: 'w', manual: ['shot-01-client-folder.png', 'clip-03-tool-insert.mov'] }, deps());
    const manifest = JSON.parse(readFileSync(join(dir, 'MANIFEST.json'), 'utf8')) as Manifest;
    expect(manifest).toMatchObject({ verified: true, manual: ['clips/clip-03-tool-insert.mov', 'clips/shot-01-client-folder.png'] });
  });

  it('does not let the manual allowlist pass a placeholder cast', async () => {
    const message = await refusal('manual-placeholder', { 'cast-02-clone.cast': PLACEHOLDER_CAST }, { manual: ['cast-02-clone.cast'] });
    expect(message).toMatch(/placeholder: clips\/cast-02-clone\.cast/);
  });

  it('with allowUnverified writes an interim manifest that lists what is not verified', async () => {
    const { clips, out } = setup('interim', {
      'cast-02-clone.cast': PLACEHOLDER_CAST,
      'clip-04-lanes.webm': 'x',
      'orchestrator-run.json': JSON.stringify({ command: ['node', 'main.js', '--dry-run'] }),
    });
    const dir = await writeEvidence({ clipsDir: clips, outRoot: out, workerName: 'w', allowUnverified: true }, deps());
    const manifest = JSON.parse(readFileSync(join(dir, 'MANIFEST.json'), 'utf8')) as Manifest;
    expect(manifest.verified).toBe(false);
    expect(manifest.placeholders).toEqual(['clips/cast-02-clone.cast']);
    expect(manifest.unverified.map((u) => u.path)).toEqual(['clips/clip-04-lanes.webm', 'clips/orchestrator-run.json']);
  });

  it('still refuses fixture-mode footage with allowUnverified', async () => {
    const { clips, out } = setup('fixture-interim', { 'clip-01-intake.webm': 'x', 'clip-01-intake.marks.json': JSON.stringify({ mode: 'fixture', marks: [] }) });
    await expect(writeEvidence({ clipsDir: clips, outRoot: out, workerName: 'w', allowUnverified: true }, deps())).rejects.toThrow(/fixture-mode/);
  });

  it('refuses a placeholder PNG or WebM recognised by content, even with marks or under --manual', async () => {
    const { clips, out } = setup('placeholder-media', {
      'shot-01-client-folder.png': 'generated png',
      'clip-04-lanes.webm': 'generated webm',
      'clip-04-lanes.marks.json': COOKIE_MARKS,
    });
    const placeholders = emptyPlaceholderManifest();
    for (const file of ['shot-01-client-folder.png', 'clip-04-lanes.webm']) recordPlaceholder(placeholders, clips, file);
    let message = '';
    try {
      await writeEvidence({ clipsDir: clips, outRoot: out, workerName: 'w', manual: ['shot-01-client-folder.png'] }, deps({ placeholders }));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/placeholder: clips\/clip-04-lanes\.webm/);
    expect(message).toMatch(/placeholder: clips\/shot-01-client-folder\.png/);
    expect(existsSync(out)).toBe(false);
  });

  it('refuses casts stamped dryRun by pnpm casts', async () => {
    const cast = `${JSON.stringify({ version: 2, width: 100, height: 24, title: 'agent-1 (dry run)', dryRun: true })}\n[1,"o","x"]\n`;
    const message = await refusal('dry-cast', { 'cast-04-agent-a.cast': cast });
    expect(message).toMatch(/clips\/cast-04-agent-a\.cast: cast from a --dry-run orchestrator/);
  });

  it('refuses --manual names that are not in the take', async () => {
    const message = await refusal('manual-typo', { 'shot-01-client-folder.png': 'png' }, { manual: ['shot-01-client-folder.png', 'clips/shot-01-client-folder.png', 'shot-1.png'] });
    expect(message).toMatch(/--manual names file\(s\) not in .*: clips\/shot-01-client-folder\.png, shot-1\.png/);
  });

  it('names an unreadable marks file instead of failing with a bare JSON error', async () => {
    const message = await refusal('bad-marks', { 'clip-01-intake.webm': 'x', 'clip-01-intake.marks.json': '{not json' });
    expect(message).toMatch(/clip-01-intake\.marks\.json is not valid JSON/);
  });

  describe('secret scan', () => {
    it('refuses a take whose cast, log or JSON still holds a token, naming the file but not the secret', async () => {
      const leaked = `${JSON.stringify({ version: 2, width: 80, height: 24, title: 'clone' })}\n[1,"o","token art_v1_deadbeefcafe0123 here"]\n`;
      const message = await refusal('secret-cast', {
        'cast-02-clone.cast': leaked,
        'orchestrator.log': '1759750000000 agent-1: Authorization: Bearer sk-live-xyz\n',
        'clip-01-intake.webm': 'x',
        'clip-01-intake.marks.json': COOKIE_MARKS,
      });
      expect(message).toMatch(/secret scan: 2 file\(s\) hold an unredacted token/);
      expect(message).toMatch(/cast-02-clone\.cast/);
      expect(message).toMatch(/orchestrator\.log/);
      expect(message).not.toContain('deadbeefcafe');
      expect(message).not.toContain('sk-live-xyz');
    });

    it('passes text that is already redacted (redaction is idempotent)', async () => {
      const { clips, out } = setup('secret-clean', {
        'cast-02-clone.cast': `${JSON.stringify({ version: 2, width: 80, height: 24, title: 'clone' })}\n[1,"o","art_…redacted cfs_…redacted Authorization: Bearer …redacted $CF_TOKEN"]\n`,
        'clip-01-intake.webm': 'x',
        'clip-01-intake.marks.json': COOKIE_MARKS,
      });
      await expect(writeEvidence({ clipsDir: clips, outRoot: out, workerName: 'w' }, deps())).resolves.toBeTruthy();
    });

    it('scans concurrency.json too, and refuses before any upload', async () => {
      const { clips, out } = setup('secret-concurrency', { 'clip-01-intake.webm': 'x', 'clip-01-intake.marks.json': COOKIE_MARKS });
      const concurrency = join(tmp, 'secret-concurrency', 'concurrency.json');
      writeFileSync(concurrency, JSON.stringify({ lease: 'cfl_leaktoken123' }));
      const uploads: string[] = [];
      const r2: Publisher = { bucket: 'b', put: async (key) => void uploads.push(key), publicUrl: (k) => k };
      await expect(writeEvidence({ clipsDir: clips, outRoot: out, concurrency, workerName: 'w', publish: r2 }, deps())).rejects.toThrow(/secret scan: 1 file/);
      expect(uploads).toEqual([]);
      expect(existsSync(out)).toBe(false);
    });
  });

  describe('--publish refuses unverified takes (M3)', () => {
    const r2 = (): Publisher & { keys: string[] } => {
      const keys: string[] = [];
      return { bucket: 'b', keys, put: async (key) => void keys.push(key), publicUrl: (k) => k };
    };

    it('refuses --publish with --allow-unverified, even for a clean take', async () => {
      const { clips, out } = setup('publish-unverified-flag', { 'clip-01-intake.webm': 'x', 'clip-01-intake.marks.json': COOKIE_MARKS });
      const publisher = r2();
      await expect(writeEvidence({ clipsDir: clips, outRoot: out, workerName: 'w', allowUnverified: true, publish: publisher }, deps())).rejects.toThrow(
        /--publish is refused with --allow-unverified/,
      );
      expect(publisher.keys).toEqual([]);
      expect(existsSync(out)).toBe(false);
    });

    it('refuses to publish a take that would be verified: false', async () => {
      const { clips, out } = setup('publish-unverified', { 'clip-04-lanes.webm': 'x' });
      const publisher = r2();
      await expect(writeEvidence({ clipsDir: clips, outRoot: out, workerName: 'w', publish: publisher }, deps())).rejects.toThrow(
        /not a verified take; --publish refused, nothing written:\n {2}- clips\/clip-04-lanes\.webm: no \.marks\.json/,
      );
      expect(publisher.keys).toEqual([]);
      expect(existsSync(out)).toBe(false);
    });
  });

  describe('--publish', () => {
    function fakeR2(fail?: string): Publisher & { puts: Array<{ key: string; bytes: string; contentType: string; sha256: string }> } {
      const puts: Array<{ key: string; bytes: string; contentType: string; sha256: string }> = [];
      return {
        bucket: 'commonforge-evidence',
        puts,
        async put(key, file, meta) {
          if (fail && key.endsWith(fail)) throw new Error('403 AccessDenied');
          puts.push({ key, bytes: readFileSync(file, 'utf8'), ...meta });
        },
        publicUrl: (key) => joinPublicUrl('https://pub-test.r2.dev', key),
      };
    }

    it('uploads every file under video/<timestamp>/ and records its public URL next to its sha256', async () => {
      const { clips, out } = setup('publish', {
        'clip-01-intake.webm': 'webm-bytes',
        'clip-01-intake.marks.json': COOKIE_MARKS,
        'cast-04-agent-a.cast': '{"version":2,"width":80,"height":24,"title":"agent-1"}\n',
      });
      const concurrency = join(tmp, 'publish', 'concurrency.json');
      writeFileSync(concurrency, '{}');
      const r2 = fakeR2();
      const dir = await writeEvidence({ clipsDir: clips, outRoot: out, concurrency, workerName: 'w', publish: r2 }, deps());
      const manifest = JSON.parse(readFileSync(join(dir, 'MANIFEST.json'), 'utf8')) as Manifest;

      expect(manifest.published).toEqual({ bucket: 'commonforge-evidence', prefix: 'video/2026-10-12T15-04-05Z/', baseUrl: 'https://pub-test.r2.dev/video/2026-10-12T15-04-05Z/' });
      expect(r2.puts.map((p) => p.key).sort()).toEqual(
        ['cast-04-agent-a.cast', 'clip-01-intake.marks.json', 'clip-01-intake.webm'].map((f) => `video/2026-10-12T15-04-05Z/clips/${f}`).concat('video/2026-10-12T15-04-05Z/concurrency.json').sort(),
      );
      const clip = manifest.files.find((f) => f.path === 'clips/clip-01-intake.webm')!;
      expect(clip).toMatchObject({ sha256: sha('webm-bytes'), url: 'https://pub-test.r2.dev/video/2026-10-12T15-04-05Z/clips/clip-01-intake.webm' });
      expect(r2.puts.find((p) => p.key.endsWith('clip-01-intake.webm'))).toMatchObject({ bytes: 'webm-bytes', contentType: 'video/webm', sha256: sha('webm-bytes') });
      expect(manifest.files.every((f) => f.url?.startsWith('https://pub-test.r2.dev/video/2026-10-12T15-04-05Z/'))).toBe(true);
    });

    it('records no URLs and published: null without --publish', async () => {
      const { clips, out } = setup('no-publish', { 'clip-01-intake.webm': 'x', 'clip-01-intake.marks.json': COOKIE_MARKS });
      const dir = await writeEvidence({ clipsDir: clips, outRoot: out, workerName: 'w' }, deps());
      const manifest = JSON.parse(readFileSync(join(dir, 'MANIFEST.json'), 'utf8')) as Manifest;
      expect(manifest.published).toBeNull();
      expect(manifest.files.some((f) => 'url' in f)).toBe(false);
    });

    it('writes nothing locally when an upload fails', async () => {
      const { clips, out } = setup('publish-fail', { 'clip-01-intake.webm': 'x', 'clip-01-intake.marks.json': COOKIE_MARKS });
      await expect(writeEvidence({ clipsDir: clips, outRoot: out, workerName: 'w', publish: fakeR2('clip-01-intake.webm') }, deps())).rejects.toThrow(
        /publishing to R2 bucket commonforge-evidence failed \(403 AccessDenied\); nothing written locally/,
      );
      expect(existsSync(join(out, '2026-10-12T15-04-05Z'))).toBe(false);
    });

    it('refuses to start without R2 credentials, naming the variables but never their values', () => {
      expect(() => createR2Publisher({ bucket: 'b', env: { CF_ACCOUNT_ID: 'acct-secret-id', CF_R2_PUBLIC_URL: 'https://pub-x.r2.dev' } })).toThrow(
        /--publish needs CF_R2_ACCESS_KEY_ID, CF_R2_SECRET_ACCESS_KEY/,
      );
      try {
        createR2Publisher({ bucket: 'b', env: { CF_ACCOUNT_ID: 'acct-secret-id' } });
      } catch (error) {
        expect((error as Error).message).not.toContain('acct-secret-id');
      }
      expect(() =>
        createR2Publisher({ bucket: 'b', env: { CF_ACCOUNT_ID: 'a', CF_R2_ACCESS_KEY_ID: 'k', CF_R2_SECRET_ACCESS_KEY: 's', CF_R2_PUBLIC_URL: 'http://insecure' } }),
      ).toThrow(/https/);
    });

    it('builds encoded public URLs under the base', () => {
      expect(joinPublicUrl('https://pub-x.r2.dev/', 'video/2026-10-12T15-04-05Z/clips/a b.png')).toBe('https://pub-x.r2.dev/video/2026-10-12T15-04-05Z/clips/a%20b.png');
    });
  });
});
