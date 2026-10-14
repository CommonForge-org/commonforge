import type React from 'react';
import { AbsoluteFill, Img, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { BRAND_LOGO, theme } from '../theme';
import { sceneBackground, type SceneDef, type SceneProps } from './shared';

const Pill: React.FC<{ label: string; delay: number }> = ({ label, delay }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pop = spring({ frame: frame - delay, fps, config: { damping: 14 } });
  return (
    <div
      style={{
        padding: '12px 26px',
        borderRadius: 999,
        border: `2px solid ${theme.color.accent}`,
        color: theme.color.accent,
        fontSize: 30,
        fontWeight: 600,
        opacity: pop,
        transform: `translateY(${(1 - pop) * 20}px)`,
      }}
    >
      {label}
    </div>
  );
};

const Title: React.FC<SceneProps> = ({ scene }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const mark = spring({ frame, fps, config: { damping: 16 } });
  const line = spring({ frame: frame - 18, fps, config: { damping: 20 } });

  return (
    <AbsoluteFill
      style={{
        ...sceneBackground,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 48,
        padding: '0 200px 120px',
        fontFamily: theme.font.sans,
        color: theme.color.text,
      }}
    >
      <Img
        src={staticFile(BRAND_LOGO.src)}
        style={{ width: 1000, height: 1000 / BRAND_LOGO.aspect, opacity: mark, transform: `scale(${0.9 + 0.1 * mark})` }}
      />
      <div
        style={{
          maxWidth: 1400,
          fontSize: 42,
          lineHeight: 1.35,
          textAlign: 'center',
          color: theme.color.text,
          opacity: line,
          transform: `translateY(${(1 - line) * 24}px)`,
        }}
      >
        {scene.text}
      </div>
      <div style={{ display: 'flex', gap: 24 }}>
        <Pill label="Cloudflare Workers" delay={40} />
        <Pill label="Artifacts" delay={50} />
      </div>
    </AbsoluteFill>
  );
};

export const S00Title: SceneDef = { beat: 'Title', captions: false, Component: Title };
