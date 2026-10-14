import type React from 'react';
import { theme } from '../theme';

/**
 * Labels time-compressed footage ("8× speed", "idle > 2 s cut"). Rendered for the pane's whole
 * duration whenever its speed is above 1 or its idle gaps are capped (see `badgeLabel`).
 */
export const SpeedBadge: React.FC<{ label: string; style?: React.CSSProperties }> = ({ label, style }) => (
  <div
    style={{
      position: 'absolute',
      top: 16,
      right: 16,
      padding: '6px 14px',
      borderRadius: 999,
      background: theme.color.amber,
      color: theme.color.frame,
      fontFamily: theme.font.sans,
      fontWeight: 700,
      fontSize: 24,
      letterSpacing: 0.5,
      boxShadow: theme.shadow.chip,
      zIndex: 10,
      ...style,
    }}
  >
    {label}
  </div>
);
