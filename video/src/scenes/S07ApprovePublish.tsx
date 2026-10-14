import type React from 'react';
import { AbsoluteFill, Sequence, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { Browser } from '../components/Browser';
import { LowerThird } from '../components/LowerThird';
import { ProposalHash } from '../components/ProposalHash';
import { shortCode } from '../lib/review-code';
import { useHashes } from '../lib/useHashes';
import { theme } from '../theme';
import { sceneSlots } from './layout';
import { required, sceneBackground, Stage, type SceneDef, type SceneProps } from './shared';

/** The three authority records, appearing at these seconds into the publish clip. */
const EVENTS = [
  { label: 'Client approved outcome', at: 2 },
  { label: 'Developer accepted', at: 7 },
  { label: 'Published', at: 12 },
];

const EventPills: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <div style={{ position: 'absolute', top: 120, right: 110, display: 'flex', flexDirection: 'column', gap: 14, zIndex: 15 }}>
      {EVENTS.map((event) => {
        const pop = spring({ frame: frame - event.at * fps, fps, config: { damping: 14 } });
        return (
          <div
            key={event.label}
            style={{
              padding: '10px 22px',
              borderRadius: 999,
              background: theme.color.panel,
              border: `2px solid ${theme.color.accent}`,
              color: theme.color.text,
              fontFamily: theme.font.sans,
              fontSize: 26,
              fontWeight: 600,
              opacity: pop,
              transform: `translateX(${(1 - pop) * 40}px)`,
            }}
          >
            <span style={{ color: theme.color.accent, marginRight: 10 }}>●</span>
            {event.label}
          </div>
        );
      })}
    </div>
  );
};

/** Scene 7: the same review code in the client's and the developer's view, then the publish clip. */
const ApprovePublish: React.FC<SceneProps> = ({ scene, media, hashesFile }) => {
  const { fps, durationInFrames } = useVideoConfig();
  required(media.clip, 'clip', scene);
  const hashes = useHashes(hashesFile);
  const [clientShot, developerShot] = media.shots ?? [];
  const clip = sceneSlots(scene.id, media, durationInFrames / fps).find((s) => s.kind === 'clip')!;
  const splitFrames = Math.round(clip.startSec * fps);

  return (
    <AbsoluteFill style={sceneBackground}>
      <Sequence durationInFrames={splitFrames} layout="none">
        <Stage>
          <ProposalHash
            hash={shortCode(hashes?.fixed?.hash ?? 'NOT CAPTURED')}
            left={{ label: 'Client view', shot: clientShot }}
            right={{ label: 'Developer view', shot: developerShot }}
            connectAtSec={3}
          />
        </Stage>
      </Sequence>
      <Sequence from={splitFrames} layout="none">
        <Stage>
          <Browser src={clip.src} play={clip.window} callouts={media.callouts} url="Approve, accept, publish" style={{ flex: 1 }} />
        </Stage>
        <EventPills />
      </Sequence>
      <LowerThird title="Approve, accept, publish" subtitle="Three records, three permissions" />
    </AbsoluteFill>
  );
};

export const S07ApprovePublish: SceneDef = { beat: 'Approve + publish', captions: true, Component: ApprovePublish };
