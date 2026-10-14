/**
 * Splits the timestamped orchestrator log (capture-terminals.sh) into one asciinema cast per
 * agent lane for scene 4. Lane N gets the `agent-N:` lines, prefix removed, at their real time
 * since the first log line's second (`castEpochMs`), so the three panes replay in sync. Agents' own output is not live
 * (they run `claude -p … --output-format json`); with --step-logs the per-step logs the
 * orchestrator writes after each step are appended after the live lines, marked as not live.
 *
 * Usage: pnpm casts [--log public/clips/orchestrator.log] [--out public/clips]
 *                   [--step-logs <run-dir>/logs] [--width 100] [--height 24]
 * Lane file names come from media.json (scene s04-three-agents, casts in agent order).
 * When orchestrator-run.json beside the log records a --dry-run orchestrator, every cast header
 * carries `dryRun: true` (and the title says so), so `pnpm evidence` can refuse rehearsal casts.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { loadVideoData } from '../src/data';
import { crlf, serializeCast, type OutputEvent } from './cast-file';

export interface LogLine {
  ms: number;
  text: string;
}

export interface StepLog {
  phase: string;
  ms: number;
  content: string;
}

const STAMPED = /^(\d{13}) (.*)$/;
const LANE = /^agent-(\d+):\s?(.*)$/;
const STEP_LOG = /^agent-(\d+)-(.+)-(\d{13})\.log$/;

export function parseLog(text: string): { lines: LogLine[]; skipped: number } {
  const lines: LogLine[] = [];
  let skipped = 0;
  for (const row of text.split('\n')) {
    if (row.trim() === '') continue;
    const m = STAMPED.exec(row);
    if (m) lines.push({ ms: Number(m[1]), text: m[2]! });
    else skipped += 1;
  }
  return { lines, skipped };
}

/** The orchestrator's per-step agent logs (`<runDir>/logs/agent-N-<phase>-<ms>.log`) by lane, oldest first. */
export function readStepLogs(dir: string): Map<number, StepLog[]> {
  const byLane = new Map<number, StepLog[]>();
  for (const name of readdirSync(dir)) {
    const m = STEP_LOG.exec(name);
    if (!m) continue;
    const lane = Number(m[1]);
    const list = byLane.get(lane) ?? [];
    list.push({ phase: m[2]!, ms: Number(m[3]), content: readFileSync(join(dir, name), 'utf8') });
    byLane.set(lane, list);
  }
  for (const list of byLane.values()) list.sort((a, b) => a.ms - b.ms);
  return byLane;
}

export interface CastOptions {
  /** Cast file names; lane N (agent-N) is `lanes[N - 1]`. */
  lanes: string[];
  width: number;
  height: number;
  stepLogs?: Map<number, StepLog[]>;
  /** The orchestrator ran with --dry-run (scripted edits, not real agents). */
  dryRun?: boolean;
}

/** True when the orchestrator-run.json written by capture-terminals.sh records a --dry-run command. */
export function isDryRun(runJsonPath: string): boolean {
  if (!existsSync(runJsonPath)) return false;
  let run: { command?: unknown };
  try {
    run = JSON.parse(readFileSync(runJsonPath, 'utf8')) as { command?: unknown };
  } catch (error) {
    throw new Error(`${runJsonPath} is not valid JSON (${(error as Error).message})`);
  }
  return Array.isArray(run.command) && run.command.includes('--dry-run');
}

/** Seconds between appended step logs, so each lands as its own visible block. */
const STEP_LOG_GAP = 1;

/**
 * Time zero of the lane casts: the first log line's second. The asciinema header `timestamp` is
 * whole seconds, so events are timed from that second and `timestamp` + event time is the exact
 * wall clock (scene 4 shows it; align-lanes.ts uses it).
 */
export function castEpochMs(firstLogMs: number): number {
  return Math.floor(firstLogMs / 1000) * 1000;
}

export function buildCasts(lines: LogLine[], o: CastOptions): Map<string, string> {
  const t0 = castEpochMs(lines[0]?.ms ?? 0);
  const events = o.lanes.map((): OutputEvent[] => []);
  for (const line of lines) {
    const m = LANE.exec(line.text);
    if (!m) continue;
    const lane = events[Number(m[1]) - 1];
    if (lane) lane.push([(line.ms - t0) / 1000, `${m[2]!}\r\n`]);
  }
  o.lanes.forEach((_, i) => {
    const lane = events[i]!;
    let t = lane.at(-1)?.[0] ?? 0;
    for (const log of o.stepLogs?.get(i + 1) ?? []) {
      t += STEP_LOG_GAP;
      const banner = `\x1b[2m── step log: ${log.phase} (written after the step, not live) ──\x1b[0m\r\n`;
      lane.push([t, banner + crlf(log.content.endsWith('\n') ? log.content : `${log.content}\n`)]);
    }
  });
  return new Map(
    o.lanes.map((file, i) => [
      file,
      serializeCast(
        { width: o.width, height: o.height, timestamp: t0 / 1000, title: `agent-${i + 1}${o.dryRun ? ' (dry run)' : ''}`, ...(o.dryRun ? { dryRun: true } : {}) },
        events[i]!,
      ),
    ]),
  );
}

function main(): void {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const { values } = parseArgs({
    options: {
      log: { type: 'string', default: join(root, 'public', 'clips', 'orchestrator.log') },
      out: { type: 'string', default: join(root, 'public', 'clips') },
      'step-logs': { type: 'string' },
      width: { type: 'string', default: '100' },
      height: { type: 'string', default: '24' },
    },
    strict: true,
  });
  const lanes = (loadVideoData().media.scenes['s04-three-agents']?.casts ?? []).map((c) => c.src.replace(/^.*\//, ''));
  if (lanes.length === 0) throw new Error('media.json scene s04-three-agents lists no casts');
  const { lines, skipped } = parseLog(readFileSync(values.log, 'utf8'));
  if (lines.length === 0) throw new Error(`${values.log} has no timestamped lines`);
  const stepDir = values['step-logs'];
  if (stepDir && !existsSync(stepDir)) throw new Error(`--step-logs: ${stepDir} does not exist`);
  const dryRun = isDryRun(join(dirname(values.log), 'orchestrator-run.json'));
  const casts = buildCasts(lines, { lanes, width: Number(values.width), height: Number(values.height), dryRun, ...(stepDir ? { stepLogs: readStepLogs(stepDir) } : {}) });
  for (const [file, text] of casts) {
    writeFileSync(join(values.out, file), text);
    const count = text.split('\n').length - 2;
    console.log(`wrote ${join(values.out, file)} (${count} event${count === 1 ? '' : 's'})`);
  }
  if (skipped > 0) console.log(`skipped ${skipped} unstamped line(s)`);
  if (dryRun) console.log('the orchestrator ran with --dry-run: casts are stamped dryRun and are rehearsal footage only');
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(`log-to-casts: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
