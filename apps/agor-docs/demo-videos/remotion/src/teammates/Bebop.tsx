import { loadFont } from '@remotion/google-fonts/SpaceGrotesk';
import {
  AbsoluteFill,
  Easing,
  interpolate,
  Sequence,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { EndCard, LogoIntro, NAVY } from './Cards';
import marks from './marks.json';
import { EXPAND, PaneShot, type PaneTiming, promptSeconds, SHRINK } from './PaneShot';

const { fontFamily } = loadFont('normal', { weights: ['500', '600', '700'] });

type Bot = keyof typeof marks;

// Pacing, in seconds.
const LOGO = 3.4; // the draw-on is finished and shining by here
const TITLE_HOLD = 2.3; // the slices and the title, before the first opens
const PROMPT_RATE = 1.8;
const ANSWER_RATE = 1.25;
const HOLD = 1.4;
const END = 2.8;

// Four slanted slices edge to edge, overlapping by the slant; the outer two
// run past the frame edges so no background shows.
const SLANT = 56;
const PANE_W = 480 + 1.25 * SLANT;
const pane = (i: number) => ({ x: i * (PANE_W - SLANT) - SLANT, y: 0, w: PANE_W, h: 1080 });

const COLORS: Record<Bot, string> = {
  databot: '#2dd4bf',
  engbot: '#60a5fa',
  legalbot: '#fbbf24',
  opsbot: '#f472b6',
};
const ORDER: Bot[] = ['databot', 'engbot', 'legalbot', 'opsbot'];

const base = (bot: Bot) => ({
  trimFrom: Math.max(0, marks[bot].question - 0.2),
  sentSrc: marks[bot].sent,
  answeredSrc: marks[bot].answered,
  promptRate: PROMPT_RATE,
  answerRate: ANSWER_RATE,
});
const typing = (bot: Bot) => promptSeconds({ ...base(bot), expandAt: 0, revealAt: 0 });

// Each slice opens as the one before it starts closing.
const EXPANDS: number[] = [TITLE_HOLD];
for (let i = 1; i < ORDER.length; i++) {
  EXPANDS.push(EXPANDS[i - 1] + EXPAND + typing(ORDER[i - 1]) + SHRINK * 0.5);
}
const lastSent = EXPANDS[3] + EXPAND + typing('opsbot');
/** All four slices play their answers together from here (segment time). */
const REVEAL = lastSent + SHRINK + 0.1;
const playFor = (bot: Bot) => (marks[bot].answered + 1.5 - marks[bot].sent) / ANSWER_RATE;
const SEGMENT = REVEAL + Math.max(...ORDER.map(playFor)) + HOLD;
export const BEBOP_SECONDS = LOGO + SEGMENT + END;
/** Without the end card (for the combined reel). */
export const BEBOP_BODY_SECONDS = LOGO + SEGMENT;

const timing = (bot: Bot, i: number): PaneTiming => ({
  ...base(bot),
  expandAt: EXPANDS[i],
  revealAt: REVEAL,
});

/**
 * "AI teammates that can do anything", Cowboy Bebop-style: the logo draws
 * on; four colored slices slam in under the title; one by one each opens to
 * full screen while its question is typed, and closes back into its slice
 * on send; then all four play their real answers side by side.
 */
export const AiTeammatesBebop: React.FC<{ withEnd?: boolean }> = ({ withEnd = true }) => {
  const { fps } = useVideoConfig();
  const f = (sec: number) => Math.round(sec * fps);
  return (
    <AbsoluteFill style={{ fontFamily, background: NAVY }}>
      <Sequence name="Logo" durationInFrames={f(LOGO)} premountFor={fps}>
        <LogoIntro />
      </Sequence>
      <Sequence name="Slices" from={f(LOGO)} durationInFrames={f(SEGMENT)} premountFor={fps}>
        <PaneShot
          clip="databot.mp4"
          name="DataBot"
          emoji="📊"
          color={COLORS.databot}
          question="How do we define MAU?"
          timing={timing('databot', 0)}
          pane={pane(0)}
          slant={SLANT}
          enterAt={0}
          enterFrom={-1}
        />
        <PaneShot
          clip="engbot.mp4"
          name="EngBot"
          emoji="🛠️"
          color={COLORS.engbot}
          question="What's the team working on right now?"
          timing={timing('engbot', 1)}
          pane={pane(1)}
          slant={SLANT}
          enterAt={0.08}
          enterFrom={1}
        />
        <PaneShot
          clip="legalbot.mp4"
          name="LegalBot"
          emoji="⚖️"
          color={COLORS.legalbot}
          question="Review the limitations of liability in this contract"
          timing={timing('legalbot', 2)}
          pane={pane(2)}
          slant={SLANT}
          enterAt={0.16}
          enterFrom={-1}
        />
        <PaneShot
          clip="opsbot.mp4"
          name="OpsBot"
          emoji="📈"
          color={COLORS.opsbot}
          question="How are my sales doing over the last 90 days?"
          timing={timing('opsbot', 3)}
          pane={pane(3)}
          slant={SLANT}
          enterAt={0.24}
          enterFrom={1}
        />
        <Sequence name="Title" durationInFrames={f(TITLE_HOLD + 0.2)} premountFor={fps}>
          <SliceTitle holdFor={TITLE_HOLD} />
        </Sequence>
      </Sequence>
      {withEnd ? (
        <Sequence name="End" from={f(LOGO + SEGMENT)} premountFor={fps}>
          <EndCard line="AI teammates that can do anything" />
        </Sequence>
      ) : null}
    </AbsoluteFill>
  );
};

const ease = Easing.bezier(0.16, 1, 0.3, 1);
const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

/** The title on a dark band across the slices, wiping in and out. */
const SliceTitle: React.FC<{ holdFor: number }> = ({ holdFor }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const inP = interpolate(t, [0.35, 0.8], [0, 1], { ...clamp, easing: ease });
  const outP = interpolate(t, [holdFor - 0.35, holdFor], [0, 1], { ...clamp, easing: ease });
  return (
    <AbsoluteFill style={{ justifyContent: 'center', zIndex: 20 }}>
      <div
        style={{
          background: '#0b0d12',
          padding: '34px 0 40px',
          textAlign: 'center',
          clipPath: `inset(0 ${100 * outP}% 0 ${100 * (1 - inP)}%)`,
        }}
      >
        <div
          style={{
            color: '#f4f7fb',
            fontSize: 112,
            fontWeight: 700,
            letterSpacing: '-0.03em',
            lineHeight: 1.05,
          }}
        >
          AI teammates that can do anything
        </div>
      </div>
    </AbsoluteFill>
  );
};
