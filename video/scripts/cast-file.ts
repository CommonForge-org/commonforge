/** Writing asciinema v2 casts (the format src/lib/asciinema.ts reads). */

export interface CastHeaderOptions {
  width: number;
  height: number;
  /** Unix seconds of the recording's time zero. */
  timestamp?: number;
  title?: string;
  /**
   * True when the recording came from a rehearsal (the orchestrator's --dry-run: scripted edits,
   * not real agents). `pnpm evidence` refuses such casts.
   */
  dryRun?: boolean;
}

/** [seconds since time zero, data] output events. */
export type OutputEvent = [number, string];

/** CommonForge bearer tokens: `cfs_…` sessions, `cfl_…` leases, … */
const CF_TOKEN = /\b(cf[a-z])_[A-Za-z0-9_-]{6,}/g;
/** Cloudflare Artifacts repository tokens: `art_v1_<hex>`, `art_v2_x_<hex>?expires=<epoch>`. */
const ARTIFACTS_TOKEN = /\bart_v\d+_[A-Za-z0-9_]+(?:\?expires=\d+)?/g;
/**
 * Any Authorization header value (`Authorization: Bearer …`, `"authorization":"…"`), whatever the
 * token looks like. A shell variable reference (`Bearer $CF_TOKEN`) is not a secret and stays.
 */
const AUTHORIZATION = /(\bauthorization["']?\s*[:=]\s*["']?)(?:(bearer|basic|token)\s+(?!\$)[^\s"',}]+|(?!\$|(?:bearer|basic|token)\b)[^\s"',}]+)/gi;

/** Masks bearer tokens: CommonForge tokens, Artifacts repository tokens and Authorization header values. */
export function redact(text: string): string {
  return text
    .replace(CF_TOKEN, '$1_…redacted')
    .replace(ARTIFACTS_TOKEN, 'art_…redacted')
    .replace(AUTHORIZATION, (_match, head: string, scheme: string | undefined) => `${head}${scheme ? `${scheme} ` : ''}…redacted`);
}

/** Terminal line endings: a bare LF moves down without returning to column 0. */
export function crlf(text: string): string {
  return text.replace(/\r?\n/g, '\r\n');
}

export function serializeCast(header: CastHeaderOptions, events: OutputEvent[]): string {
  const head = {
    version: 2,
    width: header.width,
    height: header.height,
    ...(header.timestamp !== undefined ? { timestamp: header.timestamp } : {}),
    ...(header.title ? { title: header.title } : {}),
    ...(header.dryRun ? { dryRun: true } : {}),
  };
  const rows = events.map(([t, data]) => JSON.stringify([Math.round(t * 1000) / 1000, 'o', redact(data)]));
  return `${[JSON.stringify(head), ...rows].join('\n')}\n`;
}
