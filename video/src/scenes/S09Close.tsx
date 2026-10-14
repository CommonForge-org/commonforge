import type React from 'react';
import { AbsoluteFill, Img, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { BRAND_LOGO, theme } from '../theme';
import { sceneBackground, type SceneDef, type SceneProps } from './shared';

/** Task 5 benchmark results (docs/DEMO-SCRIPT.md, "Scale card"). */
const STATS = [
  { value: '700', label: 'task lifecycles' },
  { value: '0', label: 'throttled requests' },
  { value: '~24%', label: 'of the control-plane limit at concurrency 100' },
];
const REPO_URL = 'github.com/CommonForge-org/commonforge';

const Close: React.FC<SceneProps> = ({ scene }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const fadeIn = (delay: number) => spring({ frame: frame - delay, fps, config: { damping: 18 } });

  return (
    <AbsoluteFill
      style={{
        ...sceneBackground,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 44,
        padding: '0 160px 120px',
        fontFamily: theme.font.sans,
        color: theme.color.text,
      }}
    >
      <Img src={staticFile(BRAND_LOGO.src)} style={{ width: 600, height: 600 / BRAND_LOGO.aspect, opacity: fadeIn(0) }} />
      <div style={{ display: 'flex', gap: 40 }}>
        {STATS.map((stat, i) => {
          const pop = fadeIn(i * 8);
          return (
            <div
              key={stat.label}
              style={{
                width: 440,
                padding: '32px 36px',
                borderRadius: theme.radius,
                background: theme.color.panel,
                border: `1px solid ${theme.color.hairline}`,
                opacity: pop,
                transform: `translateY(${(1 - pop) * 24}px)`,
              }}
            >
              <div style={{ fontSize: 88, fontWeight: 700, color: theme.color.accent }}>{stat.value}</div>
              <div style={{ fontSize: 28, color: theme.color.muted, marginTop: 8 }}>{stat.label}</div>
            </div>
          );
        })}
      </div>
      <div style={{ fontSize: 22, color: theme.color.muted, opacity: fadeIn(30) }}>Control-plane load benchmark</div>
      <div style={{ maxWidth: 1400, fontSize: 44, lineHeight: 1.35, textAlign: 'center', opacity: fadeIn(45) }}>{scene.text}</div>
      <div style={{ fontFamily: theme.font.mono, fontSize: 36, color: theme.color.amber, opacity: fadeIn(60) }}>{REPO_URL}</div>
    </AbsoluteFill>
  );
};

export const S09Close: SceneDef = { beat: 'Close', captions: false, Component: Close };
