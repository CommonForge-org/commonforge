import type React from 'react';
import { Freeze, Img, OffthreadVideo, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import type { Callout as CalloutData } from '../data';
import { badgeLabel, playSeconds, resolveWindow, type ResolvedWindow } from '../lib/media-window';
import { theme } from '../theme';
import { Callout } from './Callout';
import { SpeedBadge } from './SpeedBadge';

const IMAGE = /\.(png|jpe?g|webp)$/i;

interface BrowserProps {
  /** Clip or screenshot path under `public/`. */
  src: string;
  /**
   * Clips: the source window (from, to, speed). After `to` the last frame is held; speed > 1 is
   * time compression and shows a speed badge for the whole clip. Default: the whole clip at 1×.
   */
  play?: ResolvedWindow;
  /** Callout `t` is seconds after this Browser appears on screen. */
  callouts?: CalloutData[];
  /** Text for the address bar. */
  url?: string;
  style?: React.CSSProperties;
}

/** Browser window frame around a captured clip or screenshot, with callout layer. */
export const Browser: React.FC<BrowserProps> = ({ src, play = resolveWindow(undefined), callouts = [], url, style }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const badge = IMAGE.test(src) ? null : badgeLabel(play.speed);
  const video = (
    <OffthreadVideo
      src={staticFile(src)}
      trimBefore={Math.round(play.from * fps)}
      playbackRate={play.speed}
      muted
      style={{ width: '100%', height: '100%', objectFit: 'contain' }}
    />
  );
  // hold the window's last frame once it has played to `to`
  const playFrames = Math.floor(playSeconds(play) * fps);
  const held = frame >= playFrames ? <Freeze frame={Math.max(0, playFrames - 1)}>{video}</Freeze> : video;

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
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, height: 48, padding: '0 18px', flexShrink: 0 }}>
      {theme.windowControls.map((c) => (
        <div key={c} style={{ width: 14, height: 14, borderRadius: 7, background: c }} />
      ))}
      <div
        style={{
          flex: 1,
          marginLeft: 16,
          padding: '6px 16px',
          borderRadius: 8,
          background: theme.color.frame,
          color: theme.color.muted,
          fontFamily: theme.font.sans,
          fontSize: 20,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {url ?? src}
      </div>
    </div>
    {/* Media box is held at 16:9 so callout fractions map onto the captured frame, not letterboxing. */}
    <div
      style={{
        flex: 1,
        containerType: 'size',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: theme.color.frame,
      }}
    >
      <div style={{ position: 'relative', width: 'min(100cqw, calc(100cqh * 16 / 9))', aspectRatio: '16 / 9' }}>
        {IMAGE.test(src) ? (
          <Img src={staticFile(src)} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
        ) : (
          held
        )}
        {callouts.map((callout) => (
          <Callout key={`${callout.t}-${callout.label}`} callout={callout} />
        ))}
        {badge ? <SpeedBadge label={badge} /> : null}
      </div>
    </div>
  </div>
  );
};
