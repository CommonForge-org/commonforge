import type React from 'react';
import { AbsoluteFill, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { Browser } from '../components/Browser';
import { LowerThird } from '../components/LowerThird';
import { resolveWindow } from '../lib/media-window';
import { shortCode } from '../lib/review-code';
import { useHashes } from '../lib/useHashes';
import { alpha, theme } from '../theme';
import { required, sceneBackground, Stage, type SceneDef, type SceneProps } from './shared';

/** When the repaired candidate's new hash replaces the old one. */
const NEW_HASH_SEC = 8;

const HashSwap: React.FC<{ before: string; after: string }> = ({ before, after }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const swap = spring({ frame: frame - NEW_HASH_SEC * fps, fps, config: { damping: 14 } });
  return (
    <div
      style={{
        position: 'absolute',
        top: 80,
        right: 100,
        padding: '16px 24px',
        borderRadius: 12,
        background: alpha(theme.color.panel, 0.94),
        border: `1px solid ${theme.color.hairline}`,
        fontFamily: theme.font.mono,
        fontSize: 26,
        zIndex: 15,
      }}
    >
      <div style={{ color: theme.color.muted, fontFamily: theme.font.sans, fontSize: 20, marginBottom: 8 }}>review code</div>
      <div style={{ color: theme.color.muted, textDecoration: swap > 0.5 ? 'line-through' : 'none' }}>{shortCode(before)}</div>
      <div style={{ color: theme.color.accent, opacity: swap, transform: `translateY(${(1 - swap) * 16}px)`, marginTop: 6 }}>
        {shortCode(after)}
      </div>
    </div>
  );
};

const RepairPreview: React.FC<SceneProps> = ({ scene, media, hashesFile }) => {
  const clip = required(media.clip, 'clip', scene);
  const hashes = useHashes(hashesFile);
  return (
  <AbsoluteFill style={sceneBackground}>
    <Stage>
      <Browser
        src={clip.src}
        play={resolveWindow(clip, media.speed ?? 1)}
        callouts={media.callouts}
        url="Repair, re-integrate, open private preview"
        style={{ flex: 1 }}
      />
    </Stage>
    {hashes ? <HashSwap before={hashes.blocked?.hash ?? 'NOT CAPTURED'} after={hashes.fixed?.hash ?? 'NOT CAPTURED'} /> : null}
    <LowerThird title="Repair and private preview" subtitle="New immutable identity; isolated origin" />
  </AbsoluteFill>
  );
};

export const S06RepairPreview: SceneDef = { beat: 'Repair + preview', captions: true, Component: RepairPreview };
