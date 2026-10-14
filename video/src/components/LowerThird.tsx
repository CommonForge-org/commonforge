import type React from 'react';
import { Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { alpha, BRAND_ICON, theme } from '../theme';

const HOLD_SEC = 5;

/** Beat title that slides in at the start of a scene and fades out after a few seconds. */
export const LowerThird: React.FC<{ title: string; subtitle?: string }> = ({ title, subtitle }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame, fps, config: { damping: 18 } });
  const exit = interpolate(frame, [HOLD_SEC * fps, HOLD_SEC * fps + 15], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  if (exit === 0) return null;

  return (
    <div
      style={{
        position: 'absolute',
        left: 72,
        bottom: 250,
        padding: '18px 28px',
        borderLeft: `6px solid ${theme.color.accent}`,
        borderRadius: 8,
        background: alpha(theme.color.panel, 0.92),
        fontFamily: theme.font.sans,
        opacity: enter * exit,
        transform: `translateX(${(1 - enter) * -60}px)`,
        zIndex: 20,
      }}
    >
      <Img src={staticFile(BRAND_ICON.src)} style={{ display: 'block', width: 30, height: 30, marginBottom: 10 }} />
      <div style={{ color: theme.color.text, fontSize: 40, fontWeight: 700 }}>{title}</div>
      {subtitle ? <div style={{ color: theme.color.muted, fontSize: 24, marginTop: 6 }}>{subtitle}</div> : null}
    </div>
  );
};
