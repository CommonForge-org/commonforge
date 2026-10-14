import { describe, expect, it } from 'vitest';
import { CastPlayer, castPlayer, castStateAt, parseCast, visibleRows, type Cast } from './asciinema';

const castText = [
  JSON.stringify({ version: 2, width: 80, height: 24, title: 'demo' }),
  JSON.stringify([0.5, 'o', '$ git clone canonical\r\n']),
  JSON.stringify([1.0, 'o', '\x1b[31mdenied\x1b[0m']),
  JSON.stringify([1.5, 'i', 'ignored input']),
].join('\n');

describe('parseCast', () => {
  it('reads the v2 header and events', () => {
    const cast = parseCast(castText);
    expect(cast.header).toMatchObject({ version: 2, width: 80, height: 24, title: 'demo' });
    expect(cast.events).toHaveLength(3);
    expect(cast.events[0]).toEqual({ time: 0.5, type: 'o', data: '$ git clone canonical\r\n' });
  });

  it('rejects events that go back in time', () => {
    const text = [JSON.stringify({ version: 2, width: 80, height: 24 }), '[1.0,"o","a"]', '[0.5,"o","b"]'].join('\n');
    expect(() => parseCast(text)).toThrow(/event 2 goes back in time/);
  });

  it('rejects casts that are not version 2', () => {
    expect(() => parseCast(JSON.stringify({ version: 1, width: 80, height: 24 }))).toThrow(/version 2/);
  });
});

describe('castStateAt', () => {
  const cast = parseCast(castText);

  it('is empty before the first event', () => {
    expect(castStateAt(cast, 0)).toEqual({ lines: [], cursor: { row: 0, col: 0 } });
  });

  it('shows two lines after two output events', () => {
    const state = castStateAt(cast, 1200);
    expect(state.lines.map((line) => line.map((span) => span.text).join(''))).toEqual([
      '$ git clone canonical',
      'denied',
    ]);
    expect(state.cursor).toEqual({ row: 1, col: 6 });
  });

  it('applies SGR 31 as ANSI red (palette index 1) and resets on SGR 0', () => {
    const [, second] = castStateAt(cast, 1200).lines;
    expect(second).toEqual([{ text: 'denied', bold: false, fg: 1 }]);
  });

  it('handles bold, bright and 256-colour foregrounds', () => {
    const c = parseCast(
      [
        JSON.stringify({ version: 2, width: 80, height: 24 }),
        JSON.stringify([0.1, 'o', '\x1b[1;92mok\x1b[22;38;5;208m!\x1b[39mz']),
      ].join('\n'),
    );
    expect(castStateAt(c, 200).lines[0]).toEqual([
      { text: 'ok', bold: true, fg: 10 },
      { text: '!', bold: false, fg: 208 },
      { text: 'z', bold: false, fg: null },
    ]);
  });

  it('ignores unknown SGR codes and non-SGR escape sequences', () => {
    const c = parseCast(
      [
        JSON.stringify({ version: 2, width: 80, height: 24 }),
        JSON.stringify([0.1, 'o', '\x1b]0;window title\x07\x1b[4;53mplain\x1b[?25l']),
      ].join('\n'),
    );
    expect(castStateAt(c, 200).lines).toEqual([[{ text: 'plain', bold: false, fg: null }]]);
  });

  it('overwrites from column 0 after a carriage return', () => {
    const c = parseCast(
      [
        JSON.stringify({ version: 2, width: 80, height: 24 }),
        JSON.stringify([0.1, 'o', 'loading...\r']),
        JSON.stringify([0.2, 'o', 'done\x1b[K']),
      ].join('\n'),
    );
    expect(castStateAt(c, 300).lines).toEqual([[{ text: 'done', bold: false, fg: null }]]);
  });
});

/** Deterministic PRNG (mulberry32) so a failing seed can be replayed. */
function random(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A cast whose output is cut at arbitrary points, so escape sequences (SGR, erase, OSC titles)
 * and lines are split across events, with some input and marker events mixed in.
 */
function choppedCast(rand: () => number): Cast {
  const pieces = [
    '$ \x1b[1mcforge\x1b[0m status --json\r\n',
    '\x1b]0;window title\x07loading...\r\x1b[Kdone \x1b[1;32mok\x1b[0m\r\n',
    'agent-1: \x1b[38;5;208mgate FAIL\x1b[39m contract quote\r\n',
    'progress 10%\b\b\b20%\tTAB\r\n',
    'a long line '.repeat(12) + '\r\n',
    '\x1b]2;title with ST\x1b\\after OSC\x1b[2K\rerased\r\n',
    'naïve ünïcode — ✓ done\r\n',
  ];
  const output = Array.from({ length: 30 }, () => pieces[Math.floor(rand() * pieces.length)]!).join('');
  const chars = Array.from(output);
  const events: Cast['events'] = [];
  let time = 0;
  for (let i = 0; i < chars.length; ) {
    const size = 1 + Math.floor(rand() * 12);
    time += Math.round(rand() * 300) / 1000;
    events.push({ time, type: 'o', data: chars.slice(i, i + size).join('') });
    if (rand() < 0.1) events.push({ time, type: rand() < 0.5 ? 'i' : 'm', data: 'ignored' });
    i += size;
  }
  return { header: { version: 2, width: 60, height: 12 }, events };
}

describe('CastPlayer (incremental replay)', () => {
  it.each([1, 2, 3, 4, 5])('matches the full replay at random seek points (seed %i)', (seed) => {
    const rand = random(seed);
    const cast = choppedCast(rand);
    const end = cast.events.at(-1)!.time * 1000;
    const player = new CastPlayer(cast);
    // mostly forward like a render, with occasional jumps back like scrubbing in the Studio
    let t = 0;
    for (let step = 0; step < 200; step += 1) {
      t = rand() < 0.1 ? rand() * end : Math.min(end + 500, t + rand() * 400);
      expect(player.stateAt(t), `t=${t}`).toEqual(castStateAt(cast, t));
    }
  });

  it('matches at every event boundary, forward', () => {
    const cast = choppedCast(random(42));
    const player = new CastPlayer(cast);
    for (const event of cast.events) {
      const t = event.time * 1000;
      expect(player.stateAt(t)).toEqual(castStateAt(cast, t));
    }
  });

  it('feeds only the events since the previous position and keeps earlier states intact', () => {
    const cast = parseCast(castText);
    const player = new CastPlayer(cast);
    const first = player.stateAt(600);
    const snapshot = structuredClone(first);
    expect(player.countAt(600)).toBe(1);
    expect(player.stateAt(700)).toBe(first); // no new event: same object, no work
    player.stateAt(1200);
    expect(first).toEqual(snapshot);
  });

  it('shares one player per parsed cast', () => {
    const cast = parseCast(castText);
    expect(castPlayer(cast)).toBe(castPlayer(cast));
  });
});

describe('visibleRows (pane row window)', () => {
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}\r\n`).join('');
  const state = castStateAt({ header: { version: 2, width: 80, height: 24 }, events: [{ time: 0, type: 'o', data: lines }] }, 1000);

  it('shows the newest rows of a pane shorter than the cast, the cursor row at the bottom', () => {
    const { first, lines: shown } = visibleRows(state, 8);
    expect(first).toBe(13);
    expect(shown.map((l) => l.map((s) => s.text).join(''))).toEqual(['line 14', 'line 15', 'line 16', 'line 17', 'line 18', 'line 19', 'line 20']);
  });

  it('shows everything from the top while the output fits', () => {
    expect(visibleRows(state, 24).first).toBe(0);
  });
});
