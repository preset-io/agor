import {
  AbsoluteFill,
  Easing,
  interpolate,
  Sequence,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { type Act, CURSOR, type Pt, Troupe } from '../brand/Cursors';
import { fontFamily } from '../brand/fonts';
import { Heading } from '../brand/Heading';
import { BG, FILL_BLUE, FILL_GREEN, FILL_INDIGO, FILL_TEAL } from '../brand/palette';
import { EndCard, LOGO_INTRO_SECONDS, LogoIntro, NAVY, SLOGAN_AT, TOGETHER } from './Cards';
import marks from './marks.json';
import {
  EXIT,
  keyAt,
  layoutAt,
  NAME_SPOT,
  NAME_STAGGER,
  PROMPT_LEAD,
  promptPoint,
  promptSeconds,
  REVEAL,
  type SliceSpec,
  Slices,
  type SlicesTiming,
  sliceCenter,
} from './Slices';

type Bot = keyof typeof marks;

// Pacing, in seconds.
const LOGO = LOGO_INTRO_SECONDS; // the wordmark, the slogan, the cursors
const NAMES_AT = 1.0; // the names pop on, one at a time
const TITLE_HOLD = 3.3; // the slices, the title and the names, before the first opens
const ANSWER_RATE = 1.6;
const HOLD = 1.8; // after the last answer lands, before the slices slide off
const END = 1.8;

const spec = (
  bot: Bot,
  rest: Omit<SliceSpec, 'question0' | 'sent' | 'answered' | 'stillsDir' | 'stills'>
): SliceSpec => ({
  ...rest,
  question0: marks[bot].question,
  sent: marks[bot].sent,
  answered: marks[bot].answered,
  stillsDir: `${bot}-stills`,
  stills: marks[bot].stills,
});

const SLICES: SliceSpec[] = [
  spec('databot', {
    clip: 'databot.mp4',
    name: 'DataBot',
    color: FILL_GREEN,
    question: 'How do we define MAU?',
    insight: 'Reconciled MAU, opened a PR',
    focus: { cx: 1150, cy: 600 },
  }),
  spec('engbot', {
    clip: 'engbot.mp4',
    name: 'EngBot',
    color: FILL_TEAL,
    question: "What's the team working on right now?",
    insight: "Who's on what, PR by PR",
    focus: { cx: 1150, cy: 620 },
  }),
  spec('legalbot', {
    clip: 'legalbot.mp4',
    name: 'LegalBot',
    color: FILL_BLUE,
    question: 'Review the limitations of liability in this contract',
    insight: 'Redlined the liability cap',
    focus: { cx: 1150, cy: 450 },
  }),
  spec('opsbot', {
    clip: 'opsbot.mp4',
    name: 'OpsBot',
    color: FILL_INDIGO,
    question: 'How are my sales doing over the last 90 days?',
    insight: 'Sales up 15% in 90 days',
    focus: { cx: 1150, cy: 540 },
  }),
];

// Each slice opens just after the one before it sends its question.
const OPEN_AT: number[] = [TITLE_HOLD];
for (let i = 1; i < SLICES.length; i++) {
  const prev = SLICES[i - 1];
  OPEN_AT.push(OPEN_AT[i - 1] + PROMPT_LEAD + promptSeconds(prev) + 0.15);
}
const last = SLICES[SLICES.length - 1];
const REVEAL_AT = OPEN_AT[OPEN_AT.length - 1] + PROMPT_LEAD + promptSeconds(last) + 0.2;
const playFor = (s: SliceSpec) => (s.answered + 1.5 - s.sent) / ANSWER_RATE;
const EXIT_AT = REVEAL_AT + REVEAL + Math.max(...SLICES.map(playFor)) + HOLD;
const SEGMENT = EXIT_AT + EXIT + 0.07 * (SLICES.length - 1) + 0.15;
export const BEBOP_SECONDS = LOGO + SEGMENT + END;
const TIMING: SlicesTiming = { openAt: OPEN_AT, revealAt: REVEAL_AT, answerRate: ANSWER_RATE };

// The cursor troupe (times in seconds from the start of the logo). They swoop
// in from the edges once the slogan is up and circle "together" twice; then
// each takes a teammate: clicks its slice open and sits at the input, tapping
// along as the question types out, and leaves as the slice closes.
const ENTER = SLOGAN_AT + 0.6;
const LAP = 0.75;
const ORBIT_END = ENTER + 0.5 + 2 * LAP;
const orbit =
  (phase: number) =>
  (t: number): Pt => {
    const a = phase + ((t - ENTER) / LAP) * 2 * Math.PI;
    return { x: TOGETHER.x + Math.cos(a) * 300, y: TOGETHER.y + Math.sin(a) * 92 };
  };
/** Who takes which teammate, where they come from, and where they leave to. */
const CREW: { color: string; from: Pt; away: Pt }[] = [
  { color: CURSOR.maya, from: { x: -90, y: 330 }, away: { x: 300, y: 1260 } },
  { color: CURSOR.sam, from: { x: 2010, y: 180 }, away: { x: 2080, y: 900 } },
  { color: CURSOR.ari, from: { x: 820, y: -90 }, away: { x: 900, y: 1260 } },
  { color: CURSOR.lee, from: { x: 1450, y: 1170 }, away: { x: 2080, y: 1000 } },
];
/** The caret's spot after k characters (app px; the capture's input row, ~7.8 px a character). */
const caret = (s: SliceSpec, k: number): Pt => ({
  x: s.stills.rect.x + 92 + k * 7.76 + 5,
  y: s.stills.rect.y + 214,
});
const ACTS: Act[] = CREW.map((c, i) => {
  const s = SLICES[i];
  const n = SLICES.length;
  const local = (t: number) => t - LOGO;
  const chars = s.stills.count - 1;
  const clickAt = LOGO + OPEN_AT[i] - 0.06;
  const leaveAt = LOGO + (i + 1 < n ? OPEN_AT[i + 1] + 0.1 : REVEAL_AT);
  // Slice i's strip (narrow while another is open) at the names' height.
  const strip = (t: number): Pt => {
    if (local(t) < 0) return NAME_SPOT(i, n);
    const { xs, widths } = layoutAt(local(t), n, TIMING);
    return { x: sliceCenter(xs[i], widths[i], 790), y: 790 };
  };
  const typing = (t: number): Pt => {
    const k = Math.max(
      0,
      Math.min(chars, Math.floor((local(t) - OPEN_AT[i] - PROMPT_LEAD) / 0.062) + 1)
    );
    const at = caret(s, k);
    return promptPoint(local(t), n, TIMING, i, at.x, at.y);
  };
  const orbitIn: Act['moves'] = [
    { at: ENTER + i * 0.06, to: orbit((i * Math.PI) / 2), hz: 2.4 },
    { at: ENTER + 0.5, to: orbit((i * Math.PI) / 2), locked: true },
  ];
  const arrive = clickAt - 1.0;
  return {
    color: c.color,
    from: c.from,
    moves: [
      ...orbitIn,
      // Out of the huddle: the first heads down toward the slices; the rest
      // leave until it's their turn.
      i === 0
        ? { at: ORBIT_END, to: { x: 260, y: 980 }, hz: 1.6 }
        : { at: ORBIT_END + i * 0.05, to: c.from, hz: 2 },
      { at: Math.max(arrive, ORBIT_END + 0.3), to: strip, hz: 2.4 },
      { at: clickAt + 0.12, to: typing, hz: 3.2 },
      { at: leaveAt, to: c.away, hz: 2 },
    ],
    clicks: [clickAt],
    taps: Array.from({ length: chars }, (_, k) => LOGO + keyAt(TIMING, i, k + 1)),
  };
});
void NAME_STAGGER;
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
        <AbsoluteFill style={{ background: BG }} />
        <Slices
          slices={SLICES}
          timing={TIMING}
          enterAt={[0, 0.08, 0.16, 0.24]}
          namesAt={NAMES_AT}
          exitAt={EXIT_AT}
        />
        <Sequence name="Title" durationInFrames={f(TITLE_HOLD + 0.2)} premountFor={fps}>
          <BandTitle text="**AI teammates** that can do *anything*" holdFor={TITLE_HOLD} />
        </Sequence>
      </Sequence>
      <Troupe acts={ACTS} />
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

/** A black overlay fading in from `at` (seconds) (0.6s by default). */
export const FadeToBlack: React.FC<{ at: number; seconds?: number }> = ({ at, seconds = 0.6 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  return (
    <AbsoluteFill
      style={{
        background: BG,
        zIndex: 30,
        opacity: interpolate(t, [at, at + seconds], [0, 1], clamp),
      }}
    />
  );
};

/** A section title (Heading markup) on a dark band across the frame, wiping in and out. */
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
          background: BG,
          padding: '34px 0 40px',
          textAlign: 'center',
          clipPath: `inset(0 ${100 * outP}% 0 ${100 * (1 - inP)}%)`,
        }}
      >
        <Heading text={text} size={112} style={{ display: 'inline-block' }} />
      </div>
    </AbsoluteFill>
  );
};
