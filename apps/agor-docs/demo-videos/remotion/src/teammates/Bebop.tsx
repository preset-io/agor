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
import { PROMPT_LEAD, promptSeconds, REVEAL, type SliceSpec, Slices } from './Slices';

const { fontFamily } = loadFont('normal', { weights: ['500', '600', '700'] });

type Bot = keyof typeof marks;

// Pacing, in seconds.
const LOGO = 3.4; // the draw-on is finished and shining by here
const TITLE_HOLD = 2.3; // the slices and the title, before the first opens
const PROMPT_RATE = 1.8;
const ANSWER_RATE = 1.25;
const HOLD = 1.4;
const END = 1.8;
const FADE = 0.6; // to black at the end of the segment

const spec = (bot: Bot, rest: Omit<SliceSpec, 'question0' | 'sent' | 'answered'>): SliceSpec => ({
  ...rest,
  question0: marks[bot].question,
  sent: marks[bot].sent,
  answered: marks[bot].answered,
});

const SLICES: SliceSpec[] = [
  spec('databot', {
    clip: 'databot.mp4',
    name: 'DataBot',
    emoji: '📊',
    color: '#2dd4bf',
    question: 'How do we define MAU?',
  }),
  spec('engbot', {
    clip: 'engbot.mp4',
    name: 'EngBot',
    emoji: '🛠️',
    color: '#60a5fa',
    question: "What's the team working on right now?",
  }),
  spec('legalbot', {
    clip: 'legalbot.mp4',
    name: 'LegalBot',
    emoji: '⚖️',
    color: '#fbbf24',
    question: 'Review the limitations of liability in this contract',
  }),
  spec('opsbot', {
    clip: 'opsbot.mp4',
    name: 'OpsBot',
    emoji: '📈',
    color: '#f472b6',
    question: 'How are my sales doing over the last 90 days?',
  }),
];

// Each slice opens just after the one before it sends its question.
const OPEN_AT: number[] = [TITLE_HOLD];
for (let i = 1; i < SLICES.length; i++) {
  const prev = SLICES[i - 1];
  OPEN_AT.push(OPEN_AT[i - 1] + PROMPT_LEAD + promptSeconds(prev, PROMPT_RATE) + 0.15);
}
const last = SLICES[SLICES.length - 1];
const REVEAL_AT =
  OPEN_AT[OPEN_AT.length - 1] + PROMPT_LEAD + promptSeconds(last, PROMPT_RATE) + 0.2;
const playFor = (s: SliceSpec) => (s.answered + 1.5 - s.sent) / ANSWER_RATE;
const SEGMENT = REVEAL_AT + REVEAL + Math.max(...SLICES.map(playFor)) + HOLD;
export const BEBOP_SECONDS = LOGO + SEGMENT + END;
/** Without the end card (for the combined reel). */
export const BEBOP_BODY_SECONDS = LOGO + SEGMENT;

/**
 * "AI teammates that can do anything", Cowboy Bebop-style: the logo draws
 * on; four colored slices slam in under the title; like an accordion, each
 * opens in turn while its question is typed (its recording sliding up into
 * it) and closes as the next opens; then the slices even out and all four
 * play their real answers side by side.
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
        <Slices
          slices={SLICES}
          timing={{
            openAt: OPEN_AT,
            revealAt: REVEAL_AT,
            promptRate: PROMPT_RATE,
            answerRate: ANSWER_RATE,
          }}
          enterAt={[0, 0.08, 0.16, 0.24]}
        />
        <Sequence name="Title" durationInFrames={f(TITLE_HOLD + 0.2)} premountFor={fps}>
          <BandTitle text="AI teammates that can do anything" holdFor={TITLE_HOLD} />
        </Sequence>
        <FadeToBlack at={SEGMENT - FADE} />
      </Sequence>
      {withEnd ? (
        <Sequence name="End" from={f(LOGO + SEGMENT)} premountFor={fps}>
          <EndCard />
        </Sequence>
      ) : null}
    </AbsoluteFill>
  );
};

const ease = Easing.bezier(0.16, 1, 0.3, 1);
const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

/** A black overlay fading in from `at` (seconds) over FADE. */
export const FadeToBlack: React.FC<{ at: number; seconds?: number }> = ({ at, seconds = FADE }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  return (
    <AbsoluteFill
      style={{
        background: '#000',
        zIndex: 30,
        opacity: interpolate(t, [at, at + seconds], [0, 1], clamp),
      }}
    />
  );
};

/** A section title on a dark band across the frame, wiping in and out. */
export const BandTitle: React.FC<{ text: string; holdFor: number }> = ({ text, holdFor }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const inP = interpolate(t, [0.35, 0.8], [0, 1], { ...clamp, easing: ease });
  const outP = interpolate(t, [holdFor - 0.35, holdFor], [0, 1], { ...clamp, easing: ease });
  void fps;
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
          {text}
        </div>
      </div>
    </AbsoluteFill>
  );
};
