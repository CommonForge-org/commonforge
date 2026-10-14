import type React from 'react';
import { AbsoluteFill, Sequence, useVideoConfig } from 'remotion';
import { Browser } from '../components/Browser';
import { CastPane } from '../components/CastPane';
import { LowerThird } from '../components/LowerThird';
import { useCasts } from '../lib/useCasts';
import { sceneSlots } from './layout';
import { required, sceneBackground, Stage, type SceneDef, type SceneProps } from './shared';

/**
 * Scene 1: the client's hand-off folder, then the intake dry-run inventory (terminal pane, the
 * scene's callouts sit on it: intake has no screen) beside the resulting project tree (clip).
 */
const Mess: React.FC<SceneProps> = ({ scene, media }) => {
  const { fps, durationInFrames } = useVideoConfig();
  required(media.clip, 'clip', scene);
  const castRef = required(media.casts, 'casts', scene)[0]!;
  const [intake] = useCasts([castRef.src]);
  const slots = sceneSlots(scene.id, media, durationInFrames / fps);
  const folder = slots.find((s) => s.kind === 'shot');
  const clip = slots.find((s) => s.kind === 'clip')!;
  const cast = slots.find((s) => s.kind === 'cast')!;
  const paneFrom = Math.round(clip.startSec * fps);

  return (
    <AbsoluteFill style={sceneBackground}>
      {folder ? (
        <Sequence durationInFrames={paneFrom} layout="none">
          <Stage>
            <Browser src={folder.src} url="client-handoff/ (as received)" style={{ flex: 1 }} />
          </Stage>
        </Sequence>
      ) : null}
      <Sequence from={paneFrom} layout="none">
        <Stage>
          {intake ? (
            <CastPane
              cast={intake}
              play={cast.window!}
              maxIdleGapSec={cast.maxIdleGapSec}
              title="Intake: dry-run inventory"
              fontSize={16}
              callouts={media.callouts}
              style={{ flex: 3 }}
            />
          ) : null}
          <Browser src={clip.src} play={clip.window} url="Project files: one project, nothing flattened" style={{ flex: 2 }} />
        </Stage>
      </Sequence>
      <LowerThird title="The mess, then one project" subtitle="Nothing flattened, nothing secret ingested" />
    </AbsoluteFill>
  );
};

export const S01Mess: SceneDef = { beat: 'The mess', captions: true, Component: Mess };
