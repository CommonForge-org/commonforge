import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { castStateAt, parseCast } from '../src/lib/asciinema';
import { redact } from './cast-file';
import { buildCasts, castEpochMs, isDryRun, parseLog, readStepLogs } from './log-to-casts';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'cf-casts-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const T0 = 1_759_750_000_000;
const LOG = [
  `${T0} created 3 task(s); waiting for provisioning`,
  `${T0 + 4_000} agent-1: checked out t-1 (website, api)`,
  `${T0 + 4_500} agent-3: checked out t-3 (requirements, brand-assets ro)`,
  'not a stamped line',
  `${T0 + 5_250} agent-2: feature (client edition) — agent running`,
  `${T0 + 64_000} agent-1: gate attempt 1: FAIL (contract quote-schema)`,
  `${T0 + 90_000} all agents finished in 90000 ms`,
].join('\n');
const LANES = ['cast-04-agent-a.cast', 'cast-04-agent-b.cast', 'cast-04-agent-c.cast'];

describe('parseLog', () => {
  it('reads "<epoch ms> <text>" lines and counts the rest as skipped', () => {
    const { lines, skipped } = parseLog(LOG);
    expect(lines).toHaveLength(6);
    expect(lines[1]).toEqual({ ms: T0 + 4_000, text: 'agent-1: checked out t-1 (website, api)' });
    expect(skipped).toBe(1);
  });
});

describe('buildCasts', () => {
  const casts = buildCasts(parseLog(LOG).lines, { lanes: LANES, width: 100, height: 24 });

  it('writes one cast per lane, keyed by the media.json names', () => {
    expect([...casts.keys()]).toEqual(LANES);
  });

  it('keeps each agent-N line in lane N with real timings from the first log line', () => {
    const a = parseCast(casts.get('cast-04-agent-a.cast')!);
    expect(a.header).toMatchObject({ version: 2, width: 100, height: 24, timestamp: Math.floor(T0 / 1000) });
    expect(a.events.map((e) => [e.time, e.data])).toEqual([
      [4, 'checked out t-1 (website, api)\r\n'],
      [64, 'gate attempt 1: FAIL (contract quote-schema)\r\n'],
    ]);
    expect(parseCast(casts.get('cast-04-agent-b.cast')!).events.map((e) => e.time)).toEqual([5.25]);
    expect(parseCast(casts.get('cast-04-agent-c.cast')!).events.map((e) => e.time)).toEqual([4.5]);
  });

  it('leaves orchestrator lines without an agent prefix out of every lane', () => {
    for (const cast of casts.values()) expect(cast).not.toContain('all agents finished');
  });

  it('renders through the composition cast reader', () => {
    const state = castStateAt(parseCast(casts.get('cast-04-agent-a.cast')!), 70_000);
    expect(state.lines.map((l) => l.map((s) => s.text).join(''))).toEqual(['checked out t-1 (website, api)', 'gate attempt 1: FAIL (contract quote-schema)']);
  });

  it('appends step logs after the live lines, marked as not live', () => {
    const dir = join(tmp, 'logs');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `agent-1-fix-${T0 + 80_000}.log`), '$ claude -p …\n--- stdout ---\nfixed\n');
    writeFileSync(join(dir, `agent-1-feature-${T0 + 60_000}.log`), 'feature log\n');
    writeFileSync(join(dir, 'notes.txt'), 'ignored');
    const withLogs = buildCasts(parseLog(LOG).lines, { lanes: LANES, width: 100, height: 24, stepLogs: readStepLogs(dir) });
    const events = parseCast(withLogs.get('cast-04-agent-a.cast')!).events;
    expect(events).toHaveLength(4);
    expect(events[2]!.time).toBeGreaterThan(64);
    expect(events[3]!.time).toBeGreaterThan(events[2]!.time);
    expect(events[2]!.data).toMatch(/step log: feature .*not live/);
    expect(events[2]!.data).toContain('feature log\r\n');
    expect(events[3]!.data).toMatch(/step log: fix/);
    expect(parseCast(withLogs.get('cast-04-agent-b.cast')!).events).toHaveLength(1);
  });

  it('never writes session or lease tokens', () => {
    const leaky = parseLog(`${T0} agent-1: using cfl_abcdef123456 and cfs_ZZZ999yyy888`).lines;
    const cast = buildCasts(leaky, { lanes: LANES, width: 80, height: 20 }).get('cast-04-agent-a.cast')!;
    expect(cast).not.toMatch(/cfl_abcdef|cfs_ZZZ/);
    expect(redact('token cfs_abcdefghij end')).toBe('token cfs_…redacted end');
  });

  it('masks Artifacts repository tokens and Authorization header values in appended step logs', () => {
    const dir = join(tmp, 'leaky-logs');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `agent-1-feature-${T0 + 60_000}.log`),
      [
        'git push https://x:art_v2_x_0123abcdEF?expires=1759999999@artifacts.example/r.git',
        'remote token art_v1_00112233445566778899aabb',
        '> Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig',
        '{"headers":{"authorization":"Basic dXNlcjpzZWNyZXQ="}}',
        'shown command: curl -H "Authorization: Bearer $CF_TOKEN"',
      ].join('\n'),
    );
    const cast = buildCasts(parseLog(LOG).lines, { lanes: LANES, width: 100, height: 24, stepLogs: readStepLogs(dir) }).get('cast-04-agent-a.cast')!;
    expect(cast).not.toMatch(/0123abcdEF|00112233445566778899aabb|eyJhbGci|dXNlcjpzZWNyZXQ/);
    expect(cast).toContain('art_…redacted');
    expect(cast).toContain('Authorization: Bearer …redacted');
    expect(cast).toContain('Authorization: Bearer $CF_TOKEN');
  });

  it('stamps every lane cast dryRun when the orchestrator ran with --dry-run', () => {
    const casts = buildCasts(parseLog(LOG).lines, { lanes: LANES, width: 100, height: 24, dryRun: true });
    for (const text of casts.values()) {
      const header = JSON.parse(text.split('\n', 1)[0]!) as { dryRun?: boolean; title?: string };
      expect(header.dryRun).toBe(true);
      expect(header.title).toMatch(/dry run/);
    }
    const live = JSON.parse(buildCasts(parseLog(LOG).lines, { lanes: LANES, width: 100, height: 24 }).get(LANES[0]!)!.split('\n', 1)[0]!) as Record<string, unknown>;
    expect(live).not.toHaveProperty('dryRun');
  });

  it('reads --dry-run from orchestrator-run.json', () => {
    const dir = join(tmp, 'run-json');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'dry.json'), JSON.stringify({ command: ['node', 'main.js', '--dry-run'] }));
    writeFileSync(join(dir, 'live.json'), JSON.stringify({ command: ['node', 'main.js', '--agents', '1,2,3'] }));
    writeFileSync(join(dir, 'broken.json'), '{');
    expect(isDryRun(join(dir, 'dry.json'))).toBe(true);
    expect(isDryRun(join(dir, 'live.json'))).toBe(false);
    expect(isDryRun(join(dir, 'missing.json'))).toBe(false);
    expect(() => isDryRun(join(dir, 'broken.json'))).toThrow(/broken\.json is not valid JSON/);
  });
});

describe('capture-terminals.sh', () => {
  it('timestamps the command stderr into the log, passes stdout through and records the run', () => {
    const log = join(tmp, 'term', 'orchestrator.log');
    const r = spawnSync('bash', [join(SCRIPTS, 'capture-terminals.sh'), '--', 'sh', '-c', 'echo "agent-1: one" >&2; echo final-json; echo "agent-2: two" >&2'], {
      env: { ...process.env, CAPTURE_TERMINALS_LOG: log },
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('final-json');
    const lines = readFileSync(log, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\d{13} agent-1: one$/);
    expect(lines[1]).toMatch(/^\d{13} agent-2: two$/);
    const run = JSON.parse(readFileSync(join(dirname(log), 'orchestrator-run.json'), 'utf8')) as { exitCode: number; command: string[] };
    expect(run.exitCode).toBe(0);
    expect(run.command).toEqual(['sh', '-c', 'echo "agent-1: one" >&2; echo final-json; echo "agent-2: two" >&2']);
  });

  it('keeps an earlier log and reports the command exit status', () => {
    const log = join(tmp, 'term', 'orchestrator.log');
    const r = spawnSync('bash', [join(SCRIPTS, 'capture-terminals.sh'), '--', 'sh', '-c', 'echo "agent-3: boom" >&2; exit 7'], {
      env: { ...process.env, CAPTURE_TERMINALS_LOG: log },
      encoding: 'utf8',
    });
    expect(r.status).toBe(7);
    expect(readFileSync(log, 'utf8')).toMatch(/agent-3: boom/);
    const kept = execFileSync('ls', [dirname(log)], { encoding: 'utf8' }).split('\n').filter((f) => /^orchestrator\..+\.log$/.test(f));
    expect(kept).toHaveLength(1);
  });

  it('sends a rehearsal (any command after --) to .capture/rehearsal by default, never public/clips', () => {
    const video = join(tmp, 'rehearsal-video');
    mkdirSync(join(video, 'scripts'), { recursive: true });
    copyFileSync(join(SCRIPTS, 'capture-terminals.sh'), join(video, 'scripts', 'capture-terminals.sh'));
    const env = { ...process.env };
    delete env.CAPTURE_TERMINALS_LOG;
    const r = spawnSync('bash', [join(video, 'scripts', 'capture-terminals.sh'), '--', 'sh', '-c', 'echo "agent-1: rehearsal" >&2'], { env, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/rehearsal; logging to .*\.capture\/rehearsal\/orchestrator\.log/);
    expect(readFileSync(join(video, '.capture', 'rehearsal', 'orchestrator.log'), 'utf8')).toMatch(/agent-1: rehearsal/);
    expect(existsSync(join(video, '.capture', 'rehearsal', 'orchestrator-run.json'))).toBe(true);
    expect(existsSync(join(video, 'public', 'clips'))).toBe(false);
  });

  it('is valid bash', () => {
    expect(spawnSync('bash', ['-n', resolve(SCRIPTS, 'capture-terminals.sh')]).status).toBe(0);
    expect(existsSync(join(SCRIPTS, 'capture-terminals.sh'))).toBe(true);
  });
});

describe('cast time zero', () => {
  it('times events from the first line\'s whole second so header timestamp + event time is the wall clock', () => {
    const t = 1_759_750_000_400;
    const casts = buildCasts(parseLog(`${t} agent-1: a\n${t + 1_000} agent-1: b\n`).lines, { lanes: ['a.cast'], width: 80, height: 24 });
    const cast = parseCast(casts.get('a.cast')!);
    expect(cast.header.timestamp).toBe(1_759_750_000);
    expect(cast.events.map((e) => (cast.header.timestamp! * 1000 + e.time * 1000))).toEqual([t, t + 1_000]);
    expect(castEpochMs(t)).toBe(1_759_750_000_000);
  });
});
