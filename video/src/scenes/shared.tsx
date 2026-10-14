import type React from 'react';
import { AbsoluteFill } from 'remotion';
import type { MediaScene, NarrationScene } from '../data';
import { alpha, theme } from '../theme';

export interface SceneProps {
  scene: NarrationScene;
  media: MediaScene;
  /** media.json `hashes`: path under `public/` of the captured proposal hashes. */
  hashesFile?: string | undefined;
}

export interface SceneDef {
  /** Short label on the timeline rail. */
  beat: string;
  /** False for scenes that set their narration line as on-screen typography. */
  captions: boolean;
  Component: React.FC<SceneProps>;
}

/** Content area of a scene, clear of the lower third, captions and timeline rail. */
export const Stage: React.FC<{ children: React.ReactNode; style?: React.CSSProperties }> = ({ children, style }) => (
  <AbsoluteFill style={{ padding: '56px 72px 230px', display: 'flex', flexDirection: 'row', gap: 28, ...style }}>{children}</AbsoluteFill>
);

/** Reads a required media.json field for a scene, failing loudly instead of rendering a gap. */
export function required<T>(value: T | undefined, field: string, scene: NarrationScene): T {
  if (value === undefined || (Array.isArray(value) && value.length === 0)) {
    throw new Error(`media.json scene "${scene.id}" needs "${field}"`);
  }
  return value;
}

export const sceneBackground: React.CSSProperties = {
  background: `radial-gradient(ellipse at 20% 0%, ${alpha(theme.color.accent, 0.08)}, transparent 55%), ${theme.color.frame}`,
};
