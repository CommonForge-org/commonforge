import type React from 'react';
import { AbsoluteFill } from 'remotion';
import { Browser } from '../components/Browser';
import { CastPane } from '../components/CastPane';
import { LowerThird } from '../components/LowerThird';
import { resolveWindow } from '../lib/media-window';
import { useCasts } from '../lib/useCasts';
import { laneWindow } from './layout';
import { required, sceneBackground, Stage, type SceneDef, type SceneProps } from './shared';

const AGENT_TITLES = ['Agent A: website + api', 'Agent B: client edition', 'Agent C: assets + requirements'];
/** Three stacked panes share the column, so each shows its newest rows only. */
export const LANE_ROWS = 8;

/**
 * Scene 4: the live lanes (clip) beside one pane per agent. With `castOffsetSec` the panes run in
 * step with the clip (same wall-clock moment, same speed); each pane shows its wall-clock time.
 */
const ThreeAgents: React.FC<SceneProps> = ({ scene, media }) => {
  const clip = required(media.clip, 'clip', scene);
  const refs = required(media.casts, 'casts', scene);
  const casts = useCasts(refs.map((c) => c.src));

  return (
    <AbsoluteFill style={sceneBackground}>
      <Stage>
        <Browser src={clip.src} play={resolveWindow(clip, media.speed ?? 1)} callouts={media.callouts} url="Live lanes" style={{ flex: 58 }} />
        <div style={{ flex: 42, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 18 }}>
          {casts.map((cast, i) =>
            cast ? (
              <CastPane
                key={i}
                cast={cast}
                play={laneWindow(media, refs[i]!)}
                maxIdleGapSec={refs[i]!.maxIdleGapSec}
                showClock
                title={AGENT_TITLES[i] ?? `Agent ${i + 1}`}
                fontSize={16}
                rows={LANE_ROWS}
                style={{ flex: 1 }}
              />
            ) : null,
          )}
        </div>
      </Stage>
      <LowerThird title="Three real agents, concurrently" subtitle="Own forks, short-lived tokens, no shared directory" />
    </AbsoluteFill>
  );
};

export const S04ThreeAgents: SceneDef = { beat: 'Three agents', captions: true, Component: ThreeAgents };
