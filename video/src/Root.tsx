import type React from 'react';
import { Composition } from 'remotion';
import { loadVideoData } from './data';
import { calculateDemoMetadata, DemoVideo, type DemoVideoProps } from './DemoVideo';
import { loadBrandFonts } from './fonts';
import { VIDEO } from './theme';

loadBrandFonts();

const defaultProps: DemoVideoProps = { ...loadVideoData(), timings: [], hasMusicBed: false };

export const RemotionRoot: React.FC = () => (
  <Composition
    id="DemoVideo"
    component={DemoVideo}
    width={VIDEO.width}
    height={VIDEO.height}
    fps={VIDEO.fps}
    // Placeholder only: calculateDemoMetadata sets the real length from narration.json.
    durationInFrames={1}
    defaultProps={defaultProps}
    calculateMetadata={calculateDemoMetadata}
  />
);
