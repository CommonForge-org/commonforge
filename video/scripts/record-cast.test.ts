import { describe, expect, it } from 'vitest';
import { parseCast } from '../src/lib/asciinema';
import { recordCast } from './record-cast';

describe('recordCast', () => {
  it('records stdout and stderr with real relative timings as an asciinema v2 cast', async () => {
    const { cast, code } = await recordCast({
      command: 'sh',
      args: ['-c', 'echo one; sleep 0.3; echo two >&2; echo token cfs_abcdef123456'],
      width: 90,
      height: 20,
      title: 'test',
      echo: false,
    });
    expect(code).toBe(0);
    const parsed = parseCast(cast);
    expect(parsed.header).toMatchObject({ version: 2, width: 90, height: 20, title: 'test' });
    const text = parsed.events.map((e) => e.data).join('');
    expect(text).toBe('one\r\ntwo\r\ntoken cfs_…redacted\r\n');
    const two = parsed.events.find((e) => e.data.includes('two'))!;
    expect(two.time).toBeGreaterThanOrEqual(0.25);
    expect(parsed.events.map((e) => e.time)).toEqual([...parsed.events.map((e) => e.time)].sort((a, b) => a - b));
  });

  it('reports the command exit status', async () => {
    const { code } = await recordCast({ command: 'sh', args: ['-c', 'exit 3'], width: 80, height: 20, echo: false });
    expect(code).toBe(3);
  });
});
