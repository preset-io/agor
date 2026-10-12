import { loadFont } from '@remotion/google-fonts/SpaceGrotesk';
import { AbsoluteFill, Sequence, useVideoConfig } from 'remotion';
import { INTERFACES_SECONDS, Interfaces } from './interfaces/Interfaces';
import { AiTeammatesBebop, BEBOP_BODY_SECONDS } from './teammates/Bebop';
import { EndCard } from './teammates/Cards';

const { fontFamily } = loadFont('normal', { weights: ['600', '700'] });

const END = 2.8;
export const REEL_SECONDS = BEBOP_BODY_SECONDS + INTERFACES_SECONDS + END;

/**
 * The teammates sections back to back: the AI teammates segment (logo,
 * slices, answers), hard cut into "talk to them from anywhere", then one
 * end card.
 */
export const TeammatesReel: React.FC = () => {
  const { fps } = useVideoConfig();
  const f = (sec: number) => Math.round(sec * fps);
  return (
    <AbsoluteFill style={{ fontFamily }}>
      <Sequence name="AI teammates" durationInFrames={f(BEBOP_BODY_SECONDS)} premountFor={fps}>
        <AiTeammatesBebop withEnd={false} />
      </Sequence>
      <Sequence
        name="Interfaces"
        from={f(BEBOP_BODY_SECONDS)}
        durationInFrames={f(INTERFACES_SECONDS)}
        premountFor={fps}
      >
        <Interfaces />
      </Sequence>
      <Sequence name="End" from={f(BEBOP_BODY_SECONDS + INTERFACES_SECONDS)} premountFor={fps}>
        <EndCard line="AI teammates that can do anything" />
      </Sequence>
    </AbsoluteFill>
  );
};
