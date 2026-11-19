import {
  AbsoluteFill,
  Easing,
  interpolate,
  Sequence,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { fontFamily } from '../brand/fonts';
import { TILES, view } from './geometry';
import marks from './marks.json';
import { type ShotTiming, TeammateShot } from './TeammateShot';

type Bot = keyof typeof marks;

/** Source playback speed for every shot (the clips are already snappy and tight). */
const RATE = 1.35;
const HOLD = 1.1;
const SHRINK = 0.75;
const TITLE = 2.8;

/**
 * Output timing for a bot's shot, from its clip's marks: start just before
 * the question is typed, and time the camera from when it's sent and answered.
 */
export function shotTiming(bot: Bot): ShotTiming {
  const m = marks[bot];
  const trimFrom = Math.max(0, m.question - 0.25);
  return {
    trimFrom,
    rate: RATE,
    sentAt: (m.sent - trimFrom) / RATE,
    answeredAt: (m.answered + 0.35 - trimFrom) / RATE,
    hold: HOLD,
    shrink: SHRINK,
  };
}

/** When each shot starts (seconds): as the one before it starts shrinking away. */
const ORDER: Bot[] = ['databot', 'engbot', 'legalbot', 'opsbot'];
const STARTS = ORDER.reduce<number[]>((acc, bot, i) => {
  if (i === 0) return [0];
  const prev = shotTiming(ORDER[i - 1]);
  return [...acc, acc[i - 1] + prev.answeredAt + prev.hold];
}, []);
const lastTiming = shotTiming('opsbot');
const GRID_AT = STARTS[3] + lastTiming.answeredAt + lastTiming.hold + lastTiming.shrink;
export const DURATION_SECONDS = GRID_AT + TITLE;

/** The question box sits at the bottom of the session panel (right half). */
const QUESTION = view(1445, 960, 920);

/**
 * "AI teammates that can do anything": four real Agor teammates answering
 * real questions. Each question is typed close up, the answer lands, and the
 * shot shrinks into a corner while the next one is asked; it ends on all four.
 */
export const AiTeammates: React.FC = () => {
  const { fps } = useVideoConfig();
  // Later shots render first so earlier ones (already in their tiles) sit on top.
  return (
    <AbsoluteFill
      style={{
        fontFamily,
        background: 'radial-gradient(ellipse at 50% 40%, #16202e 0%, #0b0d12 70%)',
      }}
    >
      <Sequence name="OpsBot" from={Math.round(STARTS[3] * fps)} premountFor={fps}>
        <TeammateShot
          clip="opsbot.mp4"
          name="OpsBot"
          emoji="📈"
          timing={shotTiming('opsbot')}
          questionView={QUESTION}
          answerView={view(1440, 560, 980)}
          tile={TILES[3]}
        />
      </Sequence>
      <Sequence name="LegalBot" from={Math.round(STARTS[2] * fps)} premountFor={fps}>
        <TeammateShot
          clip="legalbot.mp4"
          name="LegalBot"
          emoji="⚖️"
          timing={shotTiming('legalbot')}
          questionView={QUESTION}
          answerView={view(1440, 520, 980)}
          tile={TILES[2]}
        />
      </Sequence>
      <Sequence name="EngBot" from={Math.round(STARTS[1] * fps)} premountFor={fps}>
        <TeammateShot
          clip="engbot.mp4"
          name="EngBot"
          emoji="🛠️"
          timing={shotTiming('engbot')}
          questionView={QUESTION}
          answerView={view(1440, 560, 980)}
          tile={TILES[1]}
        />
      </Sequence>
      <Sequence name="DataBot" from={0} premountFor={fps}>
        <TeammateShot
          clip="databot.mp4"
          name="DataBot"
          emoji="📊"
          timing={shotTiming('databot')}
          questionView={QUESTION}
          answerView={view(1440, 560, 980)}
          tile={TILES[0]}
        />
      </Sequence>
      <Sequence name="Title" from={Math.round(GRID_AT * fps)} premountFor={fps}>
        <Title />
      </Sequence>
    </AbsoluteFill>
  );
};

const Title: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill
      style={{
        alignItems: 'center',
        justifyContent: 'center',
        background: `rgba(8,10,14,${interpolate(frame, [0, 0.6 * fps], [0, 0.72], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        })})`,
      }}
    >
      <div
        style={{
          color: '#f4f7fb',
          fontSize: 104,
          fontWeight: 700,
          letterSpacing: '-0.02em',
          textAlign: 'center',
          lineHeight: 1.05,
          opacity: interpolate(frame, [0.2 * fps, 0.8 * fps], [0, 1], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          }),
          translate: interpolate(frame, [0.2 * fps, 0.9 * fps], ['0px 28px', '0px 0px'], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
        }}
      >
        AI teammates
        <br />
        that can do anything
      </div>
    </AbsoluteFill>
  );
};
