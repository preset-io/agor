import { Video } from '@remotion/media';
import type React from 'react';
import {
  AbsoluteFill,
  Easing,
  Img,
  interpolate,
  Sequence,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { BrandMark } from '../brand/BrandMark';
import { type Act, CURSOR, type Pt as Point, Troupe } from '../brand/Cursors';
import { fontFamily } from '../brand/fonts';
import { Heading } from '../brand/Heading';
import { BG, FILL_BLUE, FILL_GREEN, FILL_INDIGO, FILL_TEAL, INK } from '../brand/palette';
import { FadeToBlack } from '../teammates/Bebop';
import marks from '../teammates/marks.json';
import {
  type ChatBeats,
  ClaudeDesktopStage,
  DiscordStage,
  SlackStage,
  STAGE_H,
  STAGE_W,
} from './stages';

// Pacing, in seconds (the section starts and ends on black).
const TITLE_IN = 0.2; // the title's words rise in, alone on black
const TITLE_OUT = 2.5; // its band wipes away
/** When each color segment spins in behind the title. */
const SPIN_AT = [0.9, 1.0, 1.1, 1.2];
const SPIN = 0.65;
/** When each app's mark pops onto its segment. */
const MARK_AT = [1.35, 1.43, 1.51, 1.59];
/** When each segment crops down to its name label, revealing the recording. */
const WIPE_AT = [2.7, 3.0, 3.3, 3.6];
const WIPE = 0.6;
const FADE_AT = 7.0;
const FADE = 0.6;
export const INTERFACES_SECONDS = FADE_AT + FADE;

const ease = Easing.bezier(0.16, 1, 0.3, 1);
const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

// An off-axis cross of black gutters cuts the frame into four uneven
// comic panels: a vertical gutter leaning left, a horizontal one tilting up.
const TOP_X = 1010;
const BOTTOM_X = 900;
const LEFT_Y = 575;
const RIGHT_Y = 495;
const GUTTER = 18;
const cross = (() => {
  const a = (BOTTOM_X - TOP_X) / 1080;
  const b = (RIGHT_Y - LEFT_Y) / 1920;
  const y = (LEFT_Y + b * TOP_X) / (1 - a * b);
  return { x: TOP_X + a * y, y };
})();

type Pt = [number, number];
type Corner = 'tl' | 'tr' | 'bl' | 'br';
interface Panel {
  poly: Pt[];
  box: { x: number; y: number; w: number; h: number };
}
const C: Pt = [cross.x, cross.y];
const PANELS: Record<Corner, Panel> = {
  tl: { poly: [[0, 0], [TOP_X, 0], C, [0, LEFT_Y]], box: { x: 0, y: 0, w: TOP_X, h: LEFT_Y } },
  tr: {
    poly: [[TOP_X, 0], [1920, 0], [1920, RIGHT_Y], C],
    box: { x: cross.x, y: 0, w: 1920 - cross.x, h: cross.y },
  },
  bl: {
    poly: [[0, LEFT_Y], C, [BOTTOM_X, 1080], [0, 1080]],
    box: { x: 0, y: cross.y, w: cross.x, h: 1080 - cross.y },
  },
  br: {
    poly: [C, [1920, RIGHT_Y], [1920, 1080], [BOTTOM_X, 1080]],
    box: { x: BOTTOM_X, y: RIGHT_Y, w: 1920 - BOTTOM_X, h: 1080 - RIGHT_Y },
  },
};
const polygon = (pts: Pt[]) => `polygon(${pts.map(([x, y]) => `${x}px ${y}px`).join(', ')})`;

/** Label geometry: the name's type size and a rough width for it. */
const LABEL_SIZE = 38;
const labelWidth = (name: string) => name.length * LABEL_SIZE * 0.56 + 56;
const LABEL_H = LABEL_SIZE + 22;
const lerpRect = (
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
  p: number
) => ({
  x: a.x + (b.x - a.x) * p,
  y: a.y + (b.y - a.y) * p,
  w: a.w + (b.w - a.w) * p,
  h: a.h + (b.h - a.h) * p,
});

/**
 * A panel:
 * - its color segment spins in around the cross's center;
 * - the app's mark pops on, on a white tile, with the name under it;
 * - then the segment crops down to just the name and slides it into the
 *   panel's outer corner as its label, uncovering the recording behind.
 */
const PanelFrame: React.FC<{
  corner: Corner;
  color: string;
  name: string;
  mark: React.ReactNode;
  spinAt: number;
  markAt: number;
  wipeAt: number;
  children: React.ReactNode;
}> = ({ corner, color, name, mark, spinAt, markAt, wipeAt, children }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const panel = PANELS[corner];
  const { box } = panel;
  const spin = interpolate(t, [spinAt, spinAt + SPIN], [0, 1], { ...clamp, easing: ease });
  const pop = interpolate(t, [markAt, markAt + 0.4], [0, 1], {
    ...clamp,
    easing: Easing.bezier(0.34, 1.56, 0.64, 1),
  });
  const crop = interpolate(t, [wipeAt, wipeAt + WIPE], [0, 1], { ...clamp, easing: ease });
  const scale = Math.max(box.w / STAGE_W, box.h / STAGE_H);
  const top = corner.startsWith('t');
  const leftSide = corner.endsWith('l');
  const sign = corner === 'tl' || corner === 'br' ? -1 : 1;

  // The color block: the whole panel, cropping down to the label.
  const lw = labelWidth(name);
  const label = {
    x: leftSide ? box.x + 30 : box.x + box.w - 30 - lw,
    y: top ? box.y + 26 : box.y + box.h - 26 - LABEL_H,
    w: lw,
    h: LABEL_H,
  };
  const block = lerpRect(box, label, crop);
  // The name: from under the mark to the middle of the label.
  // The mark sits clear of the title band across the middle.
  const markY = box.y + box.h / 2 - (top ? 90 : 20);
  const startName = { x: box.x + box.w / 2, y: markY + 150 };
  const nameX = startName.x + (label.x + label.w / 2 - startName.x) * crop;
  const nameY = startName.y + (label.y + label.h / 2 - startName.y) * crop;
  const slant = 14 * crop;
  return (
    <AbsoluteFill
      style={{
        transformOrigin: `${cross.x}px ${cross.y}px`,
        rotate: `${sign * 100 * (1 - spin)}deg`,
        scale: String(0.4 + 0.6 * spin),
        opacity: spin > 0 ? 1 : 0,
      }}
    >
      <AbsoluteFill style={{ clipPath: polygon(panel.poly) }}>
        {/* The recording, uncovered as the block crops away. */}
        {crop > 0 ? (
          <div
            style={{
              position: 'absolute',
              left: box.x + (box.w - STAGE_W * scale) / 2,
              top: box.y + (box.h - STAGE_H * scale) / 2,
              width: STAGE_W,
              height: STAGE_H,
              transformOrigin: 'top left',
              scale: String(scale),
            }}
          >
            {children}
          </div>
        ) : null}
        <div
          style={{
            position: 'absolute',
            left: block.x,
            top: block.y,
            width: block.w,
            height: block.h,
            background: color,
            clipPath: `polygon(${slant}px 0, 100% 0, calc(100% - ${slant}px) 100%, 0 100%)`,
          }}
        />
        {/* The mark on its white tile. */}
        <div
          style={{
            position: 'absolute',
            left: box.x + box.w / 2 - 110,
            top: markY - 110,
            width: 220,
            height: 220,
            borderRadius: 48,
            background: '#ffffff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 18px 40px rgba(0,0,0,0.25)',
            scale: String(pop * (1 - interpolate(crop, [0, 0.45], [0, 1], clamp))),
          }}
        >
          {mark}
        </div>
        <div
          style={{
            position: 'absolute',
            left: nameX - 600,
            width: 1200,
            top: nameY - (52 + (LABEL_SIZE - 52) * crop) * 0.62,
            textAlign: 'center',
            whiteSpace: 'nowrap',
            color: INK,
            fontSize: 52 + (LABEL_SIZE - 52) * crop,
            fontWeight: 700,
            letterSpacing: '-0.02em',
            opacity: pop,
          }}
        >
          {name}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

/** The section title: its words rise in, alone on black, over a black band
 * that keeps them readable once the segments spin in behind. */
const Title: React.FC<{ text: string }> = ({ text }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const out = interpolate(t, [TITLE_OUT, TITLE_OUT + 0.4], [0, 1], { ...clamp, easing: ease });
  return (
    <AbsoluteFill style={{ justifyContent: 'center', zIndex: 20 }}>
      <div
        style={{
          background: BG,
          padding: '34px 0 40px',
          textAlign: 'center',
          clipPath: `inset(0 ${100 * out}% 0 0)`,
        }}
      >
        <Heading
          text={text}
          size={112}
          at={TITLE_IN}
          stagger={0.07}
          style={{ display: 'inline-block' }}
        />
      </div>
    </AbsoluteFill>
  );
};

/** The real Agor session: EngBot's answer landing (from the teammates clip). */
const AgorStage: React.FC<{ startAt: number }> = ({ startAt }) => {
  const { fps } = useVideoConfig();
  const m = marks.engbot;
  const view = { x: 960, y: 330, w: 960, h: 540 };
  const k = STAGE_W / view.w;
  return (
    <div
      style={{
        width: STAGE_W,
        height: STAGE_H,
        overflow: 'hidden',
        position: 'relative',
        background: '#141414',
      }}
    >
      <div
        style={{
          position: 'absolute',
          left: -view.x * k,
          top: -view.y * k,
          width: 1920 * k,
          height: 1080 * k,
        }}
      >
        <Sequence from={Math.round(startAt * fps)} premountFor={fps}>
          <Video
            src={staticFile('clips/engbot.mp4')}
            // Just before EngBot's table lands (the wait before it is dead air).
            trimBefore={Math.round((m.sent + 2.2) * fps)}
            playbackRate={1.6}
            muted
            style={{ width: '100%', height: '100%' }}
          />
        </Sequence>
      </div>
    </div>
  );
};

/** Where a panel's mark tile sits once it has spun in (see PanelFrame). */
const tileCenter = (corner: Corner): Point => {
  const { box } = PANELS[corner];
  return {
    x: box.x + box.w / 2 - 18,
    y: box.y + box.h / 2 - (corner.startsWith('t') ? 90 : 20) - 14,
  };
};
/**
 * The troupe from the first section comes back: each cursor flies in from
 * its side, clicks its app's mark (which crops the panel down to its
 * label), and heads back out.
 */
const CLICKERS: { corner: Corner; color: string; side: Point }[] = [
  { corner: 'tl', color: CURSOR.maya, side: { x: -90, y: 160 } },
  { corner: 'tr', color: CURSOR.sam, side: { x: 2010, y: 120 } },
  { corner: 'bl', color: CURSOR.ari, side: { x: -90, y: 1000 } },
  { corner: 'br', color: CURSOR.lee, side: { x: 2010, y: 1040 } },
];
const ACTS: Act[] = CLICKERS.map((c, i) => {
  const clickAt = WIPE_AT[i] - 0.05;
  return {
    color: c.color,
    from: c.side,
    moves: [
      { at: clickAt - 1.0, to: tileCenter(c.corner), hz: 2.3 },
      {
        at: clickAt + 0.3,
        to: { x: c.side.x, y: c.side.y + (c.side.y < 540 ? 60 : -60) },
        hz: 1.7,
      },
    ],
    clicks: [clickAt],
  };
});

const beats = (wipeAt: number, reply: number): ChatBeats => ({
  askAt: wipeAt + 0.45,
  replyAt: wipeAt + reply,
});

/**
 * "Access Agor from where you work": from black, the title rises in; four
 * comic-panel color segments (an off-axis cross of black gutters) spin in
 * behind it and each app's mark pops on; then one by one each segment crops
 * down to its name label, uncovering the same question to EngBot from
 * Slack, Discord, Claude Desktop (through Agor's MCP server) and Agor. Ends
 * on black.
 */
export const Interfaces: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const gutters = interpolate(t, [SPIN_AT[3] + SPIN * 0.6, SPIN_AT[3] + SPIN], [0, 1], clamp);
  return (
    <AbsoluteFill style={{ background: BG, fontFamily }}>
      <PanelFrame
        corner="tl"
        color={FILL_GREEN}
        name="Slack"
        mark={<BrandMark icon="slack-icon" size={130} />}
        spinAt={SPIN_AT[0]}
        markAt={MARK_AT[0]}
        wipeAt={WIPE_AT[0]}
      >
        <SlackStage t={t} beats={beats(WIPE_AT[0], 1.5)} />
      </PanelFrame>
      <PanelFrame
        corner="tr"
        color={FILL_INDIGO}
        name="Discord"
        mark={<BrandMark icon="discord-icon" size={140} />}
        spinAt={SPIN_AT[1]}
        markAt={MARK_AT[1]}
        wipeAt={WIPE_AT[1]}
      >
        <DiscordStage t={t} beats={beats(WIPE_AT[1], 1.6)} />
      </PanelFrame>
      <PanelFrame
        corner="bl"
        color={FILL_BLUE}
        name="Claude Desktop + MCP"
        mark={<BrandMark icon="model-context-protocol" size={140} viewBox="0 0 70 69" />}
        spinAt={SPIN_AT[2]}
        markAt={MARK_AT[2]}
        wipeAt={WIPE_AT[2]}
      >
        <ClaudeDesktopStage t={t} beats={beats(WIPE_AT[2], 1.8)} />
      </PanelFrame>
      <PanelFrame
        corner="br"
        color={FILL_TEAL}
        name="Agor"
        mark={<Img src={staticFile('agor-logo.svg')} style={{ width: 150, height: 150 }} />}
        spinAt={SPIN_AT[3]}
        markAt={MARK_AT[3]}
        wipeAt={WIPE_AT[3]}
      >
        <AgorStage startAt={WIPE_AT[3]} />
      </PanelFrame>
      <svg
        width={1920}
        height={1080}
        style={{ position: 'absolute', inset: 0, opacity: gutters }}
        aria-hidden="true"
      >
        <line x1={TOP_X} y1={-10} x2={BOTTOM_X} y2={1090} stroke={BG} strokeWidth={GUTTER} />
        <line x1={-10} y1={LEFT_Y} x2={1930} y2={RIGHT_Y} stroke={BG} strokeWidth={GUTTER} />
      </svg>
      <Title text="**Access Agor** from where you *work*" />
      <Troupe acts={ACTS} />
      <FadeToBlack at={FADE_AT} seconds={FADE} />
    </AbsoluteFill>
  );
};
