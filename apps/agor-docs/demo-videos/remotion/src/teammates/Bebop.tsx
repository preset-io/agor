import { loadFont } from '@remotion/google-fonts/SpaceGrotesk';
import { AbsoluteFill, Sequence, useVideoConfig } from 'remotion';
import { EndCard, LogoIntro, NAVY, NameCard, TitleCard } from './Cards';
import marks from './marks.json';
import { PaneShot, type PaneTiming } from './PaneShot';

const { fontFamily } = loadFont('normal', { weights: ['500', '600', '700'] });

type Bot = keyof typeof marks;

// Pacing, in seconds.
const LOGO = 4.6;
const TITLE = 2.4;
const NAME_CARD = 0.75;
const PROMPT_RATE = 1.8;
const ANSWER_RATE = 1.25;
const SHRINK = 0.6;
const HOLD = 1.4;
const END = 2.8;

// Four slanted panes edge to edge across the frame, overlapping by the
// slant; the outer two run past the frame edges so no background shows.
const SLANT = 56;
const PANE_W = 480 + 1.25 * SLANT;
const pane = (i: number) => ({ x: i * (PANE_W - SLANT) - SLANT, y: 0, w: PANE_W, h: 1080 });

const BOTS: { bot: Bot; name: string; emoji: string; color: string }[] = [
  { bot: 'databot', name: 'DataBot', emoji: '📊', color: '#2dd4bf' },
  { bot: 'engbot', name: 'EngBot', emoji: '🛠️', color: '#60a5fa' },
  { bot: 'legalbot', name: 'LegalBot', emoji: '⚖️', color: '#fbbf24' },
  { bot: 'opsbot', name: 'OpsBot', emoji: '📈', color: '#f472b6' },
];

const trimFrom = (bot: Bot) => Math.max(0, marks[bot].question - 0.2);
const sentAt = (bot: Bot) => (marks[bot].sent - trimFrom(bot)) / PROMPT_RATE;
const playFor = (bot: Bot) => (marks[bot].answered + 1.5 - marks[bot].sent) / ANSWER_RATE;

// Each prompt starts as the one before it starts shrinking into its pane.
const SHOTS_AT = LOGO + TITLE + NAME_CARD * 0.6;
const STARTS = BOTS.reduce<number[]>(
  (acc, b, i) => (i === 0 ? [SHOTS_AT] : [...acc, acc[i - 1] + sentAt(BOTS[i - 1].bot) + 0.3]),
  []
);
const last = BOTS.length - 1;
/** All four panes play their answers together from here. */
const REVEAL = STARTS[last] + sentAt(BOTS[last].bot) + SHRINK + 0.15;
const PLAYED = REVEAL + Math.max(...BOTS.map((b) => playFor(b.bot))) + HOLD;
export const BEBOP_SECONDS = PLAYED + END;

const timing = (bot: Bot, start: number): PaneTiming => ({
  trimFrom: trimFrom(bot),
  sentSrc: marks[bot].sent,
  answeredSrc: marks[bot].answered,
  promptRate: PROMPT_RATE,
  answerRate: ANSWER_RATE,
  revealAt: REVEAL - start,
});

const QUESTIONS: Record<Bot, string> = {
  databot: 'How do we define MAU?',
  engbot: "What's the team working on right now?",
  legalbot: 'Review the limitations of liability in this contract',
  opsbot: 'How are my sales doing over the last 90 days?',
};

/**
 * "AI teammates that can do anything", Cowboy Bebop-style: the logo, a
 * title slam, then four rapid questions (name card, prompt typed close up,
 * shrink into a slanted pane on send), then all four panes play their real
 * answers side by side, and an end card.
 */
export const AiTeammatesBebop: React.FC = () => {
  const { fps } = useVideoConfig();
  const f = (sec: number) => Math.round(sec * fps);
  return (
    <AbsoluteFill style={{ fontFamily, background: NAVY }}>
      <Sequence name="Logo" durationInFrames={f(LOGO)} premountFor={fps}>
        <LogoIntro />
      </Sequence>
      <Sequence
        name="Title"
        from={f(LOGO)}
        durationInFrames={f(TITLE + NAME_CARD)}
        premountFor={fps}
      >
        <TitleCard top="AI teammates" bottom="that can do anything" />
      </Sequence>

      <Sequence name="DataBot" from={f(STARTS[0])} premountFor={fps}>
        <PaneShot
          clip="databot.mp4"
          name="DataBot"
          emoji="📊"
          color={BOTS[0].color}
          question={QUESTIONS.databot}
          timing={timing('databot', STARTS[0])}
          pane={pane(0)}
          slant={SLANT}
        />
      </Sequence>
      <Sequence
        name="DataBot card"
        from={f(STARTS[0] - NAME_CARD * 0.6)}
        durationInFrames={f(NAME_CARD)}
        premountFor={fps}
      >
        <NameCard name="DataBot" emoji="📊" color={BOTS[0].color} seconds={NAME_CARD} />
      </Sequence>

      <Sequence name="EngBot" from={f(STARTS[1])} premountFor={fps}>
        <PaneShot
          clip="engbot.mp4"
          name="EngBot"
          emoji="🛠️"
          color={BOTS[1].color}
          question={QUESTIONS.engbot}
          timing={timing('engbot', STARTS[1])}
          pane={pane(1)}
          slant={SLANT}
        />
      </Sequence>
      <Sequence
        name="EngBot card"
        from={f(STARTS[1] - NAME_CARD * 0.6)}
        durationInFrames={f(NAME_CARD)}
        premountFor={fps}
      >
        <NameCard name="EngBot" emoji="🛠️" color={BOTS[1].color} seconds={NAME_CARD} />
      </Sequence>

      <Sequence name="LegalBot" from={f(STARTS[2])} premountFor={fps}>
        <PaneShot
          clip="legalbot.mp4"
          name="LegalBot"
          emoji="⚖️"
          color={BOTS[2].color}
          question={QUESTIONS.legalbot}
          timing={timing('legalbot', STARTS[2])}
          pane={pane(2)}
          slant={SLANT}
        />
      </Sequence>
      <Sequence
        name="LegalBot card"
        from={f(STARTS[2] - NAME_CARD * 0.6)}
        durationInFrames={f(NAME_CARD)}
        premountFor={fps}
      >
        <NameCard name="LegalBot" emoji="⚖️" color={BOTS[2].color} seconds={NAME_CARD} />
      </Sequence>

      <Sequence name="OpsBot" from={f(STARTS[3])} premountFor={fps}>
        <PaneShot
          clip="opsbot.mp4"
          name="OpsBot"
          emoji="📈"
          color={BOTS[3].color}
          question={QUESTIONS.opsbot}
          timing={timing('opsbot', STARTS[3])}
          pane={pane(3)}
          slant={SLANT}
        />
      </Sequence>
      <Sequence
        name="OpsBot card"
        from={f(STARTS[3] - NAME_CARD * 0.6)}
        durationInFrames={f(NAME_CARD)}
        premountFor={fps}
      >
        <NameCard name="OpsBot" emoji="📈" color={BOTS[3].color} seconds={NAME_CARD} />
      </Sequence>

      <Sequence name="End" from={f(PLAYED)} premountFor={fps}>
        <EndCard line="AI teammates that can do anything" />
      </Sequence>
    </AbsoluteFill>
  );
};
