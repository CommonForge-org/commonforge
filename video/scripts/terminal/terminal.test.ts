import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOKEN = 'cfs_SECRETtoken0123456789';
const CLIENT_TOKEN = 'cfs_CLIENTsecret0123456789';
const EDITION_SECRET = 'art_v1_EDITIONSECRET0123456789abcdef';

function run(script: string, env: Record<string, string>): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn('bash', [join(HERE, script)], { env: { ...process.env, ...env } });
    let out = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString()));
    child.stderr.on('data', (c: Buffer) => (out += c.toString()));
    child.on('close', (code) => resolve({ code: code ?? 1, out }));
  });
}

describe('terminal scripts', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cf-terminal-'));
  const seen: Array<{ method: string; url: string; auth: string | undefined }> = [];
  let server: Server;
  let base = '';
  let polls = 0;

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res) => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization });
      req.resume();
      const send = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      const client = req.headers.authorization === `Bearer ${CLIENT_TOKEN}`;
      if (client) {
        // edition routes, as the client
        if (req.method === 'GET' && req.url === '/api/orgs/o-1/editions/ed-1/sessions') return send(200, { sessions: [] });
        if (req.method === 'POST' && req.url === '/api/orgs/o-1/editions/ed-1/sessions') return send(201, { sessionId: 'es-1' });
        if (req.method === 'POST' && req.url === '/api/orgs/o-1/edition-sessions/es-1/credential') {
          return send(200, { tokenId: 't-1', secret: EDITION_SECRET, scope: 'read', expiresAt: '2099-01-01T00:00:00Z', remoteUrl: 'https://art.example/git/o-1-editions/ed-1.git', branch: 'main', commit: 'c1', current: true });
        }
        return send(404, { error: 'not_found' });
      }
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: 'unauthorized' });
      if (req.method === 'POST' && req.url?.startsWith('/api/orgs/o-1/intake/zip')) return send(202, { intakeId: 'in-1', state: 'inventorying', sha256: 'ab', jobId: 'j' });
      if (req.method === 'GET' && req.url === '/api/orgs/o-1/intake/in-1') {
        polls += 1;
        if (polls < 2) return send(200, { intakeId: 'in-1', state: 'inventorying' });
        return send(200, {
          intakeId: 'in-1',
          state: 'planned',
          plan: {
            placements: [
              { resourceName: 'website', provider: 'artifacts', pathPrefix: 'website/', files: 12, bytes: 3400, reason: 'top-level folder' },
              { resourceName: 'brand-assets', provider: 'r2-assets', pathPrefix: 'brand/', files: 2, bytes: 52428800, reason: 'media over 32 MiB' },
            ],
            excluded: [{ path: 'website/.env', reason: 'credential-looking file name (not read)' }],
          },
        });
      }
      return send(404, { error: 'not_found' });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(tmp, { recursive: true, force: true });
  });

  it('intake.sh shows the dry-run inventory and never prints the session token', async () => {
    const session = join(tmp, 'session.json');
    writeFileSync(session, JSON.stringify({ apiUrl: base, sessionToken: TOKEN, expiresAt: '2099-01-01T00:00:00Z', user: { userId: 'u', email: 'o@example.com' } }));
    const handoff = join(tmp, 'client-handoff');
    mkdirSync(join(handoff, 'website'), { recursive: true });
    writeFileSync(join(handoff, 'website', 'index.html'), '<h1>hi</h1>');
    const { code, out } = await run('intake.sh', { CAPTURE_BASE_URL: base, CAPTURE_OWNER_SESSION_FILE: session, CAPTURE_ORG: 'o-1', CAPTURE_PROJECT: 'p-1', CAPTURE_INTAKE_DIR: handoff });
    expect(out).not.toContain('SECRETtoken');
    expect(code).toBe(0);
    expect(out).toContain('$CF_TOKEN');
    expect(out).toMatch(/r2-assets\s+brand-assets\s+2 files/);
    expect(out).toMatch(/website\/\.env\s+credential-looking/);
    expect(seen.filter((r) => r.url.startsWith('/api/')).every((r) => r.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect(seen.some((r) => r.method === 'POST' && r.url.includes('/confirm'))).toBe(false);
  }, 30_000);

  it('clone.sh: the client token is denied on production, clones the edition, one commit; no secret printed or on argv', async () => {
    const session = join(tmp, 'client-session.json');
    writeFileSync(session, JSON.stringify({ apiUrl: base, sessionToken: CLIENT_TOKEN, expiresAt: '2099-01-01T00:00:00Z', user: { userId: 'u-c', email: 'c@example.com' } }));
    const gitLog = join(tmp, 'git.log');
    const fakeGit = join(tmp, 'fake-git');
    writeFileSync(
      fakeGit,
      [
        '#!/usr/bin/env bash',
        'echo "argv: $*" >> "$FAKE_GIT_LOG"',
        `[ "\${GIT_CONFIG_KEY_0:-}" = http.extraHeader ] && [ "\${GIT_CONFIG_VALUE_0:-}" = "Authorization: Bearer ${EDITION_SECRET}" ] && echo "header: ok" >> "$FAKE_GIT_LOG"`,
        'if [ "$1" = clone ]; then',
        '  url="${@: -2:1}"; dest="${@: -1}"',
        '  case "$url" in *canonical*) echo "fatal: unable to access \'$url\': The requested URL returned error: 403" >&2; exit 128 ;; esac',
        '  mkdir -p "$dest"; exit 0',
        'fi',
        'if [ "$1" = -C ] && [ "$3" = log ]; then echo "1a2b3c4 Website pages (client edition)"; exit 0; fi',
        'exit 1',
      ].join('\n'),
    );
    chmodSync(fakeGit, 0o755);
    const { code, out } = await run('clone.sh', {
      CAPTURE_BASE_URL: base,
      CAPTURE_CLIENT_SESSION_FILE: session,
      CAPTURE_ORG: 'o-1',
      CAPTURE_PROJECT: 'p-1',
      CAPTURE_EDITION: 'ed-1',
      CAPTURE_CANONICAL_REMOTE: 'https://art.example/git/o-1-canonical/res-1.git',
      GIT: fakeGit,
      FAKE_GIT_LOG: gitLog,
    });
    expect(out).not.toContain('EDITIONSECRET');
    expect(out).not.toContain('CLIENTsecret');
    expect(code, out).toBe(0);
    expect(out).toMatch(/git clone https:\/\/art\.example\/git\/o-1-canonical\/res-1\.git website-production/);
    expect(out).toMatch(/403/);
    expect(out).toMatch(/denied: the client's token never reaches the production repository/);
    expect(out).toMatch(/1a2b3c4 Website pages \(client edition\)/);
    const calls = readFileSync(gitLog, 'utf8');
    expect(calls).not.toContain('EDITIONSECRET');
    expect(calls.match(/header: ok/g)).toHaveLength(2);
  }, 30_000);

  it('every terminal script is valid bash', () => {
    for (const file of readdirSync(HERE).filter((f) => f.endsWith('.sh'))) {
      expect(spawnSync('bash', ['-n', join(HERE, file)]).status, file).toBe(0);
    }
  });
});
