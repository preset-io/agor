import { getLength, interpolatePath } from '@remotion/paths';
import type React from 'react';
import { useId } from 'react';
import { Easing, Img, interpolate, staticFile } from 'remotion';

// The Agor logo, animated, then the wordmark crashing in.
//
// - The mark's draw-on is a frame-driven port of
//   animated_agor_logo/index_4k.html (same paths, keyframes and easings):
//   dots spin out from the center, the ring and comet-tail arcs sweep on as
//   they settle, the A draws in one stroke, the crossbar shrinks up into
//   place, and a shine sweeps across.
// - Then the letters of "agor" (cut from the flat horizontal lockup) glide
//   in from the right in a convoy and pile up, like the problem cards on
//   agor.live: each one slams into the one ahead, and every impact shoves
//   the mark (and the letters already stopped) left, until the full
//   wordmark sits centered.

export const TEAL = '#36B7AF';
const BUILD = 3; // the mark's draw-on (seconds)
/** When the shine sweeps (after the pile-up settles). */
const SHINE_AT = 3.35;
const SHINE = 0.9;
/** When each letter hits (a, g, o, r). */
const IMPACT_AT = [2.7, 2.83, 2.96, 3.09];
/** Seconds by which everything is at rest. */
export const WORDMARK_SETTLED = SHINE_AT + SHINE;

// The lockup, in the flat PNG's pixel space (2250 x 1177).
const LOCKUP = { x0: 181, x1: 2124, y0: 199, y1: 987 };
const MARK = { x0: 181, x1: 942 };
/** Each letter's crop (public/wordmark/<l>.png) and where it sits in the lockup. */
const LETTERS = [
  { l: 'a', x: 1054, y: 492, w: 251, h: 287 },
  { l: 'g', x: 1340, y: 492, w: 273, h: 388 },
  { l: 'o', x: 1648, y: 492, w: 275, h: 287 },
  { l: 'r', x: 1958, y: 492, w: 172, h: 282 },
] as const;
// The mark's SVG (viewBox 734) in lockup space: its left arc's outer edge
// (55.5) and top dot (30) land on the PNG's mark bounds.
const SVG_SCALE = (MARK.x1 - MARK.x0) / (704 - 55.5);
const SVG_ORIGIN = { x: MARK.x0 - 55.5 * SVG_SCALE, y: LOCKUP.y0 - 30 * SVG_SCALE };

const RING = 'M556,367 A189,189 0 1,0 178,367 A189,189 0 1,0 556,367';
const ARC1 = 'M367,70 A297,297 0 0,0 188,607';
const ARC2 = 'M367,664 A297,297 0 0,0 664,367';
const APATH =
  'M188,607 C188,607 306.427,380.615 351.693,294.083 C355.033,287.698 361.66,283.713 368.865,283.756 C376.071,283.799 382.649,287.862 385.914,294.286 C420.058,361.482 494,507 494,507';
const BAR_FROM =
  'M261.42,523.76 C292.62,544.77 329.38,556.00 367.00,556.00 C405.39,556.00 442.88,544.31 474.46,522.48';
const BAR_TO =
  'M293.84,404.67 C307.45,431.55 335.34,450 367.5,450 C400,450 428.13,431.17 441.58,403.83';
const len = (d: string) => getLength(d) + 2;
const LEN = { ring: len(RING), arc1: len(ARC1), arc2: len(ARC2), a: len(APATH) };
const DOTS = [
  { cx: 367, cy: 70, s: 360 },
  { cx: 367, cy: 664, s: 360 },
  { cx: 188, cy: 607, s: 413 },
  { cx: 664, cy: 367, s: 360 },
];

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
const settle = Easing.bezier(0.22, 0.8, 0.36, 1);
const easeOut = Easing.bezier(0, 0, 0.58, 1);
const easeInOut = Easing.bezier(0.42, 0, 0.58, 1);

/** The mark at time t (seconds into the build), in its 734 viewBox. */
const Mark: React.FC<{ t: number; size: number }> = ({ t, size }) => {
  const id = useId().replace(/:/g, '');
  const p = t / BUILD;
  const grow = interpolate(p, [0, 0.18], [0, 1], clamp);
  const sweep = interpolate(p, [0.18, 0.58], [1, 0], { ...clamp, easing: settle });
  const spin = (s: number) =>
    p < 0.18
      ? interpolate(p, [0, 0.18], [s, s - 270])
      : interpolate(p, [0.18, 0.58], [s - 270, 0], { ...clamp, easing: settle });
  const a = interpolate(p, [0.5, 0.74], [1, 0], { ...clamp, easing: easeOut });
  const bar = interpolate(p, [0.74, 0.88], [0, 1], { ...clamp, easing: easeOut });
  const shineT = (t - SHINE_AT) / SHINE;
  const shineX = interpolate(shineT, [0, 1], [-260, 994], { ...clamp, easing: easeInOut });
  const shineO = interpolate(shineT, [0, 0.12, 0.5, 0.88], [0, 1, 1, 0], clamp);
  const stroke = {
    fill: 'none',
    stroke: TEAL,
    strokeWidth: 29,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  } as const;
  return (
    <svg width={size} height={size} viewBox="0 0 734 734" overflow="visible" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}g`} x1="0" y1="1" x2="0.7" y2="0">
          <stop offset="0%" stopColor="#fff" stopOpacity="0" />
          <stop offset="50%" stopColor="#fff" stopOpacity="0.4" />
          <stop offset="100%" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <mask id={`${id}m`} maskUnits="userSpaceOnUse" x="0" y="0" width="734" height="734">
          <g {...stroke} stroke="#fff">
            {[RING, ARC1, ARC2, APATH, BAR_TO].map((d) => (
              <path key={d} d={d} />
            ))}
          </g>
          {DOTS.map((d) => (
            <circle key={`${d.cx},${d.cy}`} cx={d.cx} cy={d.cy} r={40} fill="#fff" />
          ))}
        </mask>
      </defs>
      <path
        {...stroke}
        d={interpolatePath(bar, BAR_FROM, BAR_TO)}
        opacity={interpolate(p, [0.74, 0.75], [0, 1], clamp)}
      />
      <path {...stroke} d={APATH} strokeDasharray={LEN.a} strokeDashoffset={LEN.a * a} />
      <path {...stroke} d={RING} strokeDasharray={LEN.ring} strokeDashoffset={LEN.ring * sweep} />
      <path {...stroke} d={ARC1} strokeDasharray={LEN.arc1} strokeDashoffset={LEN.arc1 * sweep} />
      <path {...stroke} d={ARC2} strokeDasharray={LEN.arc2} strokeDashoffset={LEN.arc2 * sweep} />
      {DOTS.map((d) => (
        <g
          key={`${d.cx},${d.cy}`}
          transform={`rotate(${spin(d.s)} 367 367) translate(367 367) scale(${grow}) translate(-367 -367)`}
        >
          <circle cx={d.cx} cy={d.cy} r={40 * grow} opacity={grow} fill={TEAL} />
        </g>
      ))}
      <rect
        x={shineX}
        y={0}
        width={260}
        height={734}
        fill={`url(#${id}g)`}
        mask={`url(#${id}m)`}
        opacity={shineO}
      />
    </svg>
  );
};

/**
 * The animated lockup, centered in a 1920x1080 frame. `t` is seconds since
 * the draw-on started; past WORDMARK_SETTLED it's the finished wordmark.
 * `width` is the finished lockup's width in px.
 */
export const AgorWordmark: React.FC<{ t: number; width?: number }> = ({ t, width = 1100 }) => {
  const k = width / (LOCKUP.x1 - LOCKUP.x0);
  const left = 960 - ((LOCKUP.x0 + LOCKUP.x1) / 2) * k;
  const top = 540 - ((LOCKUP.y0 + LOCKUP.y1) / 2) * k;
  // Before the crash the mark sits centered on its own.
  const D = ((LOCKUP.x0 + LOCKUP.x1) / 2 - (MARK.x0 + MARK.x1) / 2) * k;
  const hit = (i: number) =>
    interpolate(t, [IMPACT_AT[i], IMPACT_AT[i] + 0.12], [0, 1], {
      ...clamp,
      easing: Easing.out(Easing.back(1.4)),
    });
  // How far the pile still is from its final spot: each impact takes a
  // quarter off, with a little overshoot.
  const moved = IMPACT_AT.reduce((sum, _, i) => sum + hit(i), 0);
  const G = D * (1 - moved / IMPACT_AT.length);
  /** A short jolt (rotation in degrees) when something hits from behind at `at`. */
  const jolt = (at: number, amp: number) => {
    const u = t - at;
    if (u < 0 || u > 0.5) return 0;
    return amp * Math.exp(-u * 9) * Math.sin(u * 38);
  };
  const SPEED = 2600; // px/s, the convoy's speed
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <div
        style={{
          position: 'absolute',
          left: left + SVG_ORIGIN.x * k + G,
          top: top + SVG_ORIGIN.y * k,
          rotate: `${jolt(IMPACT_AT[0], -3)}deg`,
        }}
      >
        <Mark t={t} size={734 * SVG_SCALE * k} />
      </div>
      {LETTERS.map((L, i) => {
        const at = IMPACT_AT[i];
        const before = t < at;
        const x = before ? D * (1 - i / LETTERS.length) + SPEED * (at - t) : G;
        const next = IMPACT_AT[i + 1];
        const rot = next !== undefined ? jolt(next, -6) : jolt(at, 4);
        const pop = next !== undefined ? -Math.abs(jolt(next, 10)) : 0;
        return (
          <Img
            key={L.l}
            src={staticFile(`wordmark/${L.l}.png`)}
            style={{
              position: 'absolute',
              left: left + L.x * k + x,
              top: top + L.y * k + pop,
              width: L.w * k,
              height: L.h * k,
              rotate: `${rot}deg`,
              transformOrigin: '50% 100%',
              opacity: interpolate(t, [at - 0.5, at - 0.36], [0, 1], clamp),
            }}
          />
        );
      })}
    </div>
  );
};
