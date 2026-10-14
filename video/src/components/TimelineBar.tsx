import type React from 'react';
import { useMemo } from 'react';
import { useCurrentFrame } from 'remotion';
import { textWidth, useBrandFontsSettled } from '../fonts';
import { theme, VIDEO } from '../theme';

export interface Beat {
  label: string;
  from: number;
  durationInFrames: number;
}

const INSET = 72;
const LABEL = { size: 16, paddingLeft: 6, /** active weight: a label must fit in its widest state */ weight: 700 };
/** Segments narrower than this never carry a label. */
const MIN_LABEL_PX = 48;

/**
 * Which beats get a label: the whole label must fit its segment (and the segment must be at least
 * MIN_LABEL_PX wide); a label that would be cut is hidden instead of truncated.
 */
export function labelledBeats(beats: Beat[], totalFrames: number, railPx: number, measure: (label: string) => number): boolean[] {
  return beats.map((beat) => {
    const segmentPx = (beat.durationInFrames / totalFrames) * railPx;
    return segmentPx >= MIN_LABEL_PX && segmentPx >= measure(beat.label) + LABEL.paddingLeft + 4;
  });
}

/** The progress rail along the bottom of the video: one labelled segment per beat plus a playhead. */
export const TimelineBar: React.FC<{ beats: Beat[]; totalFrames: number }> = ({ beats, totalFrames }) => {
  const frame = useCurrentFrame();
  const fontsSettled = useBrandFontsSettled();
  const labelled = useMemo(
    () =>
      totalFrames > 0
        ? labelledBeats(beats, totalFrames, VIDEO.width - 2 * INSET, (label) => textWidth(label, { family: theme.font.sans, size: LABEL.size, weight: LABEL.weight }))
        : [],
    [beats, totalFrames, fontsSettled],
  );
  if (totalFrames <= 0) return null;
  const progress = Math.min(1, frame / totalFrames);

  return (
    <div style={{ position: 'absolute', left: INSET, right: INSET, bottom: 22, height: 44, fontFamily: theme.font.sans }}>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 0, height: 6, borderRadius: 3, background: theme.color.hairline }} />
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          height: 6,
          width: `${progress * 100}%`,
          borderRadius: 3,
          background: theme.color.accent,
        }}
      />
      {beats.map((beat, index) => {
        const active = frame >= beat.from && frame < beat.from + beat.durationInFrames;
        return (
          <div
            key={beat.label}
            style={{
              position: 'absolute',
              top: 0,
              left: `${(beat.from / totalFrames) * 100}%`,
              width: `${(beat.durationInFrames / totalFrames) * 100}%`,
              borderLeft: `2px solid ${theme.color.frame}`,
              height: 44,
            }}
          >
            {labelled[index] ? (
              <div
                style={{
                  marginTop: 14,
                  paddingLeft: LABEL.paddingLeft,
                  fontSize: LABEL.size,
                  fontWeight: active ? LABEL.weight : 500,
                  color: active ? theme.color.accent : theme.color.muted,
                  whiteSpace: 'nowrap',
                }}
              >
                {beat.label}
              </div>
            ) : null}
          </div>
        );
      })}
      <div
        style={{
          position: 'absolute',
          top: -5,
          left: `calc(${progress * 100}% - 8px)`,
          width: 16,
          height: 16,
          borderRadius: 8,
          background: theme.color.text,
          boxShadow: `0 0 12px ${theme.color.accent}`,
        }}
      />
    </div>
  );
};
