/**
 * Records a command's output as an asciinema v2 cast with real timings (no asciinema install
 * needed; line-oriented output only, like src/lib/asciinema.ts renders). Used for the terminal
 * panes the UI cannot show: intake inventory, release after restore, export bundle verify.
 * CommonForge tokens are masked in the cast. An existing cast is kept as <name>.<UTC stamp>.cast.
 *
 * Usage: pnpm record-cast --out public/clips/cast-intake.cast [--width 100] [--height 24]
 *                         [--title "…"] -- <command> [args…]
 */
import { spawn } from 'node:child_process';
import { existsSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { crlf, serializeCast, type OutputEvent } from './cast-file';

export interface RecordOptions {
  command: string;
  args: string[];
  width: number;
  height: number;
  title?: string;
  /** Also write the output to this terminal while recording (default true). */
  echo?: boolean;
}

export function recordCast(o: RecordOptions): Promise<{ cast: string; code: number }> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const events: OutputEvent[] = [];
    const child = spawn(o.command, o.args, { stdio: ['inherit', 'pipe', 'pipe'], env: { ...process.env, COLUMNS: String(o.width), LINES: String(o.height) } });
    const take = (stream: NodeJS.WriteStream) => (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      events.push([(Date.now() - started) / 1000, crlf(text)]);
      if (o.echo !== false) stream.write(text);
    };
    child.stdout.on('data', take(process.stdout));
    child.stderr.on('data', take(process.stderr));
    child.on('error', reject);
    child.on('close', (code, signal) => {
      const header = { width: o.width, height: o.height, timestamp: Math.floor(started / 1000), ...(o.title ? { title: o.title } : {}) };
      resolve({ cast: serializeCast(header, events), code: code ?? (signal ? 128 : 1) });
    });
  });
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      out: { type: 'string' },
      width: { type: 'string', default: '100' },
      height: { type: 'string', default: '24' },
      title: { type: 'string' },
    },
    allowPositionals: true,
    strict: true,
  });
  const [command, ...args] = positionals;
  if (!values.out || !command) throw new Error('usage: record-cast --out <file.cast> [--width N] [--height N] [--title T] -- <command> [args…]');
  const { cast, code } = await recordCast({ command, args, width: Number(values.width), height: Number(values.height), ...(values.title ? { title: values.title } : {}) });
  if (existsSync(values.out)) {
    const kept = values.out.replace(/\.cast$/, `.${new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, 'Z')}.cast`);
    renameSync(values.out, kept);
    console.error(`record-cast: kept the previous cast as ${kept}`);
  }
  writeFileSync(values.out, cast);
  console.error(`record-cast: wrote ${values.out} (command exit ${code})`);
  process.exitCode = code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(`record-cast: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
