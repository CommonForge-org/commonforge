import { fade } from '@remotion/transitions/fade';
import { linearTiming, TransitionSeries } from '@remotion/transitions';
import type React from 'react';
import { AbsoluteFill, getStaticFiles, Html5Audio, Sequence, staticFile, type CalculateMetadataFunction } from 'remotion';
import { Captions } from './components/Captions';
import { musicGain, type MusicPlan } from './lib/music';
import { TimelineBar } from './components/TimelineBar';
import type { Media, Narration } from './data';
import { S00Title } from './scenes/S00Title';
import { S01Mess } from './scenes/S01Mess';
import { S02ClientUpdate } from './scenes/S02ClientUpdate';
import { S03OwnTool } from './scenes/S03OwnTool';
import { S04ThreeAgents } from './scenes/S04ThreeAgents';
import { S05Collision } from './scenes/S05Collision';
import { S06RepairPreview } from './scenes/S06RepairPreview';
import { S07ApprovePublish } from './scenes/S07ApprovePublish';
import { S08RestoreExport } from './scenes/S08RestoreExport';
import { S09Close } from './scenes/S09Close';
import type { SceneDef } from './scenes/shared';
import { theme, VIDEO } from './theme';
import { sceneFrames, totalFrames, TRANSITION_FRAMES, type SceneTiming } from './timing';

/** Optional music bed under the narration; omitted when the file is absent. */
export const MUSIC_BED = 'audio/bed.mp3';

/** narration.json scene id → scene implementation. */
const SCENES: Record<string, SceneDef> = {
  's00-title': S00Title,
  's01-mess': S01Mess,
  's02-client-update': S02ClientUpdate,
  's03-own-tool': S03OwnTool,
  's04-three-agents': S04ThreeAgents,
  's05-collision': S05Collision,
  's06-repair-preview': S06RepairPreview,
  's07-approve-publish': S07ApprovePublish,
  's08-restore-export': S08RestoreExport,
  's09-close': S09Close,
};

function sceneDef(id: string): SceneDef {
  const def = SCENES[id];
  if (!def) throw new Error(`narration.json scene "${id}" has no scene component (known: ${Object.keys(SCENES).join(', ')})`);
  return def;
}

export type DemoVideoProps = {
  narration: Narration;
  media: Media;
  /** Filled by calculateDemoMetadata from narration durations. */
  timings: SceneTiming[];
  hasMusicBed: boolean;
};

/** Derives the video length and scene placement from narration.json audio durations. */
export const calculateDemoMetadata: CalculateMetadataFunction<DemoVideoProps> = ({ props }) => {
  props.narration.scenes.forEach((scene) => sceneDef(scene.id));
  const timings = sceneFrames(props.narration, VIDEO.fps, TRANSITION_FRAMES);
  const hasMusicBed = getStaticFiles().some((file) => file.name === MUSIC_BED);
  return { durationInFrames: totalFrames(timings), props: { ...props, timings, hasMusicBed } };
};

export const DemoVideo: React.FC<DemoVideoProps> = ({ narration, media, timings, hasMusicBed }) => {
  const scenes = narration.scenes.map((scene, i) => ({ scene, timing: timings[i]!, def: sceneDef(scene.id) }));
  const music: MusicPlan = {
    fps: VIDEO.fps,
    totalFrames: totalFrames(timings),
    speech: scenes.map(({ scene, timing }): [number, number] => [timing.from, timing.from + Math.ceil(scene.durationSec * VIDEO.fps)]),
  };

  return (
    <AbsoluteFill style={{ background: theme.color.frame }}>
      <TransitionSeries>
        {scenes.flatMap(({ scene, timing, def }, i) => [
          ...(i > 0
            ? [
                <TransitionSeries.Transition
                  key={`fade-${scene.id}`}
                  presentation={fade()}
                  timing={linearTiming({ durationInFrames: TRANSITION_FRAMES })}
                />,
              ]
            : []),
          <TransitionSeries.Sequence key={scene.id} durationInFrames={timing.durationInFrames} name={scene.id}>
            <AbsoluteFill style={{ background: theme.color.frame }}>
              <def.Component scene={scene} media={media.scenes[scene.id] ?? {}} hashesFile={media.hashes} />
              {def.captions ? <Captions words={scene.words} text={scene.text} /> : null}
            </AbsoluteFill>
          </TransitionSeries.Sequence>,
        ])}
      </TransitionSeries>

      {scenes.map(({ scene, timing }) => (
        <Sequence key={`audio-${scene.id}`} from={timing.from} durationInFrames={timing.durationInFrames} layout="none" name={`narration ${scene.id}`}>
          <Html5Audio src={staticFile(scene.audio)} />
        </Sequence>
      ))}
      {hasMusicBed ? <Html5Audio src={staticFile(MUSIC_BED)} volume={(f) => musicGain(f, music)} loop /> : null}

      <TimelineBar
        beats={scenes.map(({ timing, def }) => ({ label: def.beat, from: timing.from, durationInFrames: timing.durationInFrames }))}
        totalFrames={totalFrames(timings)}
      />
    </AbsoluteFill>
  );
};
