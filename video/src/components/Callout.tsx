import type React from 'react';
import { spring, useCurrentFrame, useVideoConfig } from 'remotion';
import type { Callout as CalloutData } from '../data';
import { theme } from '../theme';

/**
 * Highlight box with a label, springing in at `callout.t` seconds. Position and
 * size are fractions of the parent box (the media area of a Browser frame).
 */
export const Callout: React.FC<{ callout: CalloutData }> = ({ callout }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const start = Math.round(callout.t * fps);
  if (frame < start) return null;
  const pop = spring({ frame: frame - start, fps, config: { damping: 14, stiffness: 140 } });
  const labelAbove = callout.y > 0.12;

  return (
    <div
      style={{
        position: 'absolute',
        left: `${callout.x * 100}%`,
        top: `${callout.y * 100}%`,
        width: `${callout.w * 100}%`,
        height: `${callout.h * 100}%`,
        border: `4px solid ${theme.color.accent}`,
        borderRadius: 10,
        boxShadow: `0 0 24px ${theme.color.accent}`,
        opacity: pop,
        transform: `scale(${0.85 + 0.15 * pop})`,
      }}
    >
      <div
        style={{
          position: 'absolute',
          left: -4,
          [labelAbove ? 'bottom' : 'top']: 'calc(100% + 10px)',
          padding: '6px 14px',
          borderRadius: 8,
          background: theme.color.accent,
          color: theme.color.frame,
          fontFamily: theme.font.sans,
          fontWeight: 700,
          fontSize: 26,
          whiteSpace: 'nowrap',
        }}
      >
        {callout.label}
      </div>
    </div>
  );
};
