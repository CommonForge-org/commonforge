import type React from 'react';
import { Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { theme } from '../theme';

interface Pane {
  label: string;
  /** Optional screenshot under `public/` shown in the pane. */
  shot?: string;
}

interface ProposalHashProps {
  hash: string;
  left: Pane;
  right: Pane;
  /** Seconds after mount when the connecting highlight draws between the two hashes. */
  connectAtSec?: number;
}

const HashChip: React.FC<{ hash: string; lit: number }> = ({ hash, lit }) => (
  <div
    style={{
      position: 'relative',
      zIndex: 2,
      alignSelf: 'center',
      padding: '12px 22px',
      borderRadius: 10,
      background: theme.color.frame,
      border: `2px solid ${lit > 0 ? theme.color.accent : theme.color.hairline}`,
      boxShadow: `0 0 ${28 * lit}px ${theme.color.accent}`,
      color: theme.color.accent,
      fontFamily: theme.font.mono,
      fontSize: 30,
      letterSpacing: 1,
    }}
  >
    {hash}
  </div>
);

/** Split screen showing the identical proposal hash in two views, joined by a highlight. */
export const ProposalHash: React.FC<ProposalHashProps> = ({ hash, left, right, connectAtSec = 2 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const draw = interpolate(frame, [connectAtSec * fps, connectAtSec * fps + 24], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const lit = spring({ frame: frame - connectAtSec * fps - 24, fps, config: { damping: 12 } });

  const pane = (p: Pane) => (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        gap: 20,
        padding: 24,
        borderRadius: theme.radius,
        background: theme.color.panel,
        border: `1px solid ${theme.color.hairline}`,
      }}
    >
      <div style={{ color: theme.color.muted, fontFamily: theme.font.sans, fontSize: 26, fontWeight: 600 }}>{p.label}</div>
      <div style={{ flex: 1, borderRadius: 10, overflow: 'hidden', background: theme.color.frame }}>
        {p.shot ? <Img src={staticFile(p.shot)} style={{ width: '100%', height: '100%', objectFit: 'contain' }} /> : null}
      </div>
      <HashChip hash={hash} lit={lit} />
    </div>
  );

  return (
    <div style={{ position: 'relative', display: 'flex', gap: 120, width: '100%', height: '100%' }}>
      {pane(left)}
      {pane(right)}
      {/* Drawn between the two chip centres; the chips (z-index 2) cover its ends. */}
      <div
        style={{
          position: 'absolute',
          zIndex: 1,
          left: '25%',
          width: '50%',
          bottom: 54,
          height: 4,
          background: theme.color.accent,
          boxShadow: `0 0 12px ${theme.color.accent}`,
          transform: `scaleX(${draw})`,
          transformOrigin: 'left center',
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: '50%',
          zIndex: 3,
          bottom: 72,
          transform: `translateX(-50%) scale(${0.8 + 0.2 * lit})`,
          opacity: lit,
          padding: '6px 16px',
          borderRadius: 999,
          background: theme.color.accent,
          color: theme.color.frame,
          fontFamily: theme.font.sans,
          fontWeight: 700,
          fontSize: 24,
        }}
      >
        identical
      </div>
    </div>
  );
};
