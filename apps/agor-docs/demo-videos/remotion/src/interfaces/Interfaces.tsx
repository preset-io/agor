import { loadFont } from '@remotion/google-fonts/SpaceGrotesk';
import { Video } from '@remotion/media';
import type React from 'react';
import {
  AbsoluteFill,
  Easing,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import marks from '../teammates/marks.json';
import {
  type ChatBeats,
  ClaudeDesktopStage,
  DiscordStage,
  SlackStage,
  STAGE_H,
  STAGE_W,
} from './stages';

const { fontFamily } = loadFont('normal', { weights: ['600', '700'] });

export const INTERFACES_SECONDS = 5;

const ease = Easing.bezier(0.16, 1, 0.3, 1);
const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

// An off-axis cross of black gutters cuts the frame into four uneven
// comic panels: a vertical gutter leaning left, a horizontal one tilting up.
const TOP_X = 1010; // vertical gutter at the top edge
const BOTTOM_X = 900; // ...and at the bottom edge
const LEFT_Y = 575; // horizontal gutter at the left edge
const RIGHT_Y = 495; // ...and at the right edge
const GUTTER = 18;
// Where the gutters cross (solve the two lines).
const cross = (() => {
  // x = TOP_X + (BOTTOM_X - TOP_X) * y / 1080 ; y = LEFT_Y + (RIGHT_Y - LEFT_Y) * x / 1920
  const a = (BOTTOM_X - TOP_X) / 1080;
  const b = (RIGHT_Y - LEFT_Y) / 1920;
  const y = (LEFT_Y + b * TOP_X) / (1 - a * b);
  return { x: TOP_X + a * y, y };
})();

type Pt = [number, number];
interface Panel {
  poly: Pt[];
  /** Bounding box the stage is fitted to. */
  box: { x: number; y: number; w: number; h: number };
}
const C: Pt = [cross.x, cross.y];
const PANELS: Record<'tl' | 'tr' | 'bl' | 'br', Panel> = {
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

/** A panel: clipped to its shape, stage fitted to its box, punching in at `at`. */
const PanelFrame: React.FC<{
  panel: Panel;
  at: number;
  label: string;
  color: string;
  labelCorner: 'tl' | 'tr' | 'bl' | 'br';
  children: React.ReactNode;
}> = ({ panel, at, label, color, labelCorner, children }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const p = interpolate(t, [at, at + 0.4], [0, 1], { ...clamp, easing: ease });
  const scale = Math.max(panel.box.w / STAGE_W, panel.box.h / STAGE_H);
  const { box } = panel;
  const tab: React.CSSProperties = {
    position: 'absolute',
    padding: '10px 26px',
    background: color,
    color: '#0b0d12',
    fontSize: 38,
    fontWeight: 700,
    letterSpacing: '-0.02em',
    clipPath: 'polygon(14px 0, 100% 0, calc(100% - 14px) 100%, 0 100%)',
    opacity: interpolate(t, [at + 0.15, at + 0.45], [0, 1], clamp),
    ...(labelCorner.startsWith('t') ? { top: box.y + 26 } : { bottom: 1080 - box.y - box.h + 26 }),
    ...(labelCorner.endsWith('l') ? { left: box.x + 30 } : { right: 1920 - box.x - box.w + 30 }),
  };
  return (
    <>
      <AbsoluteFill style={{ clipPath: polygon(panel.poly) }}>
        <div
          style={{
            position: 'absolute',
            left: box.x + (box.w - STAGE_W * scale) / 2,
            top: box.y + (box.h - STAGE_H * scale) / 2,
            width: STAGE_W,
            height: STAGE_H,
            transformOrigin: 'top left',
            scale: String(scale * (1 + 0.12 * (1 - p))),
            opacity: p,
          }}
        >
          {children}
        </div>
      </AbsoluteFill>
      <div style={tab}>{label}</div>
    </>
  );
};

/** The real Agor session: EngBot's answer landing (from the teammates clip). */
const AgorStage: React.FC<{ startAt: number }> = ({ startAt }) => {
  const { fps } = useVideoConfig();
  const m = marks.engbot;
  // The session panel's lower area, where the answer lands (app space, 16:9).
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
        <Video
          src={staticFile('clips/engbot.mp4')}
          trimBefore={Math.round((m.sent - 0.4 - startAt * 1.6) * fps)}
          playbackRate={1.6}
          muted
          style={{ width: '100%', height: '100%' }}
        />
      </div>
    </div>
  );
};

const BEATS: Record<'slack' | 'discord' | 'claude', ChatBeats> = {
  slack: { askAt: 0.55, replyAt: 2.2 },
  discord: { askAt: 0.7, replyAt: 2.65 },
  claude: { askAt: 0.85, replyAt: 3.1 },
};

/**
 * "Talk to them from anywhere": the same question to EngBot from Slack,
 * Discord, Claude Desktop (through Agor's MCP server) and Agor itself, in
 * four comic panels cut by an off-axis cross of black gutters.
 */
export const Interfaces: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  return (
    <AbsoluteFill style={{ background: '#050608', fontFamily }}>
      <PanelFrame panel={PANELS.tl} at={0} label="Slack" color="#f472b6" labelCorner="tr">
        <SlackStage t={t} beats={BEATS.slack} />
      </PanelFrame>
      <PanelFrame panel={PANELS.tr} at={0.08} label="Discord" color="#60a5fa" labelCorner="tr">
        <DiscordStage t={t} beats={BEATS.discord} />
      </PanelFrame>
      <PanelFrame
        panel={PANELS.bl}
        at={0.16}
        label="Claude Desktop · MCP"
        color="#fbbf24"
        labelCorner="bl"
      >
        <ClaudeDesktopStage t={t} beats={BEATS.claude} />
      </PanelFrame>
      <PanelFrame panel={PANELS.br} at={0.24} label="Agor" color="#2dd4bf" labelCorner="br">
        <AgorStage startAt={0} />
      </PanelFrame>
      {/* The gutters, drawn over the panel edges. */}
      <svg width={1920} height={1080} style={{ position: 'absolute', inset: 0 }} aria-hidden="true">
        <line x1={TOP_X} y1={-10} x2={BOTTOM_X} y2={1090} stroke="#050608" strokeWidth={GUTTER} />
        <line x1={-10} y1={LEFT_Y} x2={1930} y2={RIGHT_Y} stroke="#050608" strokeWidth={GUTTER} />
      </svg>
    </AbsoluteFill>
  );
};
