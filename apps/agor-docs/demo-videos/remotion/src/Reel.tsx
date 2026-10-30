import { AbsoluteFill, Sequence, useVideoConfig } from 'remotion';
import { fontFamily } from './brand/fonts';
import { INTERFACES_SECONDS, Interfaces } from './interfaces/Interfaces';
import { RAISE_SECONDS, RaiseTogether } from './raise/Raise';
import { AiTeammatesBebop, BEBOP_BODY_SECONDS } from './teammates/Bebop';
import { EndCard } from './teammates/Cards';
import { MultiplyThroughput, THROUGHPUT_SECONDS } from './throughput/Throughput';

const END = 1.8;
export const REEL_SECONDS =
  BEBOP_BODY_SECONDS + INTERFACES_SECONDS + RAISE_SECONDS + THROUGHPUT_SECONDS + END;

/**
 * The sections back to back: the AI teammates segment (logo, slices,
 * answers), "Access Agor from where you work", "Raise AI teammates
 * together", "Multiply engineering
 * throughput", then one end card.
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
      <Sequence
        name="Raise AI teammates together"
        from={f(BEBOP_BODY_SECONDS + INTERFACES_SECONDS)}
        durationInFrames={f(RAISE_SECONDS)}
        premountFor={fps}
      >
        <RaiseTogether />
      </Sequence>
      <Sequence
        name="Multiply engineering throughput"
        from={f(BEBOP_BODY_SECONDS + INTERFACES_SECONDS + RAISE_SECONDS)}
        durationInFrames={f(THROUGHPUT_SECONDS)}
        premountFor={fps}
      >
        <MultiplyThroughput />
      </Sequence>
      <Sequence
        name="End"
        from={f(BEBOP_BODY_SECONDS + INTERFACES_SECONDS + RAISE_SECONDS + THROUGHPUT_SECONDS)}
        premountFor={fps}
      >
        <EndCard />
      </Sequence>
    </AbsoluteFill>
  );
};
