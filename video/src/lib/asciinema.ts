/**
 * Minimal asciinema v2 cast reader: replays "o" (output) events into a grid of
 * styled cells. Supports CR/LF, backspace, tab, autowrap, erase-in-line and
 * SGR bold + 16/256-colour foregrounds. Other escape sequences (cursor
 * movement, OSC titles, private modes) are consumed and ignored, so full-screen
 * TUIs will not render faithfully; line-oriented CLI output does.
 */

export interface CastHeader {
  version: 2;
  width: number;
  height: number;
  timestamp?: number;
  title?: string;
}

export interface CastEvent {
  /** Seconds since the start of the recording. */
  time: number;
  /** "o" output, "i" input, "m" marker, "r" resize. */
  type: string;
  data: string;
}

export interface Cast {
  header: CastHeader;
  events: CastEvent[];
}

export interface Style {
  bold: boolean;
  /** ANSI palette index 0-255, or null for the terminal's default foreground. */
  fg: number | null;
}

export interface Span extends Style {
  text: string;
}

export type Line = Span[];

export interface CastState {
  /** Rows with content; trailing empty rows are dropped. */
  lines: Line[];
  cursor: { row: number; col: number };
}

export function parseCast(text: string): Cast {
  const rows = text.split('\n').filter((row) => row.trim() !== '');
  const [headerRow, ...eventRows] = rows;
  if (headerRow === undefined) throw new Error('cast is empty');
  const header = JSON.parse(headerRow) as Partial<CastHeader> & { version?: unknown };
  if (header.version !== 2) throw new Error(`cast must be asciinema version 2, got ${String(header.version)}`);
  if (typeof header.width !== 'number' || typeof header.height !== 'number') {
    throw new Error('cast header needs numeric width and height');
  }
  const events = eventRows.map((row, index): CastEvent => {
    const event: unknown = JSON.parse(row);
    if (
      !Array.isArray(event) ||
      typeof event[0] !== 'number' ||
      typeof event[1] !== 'string' ||
      typeof event[2] !== 'string'
    ) {
      throw new Error(`cast event ${index + 1} is not [time, type, data]: ${row}`);
    }
    return { time: event[0], type: event[1], data: event[2] };
  });
  events.forEach((event, index) => {
    if (index > 0 && event.time < events[index - 1]!.time) {
      throw new Error(`cast event ${index + 1} goes back in time (${event.time} s after ${events[index - 1]!.time} s)`);
    }
  });
  return { header: header as CastHeader, events };
}

/** Terminal state after all output events at or before `tMs` milliseconds (full replay). */
export function castStateAt(cast: Cast, tMs: number): CastState {
  const output = cast.events
    .filter((event) => event.type === 'o' && event.time * 1000 <= tMs)
    .map((event) => event.data)
    .join('');
  const screen = new Screen(cast.header.width);
  screen.write(output);
  return screen.snapshot();
}

/**
 * Incremental replay of one cast for frame-by-frame rendering. The output events are extracted
 * once; moving forward in time only feeds the events since the previous position, and rows are
 * re-styled only when they changed, so each frame costs O(new events). Moving backward replays
 * from the start. Always equal to `castStateAt` for the same `tMs`.
 */
export class CastPlayer {
  private readonly times: number[] = [];
  private readonly data: string[] = [];
  private screen: Screen;
  private applied = 0;
  private state: CastState;

  constructor(private readonly cast: Cast) {
    for (const event of cast.events) {
      if (event.type !== 'o') continue;
      this.times.push(event.time * 1000);
      this.data.push(event.data);
    }
    this.screen = new Screen(cast.header.width);
    this.state = this.screen.snapshot();
  }

  /** Number of output events at or before `tMs`; the state only changes when this does. */
  countAt(tMs: number): number {
    let lo = 0;
    let hi = this.times.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.times[mid]! <= tMs) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  stateAt(tMs: number): CastState {
    const count = this.countAt(tMs);
    if (count === this.applied) return this.state;
    if (count < this.applied) {
      this.screen = new Screen(this.cast.header.width);
      this.applied = 0;
    }
    for (; this.applied < count; this.applied += 1) this.screen.write(this.data[this.applied]!);
    this.state = this.screen.snapshot();
    return this.state;
  }
}

/**
 * The rows a pane `rows` high shows: the newest ones, anchored so the cursor row is the bottom
 * row once output fills the pane. `first` is the index of the first visible row.
 */
export function visibleRows(state: CastState, rows: number): { first: number; lines: Line[] } {
  const first = Math.max(0, state.cursor.row + 1 - rows, state.lines.length - rows);
  return { first, lines: state.lines.slice(first, first + rows) };
}

const players = new WeakMap<Cast, CastPlayer>();

/** The shared incremental player for a parsed cast (kept across component remounts). */
export function castPlayer(cast: Cast): CastPlayer {
  let player = players.get(cast);
  if (!player) {
    player = new CastPlayer(cast);
    players.set(cast, player);
  }
  return player;
}

interface Cell extends Style {
  ch: string;
}

const DEFAULT_STYLE: Style = { bold: false, fg: null };
const ESC = '\x1b';

/**
 * A line-oriented terminal screen fed output in chunks. An escape sequence split across chunks
 * is held back until it completes, exactly as if the chunks had arrived joined.
 */
class Screen {
  private readonly rows: Cell[][] = [[]];
  private row = 0;
  private col = 0;
  private style: Style = { ...DEFAULT_STYLE };
  /** The start of an escape sequence whose end has not arrived yet. */
  private pending = '';
  /** Styled spans per row, rebuilt only for rows written since the last snapshot. */
  private readonly spans: Line[] = [];
  private readonly dirty = new Set<number>([0]);

  constructor(private readonly width: number) {}

  private current(): Cell[] {
    this.dirty.add(this.row);
    return (this.rows[this.row] ??= []);
  }

  private newline(): void {
    this.row += 1;
    this.col = 0;
    this.current();
  }

  write(data: string): void {
    const chars = Array.from(this.pending + data);
    this.pending = '';
    for (let i = 0; i < chars.length; i += 1) {
      const ch = chars[i]!;
      if (ch === ESC) {
        const kind = chars[i + 1];
        if (kind === undefined) {
          this.pending = ESC;
          return;
        }
        if (kind === '[') {
          let end = i + 2;
          while (end < chars.length && !isCsiFinal(chars[end]!)) end += 1;
          if (end >= chars.length) {
            this.pending = chars.slice(i).join('');
            return;
          }
          const params = chars.slice(i + 2, end).join('');
          const final = chars[end];
          if (final === 'm' && !params.startsWith('?')) this.style = applySgr(this.style, params);
          if (final === 'K') eraseInLine(this.current(), this.col, params);
          i = end;
        } else if (kind === ']') {
          let end = i + 2;
          while (end < chars.length && chars[end] !== '\x07' && !(chars[end] === ESC && chars[end + 1] === '\\')) {
            end += 1;
          }
          if (end >= chars.length) {
            this.pending = chars.slice(i).join('');
            return;
          }
          i = chars[end] === ESC ? end + 1 : end;
        } else {
          i += 1;
        }
        continue;
      }
      if (ch === '\r') this.col = 0;
      else if (ch === '\n') this.newline();
      else if (ch === '\b') this.col = Math.max(0, this.col - 1);
      else if (ch === '\t') this.col = Math.min(this.width - 1, (Math.floor(this.col / 8) + 1) * 8);
      else if (ch < ' ' || ch === '\x7f') continue;
      else {
        if (this.col >= this.width) this.newline();
        const line = this.current();
        while (line.length < this.col) line.push({ ch: ' ', ...DEFAULT_STYLE });
        line[this.col] = { ch, ...this.style };
        this.col += 1;
      }
    }
  }

  /** The visible state; earlier snapshots are never mutated by later writes. */
  snapshot(): CastState {
    for (const index of this.dirty) this.spans[index] = toSpans(this.rows[index] ?? []);
    this.dirty.clear();
    let length = this.rows.length;
    while (length > 0 && this.rows[length - 1]!.length === 0) length -= 1;
    return { lines: this.spans.slice(0, length), cursor: { row: this.row, col: this.col } };
  }
}

function isCsiFinal(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return code >= 0x40 && code <= 0x7e;
}

function eraseInLine(line: Cell[], col: number, params: string): void {
  const mode = params === '' ? 0 : Number(params);
  if (mode === 0) line.length = Math.min(line.length, col);
  if (mode === 2) line.length = 0;
}

function applySgr(style: Style, params: string): Style {
  const codes = params === '' ? [0] : params.split(';').map((p) => (p === '' ? 0 : Number(p)));
  let next = { ...style };
  for (let k = 0; k < codes.length; k += 1) {
    const code = codes[k]!;
    if (code === 0) next = { ...DEFAULT_STYLE };
    else if (code === 1) next.bold = true;
    else if (code === 22) next.bold = false;
    else if (code >= 30 && code <= 37) next.fg = code - 30;
    else if (code >= 90 && code <= 97) next.fg = code - 90 + 8;
    else if (code === 39) next.fg = null;
    else if (code === 38 || code === 48) {
      // Extended colour: 5;n (256-colour) or 2;r;g;b (truecolor, ignored). Background is ignored.
      const mode = codes[k + 1];
      if (mode === 5) {
        if (code === 38) next.fg = codes[k + 2] ?? null;
        k += 2;
      } else if (mode === 2) {
        k += 4;
      }
    }
  }
  return next;
}

function toSpans(cells: Cell[]): Line {
  const spans: Span[] = [];
  for (const cell of cells) {
    const last = spans.at(-1);
    if (last && last.bold === cell.bold && last.fg === cell.fg) last.text += cell.ch;
    else spans.push({ text: cell.ch, bold: cell.bold, fg: cell.fg });
  }
  return spans;
}
