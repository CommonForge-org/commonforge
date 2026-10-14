import type React from 'react';
import { AbsoluteFill, interpolate, Sequence, useCurrentFrame, useVideoConfig } from 'remotion';
import { Browser } from '../components/Browser';
import { LowerThird } from '../components/LowerThird';
import { sceneSlots } from './layout';
import { required, sceneBackground, Stage, type SceneDef, type SceneProps } from './shared';

const EvidenceZoom: React.FC<{ shot: string; frames: number }> = ({ shot, frames }) => {
  const frame = useCurrentFrame();
  const scale = interpolate(frame, [0, frames], [1, 1.3], { extrapolateRight: 'clamp' });
  return (
    <Stage>
      <div style={{ flex: 1, overflow: 'hidden', borderRadius: 14 }}>
        <Browser src={shot} url="Evidence panel" style={{ width: '100%', height: '100%', transform: `scale(${scale})`, transformOrigin: '70% 40%' }} />
      </div>
    </Stage>
  );
};

const Collision: React.FC<SceneProps> = ({ scene, media }) => {
  const { fps, durationInFrames } = useVideoConfig();
  required(media.clip, 'clip', scene);
  // the evidence-panel screenshot takes over for the last seconds, slowly zooming in
  const slots = sceneSlots(scene.id, media, durationInFrames / fps);
  const clip = slots.find((s) => s.kind === 'clip')!;
  const shot = slots.find((s) => s.kind === 'shot')?.src;
  const zoomFrom = shot ? Math.round((clip.startSec + clip.durationSec) * fps) : durationInFrames;
  const zoomFrames = durationInFrames - zoomFrom;

  return (
    <AbsoluteFill style={sceneBackground}>
      <Sequence durationInFrames={zoomFrom} layout="none">
        <Stage>
          <Browser src={clip.src} play={clip.window} callouts={media.callouts} url="Change: integration result" style={{ flex: 1 }} />
        </Stage>
      </Sequence>
      {shot ? (
        <Sequence from={zoomFrom} layout="none">
          <EvidenceZoom shot={shot} frames={zoomFrames} />
        </Sequence>
      ) : null}
      <LowerThird title="Clean merge, failing contract" subtitle="Acceptance blocked; production untouched" />
    </AbsoluteFill>
  );
};

export const S05Collision: SceneDef = { beat: 'Collision', captions: true, Component: Collision };
