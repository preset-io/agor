import { Video } from '@remotion/media';
import {
  AbsoluteFill,
  Easing,
  Freeze,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';

const ease = Easing.bezier(0.16, 1, 0.3, 1);
const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
export const NAVY = 'linear-gradient(180deg, #141f38 0%, #070a10 100%)';
export const TEAL = '#2dd4bf';

/** The Agor logo draw-on, from the syllabus reel. */
export const LogoIntro: React.FC = () => (
  <AbsoluteFill style={{ background: NAVY }}>
    <Video src={staticFile('clips/agor-logo.mp4')} muted />
  </AbsoluteFill>
);

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
          color: '#06121a',
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
          color: '#f4f7fb',
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
      <div style={{ color: '#0b0d12', fontSize: 190, fontWeight: 700, letterSpacing: '-0.04em' }}>
        {emoji} @{name}
      </div>
    </AbsoluteFill>
  );
};

/** End card: the panes dim behind the finished logo and the title. */
/** The sign-off: the finished logo on the navy card (an optional line under it). */
export const EndCard: React.FC<{ line?: string }> = ({ line }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill
      style={{
        background: NAVY,
        opacity: interpolate(frame, [0, 0.5 * fps], [0, 1], clamp),
        justifyContent: 'center',
        alignItems: 'center',
      }}
    >
      <div
        style={{
          width: 1280,
          height: 720,
          marginTop: line ? -160 : 0,
          // Feather the logo clip's own background into the card's.
          maskImage: 'radial-gradient(ellipse 45% 55% at center, black 55%, transparent 100%)',
          WebkitMaskImage:
            'radial-gradient(ellipse 45% 55% at center, black 55%, transparent 100%)',
        }}
      >
        <Freeze frame={Math.round(6 * fps)}>
          <Video
            src={staticFile('clips/agor-logo.mp4')}
            muted
            style={{ width: '100%', height: '100%' }}
          />
        </Freeze>
      </div>
      <div
        style={{
          marginTop: -150,
          // Above the feathered logo video, which otherwise dims the middle words.
          position: 'relative',
          zIndex: 2,
          color: '#f4f7fb',
          fontSize: 76,
          fontWeight: 700,
          letterSpacing: '-0.02em',
          opacity: interpolate(frame, [0.35 * fps, 0.8 * fps], [0, 1], clamp),
        }}
      >
        {line ?? null}
      </div>
    </AbsoluteFill>
  );
};
