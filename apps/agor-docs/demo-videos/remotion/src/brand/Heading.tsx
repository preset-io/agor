import type React from 'react';
import { Easing, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { fontFamily } from './fonts';
import { ACCENT_GRADIENT, gradientText, INK } from './palette';

// A heading in agor.live's style: thin words, one gradient accent word (or
// phrase), one strong word. Write it as "Work *together* **again**":
// *x* is the accent, **x** is strong, the rest is thin. Words rise in one
// by one from `at` (seconds), or sit still when `at` is omitted.

type Weight = 'thin' | 'accent' | 'strong';

function parse(text: string): { word: string; weight: Weight }[] {
  const out: { word: string; weight: Weight }[] = [];
  const re = /\*\*([^*]+)\*\*|\*([^*]+)\*|([^*\s]+)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const weight: Weight = m[1] ? 'strong' : m[2] ? 'accent' : 'thin';
    for (const word of (m[1] ?? m[2] ?? m[3]).split(' ')) out.push({ word, weight });
  }
  return out;
}

const STYLE: Record<Weight, React.CSSProperties> = {
  thin: { fontWeight: 100, color: INK },
  accent: { fontWeight: 600, ...gradientText(ACCENT_GRADIENT) },
  strong: { fontWeight: 700, color: INK },
};

const ease = Easing.bezier(0.16, 1, 0.3, 1);
const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

export const Heading: React.FC<{
  text: string;
  size: number;
  /** When the words start rising (seconds, local); omit for no animation. */
  at?: number;
  stagger?: number;
  style?: React.CSSProperties;
}> = ({ text, size, at, stagger = 0.08, style }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  return (
    <div
      style={{
        fontFamily,
        fontSize: size,
        letterSpacing: '-0.025em',
        lineHeight: 1.12,
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {parse(text).map(({ word, weight }, i) => {
        const rise =
          at === undefined
            ? 1
            : interpolate(t, [at + i * stagger, at + i * stagger + 0.45], [0, 1], {
                ...clamp,
                easing: ease,
              });
        return (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: words of a fixed string
            key={i}
            style={{
              display: 'inline-block',
              overflow: 'hidden',
              verticalAlign: 'bottom',
              paddingBottom: size * 0.12,
              marginBottom: -size * 0.12,
            }}
          >
            <span
              style={{
                display: 'inline-block',
                translate: `0px ${(1 - rise) * 115}%`,
                ...STYLE[weight],
              }}
            >
              {word}
            </span>
            {' '}
          </span>
        );
      })}
    </div>
  );
};
