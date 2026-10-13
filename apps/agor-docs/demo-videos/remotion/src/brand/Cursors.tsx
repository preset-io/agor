import type React from 'react';
import { useCurrentFrame, useVideoConfig } from 'remotion';

// The cursor troupe, after agor.live's (components/landing/CursorTroupe.tsx):
// the same arrow and colors, and the same feel. Each cursor chases its
// current target on a damped spring with a sideways pull that bows every
// free move up and to the left, the arc a right hand makes pivoting on its
// wrist. Clicks press the arrow and send out a ring in its color.
//
// Two ways to drive one:
// - choreographed (`Troupe`): a script of targets over time, simulated
//   deterministically (the same frames every render);
// - on a recording (`TrackCursor`): the real path a cursorless take's mouse
//   followed (e2e `pointer` samples), so hovers and clicks in the UI line up.

export const CURSOR = {
  maya: '#f5a3c7',
  ari: '#6fdcf0',
  sam: '#f2d27a',
  lee: '#b9f18c',
  kit: '#c3a6ff',
  rho: '#ff9f7a',
} as const;

export interface Pt {
  x: number;
  y: number;
}
/** Where to head from `at` (seconds): a point, or one that moves (an orbit, a moving slice). */
export interface Move {
  at: number;
  to: Pt | ((t: number) => Pt);
  /** Spring frequency: higher follows tighter. Default 2.2. */
  hz?: number;
  /** Follow straight and stiffly (orbits, riding along with something). */
  locked?: boolean;
}
export interface Act {
  color: string;
  /** Where it starts (usually off screen). */
  from: Pt;
  moves: Move[];
  /** Click times (seconds). */
  clicks?: number[];
  /** Little presses with no ring (typing). */
  taps?: number[];
}

const MAX_SPEED = 2600; // px/s, so long trips don't whip
const SIM_HZ = 240;

/** The act's position at every frame from 0 to `frames`. */
function simulate(act: Act, frames: number, fps: number): Pt[] {
  const out: Pt[] = [];
  let x = act.from.x;
  let y = act.from.y;
  let vx = 0;
  let vy = 0;
  const h = 1 / SIM_HZ;
  const perFrame = SIM_HZ / fps;
  const moves = [...act.moves].sort((a, b) => a.at - b.at);
  let step = 0;
  for (let f = 0; f <= frames; f++) {
    out.push({ x, y });
    for (let s = 0; s < perFrame; s++, step++) {
      const t = step * h;
      let move: Move | undefined;
      for (const m of moves) if (m.at <= t) move = m;
      if (!move) continue;
      const target = typeof move.to === 'function' ? move.to(t) : move.to;
      const hz = move.locked ? 9 : (move.hz ?? 2.2);
      const k = (2 * Math.PI * hz) ** 2;
      const c = 2 * Math.sqrt(k);
      const dx = target.x - x;
      const dy = target.y - y;
      const dist = Math.hypot(dx, dy);
      let ax = k * dx - c * vx;
      let ay = k * dy - c * vy;
      if (!move.locked && dist > 2) {
        // The right hand's bow: pull sideways, always toward up-left.
        let nx = -dy / dist;
        let ny = dx / dist;
        if (nx + ny > 0) {
          nx = -nx;
          ny = -ny;
        }
        ax += nx * k * dist * 0.18;
        ay += ny * k * dist * 0.18;
      }
      vx += ax * h;
      vy += ay * h;
      const speed = Math.hypot(vx, vy);
      if (!move.locked && speed > MAX_SPEED) {
        vx *= MAX_SPEED / speed;
        vy *= MAX_SPEED / speed;
      }
      x += vx * h;
      y += vy * h;
    }
  }
  return out;
}

const tracks = new WeakMap<Act, Pt[]>();
function trackOf(act: Act, frames: number, fps: number): Pt[] {
  let track = tracks.get(act);
  if (!track || track.length <= frames) {
    track = simulate(act, frames, fps);
    tracks.set(act, track);
  }
  return track;
}

const SIZE = 56;
const TIP = { x: (2 / 18) * SIZE, y: (1 / 18) * SIZE };

/** One cursor: the site's arrow with its tip at (x, y), and a click ring. */
export const Cursor: React.FC<{
  x: number;
  y: number;
  color: string;
  /** 0..1 while a click's ring spreads (or undefined). */
  ring?: number;
  pressed?: boolean;
  scale?: number;
  opacity?: number;
}> = ({ x, y, color, ring, pressed, scale = 1, opacity = 1 }) => (
  <>
    {ring !== undefined ? (
      <div
        style={{
          position: 'absolute',
          left: x - 34,
          top: y - 34,
          width: 68,
          height: 68,
          borderRadius: '50%',
          border: `3px solid ${color}`,
          opacity: (1 - ring) * opacity,
          scale: String(0.3 + ring * 1.4),
        }}
      />
    ) : null}
    <svg
      width={SIZE}
      height={SIZE}
      viewBox="0 0 18 18"
      aria-hidden="true"
      style={{
        position: 'absolute',
        left: x - TIP.x,
        top: y - TIP.y,
        overflow: 'visible',
        transformOrigin: `${TIP.x}px ${TIP.y}px`,
        scale: String(scale * (pressed ? 0.8 : 1)),
        opacity,
        filter: 'drop-shadow(0 3px 6px rgba(0,0,0,0.45))',
      }}
    >
      <path d="M2 1l15 8-7 1.6L7 18z" fill={color} stroke="#061010" strokeWidth="1.2" />
    </svg>
  </>
);

const RING = 0.45;
const PRESS = 0.12;

/** Ring progress and press state at `t` for a list of click times. */
export function clickState(t: number, clicks: number[] = [], taps: number[] = []) {
  let ring: number | undefined;
  let pressed = false;
  for (const c of clicks) {
    if (t >= c && t < c + RING) ring = (t - c) / RING;
    if (t >= c && t < c + PRESS) pressed = true;
  }
  for (const c of taps) if (t >= c && t < c + 0.07) pressed = true;
  return { ring, pressed };
}

/** Choreographed cursors, simulated over the whole composition. */
export const Troupe: React.FC<{ acts: Act[] }> = ({ acts }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const t = frame / fps;
  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 40 }}>
      {acts.map((act) => {
        const p = trackOf(act, durationInFrames, fps)[Math.min(frame, durationInFrames)];
        if (p.x < -120 || p.x > 2040 || p.y < -120 || p.y > 1200) return null;
        return (
          <Cursor
            key={act.color}
            x={p.x}
            y={p.y}
            color={act.color}
            {...clickState(t, act.clicks, act.taps)}
          />
        );
      })}
    </div>
  );
};

/** A take's logged cursor path: [seconds, x, y] samples and [seconds, x, y] clicks (app px). */
export interface CursorTrack {
  pointer: [number, number, number][];
  clicks: [number, number, number][];
}

/** Where the take's mouse was at source time `s` (app px): between samples it rests. */
export function pointerAt(track: CursorTrack, s: number): Pt {
  const p = track.pointer;
  if (p.length === 0) return { x: 960, y: 540 };
  if (s <= p[0][0]) return { x: p[0][1], y: p[0][2] };
  let lo = 0;
  let hi = p.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (p[mid][0] <= s) lo = mid;
    else hi = mid;
  }
  const a = p[lo];
  const b = p[hi];
  if (s >= b[0]) return { x: b[1], y: b[2] };
  // Samples are ~16ms apart inside a glide; a longer gap is the cursor at rest.
  if (b[0] - a[0] > 0.1) return { x: a[1], y: a[2] };
  const f = (s - a[0]) / (b[0] - a[0]);
  return { x: a[1] + (b[1] - a[1]) * f, y: a[2] + (b[2] - a[2]) * f };
}
