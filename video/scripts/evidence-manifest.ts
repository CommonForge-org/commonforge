/**
 * Freezes a capture take as evidence: copies public/clips (clips, screenshots, casts, marks,
 * orchestrator log) and the orchestrator's concurrency.json into evidence/video/<UTC timestamp>/
 * and writes MANIFEST.json with each file's sha256, capture times, the app's git sha and the
 * Worker deployment from `wrangler deployments list` (when wrangler is available and logged in).
 * The Worker has no /api/version; /health is recorded when CAPTURE_BASE_URL is set.
 *
 * Usage: pnpm evidence [--clips public/clips] [--out ../evidence/video] [--concurrency <file>]
 *   --concurrency defaults to <evidenceDir>/concurrency.json from public/clips/orchestrator-run.json
 *   --manual <file,…>   hand-made media in the take (e.g. shot-01-client-folder.png); exempt from
 *                       the capture-marks check and listed in the manifest; every name must be in the take.
 *                       media.json "manual" files present in the take are added automatically
 *   --allow-unverified  write an interim manifest (verified: false) instead of refusing a take
 *                       with placeholder media, media without cookie-mode marks, dry-run casts or a
 *                       dry-run orchestrator run; fixture-mode footage is always refused; never
 *                       with --publish (only a verified take is published)
 *
 * Before anything is written or published, every cast, log and JSON of the take (and
 * concurrency.json) goes through `redact()`; a take where that changes anything is refused.
 *   --publish           upload every file of the take to the R2 bucket (--bucket, default
 *                       commonforge-evidence) under video/<timestamp>/ and record each public URL
 *                       next to its sha256 (scripts/r2-publisher.ts; credentials from video/.env)
 *   WRANGLER  the wrangler command (default "wrangler"; e.g. "pnpm --dir ../apps/worker exec wrangler")
 *
 * Placeholders are recognised by content through .placeholder-manifest.json (pnpm placeholders), so
 * a placeholder PNG or WebM cannot pass even under --manual; placeholder casts also by their title.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { loadVideoData, mediaPaths } from '../src/data';
import { redact } from './cast-file';
import { hasPlaceholderMarker } from './placeholder-marker';
import { emptyPlaceholderManifest, isPlaceholderCast, PlaceholderIndex, readPlaceholderManifest, type PlaceholderManifest } from './placeholder-manifest';
import { createR2Publisher, type Publisher } from './r2-publisher';

export interface FileEntry {
  path: string;
  bytes: number;
  sha256: string;
  modifiedAt: string;
  /** Public URL of the published copy (--publish); its bytes hash to `sha256`. */
  url?: string;
}

export interface Manifest {
  schema: 'commonforge.video.evidence/1';
  createdAt: string;
  captureTime: { earliest: string; latest: string };
  git: { sha: string; branch: string; dirty: boolean } | null;
  worker: { name: string; latestDeploymentId: string | null; deployments: unknown; error?: string };
  health: { url: string; status: number; body: string } | null;
  files: FileEntry[];
  /** media.json files not present in the take. */
  missing: string[];
  /** False only for an interim manifest written with --allow-unverified. */
  verified: boolean;
  /** Hand-made media the operator vouched for with --manual (exempt from the capture-marks check). */
  manual: string[];
  /** Generated placeholder media found in the take (--allow-unverified only). */
  placeholders: string[];
  /** Media not proven to come from a live capture, with the reason (--allow-unverified only). */
  unverified: Array<{ path: string; reason: string }>;
  /** Where the raw files were published (--publish), or null when they stay local. */
  published: { bucket: string; prefix: string; baseUrl: string } | null;
}

export interface EvidenceDeps {
  now: () => Date;
  git: () => Manifest['git'];
  /** Raw stdout of `wrangler deployments list --name <worker> --json`; throws when unavailable. */
  wrangler: (workerName: string) => string;
  health: () => Promise<Manifest['health']>;
  /** media.json paths (relative to public/) the take should contain. */
  expected: string[];
  /** Recorded placeholders (.placeholder-manifest.json); default: none. */
  placeholders?: PlaceholderManifest;
}

export interface EvidenceOptions {
  clipsDir: string;
  outRoot: string;
  concurrency?: string | undefined;
  workerName: string;
  /** File names in clipsDir that were made by hand (screenshots, screen-recording inserts). */
  manual?: string[];
  /** Write an interim manifest listing placeholder and unverified media instead of refusing. */
  allowUnverified?: boolean;
  /** Upload the take here and record each file's public URL. */
  publish?: Publisher;
}

const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

/** Parses a JSON file of the take, naming it when it is not JSON. */
function readJson<T>(path: string): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (error) {
    throw new Error(`${basename(path)} is not valid JSON (${(error as Error).message})`);
  }
}

function latestDeployment(raw: unknown): string | null {
  if (!Array.isArray(raw)) return null;
  const dated = raw.filter((d): d is { id: string; created_on?: string } => typeof d === 'object' && d !== null && typeof (d as { id?: unknown }).id === 'string');
  dated.sort((a, b) => Date.parse(b.created_on ?? '') - Date.parse(a.created_on ?? ''));
  return dated[0]?.id ?? null;
}

function assertLiveFootage(clipsDir: string, files: string[]): void {
  if (basename(clipsDir) === 'clips-dry') throw new Error(`${clipsDir} holds dry-run captures; evidence takes public/clips only`);
  for (const file of files.filter((f) => f.endsWith('.marks.json'))) {
    const marks = readJson<{ mode?: string }>(join(clipsDir, file));
    if (marks.mode === 'fixture') throw new Error(`${file} was captured in fixture-mode; fixture clips are never final footage`);
  }
}

/** Media that only `pnpm capture` produces; each needs a cookie-mode `.marks.json` unless allowlisted. */
const MEDIA = /\.(webm|mp4|mov|png|jpe?g)$/i;

export interface Audit {
  placeholders: string[];
  unverified: Array<{ path: string; reason: string }>;
}

/**
 * Finds what must not pass as the take: generated placeholders (by content, or a PLACEHOLDER cast
 * title), media without cookie-mode capture marks (failed units, unvouched hand-made files),
 * casts stamped dryRun and a dry-run orchestrator run.
 */
export function auditTake(
  clipsDir: string,
  files: string[],
  manual: Set<string>,
  placeholders: PlaceholderIndex,
  opts: { only?: Set<string>; hasMarker?: (file: string) => boolean } = {},
): Audit {
  const audit: Audit = { placeholders: [], unverified: [] };
  const present = new Set(files);
  const hasMarker = opts.hasMarker ?? ((file: string) => hasPlaceholderMarker(file));
  for (const file of files) {
    if (opts.only && !opts.only.has(file)) continue;
    const path = join(clipsDir, file);
    if (placeholders.matches(path) || (MEDIA.test(file) && hasMarker(path))) {
      audit.placeholders.push(`clips/${file}`);
    } else if (file.endsWith('.cast')) {
      const text = readFileSync(path, 'utf8');
      let header: { dryRun?: unknown } = {};
      try {
        header = JSON.parse(text.split('\n', 1)[0] ?? '') as { dryRun?: unknown };
      } catch {
        audit.unverified.push({ path: `clips/${file}`, reason: 'not an asciinema cast (unreadable header)' });
      }
      if (isPlaceholderCast(text)) audit.placeholders.push(`clips/${file}`);
      else if (header.dryRun === true) audit.unverified.push({ path: `clips/${file}`, reason: 'cast from a --dry-run orchestrator (scripted edits, not real agents)' });
    } else if (MEDIA.test(file) && !manual.has(file)) {
      const marks = file.replace(/\.[^.]+$/, '.marks.json');
      if (!present.has(marks)) {
        audit.unverified.push({ path: `clips/${file}`, reason: 'no .marks.json (not written by pnpm capture; pass --manual if hand-made)' });
        continue;
      }
      const mode = readJson<{ mode?: string }>(join(clipsDir, marks)).mode ?? 'unknown';
      if (mode !== 'cookie') audit.unverified.push({ path: `clips/${file}`, reason: `captured in mode "${mode}", not cookie` });
    } else if (file === 'orchestrator-run.json') {
      const run = readJson<{ command?: unknown }>(path);
      if (Array.isArray(run.command) && run.command.includes('--dry-run')) {
        audit.unverified.push({ path: `clips/${file}`, reason: 'the orchestrator ran with --dry-run (scripted edits, not real agents)' });
      }
    }
  }
  return audit;
}

/** Text the take publishes as is: casts, logs and JSON (marks, hashes, orchestrator run, concurrency). */
const SCANNED = /\.(cast|log|json)$/i;

/**
 * Files whose text `redact()` would change: a token (CommonForge, Artifacts) or Authorization
 * value that escaped redaction. Names only; the secret itself is never repeated.
 */
export function secretScan(paths: string[]): string[] {
  return paths.filter((path) => SCANNED.test(path) && existsSync(path)).filter((path) => {
    const text = readFileSync(path, 'utf8');
    return redact(text) !== text;
  });
}

/** Writes evidence/video/<timestamp>/ and returns its path. */
export async function writeEvidence(o: EvidenceOptions, deps: EvidenceDeps): Promise<string> {
  const files = readdirSync(o.clipsDir).filter((f) => !f.startsWith('.') && statSync(join(o.clipsDir, f)).isFile()).sort();
  if (o.publish && o.allowUnverified) {
    throw new Error('--publish is refused with --allow-unverified: only a verified take is published; nothing written');
  }
  const leaking = secretScan([...files.map((f) => join(o.clipsDir, f)), ...(o.concurrency ? [o.concurrency] : [])]);
  if (leaking.length > 0) {
    throw new Error(
      `secret scan: ${leaking.length} file(s) hold an unredacted token or Authorization value; nothing written or published:\n` +
        `${leaking.map((p) => `  - ${p}`).join('\n')}\nRe-record them (record-cast and pnpm casts redact) or redact them before taking evidence.`,
    );
  }
  assertLiveFootage(o.clipsDir, files);
  const manual = new Set(o.manual ?? []);
  const unknownManual = [...manual].filter((m) => !files.includes(m));
  if (unknownManual.length > 0) {
    throw new Error(`--manual names file(s) not in ${o.clipsDir}: ${unknownManual.join(', ')} (use the bare file name, e.g. shot-01-client-folder.png)`);
  }
  const audit = auditTake(o.clipsDir, files, manual, new PlaceholderIndex(deps.placeholders ?? emptyPlaceholderManifest()));
  const problems = [...audit.placeholders.map((p) => `placeholder: ${p}`), ...audit.unverified.map((u) => `${u.path}: ${u.reason}`)];
  if (problems.length > 0 && o.publish) {
    throw new Error(`not a verified take; --publish refused, nothing written:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }
  if (problems.length > 0 && !o.allowUnverified) {
    throw new Error(`not a verified take; nothing written:\n${problems.map((p) => `  - ${p}`).join('\n')}\nRe-capture these, or pass --allow-unverified for an interim manifest that lists them.`);
  }

  const now = deps.now();
  const dir = join(o.outRoot, now.toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-'));
  if (existsSync(dir)) throw new Error(`${dir} already exists`);
  mkdirSync(join(dir, 'clips'), { recursive: true });

  const entries: FileEntry[] = [];
  const copy = (src: string, rel: string) => {
    const target = join(dir, rel);
    copyFileSync(src, target);
    const stat = statSync(src);
    entries.push({ path: rel, bytes: stat.size, sha256: sha256(target), modifiedAt: stat.mtime.toISOString() });
  };
  for (const file of files) copy(join(o.clipsDir, file), `clips/${file}`);
  if (o.concurrency) {
    if (!existsSync(o.concurrency)) throw new Error(`--concurrency: ${o.concurrency} does not exist`);
    copy(o.concurrency, 'concurrency.json');
  }

  const prefix = `video/${basename(dir)}`;
  if (o.publish) {
    try {
      for (const entry of entries) {
        const key = `${prefix}/${entry.path}`;
        await o.publish.put(key, join(dir, entry.path), { contentType: contentType(entry.path), sha256: entry.sha256 });
        entry.url = o.publish.publicUrl(key);
      }
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      throw new Error(
        `publishing to R2 bucket ${o.publish.bucket} failed (${error instanceof Error ? error.message : String(error)}); nothing written locally. ` +
          `Objects already uploaded under ${prefix}/ are orphaned; rerun to publish a new timestamped take.`,
        { cause: error },
      );
    }
  }

  let worker: Manifest['worker'];
  try {
    const deployments: unknown = JSON.parse(deps.wrangler(o.workerName));
    worker = { name: o.workerName, latestDeploymentId: latestDeployment(deployments), deployments };
  } catch (error) {
    worker = { name: o.workerName, latestDeploymentId: null, deployments: null, error: error instanceof Error ? error.message : String(error) };
  }

  const times = entries.map((e) => e.modifiedAt).sort();
  const present = new Set(files.map((f) => `clips/${f}`));
  const manifest: Manifest = {
    schema: 'commonforge.video.evidence/1',
    createdAt: now.toISOString(),
    captureTime: { earliest: times[0] ?? now.toISOString(), latest: times.at(-1) ?? now.toISOString() },
    git: deps.git(),
    worker,
    health: await deps.health(),
    files: entries,
    missing: deps.expected.filter((p) => !present.has(p)),
    verified: problems.length === 0,
    manual: files.filter((f) => manual.has(f)).map((f) => `clips/${f}`),
    placeholders: audit.placeholders,
    unverified: audit.unverified,
    published: o.publish ? { bucket: o.publish.bucket, prefix: `${prefix}/`, baseUrl: o.publish.publicUrl(`${prefix}/`) } : null,
  };
  writeFileSync(join(dir, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return dir;
}

const CONTENT_TYPES: Record<string, string> = {
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.json': 'application/json',
  '.cast': 'application/x-asciicast',
  '.log': 'text/plain; charset=utf-8',
};

function contentType(path: string): string {
  const ext = /\.[^.]+$/.exec(path)?.[0]?.toLowerCase() ?? '';
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

function gitInfo(cwd: string): Manifest['git'] {
  try {
    const run = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    return { sha: run('rev-parse', 'HEAD'), branch: run('rev-parse', '--abbrev-ref', 'HEAD'), dirty: run('status', '--porcelain', '--untracked-files=no') !== '' };
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const repo = resolve(root, '..');
  const { values } = parseArgs({
    options: {
      clips: { type: 'string', default: join(root, 'public', 'clips') },
      out: { type: 'string', default: join(repo, 'evidence', 'video') },
      concurrency: { type: 'string' },
      'worker-name': { type: 'string', default: 'commonforge-worker' },
      manual: { type: 'string', multiple: true },
      'allow-unverified': { type: 'boolean' },
      publish: { type: 'boolean' },
      bucket: { type: 'string', default: 'commonforge-evidence' },
    },
    strict: true,
  });
  if (values.publish && values['allow-unverified']) throw new Error('--publish is refused with --allow-unverified: only a verified take is published');
  let concurrency = values.concurrency;
  const runJson = join(values.clips, 'orchestrator-run.json');
  if (!concurrency && existsSync(runJson)) {
    const run = readJson<{ evidenceDir?: string | null }>(runJson);
    const candidate = run.evidenceDir ? join(run.evidenceDir, 'concurrency.json') : null;
    if (candidate && existsSync(candidate)) concurrency = candidate;
  }
  if (!concurrency) console.log('evidence: no concurrency.json found (pass --concurrency); continuing without it');

  const { media } = loadVideoData();
  const expected = mediaPaths(media);
  const [wranglerCmd = 'wrangler', ...wranglerArgs] = (process.env.WRANGLER ?? 'wrangler').split(' ').filter(Boolean);
  const base = process.env.CAPTURE_BASE_URL;
  const dir = await writeEvidence(
    {
      clipsDir: resolve(values.clips),
      outRoot: resolve(values.out),
      concurrency,
      workerName: values['worker-name'],
      // --manual names plus media.json "manual" files present in the take
      manual: [
        ...new Set([
          ...(values.manual ?? []).flatMap((m) => m.split(',')).map((m) => m.trim()).filter(Boolean),
          ...(media.manual ?? []).map((p) => basename(p)).filter((f) => existsSync(join(values.clips, f))),
        ]),
      ],
      allowUnverified: values['allow-unverified'] === true,
      ...(values.publish ? { publish: createR2Publisher({ bucket: values.bucket, envFile: join(root, '.env') }) } : {}),
    },
    {
      now: () => new Date(),
      git: () => gitInfo(repo),
      wrangler: (name) => execFileSync(wranglerCmd, [...wranglerArgs, 'deployments', 'list', '--name', name, '--json'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
      health: async () => {
        if (!base) return null;
        const url = new URL('/health', base).toString();
        const res = await fetch(url);
        return { url, status: res.status, body: await res.text() };
      },
      expected,
      placeholders: readPlaceholderManifest(),
    },
  );
  const manifest = JSON.parse(readFileSync(join(dir, 'MANIFEST.json'), 'utf8')) as Manifest;
  console.log(`evidence: ${manifest.files.length} file(s) → ${dir}`);
  console.log(`  git ${manifest.git?.sha ?? 'unknown'}${manifest.git?.dirty ? ' (dirty)' : ''}; worker deployment ${manifest.worker.latestDeploymentId ?? `unknown (${manifest.worker.error ?? 'no deployments'})`}`);
  if (manifest.published) console.log(`  published ${manifest.files.length} file(s) to R2 ${manifest.published.bucket}: ${manifest.published.baseUrl}`);
  if (manifest.missing.length) console.log(`  WARNING: missing from this take: ${manifest.missing.join(', ')}`);
  if (!manifest.verified) {
    console.log(`  WARNING: interim manifest (verified: false): ${[...manifest.placeholders, ...manifest.unverified.map((u) => u.path)].join(', ')}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(`evidence: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
