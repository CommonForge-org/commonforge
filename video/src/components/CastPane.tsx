import type React from 'react';
import { useCurrentFrame, useVideoConfig } from 'remotion';
import type { Callout as CalloutData } from '../data';
import type { Cast } from '../lib/asciinema';
import { badgeLabel, wallClock, windowCastCached, type ResolvedWindow } from '../lib/media-window';
import { Terminal } from './Terminal';

interface CastPaneProps {
  cast: Cast;
  /** Source window and speed (media.json, `resolveWindow` / `laneWindow`). */
  play: ResolvedWindow;
  maxIdleGapSec?: number | undefined;
  /** Composition frame (within the scene) at which the pane appears; playback starts there. */
  startFrame?: number;
  /** Label the pane with the wall-clock time of the shown output (header timestamp + source time). */
  showClock?: boolean;
  title?: string;
  fontSize?: number;
  rows?: number;
  callouts?: CalloutData[];
  style?: React.CSSProperties;
}

/** A terminal pane playing a window of a cast: from/to, speed, idle-gap cap, speed badge, clock. */
export const CastPane: React.FC<CastPaneProps> = ({ cast, play, maxIdleGapSec, startFrame = 0, showClock = false, ...terminal }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { cast: windowed, toSourceSec } = windowCastCached(cast, { from: play.from, to: play.to, maxIdleGapSec });
  const t = (Math.max(0, frame - startFrame) / fps) * play.speed;
  const clock = showClock && cast.header.timestamp !== undefined ? wallClock(cast.header.timestamp * 1000 + toSourceSec(t) * 1000) : undefined;
  return (
    <Terminal
      cast={windowed}
      tMs={t * 1000}
      badge={badgeLabel(play.speed, maxIdleGapSec)}
      {...(clock ? { clock } : {})}
      {...terminal}
    />
  );
};
