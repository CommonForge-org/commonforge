import type React from 'react';
import { AbsoluteFill } from 'remotion';
import { Browser } from '../components/Browser';
import { CastPane } from '../components/CastPane';
import { LowerThird } from '../components/LowerThird';
import { resolveWindow } from '../lib/media-window';
import { useCasts } from '../lib/useCasts';
import { required, sceneBackground, Stage, type SceneDef, type SceneProps } from './shared';

/** Scene 2: the client starts an update (clip) beside the clone terminal (canonical denied, edition works). */
const ClientUpdate: React.FC<SceneProps> = ({ scene, media }) => {
  const clip = required(media.clip, 'clip', scene);
  const castRef = required(media.casts, 'casts', scene)[0]!;
  const [cast] = useCasts([castRef.src]);
  const speed = media.speed ?? 1;

  return (
    <AbsoluteFill style={sceneBackground}>
      <Stage>
        <Browser src={clip.src} play={resolveWindow(clip, speed)} callouts={media.callouts} url="Client: Start an update" style={{ flex: 3 }} />
        {cast ? (
          <CastPane
            cast={cast}
            play={resolveWindow(castRef, speed)}
            maxIdleGapSec={castRef.maxIdleGapSec}
            title="client token"
            fontSize={20}
            style={{ flex: 2 }}
          />
        ) : null}
      </Stage>
      <LowerThird title="Client starts an update" subtitle="Edition copy, never production" />
    </AbsoluteFill>
  );
};

export const S02ClientUpdate: SceneDef = { beat: 'Client update', captions: true, Component: ClientUpdate };
