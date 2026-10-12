import logos from '@iconify-json/logos/icons.json';
import { loadFont } from '@remotion/google-fonts/SpaceGrotesk';
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
import { BandTitle } from '../teammates/Bebop';
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

const TITLE_HOLD = 1.7;
/** When each panel's recording wipes in (seconds), in reading order. */
const WIPE_AT = [1.85, 2.15, 2.45, 2.75];
const WIPE = 0.55;
export const INTERFACES_SECONDS = 6.6;

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

/** An official brand mark from the CC0 `logos` icon set (unaltered). */
const BrandMark: React.FC<{
  icon: keyof typeof logos.icons;
  size: number;
  /** Crop a lockup to its symbol (e.g. the MCP mark without its wordmark). */
  viewBox?: string;
}> = ({ icon, size, viewBox }) => {
  const data = logos.icons[icon] as { body: string; width?: number; height?: number };
  const w = data.width ?? logos.width ?? 256;
  const h = data.height ?? logos.height ?? 256;
  return (
    <svg
      width={size}
      height={size}
      viewBox={viewBox ?? `0 0 ${w} ${h}`}
      aria-hidden="true"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: static SVG body from the logos icon set
      dangerouslySetInnerHTML={{ __html: data.body }}
    />
  );
};

/**
 * A panel: first a flat color block with the app's mark and name, then its
 * recording wipes in from the panel's outer corner and the mark gives way to
 * a small corner tab.
 */
const PanelFrame: React.FC<{
  corner: Corner;
  color: string;
  name: string;
  mark: React.ReactNode;
  tileBg: string;
  enterAt: number;
  wipeAt: number;
  children: React.ReactNode;
}> = ({ corner, color, name, mark, tileBg, enterAt, wipeAt, children }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const panel = PANELS[corner];
  const { box } = panel;
  const enter = interpolate(t, [enterAt, enterAt + 0.4], [0, 1], { ...clamp, easing: ease });
  const wipe = interpolate(t, [wipeAt, wipeAt + WIPE], [0, 1], { ...clamp, easing: ease });
  const scale = Math.max(box.w / STAGE_W, box.h / STAGE_H);
  const dx = corner.endsWith('l') ? -1 : 1;
  const dy = corner.startsWith('t') ? -1 : 1;
  const tab: React.CSSProperties = {
    position: 'absolute',
    padding: '10px 26px',
    background: color,
    color: '#0b0d12',
    fontSize: 38,
    fontWeight: 700,
    letterSpacing: '-0.02em',
    clipPath: 'polygon(14px 0, 100% 0, calc(100% - 14px) 100%, 0 100%)',
    opacity: interpolate(wipe, [0.6, 1], [0, 1], clamp),
    ...(corner.startsWith('t') ? { top: box.y + 26 } : { bottom: 1080 - box.y - box.h + 26 }),
    ...(corner.endsWith('l') ? { left: box.x + 30 } : { right: 1920 - box.x - box.w + 30 }),
  };
  return (
    <>
      <AbsoluteFill style={{ clipPath: polygon(panel.poly) }}>
        {/* The color block with the app's mark. */}
        <AbsoluteFill style={{ background: color, opacity: enter }}>
          <div
            style={{
              position: 'absolute',
              left: box.x,
              top: box.y,
              width: box.w,
              height: box.h,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 22,
              scale: String(interpolate(enter, [0, 1], [0.85, 1]) * (1 - 0.2 * wipe)),
            }}
          >
            <div
              style={{
                width: 220,
                height: 220,
                borderRadius: 48,
                background: tileBg,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: '0 18px 40px rgba(0,0,0,0.25)',
              }}
            >
              {mark}
            </div>
            <div
              style={{ color: '#0b0d12', fontSize: 52, fontWeight: 700, letterSpacing: '-0.02em' }}
            >
              {name}
            </div>
          </div>
        </AbsoluteFill>
        {/* The recording, wiping in from the outer corner. */}
        <div
          style={{
            position: 'absolute',
            left: box.x + (box.w - STAGE_W * scale) / 2,
            top: box.y + (box.h - STAGE_H * scale) / 2,
            width: STAGE_W,
            height: STAGE_H,
            transformOrigin: 'top left',
            scale: String(scale),
            translate: `${dx * (1 - wipe) * 1100}px ${dy * (1 - wipe) * 640}px`,
            visibility: wipe > 0 ? 'visible' : 'hidden',
          }}
        >
          {children}
        </div>
      </AbsoluteFill>
      <div style={tab}>{name}</div>
    </>
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
            trimBefore={Math.round((m.sent - 0.4) * fps)}
            playbackRate={1.6}
            muted
            style={{ width: '100%', height: '100%' }}
          />
        </Sequence>
      </div>
    </div>
  );
};

const beats = (wipeAt: number, reply: number): ChatBeats => ({
  askAt: wipeAt + 0.45,
  replyAt: wipeAt + reply,
});

/**
 * "Access Agor from where you work": four comic panels (an off-axis cross of
 * black gutters) start as color blocks with each app's mark under the
 * title; then one by one each wipes in to show the same question to EngBot
 * from Slack, Discord, Claude Desktop (through Agor's MCP server) and Agor.
 */
export const Interfaces: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const f = (sec: number) => Math.round(sec * fps);
  return (
    <AbsoluteFill style={{ background: '#050608', fontFamily }}>
      <PanelFrame
        corner="tl"
        color="#f472b6"
        name="Slack"
        tileBg="#ffffff"
        mark={<BrandMark icon="slack-icon" size={130} />}
        enterAt={0}
        wipeAt={WIPE_AT[0]}
      >
        <SlackStage t={t} beats={beats(WIPE_AT[0], 1.5)} />
      </PanelFrame>
      <PanelFrame
        corner="tr"
        color="#60a5fa"
        name="Discord"
        tileBg="#ffffff"
        mark={<BrandMark icon="discord-icon" size={140} />}
        enterAt={0.08}
        wipeAt={WIPE_AT[1]}
      >
        <DiscordStage t={t} beats={beats(WIPE_AT[1], 1.6)} />
      </PanelFrame>
      <PanelFrame
        corner="bl"
        color="#fbbf24"
        name="Claude Desktop + MCP"
        tileBg="#ffffff"
        mark={<BrandMark icon="model-context-protocol" size={140} viewBox="0 0 70 69" />}
        enterAt={0.16}
        wipeAt={WIPE_AT[2]}
      >
        <ClaudeDesktopStage t={t} beats={beats(WIPE_AT[2], 1.8)} />
      </PanelFrame>
      <PanelFrame
        corner="br"
        color="#2dd4bf"
        name="Agor"
        tileBg="#0d1526"
        mark={<Img src={staticFile('agor-logo.svg')} style={{ width: 150, height: 150 }} />}
        enterAt={0.24}
        wipeAt={WIPE_AT[3]}
      >
        <AgorStage startAt={WIPE_AT[3]} />
      </PanelFrame>
      <svg width={1920} height={1080} style={{ position: 'absolute', inset: 0 }} aria-hidden="true">
        <line x1={TOP_X} y1={-10} x2={BOTTOM_X} y2={1090} stroke="#050608" strokeWidth={GUTTER} />
        <line x1={-10} y1={LEFT_Y} x2={1930} y2={RIGHT_Y} stroke="#050608" strokeWidth={GUTTER} />
      </svg>
      <Sequence name="Title" durationInFrames={f(TITLE_HOLD + 0.2)} premountFor={fps}>
        <BandTitle text="Access Agor from where you work" holdFor={TITLE_HOLD} />
      </Sequence>
    </AbsoluteFill>
  );
};
