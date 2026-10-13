import type React from 'react';
import { AbsoluteFill, interpolate, Sequence, useCurrentFrame, useVideoConfig } from 'remotion';
import { type BrandIcon, BrandMark } from '../brand/BrandMark';
import { bowed, CURSOR, Cursor, clickState, type Pt } from '../brand/Cursors';
import { fontFamily } from '../brand/fonts';
import { Heading } from '../brand/Heading';
import { BG_GRADIENT, FILL_BLUE, FILL_INDIGO, FILL_TEAL, INK } from '../brand/palette';
import marks from './marks.json';
import {
  CHAR,
  clamp,
  clickTimes,
  ease,
  full,
  onActorTrack,
  onTrack,
  ShotAt,
  type ShotSpec,
  type Stills,
  shotEnd,
  smooth,
  toScreen,
  typingSeconds,
} from './shots';

// "Multiply engineering throughput": one engineering team's board, Backlog
// to Merged. The product plays full screen with a slow camera on it and
// labels laid over it; the troupe carries the story. Maya (the EM) picks
// the board and asks EngBot for it and for work; Ari, Sam, Lee, Kit and Rho
// each take a ticket into In Progress at once; then they let go while the
// agents run the loop (Claude builds, Codex reviews, QA tests), perk up when
// it reaches people, and cheer Rho's merge. Maya asks for 50 more.
//
// Clips: e2e eng-build (real EngBot turns, replayed), eng-fanout (five
// simultaneous drags, real zone-triggered sessions held running), eng-flow
// (the loop staged live on the real board). `npm run sync` brings them in.

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
const TYPE_LEAD = 0.25; // the input on screen before the first key
const TYPE_TAIL = 0.45; // ...and after the last, to the Send click

// Where things are on the EngTeam board in eng-flow (app px, from gridded
// reference frames of the take).
const FLOW = {
  prompt: { cx: 960, cy: 520 },
  progress: { cx: 560, cy: 260 },
  review: { cx: 1015, cy: 270 },
  qa: { cx: 1470, cy: 270 },
  ready: { cx: 1015, cy: 368 },
  merged: { cx: 1463, cy: 375 },
};
const COMPOSE = { cx: 1459, cy: 320 };

const XF = 0.2; // cross-fade between shots

// ---- Timeline (composition seconds) ----
const TITLE = 2.8;

/** A typing shot: full screen on Compose, the stills over the input, timed to the keys. */
function typingShot(
  stills: Stills,
  start: number,
  from: number,
  sent: number
): { spec: ShotSpec; typeAt: number; end: number } {
  const typeAt = start + TYPE_LEAD;
  const end = typeAt + typingSeconds(stills) + TYPE_TAIL;
  const rate = (sent + 0.15 - from) / (end - start);
  return {
    typeAt,
    end,
    spec: {
      clip: stills.dir === 'eng-flow-stills' ? 'eng-flow' : 'eng-build',
      from,
      to: sent + 0.15,
      rate,
      start,
      keys: [
        { at: from, cx: COMPOSE.cx, cy: COMPOSE.cy, z: 2.75 },
        { at: sent + 0.15, cx: COMPOSE.cx + 16, cy: COMPOSE.cy + 4, z: 2.9 },
      ],
      box: full(),
      typing: { stills, at: typeAt },
    },
  };
}

const PICK: ShotSpec = {
  clip: 'eng-build',
  from: B.picker - 0.1,
  to: B.board + 0.2,
  rate: 2.0,
  start: TITLE,
  keys: [
    { at: B.picker, cx: 560, cy: 320, z: 1.6 },
    { at: B.board, cx: 620, cy: 340, z: 1.5 },
  ],
  box: full(-0.4),
};
const KANBAN_SHOT = typingShot(KANBAN, shotEnd(PICK), B.kanban - 0.1, B['kanban-sent']);
const ZONES: ShotSpec = {
  clip: 'eng-build',
  from: B['zones-start'] - 0.9,
  to: B['zones-start'] + 1.2,
  rate: 1.4,
  start: KANBAN_SHOT.end,
  keys: [
    { at: B['zones-start'] - 0.9, cx: 988, cy: 600, z: 1.12 },
    { at: B['zones-start'] + 1.2, cx: 988, cy: 600, z: 1.2 },
  ],
  box: full(0.3),
};
const ISSUES_SHOT = typingShot(ISSUES, shotEnd(ZONES), B.issues - 0.1, B['issues-sent']);
const LANDING: ShotSpec = {
  clip: 'eng-build',
  from: B['tickets-start'] - 0.4,
  to: B['tickets-start'] + 9.0,
  rate: 4.0,
  start: ISSUES_SHOT.end,
  keys: [
    { at: B['tickets-start'] - 0.4, cx: 640, cy: 600, z: 1.55 },
    { at: B['tickets-start'] + 9.0, cx: 660, cy: 610, z: 1.65 },
  ],
  box: full(-0.3),
};
const FANOUT: ShotSpec = {
  clip: 'eng-fanout',
  from: F.drag - 0.5,
  to: F.running + 0.8,
  rate: 1.6,
  start: shotEnd(LANDING),
  keys: [
    { at: F.drag - 0.5, cx: 960, cy: 560, z: 1.0 },
    { at: F.running + 0.8, cx: 900, cy: 560, z: 1.08 },
  ],
  box: full(0.3),
};
const AUTOPILOT: ShotSpec = {
  clip: 'eng-flow',
  from: W['zone-prompt'] + 0.2,
  to: W.pr - 0.15,
  rate: 0.95,
  start: shotEnd(FANOUT),
  keys: [
    { at: W['zone-prompt'] + 0.2, cx: FLOW.prompt.cx, cy: FLOW.prompt.cy, z: 1.9 },
    { at: W.pr - 0.15, cx: FLOW.prompt.cx, cy: FLOW.prompt.cy, z: 2.1 },
  ],
  box: full(-0.3),
};
const LOOP_KEY = 1.9;
const LOOP: ShotSpec = {
  clip: 'eng-flow',
  from: W.pr - 0.2,
  to: W['qa-passed'] + 0.5,
  rate: 1.8,
  start: shotEnd(AUTOPILOT),
  keys: [
    { at: W.pr - 0.2, ...FLOW.progress, z: LOOP_KEY },
    { at: W['to-review'] - 0.05, ...FLOW.progress, z: LOOP_KEY },
    { at: W['to-review'] + 0.4, ...FLOW.review, z: LOOP_KEY },
    { at: W.back - 0.05, ...FLOW.review, z: LOOP_KEY },
    { at: W.back + 0.4, ...FLOW.progress, z: LOOP_KEY },
    { at: W.fixed + 0.25, ...FLOW.progress, z: LOOP_KEY },
    { at: W.fixed + 0.7, ...FLOW.review, z: LOOP_KEY },
    { at: W['to-qa'] - 0.05, ...FLOW.review, z: LOOP_KEY },
    { at: W['to-qa'] + 0.4, ...FLOW.qa, z: LOOP_KEY + 0.1 },
  ],
  box: full(),
};
const DEEP: ShotSpec = {
  clip: 'eng-flow',
  from: W.ready - 0.1,
  to: W['deep-done'] + 0.3,
  rate: 1.15,
  start: shotEnd(LOOP),
  keys: [
    { at: W.ready, cx: FLOW.ready.cx - 120, cy: FLOW.ready.cy, z: 1.9 },
    { at: W['deep-running'], cx: FLOW.ready.cx - 190, cy: FLOW.ready.cy - 20, z: 2.4 },
    { at: W['deep-done'] + 0.3, cx: FLOW.ready.cx - 190, cy: FLOW.ready.cy - 10, z: 2.5 },
  ],
  box: full(0.3),
};
const HARNESS_AT = shotEnd(DEEP);
const HARNESS = 3.6;
const MERGE: ShotSpec = {
  clip: 'eng-flow',
  from: W.merge - 0.2,
  to: W.merged + 0.9,
  rate: 1.2,
  start: HARNESS_AT + HARNESS,
  keys: [
    { at: W.merge - 0.2, cx: (FLOW.ready.cx + FLOW.merged.cx) / 2, cy: 420, z: 1.45 },
    { at: W.merged + 0.9, cx: (FLOW.ready.cx + FLOW.merged.cx) / 2 + 60, cy: 420, z: 1.55 },
  ],
  box: full(-0.3),
};
const MERGE_DROP = MERGE.start + (W.merged - MERGE.from) / MERGE.rate;
const MORE_SHOT = typingShot(MORE, shotEnd(MERGE), W.more - 0.1, W.send);
const SEND_CLICK = MORE_SHOT.typeAt + typingSeconds(MORE) + TYPE_TAIL - 0.12;
const END = MORE_SHOT.end + 0.35;
export const THROUGHPUT_SECONDS = END;

// ---- The troupe ----
interface Role {
  key: string;
  color: string;
  /** Composition seconds it works; it flies on before and off after. */
  from: number;
  to: number;
  enter: Pt;
  exit: Pt;
  enterFor?: number;
  exitFor?: number;
  at: (t: number) => Pt;
  clicks?: number[];
  taps?: number[];
}

function rolePoint(r: Role, t: number): Pt | null {
  const inFor = r.enterFor ?? 0.55;
  const outFor = r.exitFor ?? 0.7;
  if (t < r.from - inFor || t > r.to + outFor) return null;
  if (t < r.from) return bowed(r.enter, r.at(r.from), smooth((t - (r.from - inFor)) / inFor));
  if (t > r.to) return bowed(r.at(r.to), r.exit, smooth((t - r.to) / outFor));
  return r.at(t);
}

/** Maya at the input: rides the take's mouse (which clicked the field, then Send), tapping per key. */
const typingRole = (
  key: string,
  shot: { spec: ShotSpec; typeAt: number; end: number },
  stills: Stills,
  enter: Pt,
  exit: Pt
): Role => ({
  key,
  color: CURSOR.maya,
  from: shot.spec.start + 0.05,
  to: shot.end - 0.05,
  enter,
  exit,
  at: (t) => onTrack(shot.spec, t),
  taps: Array.from({ length: stills.last - stills.first }, (_, k) => shot.typeAt + k * CHAR),
  clicks: clickTimes(shot.spec).filter((c) => c > shot.typeAt + 0.2),
});

const CARRIERS = [CURSOR.ari, CURSOR.sam, CURSOR.lee, CURSOR.kit, CURSOR.rho];
const fanoutAt = (src: number) => FANOUT.start + (src - FANOUT.from) / FANOUT.rate;

/** A small hop (seconds since it started): a cursor's cheer. */
const hop = (u: number) => (u < 0 || u > 0.32 ? 0 : -Math.sin((u / 0.32) * Math.PI) * 26);

const ROLES: Role[] = [
  // Maya picks the board...
  {
    key: 'pick',
    color: CURSOR.maya,
    from: PICK.start + 0.05,
    to: shotEnd(PICK) - 0.05,
    enter: { x: 1100, y: 1180 },
    exit: { x: 1300, y: 1180 },
    at: (t) => onTrack(PICK, t),
    clicks: clickTimes(PICK),
  },
  // ...asks for the board, and watches it build: a little delighted loop as the zones land.
  typingRole('kanban', KANBAN_SHOT, KANBAN, { x: 1300, y: 1180 }, { x: 1150, y: 980 }),
  {
    key: 'zones',
    color: CURSOR.maya,
    from: ZONES.start + 0.1,
    to: shotEnd(ZONES) - 0.1,
    enter: { x: 1150, y: 980 },
    exit: { x: 1500, y: 1180 },
    at: (t) => {
      const land = ZONES.start + (B['zones-start'] - ZONES.from) / ZONES.rate;
      const u = interpolate(t, [land, land + 0.9], [0, 1], clamp);
      const a = smooth(u) * Math.PI * 2;
      return { x: 1010 + Math.sin(a) * 60, y: 900 - (1 - Math.cos(a)) * 40 };
    },
  },
  typingRole('issues', ISSUES_SHOT, ISSUES, { x: 1500, y: 1180 }, { x: 900, y: 1180 }),
  // Five people, five tickets, all at once: each rides its card's grip.
  ...[0, 1, 2, 3, 4].map(
    (i): Role => ({
      key: `carry-${i}`,
      color: CARRIERS[i],
      from: fanoutAt(F.drag) + i * 0.1,
      to: fanoutAt(F[`drop-${i}`]) + 0.25,
      enter: i % 2 ? { x: -120, y: 260 + i * 140 } : { x: 260 + i * 180, y: 1180 },
      exit: i % 2 ? { x: -120, y: 900 } : { x: 1300 + i * 100, y: 1180 },
      enterFor: 0.6,
      exitFor: 0.8,
      at: (t) => onActorTrack(FANOUT, `troupe-${i}`, t) ?? { x: 960, y: 540 },
      clicks: [fanoutAt(F.drag) + i * 0.137],
    })
  ),
  // Autopilot: two of them hand off. They drift down and away, unhurried.
  ...[CURSOR.ari, CURSOR.lee].map(
    (color, k): Role => ({
      key: `letgo-${k}`,
      color,
      from: AUTOPILOT.start + 0.1,
      to: AUTOPILOT.start + 0.7 + k * 0.15,
      enter: { x: 1300 + k * 160, y: 760 + k * 60 },
      exit: { x: 1500 + k * 260, y: 1200 },
      enterFor: 0.01,
      exitFor: 1.6,
      at: () => ({ x: 1300 + k * 160, y: 760 + k * 60 }),
    })
  ),
  // QA passes: Kit perks up beside the card and hops.
  {
    key: 'qa',
    color: CURSOR.kit,
    from: LOOP.start + (W['qa-passed'] - LOOP.from) / LOOP.rate - 0.1,
    to: shotEnd(LOOP) - 0.05,
    enter: { x: 2050, y: 980 },
    exit: { x: 2050, y: 760 },
    exitFor: 0.5,
    at: (t) => {
      const base = toScreen(LOOP, t, { x: FLOW.qa.cx + 210, y: FLOW.qa.cy + 70 });
      const at = LOOP.start + (W['qa-passed'] - LOOP.from) / LOOP.rate + 0.35;
      return { x: base.x, y: base.y + hop(t - at) + hop(t - at - 0.36) };
    },
  },
  // Rho merges it...
  {
    key: 'merge',
    color: CURSOR.rho,
    from: MERGE.start + 0.05,
    to: MERGE_DROP + 0.5,
    enter: { x: 500, y: 1180 },
    exit: { x: 2050, y: 1000 },
    at: (t) => onTrack(MERGE, t),
  },
  // ...and the others pop in around the card and cheer.
  ...[CURSOR.ari, CURSOR.sam, CURSOR.lee, CURSOR.kit].map((color, k): Role => {
    const spot = { x: FLOW.merged.cx - 160 + k * 105, y: FLOW.merged.cy + 260 - (k % 2) * 40 };
    return {
      key: `cheer-${k}`,
      color,
      from: MERGE_DROP + 0.05 + k * 0.06,
      to: shotEnd(MERGE) - 0.15,
      enter: [
        { x: 600, y: 1180 },
        { x: 2050, y: 1100 },
        { x: 1100, y: 1180 },
        { x: 2050, y: 700 },
      ][k],
      exit: { x: 900 + k * 260, y: 1200 },
      enterFor: 0.45,
      exitFor: 0.5,
      at: (t) => {
        const p = toScreen(MERGE, t, spot);
        const at = MERGE_DROP + 0.5 + k * 0.08;
        return { x: p.x, y: p.y + hop(t - at) + hop(t - at - 0.4) };
      },
    };
  }),
  // Maya asks for 50 more, and sends it.
  typingRole('more', MORE_SHOT, MORE, { x: 900, y: 1180 }, { x: 1700, y: 1180 }),
];

const Troupe: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 40 }}>
      {ROLES.map((r) => {
        const p = rolePoint(r, t);
        if (!p) return null;
        const send = r.key === 'more' && t >= SEND_CLICK;
        return (
          <Cursor
            key={r.key}
            x={p.x}
            y={p.y}
            color={r.color}
            // The last Send lands with a little more weight.
            scale={send ? 1 + 0.25 * Math.max(0, 1 - (t - SEND_CLICK) / 0.4) : 1}
            {...clickState(t, r.clicks, r.taps)}
          />
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
    <AbsoluteFill style={{ opacity: 1 - out }}>
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
        return (
          <div
            key={m.word}
            style={{
              position: 'absolute',
              left: m.from.x + (m.to.x - m.from.x) * u - 270,
              top: m.from.y + (m.to.y - m.from.y) * u - 58,
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

// ---- Labels over the product ----
const Label: React.FC<{
  at: number;
  until: number;
  text: string;
  sub?: string;
  x?: number;
  y?: number;
}> = ({ at, until, text, sub, x = 90, y = 820 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  if (t < at - 0.05 || t > until + 0.4) return null;
  const inU = interpolate(t, [at, at + 0.45], [0, 1], { ...clamp, easing: ease });
  const outU = interpolate(t, [until, until + 0.35], [0, 1], clamp);
  const subU = interpolate(t, [at + 0.5, at + 0.9], [0, 1], { ...clamp, easing: ease });
  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        zIndex: 30,
        opacity: inU * (1 - outU),
        translate: `0px ${(1 - inU) * 40}px`,
        padding: '18px 34px 22px',
        background: 'rgba(7,16,15,0.82)',
        borderLeft: '8px solid #34e6c4',
        borderRadius: 6,
        boxShadow: '0 30px 70px rgba(0,0,0,0.5)',
      }}
    >
      {text.split('\n').map((line) => (
        <Heading key={line} text={line} size={66} />
      ))}
      {sub ? (
        <div
          style={{
            color: INK,
            fontSize: 38,
            fontWeight: 300,
            opacity: subU,
            translate: `0px ${(1 - subU) * 14}px`,
            marginTop: 6,
          }}
        >
          {sub}
        </div>
      ) : null}
    </div>
  );
};

/** Where a ticket came from: a white tag with the tracker's mark. */
const SourceTag: React.FC<{
  icon: BrandIcon;
  label: string;
  at: number;
  until: number;
  x: number;
  y: number;
}> = ({ icon, label, at, until, x, y }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  if (t < at - 0.05 || t > until + 0.4) return null;
  const u = interpolate(t, [at, at + 0.4], [0, 1], { ...clamp, easing: ease });
  const o = interpolate(t, [until, until + 0.3], [0, 1], clamp);
  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        zIndex: 30,
        opacity: u * (1 - o),
        translate: `0px ${(1 - u) * 30}px`,
        display: 'flex',
        alignItems: 'center',
        gap: 18,
        padding: '16px 28px',
        background: '#ffffff',
        borderRadius: 16,
        boxShadow: '0 24px 60px rgba(0,0,0,0.45)',
      }}
    >
      <BrandMark icon={icon} size={64} />
      <div style={{ color: '#0d1312', fontSize: 36, fontWeight: 600 }}>{label}</div>
    </div>
  );
};

const HARNESSES: { icon: BrandIcon; name: string; color: string }[] = [
  { icon: 'claude-icon', name: 'Claude Code', color: CURSOR.maya },
  { icon: 'openai-icon', name: 'Codex', color: CURSOR.ari },
  { icon: 'google-gemini-icon', name: 'Gemini', color: CURSOR.lee },
  { icon: 'github-copilot', name: 'Copilot', color: CURSOR.kit },
];
const TILE = { w: 280, h: 300, y: 300 };
const tileX = (i: number) => 300 + i * 340;

/**
 * agor.live's harness bar, built by the troupe: each cursor carries its
 * harness's tile in from off screen and sets it down in the row; then the
 * line lands and they gather under "together" and cheer.
 */
const HarnessBar: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const out = interpolate(t, [HARNESS - 0.35, HARNESS], [0, 1], { ...clamp, easing: ease });
  const LINE_AT = 1.9;
  return (
    <AbsoluteFill style={{ opacity: 1 - out }}>
      {HARNESSES.map((h, i) => {
        const at = 0.1 + i * 0.32;
        const carry = 0.75;
        const u = smooth(interpolate(t, [at, at + carry], [0, 1], clamp));
        // Each comes from its own side, carried along a hand's arc.
        const from = i % 2 ? { x: 2200, y: 900 - i * 60 } : { x: -400, y: 820 + i * 40 };
        const dest = { x: tileX(i) + TILE.w / 2, y: TILE.y + TILE.h / 2 };
        const p = bowed(from, dest, u);
        // Set down: a small settle as it lands.
        const settle = interpolate(
          t,
          [at + carry, at + carry + 0.12, at + carry + 0.3],
          [1, 0.94, 1],
          clamp
        );
        const grip = { x: p.x + 60, y: p.y - TILE.h / 2 + 30 };
        const leave = smooth(interpolate(t, [at + carry + 0.2, LINE_AT + 0.3], [0, 1], clamp));
        // After setting it down, each heads under the line to watch.
        const watch = { x: 760 + i * 120, y: 860 };
        const hopAt = LINE_AT + 0.75 + i * 0.07;
        const c =
          t < at + carry + 0.2 ? grip : bowed({ x: dest.x + 60, y: TILE.y + 30 }, watch, leave);
        const cy = c.y + hop(t - hopAt) + hop(t - hopAt - 0.38);
        return (
          <div key={h.name}>
            <div
              style={{
                position: 'absolute',
                left: p.x - TILE.w / 2,
                top: p.y - TILE.h / 2,
                width: TILE.w,
                height: TILE.h,
                scale: String(settle),
                background: '#ffffff',
                borderRadius: 28,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 22,
                boxShadow: '0 30px 70px rgba(0,0,0,0.5)',
                opacity: t < at ? 0 : 1,
              }}
            >
              <BrandMark icon={h.icon} size={140} />
              <div style={{ color: '#0d1312', fontSize: 34, fontWeight: 600 }}>{h.name}</div>
            </div>
            {t >= at - 0.05 ? (
              <Cursor
                x={c.x}
                y={cy}
                color={h.color}
                pressed={t >= at && t < at + carry}
                {...(t >= at + carry && t < at + carry + 0.45
                  ? { ring: (t - at - carry) / 0.45 }
                  : {})}
              />
            ) : null}
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
        <Heading text="**Every** top harness, working *together*" size={78} at={LINE_AT} />
      </div>
    </AbsoluteFill>
  );
};

export const MultiplyThroughput: React.FC = () => {
  const { fps } = useVideoConfig();
  const f = (s: number) => Math.round(s * fps);
  const frame = useCurrentFrame();
  const t = frame / fps;
  const autopilotAt = AUTOPILOT.start + 0.3;
  const deepAt = DEEP.start + (W['deep-running'] - DEEP.from) / DEEP.rate - 0.4;
  return (
    <AbsoluteFill style={{ background: BG_GRADIENT, fontFamily, overflow: 'hidden' }}>
      <Sequence durationInFrames={f(TITLE)}>
        <Title />
      </Sequence>

      <ShotAt spec={PICK} tail={XF} fadeIn={0.3} />
      <ShotAt spec={KANBAN_SHOT.spec} tail={XF} fadeIn={XF} />
      <ShotAt spec={ZONES} tail={XF} fadeIn={XF} />
      <ShotAt spec={ISSUES_SHOT.spec} tail={XF} fadeIn={XF} />
      <ShotAt spec={LANDING} tail={XF} fadeIn={XF} />
      <SourceTag
        icon="github-icon"
        label="GitHub Issues"
        at={LANDING.start + 0.3}
        until={shotEnd(LANDING) - 0.2}
        x={1060}
        y={300}
      />
      <SourceTag
        icon="jira"
        label="Jira"
        at={LANDING.start + 0.55}
        until={shotEnd(LANDING) - 0.2}
        x={1060}
        y={430}
      />
      <ShotAt spec={FANOUT} tail={XF} fadeIn={XF} />
      <ShotAt spec={AUTOPILOT} tail={XF} fadeIn={XF} />
      <ShotAt spec={LOOP} tail={XF} fadeIn={XF} />
      <Label
        at={autopilotAt}
        until={LOOP.start + 1.4}
        text="Put work on *autopilot* with **Zones**"
        sub="...even across models and harnesses"
      />
      <ShotAt spec={DEEP} tail={XF} fadeIn={XF} />
      <Label
        at={deepAt}
        until={shotEnd(DEEP) - 0.1}
        text={'Parallelize *sessions*\nacross **models**'}
        y={700}
      />
      <Sequence from={f(HARNESS_AT)} durationInFrames={f(HARNESS)}>
        <HarnessBar />
      </Sequence>
      <ShotAt spec={MERGE} tail={XF} fadeIn={XF} />
      <ShotAt spec={MORE_SHOT.spec} tail={0.6} fadeIn={XF} />

      <Troupe />
      {t >= END - 0.02 ? <AbsoluteFill style={{ background: '#000' }} /> : null}
    </AbsoluteFill>
  );
};
