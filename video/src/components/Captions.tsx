import type React from 'react';
import { useMemo } from 'react';
import { useCurrentFrame, useVideoConfig } from 'remotion';
import type { Word } from '../data';
import { textWidth, useBrandFontsSettled } from '../fonts';
import { fitLine } from '../lib/fit-line';
import { alpha, theme } from '../theme';

const MAX_WORDS = 8;
/** A pause longer than this starts a new caption window. */
const BREAK_GAP_SEC = 0.6;
/** How long a window lingers after its last word ends. */
const LINGER_SEC = 0.5;

/** Groups timed words into short caption windows, breaking on pauses and at MAX_WORDS. */
function windows(words: Word[]): Word[][] {
  const groups: Word[][] = [];
  let current: Word[] = [];
  for (const word of words) {
    const previous = current.at(-1);
    if (current.length === MAX_WORDS || (previous && word.start - previous.end > BREAK_GAP_SEC)) {
      groups.push(current);
      current = [];
    }
    current.push(word);
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

const MAX_WIDTH = 1600;
const PADDING_X = 28;
const FONT_WEIGHT = 600;
/** The whole-text fallback starts at this size and shrinks to fit one line, down to the minimum. */
const FALLBACK_FONT = { max: 30, min: 20 };

const box: React.CSSProperties = {
  position: 'absolute',
  left: '50%',
  bottom: 96,
  transform: 'translateX(-50%)',
  maxWidth: MAX_WIDTH,
  padding: `14px ${PADDING_X}px`,
  borderRadius: 12,
  background: alpha(theme.color.frame, 0.82),
  color: theme.color.text,
  fontFamily: theme.font.sans,
  fontSize: 36,
  fontWeight: FONT_WEIGHT,
  lineHeight: 1.3,
  textAlign: 'center',
  zIndex: 30,
};

/** The scene's whole text on one line: shrunk until it fits the caption box, else cut with an ellipsis. */
const WholeText: React.FC<{ text: string }> = ({ text }) => {
  const fontsSettled = useBrandFontsSettled();
  const fit = useMemo(() => {
    const width = textWidth(text, { family: theme.font.sans, size: FALLBACK_FONT.max, weight: FONT_WEIGHT });
    return fitLine(width, { maxWidth: MAX_WIDTH - 2 * PADDING_X, maxFontSize: FALLBACK_FONT.max, minFontSize: FALLBACK_FONT.min });
  }, [text, fontsSettled]);
  return (
    <div
      style={{
        ...box,
        width: fit.ellipsis ? MAX_WIDTH : undefined,
        boxSizing: 'border-box',
        fontSize: fit.fontSize,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}
    >
      {text}
    </div>
  );
};

/**
 * Captions for the current scene. With word timestamps it shows the window
 * holding the current word and highlights that word; without them it shows the
 * scene's whole narration text on one line.
 */
export const Captions: React.FC<{ words: Word[]; text: string }> = ({ words, text }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;

  if (words.length === 0) return text ? <WholeText text={text} /> : null;

  const group = windows(words).find((g) => t >= g[0]!.start && t <= g.at(-1)!.end + LINGER_SEC);
  if (!group) return null;
  return (
    <div style={box}>
      {group.map((word, i) => (
        <span
          key={`${word.start}-${i}`}
          style={{ color: t >= word.start && t < word.end ? theme.color.accent : theme.color.text }}
        >
          {i > 0 ? ' ' : ''}
          {word.w}
        </span>
      ))}
    </div>
  );
};
