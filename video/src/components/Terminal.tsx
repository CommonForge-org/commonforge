import type React from 'react';
import { useCurrentFrame, useVideoConfig } from 'remotion';
import type { Callout as CalloutData } from '../data';
import { castPlayer, visibleRows, type Cast } from '../lib/asciinema';
import { theme } from '../theme';
import { Callout } from './Callout';
import { SpeedBadge } from './SpeedBadge';

/** Hex colour for an ANSI 256-colour palette index. */
export function ansiColor(index: number): string {
  if (index < 16) return theme.ansi16[index] ?? theme.color.text;
  if (index >= 232) {
    const level = 8 + (index - 232) * 10;
    return `rgb(${level}, ${level}, ${level})`;
  }
  const cube = index - 16;
  const step = (n: number) => (n === 0 ? 0 : 55 + n * 40);
  return `rgb(${step(Math.floor(cube / 36))}, ${step(Math.floor(cube / 6) % 6)}, ${step(cube % 6)})`;
}

interface TerminalProps {
  cast: Cast;
  /** Playback position in the cast, in milliseconds. */
  tMs: number;
  title?: string;
  /** Speed badge text (time compression or capped idle gaps); shown for the pane's whole duration. */
  badge?: string | null;
  /** Wall-clock time of the shown output (scene 4 lanes), a small label in the title bar. */
  clock?: string;
  fontSize?: number;
  /** Visible rows (the newest ones); default the cast's height. For panes shorter than the cast. */
  rows?: number;
  /**
   * Highlights over the pane's text area: `x y w h` are fractions of that area and `t` is seconds
   * after the pane appears (the enclosing Sequence's start).
   */
  callouts?: CalloutData[];
  style?: React.CSSProperties;
}

/** A generated placeholder cast (scripts/make-placeholders.ts titles them PLACEHOLDER…). */
function isPlaceholder(cast: Cast): boolean {
  return cast.header.title?.startsWith('PLACEHOLDER') ?? false;
}

/** Terminal pane replaying an asciinema cast at `tMs`, with a blinking block cursor. */
export const Terminal: React.FC<TerminalProps> = ({ cast, tMs, title, badge, clock, fontSize = 22, rows: paneRows, callouts = [], style }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  // Incremental replay: only the output events since the previous frame are applied.
  const state = castPlayer(cast).stateAt(tMs);
  const { first: firstVisible, lines: visible } = visibleRows(state, paneRows ?? cast.header.height);
  const cursorOn = Math.floor(((frame / fps) * 1000) / 530) % 2 === 0;
  const lineHeight = 1.35;

  return (
    <div
      style={{
        minWidth: 0,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        borderRadius: theme.radius,
        overflow: 'hidden',
        background: theme.color.panel,
        border: `1px solid ${theme.color.hairline}`,
        boxShadow: theme.shadow.window,
        ...style,
      }}
    >
      <div
        style={{
          position: 'relative',
          height: 44,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          padding: '0 18px',
          color: theme.color.muted,
          fontFamily: theme.font.sans,
          fontSize: 19,
          borderBottom: `1px solid ${theme.color.hairline}`,
        }}
      >
        {title ?? cast.header.title ?? 'terminal'}
        {clock ? (
          <span style={{ marginLeft: 14, fontFamily: theme.font.mono, fontSize: 15, color: theme.color.muted }}>{clock}</span>
        ) : null}
        {badge ? <SpeedBadge label={badge} style={{ top: 6, right: 10, fontSize: 18, padding: '3px 10px' }} /> : null}
      </div>
      <div
        style={{
          position: 'relative',
          flex: 1,
          overflow: 'hidden',
          padding: '14px 18px',
          fontFamily: theme.font.mono,
          fontSize,
          lineHeight,
          color: theme.color.text,
          whiteSpace: 'pre',
        }}
      >
        {visible.map((line, row) => (
          <div key={row} style={{ minHeight: `${lineHeight}em` }}>
            {line.map((span, i) => (
              <span
                key={i}
                style={{
                  fontWeight: span.bold ? 700 : 400,
                  color: span.fg === null ? undefined : ansiColor(span.fg),
                }}
              >
                {span.text}
              </span>
            ))}
          </div>
        ))}
        {cursorOn ? (
          <div
            style={{
              position: 'absolute',
              left: `calc(18px + ${state.cursor.col}ch)`,
              top: `calc(14px + ${(state.cursor.row - firstVisible) * lineHeight}em)`,
              width: '1ch',
              height: `${lineHeight}em`,
              background: theme.color.accent,
              opacity: 0.85,
            }}
          />
        ) : null}
        {callouts.map((callout) => (
          <Callout key={`${callout.t}-${callout.label}`} callout={callout} />
        ))}
        {isPlaceholder(cast) ? (
          // shown from the first frame, before the cast's own PLACEHOLDER line is replayed
          <div
            style={{
              position: 'absolute',
              right: 14,
              bottom: 12,
              padding: '4px 12px',
              borderRadius: 6,
              background: theme.color.amber,
              color: theme.color.frame,
              fontFamily: theme.font.sans,
              fontWeight: 700,
              fontSize: 18,
              letterSpacing: 1,
            }}
          >
            PLACEHOLDER
          </div>
        ) : null}
      </div>
    </div>
  );
};
