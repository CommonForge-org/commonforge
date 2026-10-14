import type React from 'react';
import { AbsoluteFill, Sequence, useVideoConfig } from 'remotion';
import { Browser } from '../components/Browser';
import { LowerThird } from '../components/LowerThird';
import { sceneSlots } from './layout';
import { required, sceneBackground, Stage, type SceneDef, type SceneProps } from './shared';

/**
 * Scene 3: the owner's screen recording of the edit in an external tool (`insert`, optional), then
 * the return in the app (`clip`). The callouts belong to the return clip.
 */
const OwnTool: React.FC<SceneProps> = ({ scene, media }) => {
  const { fps, durationInFrames } = useVideoConfig();
  required(media.clip, 'clip', scene);
  const slots = sceneSlots(scene.id, media, durationInFrames / fps);
  const insert = slots.find((s) => s.kind === 'insert');
  const clip = slots.find((s) => s.kind === 'clip')!;
  const clipFrom = Math.round(clip.startSec * fps);

  return (
    <AbsoluteFill style={sceneBackground}>
      {insert ? (
        <Sequence durationInFrames={clipFrom} layout="none">
          <Stage>
            <Browser src={insert.src} play={insert.window} url="The client's own tool: editing the working copy" style={{ flex: 1 }} />
          </Stage>
        </Sequence>
      ) : null}
      <Sequence from={clipFrom} layout="none">
        <Stage>
          <Browser
            src={clip.src}
            play={clip.window}
            callouts={media.callouts}
            url="Edition folder in the client's own tool, then Return changes"
            style={{ flex: 1 }}
          />
        </Stage>
      </Sequence>
      <LowerThird title="Edit in your own tool" subtitle="No Git commands for the client" />
    </AbsoluteFill>
  );
};

export const S03OwnTool: SceneDef = { beat: 'Own tool', captions: true, Component: OwnTool };
