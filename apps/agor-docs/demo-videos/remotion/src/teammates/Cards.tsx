import { AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { AgorWordmark, WORDMARK_SETTLED } from '../brand/AgorWordmark';
import { Heading } from '../brand/Heading';
import { BG_GRADIENT, INK, ON_FILL, TEAL } from '../brand/palette';

const ease = Easing.bezier(0.16, 1, 0.3, 1);
const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
export const NAVY = BG_GRADIENT;

/** When the slogan rises in under the wordmark (seconds into the intro). */
export const SLOGAN_AT = WORDMARK_SETTLED - 0.5;
/**
 * How long the intro runs: the wordmark lands, then the slogan, then the
 * cursors swoop in and circle "together" (Bebop.tsx) before heading off.
 */
export const LOGO_INTRO_SECONDS = SLOGAN_AT + 3.0;
/** The middle of "together" in the slogan (px), which the cursors circle. */
export const TOGETHER = { x: 952, y: 790 };

/**
 * The Agor logo draws on, the wordmark crashes in (src/brand/AgorWordmark.tsx),
 * then it lifts to make room for the slogan, which rises in under it.
 */
export const LogoIntro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const lift = interpolate(t, [SLOGAN_AT - 0.1, SLOGAN_AT + 0.5], [0, 1], {
    ...clamp,
    easing: ease,
  });
  return (
    <AbsoluteFill style={{ background: NAVY }}>
      <AbsoluteFill style={{ translate: `0px ${-lift * 95}px` }}>
        <AgorWordmark t={t} />
      </AbsoluteFill>
      <AbsoluteFill style={{ top: 735, alignItems: 'center' }}>
        <Heading text="Work *together* **again**" size={92} at={SLOGAN_AT + 0.1} stagger={0.12} />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

/** Title: two color blocks slam in from opposite sides, Bebop-style. */
export const TitleCard: React.FC<{ top: string; bottom: string }> = ({ top, bottom }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill style={{ background: NAVY, justifyContent: 'center' }}>
      <div
        style={{
          alignSelf: 'flex-start',
          background: TEAL,
          color: ON_FILL,
          fontSize: 150,
          fontWeight: 700,
          letterSpacing: '-0.03em',
          padding: '18px 80px 18px 120px',
          clipPath: 'polygon(0 0, 100% 0, calc(100% - 60px) 100%, 0 100%)',
          translate: interpolate(frame, [0, 0.45 * fps], ['-110% 0px', '0% 0px'], {
            ...clamp,
            easing: ease,
          }),
        }}
      >
        {top}
      </div>
      <div
        style={{
          alignSelf: 'flex-end',
          marginTop: 28,
          color: INK,
          fontSize: 92,
          fontWeight: 600,
          letterSpacing: '-0.02em',
          padding: '0 120px 0 60px',
          translate: interpolate(frame, [0.15 * fps, 0.6 * fps], ['110% 0px', '0% 0px'], {
            ...clamp,
            easing: ease,
          }),
        }}
      >
        {bottom}
      </div>
    </AbsoluteFill>
  );
};

/** A bot's name card: a full-frame color block wipes across and off. */
export const NameCard: React.FC<{
  name: string;
  emoji: string;
  color: string;
  seconds: number;
}> = ({ name, emoji, color, seconds }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const inEnd = 0.28 * fps;
  const outStart = (seconds - 0.28) * fps;
  return (
    <AbsoluteFill
      style={{
        background: color,
        justifyContent: 'center',
        alignItems: 'center',
        clipPath: 'polygon(8% 0, 100% 0, 92% 100%, 0 100%)',
        translate: interpolate(
          frame,
          [0, inEnd, outStart, seconds * fps],
          ['-120% 0px', '0% 0px', '0% 0px', '120% 0px'],
          { ...clamp, easing: ease }
        ),
      }}
    >
      <div style={{ color: ON_FILL, fontSize: 190, fontWeight: 700, letterSpacing: '-0.04em' }}>
        {emoji} @{name}
      </div>
    </AbsoluteFill>
  );
};

/** The sign-off: the finished wordmark (an optional line under it). */
export const EndCard: React.FC<{ line?: string }> = ({ line }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill
      style={{ background: NAVY, opacity: interpolate(frame, [0, 0.5 * fps], [0, 1], clamp) }}
    >
      <AbsoluteFill style={{ translate: `0px ${line ? -90 : 0}px` }}>
        <AgorWordmark t={WORDMARK_SETTLED + 1} />
      </AbsoluteFill>
      {line ? (
        <div
          style={{
            position: 'absolute',
            top: 770,
            width: '100%',
            textAlign: 'center',
            color: INK,
            fontSize: 76,
            fontWeight: 700,
            letterSpacing: '-0.02em',
            opacity: interpolate(frame, [0.35 * fps, 0.8 * fps], [0, 1], clamp),
          }}
        >
          {line}
        </div>
      ) : null}
    </AbsoluteFill>
  );
};
