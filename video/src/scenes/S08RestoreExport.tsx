import type React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { Browser } from '../components/Browser';
import { CastPane } from '../components/CastPane';
import { LowerThird } from '../components/LowerThird';
import { useCasts } from '../lib/useCasts';
import { sceneSlots } from './layout';
import { required, sceneBackground, Stage, type SceneDef, type SceneProps } from './shared';

/** Two stacked panes share the column height, so each shows its last rows only. */
const PANE_ROWS = 14;

/**
 * Scene 8: restore in the UI (clip), then two terminal panes: `casts[0]` publishes the restored
 * version through the release gate (the UI has no restore-then-publish path), `casts[1]` exports
 * and verifies the git bundles.
 */
const RestoreExport: React.FC<SceneProps> = ({ scene, media }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  required(media.clip, 'clip', scene);
  const refs = required(media.casts, 'casts', scene);
  const [release, verify] = useCasts(refs.slice(0, 2).map((c) => c.src));
  const slots = sceneSlots(scene.id, media, durationInFrames / fps);
  const clip = slots.find((s) => s.kind === 'clip')!;
  const [releaseSlot, exportSlot] = slots.filter((s) => s.kind === 'cast');

  const pane = (slot: (typeof slots)[number] | undefined) => {
    const from = Math.round((slot?.startSec ?? 0) * fps);
    return { from, opacity: interpolate(frame, [from, from + 15], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }) };
  };
  const releasePane = pane(releaseSlot);
  const exportPane = pane(exportSlot);

  return (
    <AbsoluteFill style={sceneBackground}>
      <Stage>
        <Browser src={clip.src} play={clip.window} callouts={media.callouts} url="Versions: restore, then Export" style={{ flex: 3 }} />
        <div style={{ flex: 2, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 18 }}>
          {release && releaseSlot ? (
            <CastPane
              cast={release}
              play={releaseSlot.window!}
              maxIdleGapSec={releaseSlot.maxIdleGapSec}
              startFrame={releasePane.from}
              title="Release the restored version"
              fontSize={15}
              rows={PANE_ROWS}
              style={{ flex: 1, opacity: releasePane.opacity }}
            />
          ) : null}
          {verify && exportSlot ? (
            <CastPane
              cast={verify}
              play={exportSlot.window!}
              maxIdleGapSec={exportSlot.maxIdleGapSec}
              startFrame={exportPane.from}
              title="git bundle verify"
              fontSize={15}
              rows={PANE_ROWS}
              style={{ flex: 1, opacity: exportPane.opacity }}
            />
          ) : null}
        </div>
      </Stage>
      <LowerThird title="Restore and export" subtitle="Forward version; plain git bundles" />
    </AbsoluteFill>
  );
};

export const S08RestoreExport: SceneDef = { beat: 'Restore + export', captions: true, Component: RestoreExport };
