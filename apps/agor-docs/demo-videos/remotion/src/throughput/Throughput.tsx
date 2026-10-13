import type React from 'react';
import { AbsoluteFill, interpolate, Sequence, useCurrentFrame, useVideoConfig } from 'remotion';
import { type BrandIcon, BrandMark } from '../brand/BrandMark';
import { bowed, CURSOR, Cursor, clickState, type Pt } from '../brand/Cursors';
import { fontFamily } from '../brand/fonts';
import { Heading } from '../brand/Heading';
import { BG_GRADIENT, FILL_BLUE, FILL_INDIGO, FILL_TEAL, INK } from '../brand/palette';
import marks from './marks.json';
import {
  type Box,
  caretAt,
  clamp,
  clickTimes,
  ease,
  onTrack,
  ShotAt,
  type ShotSpec,
  type Stills,
  shotEnd,
  smooth,
  TypingStrip,
  toScreen,
  typingSeconds,
} from './shots';

// "Multiply engineering throughput": one engineering team's board, start to
// merge. The troupe carries it: Maya (the EM) picks the board and asks
// EngBot for it and for work; Ari, Sam, Lee and Kit drag the tickets into
// In Progress; then they let go while the agents run the loop (Claude
// builds, Codex reviews, QA tests), until Rho merges and Maya asks for 50
// more. Off-square throughout: tilted frames, angled shards, whip pans.
//
// Clips: e2e eng-build (real EngBot turns, replayed), eng-fanout (five
// real zone-triggered sessions, held running), eng-flow (the loop staged
// live on the real board). `npm run sync` brings them in with their marks.

const M = marks as unknown as {
  'eng-build': Record<string, number> & { stills: { rect: Stills['rect']; count: number } };
  'eng-fanout': Record<string, number>;
  'eng-flow': Record<string, number> & { stills: { rect: Stills['rect']; count: number } };
};
const B = M['eng-build'];
const F = M['eng-fanout'];
const W = M['eng-flow'];

// The typing: eng-build typed two asks into Compose, eng-flow one.
const KANBAN: Stills = { dir: 'eng-build-stills', first: 0, last: 41, rect: B.stills.rect };
const ISSUES: Stills = {
  dir: 'eng-build-stills',
  first: 42,
  last: B.stills.count - 1,
  rect: B.stills.rect,
};
const MORE: Stills = {
  dir: 'eng-flow-stills',
  first: 0,
  last: W.stills.count - 1,
  rect: W.stills.rect,
};
const TYPE_TAIL = 0.3;

// Card centers on the EngTeam board in eng-flow (app px, from gridded frames).
const LANE = { progress: 423, review: 858, qa: 1293 };
const LANE_Y = 330;
const READY = { x: 960, y: 380 };
const MERGED = { x: 1400, y: 380 };

// ---- Timeline (composition seconds) ----
const TITLE = 2.8;
const PICK_AT = TITLE;
const PICK: ShotSpec = {
  clip: 'eng-build',
  from: B.picker - 0.1,
  to: B.board + 0.3,
  rate: 2.4,
  start: PICK_AT,
  keys: [
    { at: B.picker, cx: 640, cy: 350, z: 1.35 },
    { at: B.board, cx: 700, cy: 400, z: 1.3 },
  ],
  box: { x: 90, y: 70, w: 1740, h: 940, rot: -5 },
};
const KANBAN_AT = shotEnd(PICK) + 0.05;
const KANBAN_END = KANBAN_AT + typingSeconds(KANBAN) + TYPE_TAIL;
const ZONES: ShotSpec = {
  clip: 'eng-build',
  from: B['zones-start'] - 0.5,
  to: B['zones-start'] + 1.6,
  rate: 1.4,
  start: KANBAN_END,
  keys: [
    { at: B['zones-start'] - 0.5, cx: 988, cy: 600, z: 1.08 },
    { at: B['zones-start'] + 1.6, cx: 988, cy: 600, z: 1.16 },
  ],
  // Snaps level as the zones land: from the strip's tilt, with an overshoot.
  box: (t) => ({
    x: 40,
    y: 40,
    w: 1840,
    h: 1000,
    rot: interpolate(t, [0, 0.45, 0.7], [-4, 0.8, 0], { ...clamp, easing: ease }),
  }),
};
const ISSUES_AT = shotEnd(ZONES) + 0.05;
const ISSUES_END = ISSUES_AT + typingSeconds(ISSUES) + TYPE_TAIL;
const LANDING: ShotSpec = {
  clip: 'eng-build',
  from: B['tickets-start'] - 0.4,
  to: B['tickets-start'] + 9.2,
  rate: 4.6,
  start: ISSUES_END,
  keys: [
    { at: B['tickets-start'], cx: 333, cy: 560, z: 1.9 },
    { at: B['tickets-start'] + 9.2, cx: 333, cy: 620, z: 1.75 },
  ],
  box: { x: 560, y: 60, w: 800, h: 960, rot: 4 },
};
const FANOUT: ShotSpec = {
  clip: 'eng-fanout',
  from: F['drag-0'] - 0.2,
  to: F.running + 0.6,
  rate: 3.4,
  start: shotEnd(LANDING) + 0.05,
  keys: [
    { at: F['drag-0'], cx: 465, cy: 630, z: 1.75 },
    { at: F.running + 0.6, cx: 470, cy: 600, z: 1.6 },
  ],
  box: { x: 160, y: 30, w: 1600, h: 1020, rot: -3 },
};
const AUTOPILOT: ShotSpec = {
  clip: 'eng-flow',
  from: W['zone-settings'] - 0.3,
  to: W.pr - 0.1,
  rate: 1.15,
  start: shotEnd(FANOUT) + 0.05,
  keys: [
    { at: W['zone-settings'], cx: 860, cy: 560, z: 1.25 },
    { at: W['zone-prompt'] - 0.1, cx: 960, cy: 520, z: 1.5 },
    { at: W['zone-prompt'] + 0.4, cx: 860, cy: 440, z: 2.5 },
    { at: W.pr - 0.1, cx: 860, cy: 440, z: 2.65 },
  ],
  box: { x: 760, y: 80, w: 1080, h: 920, rot: 3 },
};
const LOOP: ShotSpec = {
  clip: 'eng-flow',
  from: W.pr - 0.2,
  to: W['qa-passed'] + 0.4,
  rate: 1.8,
  start: shotEnd(AUTOPILOT) + 0.05,
  keys: [
    { at: W.pr - 0.2, cx: LANE.progress, cy: LANE_Y, z: 2.0 },
    { at: W['to-review'] - 0.05, cx: LANE.progress, cy: LANE_Y, z: 2.0 },
    { at: W['to-review'] + 0.35, cx: LANE.review, cy: LANE_Y, z: 2.1 },
    { at: W.back - 0.05, cx: LANE.review, cy: LANE_Y, z: 2.1 },
    { at: W.back + 0.35, cx: LANE.progress, cy: LANE_Y, z: 2.0 },
    { at: W.fixed + 0.25, cx: LANE.progress, cy: LANE_Y, z: 2.0 },
    { at: W.fixed + 0.65, cx: LANE.review, cy: LANE_Y, z: 2.1 },
    { at: W['to-qa'] - 0.05, cx: LANE.review, cy: LANE_Y, z: 2.1 },
    { at: W['to-qa'] + 0.35, cx: LANE.qa, cy: LANE_Y, z: 2.2 },
  ],
  box: (t) => ({ x: 120, y: 90, w: 1680, h: 900, rot: Math.sin(t * 1.6) * 2.2 }),
};
const DEEP: ShotSpec = {
  clip: 'eng-flow',
  from: W.ready - 0.1,
  to: W['deep-done'] + 0.3,
  rate: 1.15,
  start: shotEnd(LOOP) + 0.05,
  keys: [
    { at: W.ready, cx: READY.x, cy: 330, z: 1.9 },
    { at: W['deep-running'], cx: READY.x, cy: 360, z: 2.6 },
    { at: W['deep-done'] + 0.3, cx: READY.x, cy: 370, z: 2.75 },
  ],
  box: { x: 880, y: 60, w: 1000, h: 960, rot: -4 },
};
const HARNESS_AT = shotEnd(DEEP) + 0.1;
const HARNESS = 2.9;
const MERGE: ShotSpec = {
  clip: 'eng-flow',
  from: W.merge - 0.2,
  to: W.merged + 0.4,
  rate: 1.3,
  start: HARNESS_AT + HARNESS,
  keys: [
    { at: W.merge - 0.2, cx: 1180, cy: 400, z: 1.55 },
    { at: W.merged + 0.4, cx: MERGED.x - 60, cy: 400, z: 1.7 },
  ],
  box: { x: 80, y: 60, w: 1760, h: 960, rot: 3 },
};
const MORE_AT = shotEnd(MERGE) + 0.25;
const MORE_END = MORE_AT + typingSeconds(MORE) + 0.2;
const SEND: ShotSpec = {
  clip: 'eng-flow',
  from: W.send - 0.25,
  to: W.send + 0.35,
  rate: 1,
  start: MORE_END,
  keys: [{ at: W.send - 0.25, cx: 1560, cy: 340, z: 3.4 }],
  box: { x: 0, y: 0, w: 1920, h: 1080, rot: 0 },
};
const SEND_CLICK = SEND.start + 0.55;
const END = SEND_CLICK + 0.55;
export const THROUGHPUT_SECONDS = END;

// ---- Strips for typed asks: a slanted band across the screen ----
const strip = (rot: number, cy = 540): Box => {
  const w = 1720;
  const h = (w * KANBAN.rect.h) / KANBAN.rect.w;
  return { x: (1920 - w) / 2, y: cy - h / 2, w, h, rot };
};
const KANBAN_BOX = strip(-4, 560);
const ISSUES_BOX = strip(4, 520);
const MORE_BOX = strip(-3, 540);

/** A point on a typing strip (fraction across, fraction down) on screen. */
function onStrip(box: Box, fx: number, fy: number): Pt {
  const dx = (fx - 0.5) * box.w;
  const dy = (fy - 0.5) * box.h;
  const r = (box.rot * Math.PI) / 180;
  return {
    x: box.x + box.w / 2 + dx * Math.cos(r) - dy * Math.sin(r),
    y: box.y + box.h / 2 + dx * Math.sin(r) + dy * Math.cos(r),
  };
}

// ---- The troupe ----
interface Role {
  color: string;
  /** Composition seconds it's on screen. */
  from: number;
  to: number;
  /** Where it flies on from and off to. */
  enter: Pt;
  exit: Pt;
  enterFor?: number;
  exitFor?: number;
  /** Where it is while it works. */
  at: (t: number) => Pt;
  clicks?: number[];
  taps?: number[];
}

function rolePoint(r: Role, t: number): Pt | null {
  const inFor = r.enterFor ?? 0.5;
  const outFor = r.exitFor ?? 0.6;
  if (t < r.from - inFor || t > r.to + outFor) return null;
  if (t < r.from) return bowed(r.enter, r.at(r.from), smooth((t - (r.from - inFor)) / inFor));
  if (t > r.to) return bowed(r.at(r.to), r.exit, smooth((t - r.to) / outFor));
  return r.at(t);
}

const typingRole = (
  color: string,
  stills: Stills,
  box: Box,
  start: number,
  enter: Pt,
  exit: Pt
): Role => {
  const n = stills.last - stills.first;
  const end = start + n * 0.062 + TYPE_TAIL;
  return {
    color,
    from: start - 0.1,
    to: end,
    enter,
    exit,
    at: (t) => {
      const k = Math.max(0, Math.min(n, Math.floor((t - start) / 0.062)));
      // Rides just under the caret, a little behind it.
      return onStrip(box, caretAt(stills, k) + 0.02, 0.86);
    },
    taps: Array.from({ length: n }, (_, k) => start + k * 0.062),
    clicks: [end - 0.08],
  };
};

const FANOUT_CAST = [CURSOR.ari, CURSOR.sam, CURSOR.lee, CURSOR.kit, CURSOR.maya];
const fanoutTime = (src: number) => FANOUT.start + (src - FANOUT.from) / FANOUT.rate;

const ROLES: Role[] = [
  // Maya picks the board.
  {
    color: CURSOR.maya,
    from: PICK.start + 0.05,
    to: shotEnd(PICK),
    enter: { x: 1300, y: 1180 },
    exit: { x: 1400, y: 1180 },
    at: (t) => onTrack(PICK, t),
    clicks: clickTimes(PICK),
  },
  // ...and types both asks.
  typingRole(CURSOR.maya, KANBAN, KANBAN_BOX, KANBAN_AT, { x: 1400, y: 1180 }, { x: 2050, y: 760 }),
  typingRole(CURSOR.maya, ISSUES, ISSUES_BOX, ISSUES_AT, { x: 2050, y: 760 }, { x: 1500, y: 1180 }),
  // Five drags into In Progress, each its own cursor, passing each other.
  ...[0, 1, 2, 3, 4].map(
    (i): Role => ({
      color: FANOUT_CAST[i],
      from: fanoutTime(F[`drag-${i}`]) - 0.05,
      to: fanoutTime(F[`drop-${i}`]) + 0.05,
      enterFor: 0.4,
      exitFor: 0.45,
      enter: i % 2 ? { x: -120, y: 700 + i * 60 } : { x: 300 + i * 120, y: 1180 },
      exit: i % 2 ? { x: 2050, y: 260 + i * 80 } : { x: 1500, y: -120 },
      at: (t) => onTrack(FANOUT, t),
    })
  ),
  // Kit opens the Review zone's settings, then lets go.
  {
    color: CURSOR.kit,
    from: AUTOPILOT.start + 0.05,
    to: AUTOPILOT.start + (W['zone-prompt'] - AUTOPILOT.from) / AUTOPILOT.rate,
    enter: { x: 2050, y: 900 },
    exit: { x: 2050, y: 1000 },
    exitFor: 1.4,
    at: (t) => onTrack(AUTOPILOT, t),
    clicks: clickTimes(AUTOPILOT),
  },
  // Rho drags it to Merged.
  {
    color: CURSOR.rho,
    from: MERGE.start + 0.05,
    to: shotEnd(MERGE) - 0.1,
    enter: { x: 600, y: 1180 },
    exit: { x: 2050, y: 1100 },
    at: (t) => onTrack(MERGE, t),
  },
  // Maya types the last ask.
  typingRole(CURSOR.maya, MORE, MORE_BOX, MORE_AT, { x: 600, y: 1180 }, { x: 1300, y: 1180 }),
];

/** Everyone piles onto Send at the end. */
const PILE = [CURSOR.maya, CURSOR.ari, CURSOR.sam, CURSOR.lee, CURSOR.kit, CURSOR.rho];
const PILE_FROM: Pt[] = [
  { x: -120, y: 300 },
  { x: 500, y: 1180 },
  { x: 2050, y: 200 },
  { x: 2050, y: 900 },
  { x: 1200, y: -120 },
  { x: -120, y: 1000 },
];

const Troupe: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const send = toScreen(SEND, Math.min(t, SEND.start + 0.3), { x: 1602, y: 366 });
  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 40 }}>
      {ROLES.map((r) => {
        const p = rolePoint(r, t);
        if (!p) return null;
        return (
          <Cursor
            key={`${r.color}-${r.from}`}
            x={p.x}
            y={p.y}
            color={r.color}
            {...clickState(t, r.clicks, r.taps)}
          />
        );
      })}
      {t > SEND.start - 0.4 &&
        PILE.map((color, k) => {
          const u = smooth(
            interpolate(t, [SEND.start - 0.4 + k * 0.04, SEND_CLICK - 0.05], [0, 1], clamp)
          );
          const spot = { x: send.x + (k - 2.5) * 16, y: send.y + Math.abs(k - 2.5) * 10 };
          const p = bowed(PILE_FROM[k], spot, u);
          const st = clickState(t, [SEND_CLICK, SEND_CLICK + 0.12]);
          return (
            <Cursor key={color} x={p.x} y={p.y} color={color} {...st} scale={k === 0 ? 1.25 : 1} />
          );
        })}
    </div>
  );
};

// ---- Title: "Multiply" splits into three shards ----
const MULTI: { word: string; fill: string; from: Pt; to: Pt; rot: number; color: string }[] = [
  {
    word: 'Multi-model',
    fill: FILL_TEAL,
    from: { x: -900, y: 700 },
    to: { x: 330, y: 720 },
    rot: -6,
    color: CURSOR.ari,
  },
  {
    word: 'Multi-backlog',
    fill: FILL_BLUE,
    from: { x: 960, y: 1300 },
    to: { x: 960, y: 800 },
    rot: 3,
    color: CURSOR.sam,
  },
  {
    word: 'Multiplayer',
    fill: FILL_INDIGO,
    from: { x: 2800, y: 700 },
    to: { x: 1590, y: 720 },
    rot: -4,
    color: CURSOR.lee,
  },
];
const SHARD_AT = 0.85;

const Title: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const out = interpolate(t, [TITLE - 0.35, TITLE], [0, 1], { ...clamp, easing: ease });
  return (
    <AbsoluteFill style={{ opacity: 1 - out, scale: String(1 + out * 0.08) }}>
      <AbsoluteFill
        style={{ justifyContent: 'center', alignItems: 'center', translate: '0px -110px' }}
      >
        <Heading text="**Multiply** engineering *throughput*" size={112} at={0.1} />
      </AbsoluteFill>
      {MULTI.map((m, i) => {
        const u = interpolate(t, [SHARD_AT + i * 0.18, SHARD_AT + i * 0.18 + 0.5], [0, 1], {
          ...clamp,
          easing: ease,
        });
        const x = m.from.x + (m.to.x - m.from.x) * u;
        const y = m.from.y + (m.to.y - m.from.y) * u;
        return (
          <div
            key={m.word}
            style={{
              position: 'absolute',
              left: x - 270,
              top: y - 58,
              width: 540,
              height: 116,
              background: m.fill,
              clipPath: 'polygon(6% 0, 100% 0, 94% 100%, 0 100%)',
              rotate: `${m.rot * (2 - u)}deg`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: INK,
              fontSize: 56,
              fontWeight: 600,
              letterSpacing: '-0.02em',
            }}
          >
            {m.word}
          </div>
        );
      })}
      {/* Each shard's cursor catches it and pins it. */}
      {MULTI.map((m, i) => {
        const land = SHARD_AT + i * 0.18 + 0.5;
        const spot = { x: m.to.x + 190, y: m.to.y + 30 };
        const startPt = { x: m.to.x + (i - 1) * 500, y: 1180 };
        const u = smooth(interpolate(t, [land - 0.45, land], [0, 1], clamp));
        const leave = smooth(interpolate(t, [TITLE - 0.5, TITLE], [0, 1], clamp));
        const p = leave > 0 ? bowed(spot, { x: spot.x, y: 1200 }, leave) : bowed(startPt, spot, u);
        return <Cursor key={m.word} x={p.x} y={p.y} color={m.color} {...clickState(t, [land])} />;
      })}
    </AbsoluteFill>
  );
};

// ---- Big lines over the action ----
const Band: React.FC<{
  at: number;
  until: number;
  text: string;
  sub?: string;
  rot?: number;
  y?: number;
  x?: number;
  align?: 'left' | 'right';
}> = ({ at, until, text, sub, rot = -4, y = 760, x = 90, align = 'left' }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  if (t < at - 0.1 || t > until + 0.4) return null;
  const inU = interpolate(t, [at, at + 0.45], [0, 1], { ...clamp, easing: ease });
  const outU = interpolate(t, [until, until + 0.35], [0, 1], { ...clamp, easing: ease });
  const subU = interpolate(t, [at + 0.55, at + 0.95], [0, 1], { ...clamp, easing: ease });
  const dir = align === 'left' ? -1 : 1;
  return (
    <div
      style={{
        position: 'absolute',
        [align]: x,
        top: y,
        rotate: `${rot}deg`,
        translate: `${dir * ((1 - inU) * 900 + outU * 900)}px 0px`,
        zIndex: 30,
        textAlign: align,
      }}
    >
      <div
        style={{
          display: 'inline-block',
          padding: '14px 34px 18px',
          background: 'rgba(7,16,15,0.86)',
          borderLeft: align === 'left' ? '8px solid #34e6c4' : undefined,
          borderRight: align === 'right' ? '8px solid #34e6c4' : undefined,
          boxShadow: '0 30px 70px rgba(0,0,0,0.5)',
        }}
      >
        {text.split('\n').map((line) => (
          <Heading key={line} text={line} size={72} />
        ))}
        {sub ? (
          <div
            style={{
              color: INK,
              fontSize: 40,
              fontWeight: 300,
              opacity: subU,
              translate: `${(1 - subU) * 40 * -dir}px 0px`,
              marginTop: 4,
            }}
          >
            {sub}
          </div>
        ) : null}
      </div>
    </div>
  );
};

// ---- Source shards (GitHub, Jira) and harness marks ----
const Shard: React.FC<{
  icon: BrandIcon;
  label: string;
  at: number;
  until: number;
  from: Pt;
  to: Pt;
  rot: number;
}> = ({ icon, label, at, until, from, to, rot }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  if (t < at - 0.1 || t > until + 0.5) return null;
  const u = interpolate(t, [at, at + 0.5], [0, 1], { ...clamp, easing: ease });
  const o = interpolate(t, [until, until + 0.4], [0, 1], { ...clamp, easing: ease });
  const p = {
    x: from.x + (to.x - from.x) * u + (from.x - to.x) * o,
    y: from.y + (to.y - from.y) * u,
  };
  return (
    <div
      style={{
        position: 'absolute',
        left: p.x - 200,
        top: p.y - 120,
        width: 400,
        height: 240,
        rotate: `${rot}deg`,
        background: '#ffffff',
        clipPath: 'polygon(8% 0, 100% 0, 92% 100%, 0 100%)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 14,
        zIndex: 20,
        boxShadow: '0 30px 70px rgba(0,0,0,0.5)',
      }}
    >
      <BrandMark icon={icon} size={110} />
      <div style={{ color: '#0d1312', fontSize: 34, fontWeight: 600 }}>{label}</div>
    </div>
  );
};

const HARNESSES: { icon: BrandIcon; name: string }[] = [
  { icon: 'claude-icon', name: 'Claude Code' },
  { icon: 'openai-icon', name: 'Codex' },
  { icon: 'google-gemini-icon', name: 'Gemini' },
  { icon: 'github-copilot', name: 'Copilot' },
];

/** agor.live's harness bar as motion: marks slam in on white tiles, then the line. */
const HarnessBar: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const out = interpolate(t, [HARNESS - 0.35, HARNESS], [0, 1], { ...clamp, easing: ease });
  return (
    <AbsoluteFill style={{ opacity: 1 - out }}>
      {HARNESSES.map((h, i) => {
        const at = 0.1 + i * 0.16;
        const u = interpolate(t, [at, at + 0.38], [0, 1], { ...clamp, easing: ease });
        // Slam from the right in a convoy, overshoot and squash on landing.
        const land = interpolate(t, [at + 0.3, at + 0.42, at + 0.6], [1, 0.86, 1], clamp);
        const x = 300 + i * 340;
        return (
          <div
            key={h.name}
            style={{
              position: 'absolute',
              left: x + (1 - u) * 2200,
              top: 300,
              width: 280,
              height: 300,
              rotate: `${(1 - u) * 18 - 4 + i * 2.5}deg`,
              scale: `${land} ${2 - land}`,
              transformOrigin: '50% 100%',
              background: '#ffffff',
              borderRadius: 28,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 22,
              boxShadow: '0 30px 70px rgba(0,0,0,0.5)',
            }}
          >
            <BrandMark icon={h.icon} size={140} />
            <div style={{ color: '#0d1312', fontSize: 34, fontWeight: 600 }}>{h.name}</div>
          </div>
        );
      })}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: 700,
          display: 'flex',
          justifyContent: 'center',
        }}
      >
        <Heading text="**Every** top harness, working *together*" size={78} at={0.9} />
      </div>
      {/* The troupe high-fives through it: a pass along the tiles. */}
      {[CURSOR.ari, CURSOR.sam, CURSOR.lee, CURSOR.kit].map((color, i) => {
        const u = smooth(interpolate(t, [1.2 + i * 0.07, 2.4 + i * 0.07], [0, 1], clamp));
        const p = bowed({ x: -120, y: 640 + i * 30 }, { x: 2050, y: 260 - i * 30 }, u);
        const tile = 0.1 + i * 0.16;
        return (
          <Cursor
            key={color}
            x={p.x}
            y={p.y}
            color={color}
            {...clickState(t, [1.75 + i * 0.07 + tile * 0])}
          />
        );
      })}
    </AbsoluteFill>
  );
};

export const MultiplyThroughput: React.FC = () => {
  const { fps } = useVideoConfig();
  const f = (s: number) => Math.round(s * fps);
  const frame = useCurrentFrame();
  const t = frame / fps;
  const black = t >= END - 0.02;
  return (
    <AbsoluteFill style={{ background: BG_GRADIENT, fontFamily, overflow: 'hidden' }}>
      <Sequence durationInFrames={f(TITLE)}>
        <Title />
      </Sequence>

      <ShotAt spec={PICK} tail={0.1} />
      <Sequence
        from={f(KANBAN_AT)}
        durationInFrames={f(KANBAN_END - KANBAN_AT + 0.05)}
        premountFor={fps}
      >
        <TypingStrip stills={KANBAN} start={0} box={KANBAN_BOX} />
      </Sequence>
      <ShotAt spec={ZONES} tail={0.1} />
      <Sequence
        from={f(ISSUES_AT)}
        durationInFrames={f(ISSUES_END - ISSUES_AT + 0.05)}
        premountFor={fps}
      >
        <TypingStrip stills={ISSUES} start={0} box={ISSUES_BOX} />
      </Sequence>
      <ShotAt spec={LANDING} tail={0.1} />
      <Shard
        icon="github-icon"
        label="GitHub Issues"
        at={LANDING.start - 0.1}
        until={shotEnd(LANDING) - 0.3}
        from={{ x: -400, y: 300 }}
        to={{ x: 300, y: 330 }}
        rot={-7}
      />
      <Shard
        icon="jira"
        label="Jira"
        at={LANDING.start + 0.15}
        until={shotEnd(LANDING) - 0.3}
        from={{ x: 2300, y: 740 }}
        to={{ x: 1620, y: 720 }}
        rot={6}
      />
      <ShotAt spec={FANOUT} tail={0.1} />
      <ShotAt spec={AUTOPILOT} tail={0.1} />
      <Band
        at={AUTOPILOT.start + (W['zone-prompt'] - AUTOPILOT.from) / AUTOPILOT.rate + 0.2}
        until={LOOP.start + 0.9}
        text="Put work on *autopilot* with **Zones**"
        sub="...even across models and harnesses"
        y={700}
        x={60}
      />
      <ShotAt spec={LOOP} tail={0.1} />
      <ShotAt spec={DEEP} tail={0.15} />
      <Band
        at={DEEP.start + (W['deep-running'] - DEEP.from) / DEEP.rate - 0.3}
        until={shotEnd(DEEP) - 0.1}
        text={'Parallelize *sessions*\nacross **models**'}
        rot={4}
        y={420}
        x={30}
      />
      <Sequence from={f(HARNESS_AT)} durationInFrames={f(HARNESS)}>
        <HarnessBar />
      </Sequence>
      <ShotAt spec={MERGE} tail={0.3} />
      <Sequence from={f(MORE_AT)} durationInFrames={f(MORE_END - MORE_AT + 0.05)} premountFor={fps}>
        <TypingStrip stills={MORE} start={0} box={MORE_BOX} />
      </Sequence>
      <ShotAt spec={SEND} tail={0.7} />

      <Troupe />
      {black ? <AbsoluteFill style={{ background: '#000' }} /> : null}
    </AbsoluteFill>
  );
};
