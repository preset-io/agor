import { Video } from '@remotion/media';
import type React from 'react';
import {
  Easing,
  Freeze,
  Img,
  interpolate,
  Sequence,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import type { CursorTrack, Pt } from '../brand/Cursors';
import { pointerAt } from '../brand/Cursors';
import cursors from './cursors.json';

// Shots on the EngTeam recordings (4K captures of a 1920x1080 app), framed
// off-square: each shot is a box on screen that can tilt, with a camera
// keyed to *source* time so it follows what the take did (a card moving
// zone to zone), not the edit's clock.

export const smooth = Easing.bezier(0.45, 0, 0.55, 1);
export const ease = Easing.bezier(0.16, 1, 0.3, 1);
export const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

export type Clip = 'eng-build' | 'eng-fanout' | 'eng-flow';

/** A camera key: at source second `at`, center (app px) and zoom (screen px per app px). */
export interface Key {
  at: number;
  cx: number;
  cy: number;
  z: number;
}
/** Where a shot sits on screen: a box, tilted `rot` degrees about its center. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
}
export interface ShotSpec {
  clip: Clip;
  /** Source seconds. */
  from: number;
  to: number;
  rate: number;
  /** Composition second it starts at. */
  start: number;
  keys: Key[];
  /** The box, or a function of seconds into the shot (to snap or swing it). */
  box: Box | ((t: number) => Box);
}

export const shotSeconds = (s: ShotSpec) => (s.to - s.from) / s.rate;
export const shotEnd = (s: ShotSpec) => s.start + shotSeconds(s);
export const boxAt = (s: ShotSpec, t: number) => (typeof s.box === 'function' ? s.box(t) : s.box);

/** The camera at source second `src`: eased between keys, kept inside the recording. */
export function camAt(keys: Key[], src: number, box: Box): Key {
  let k = keys[0];
  if (src >= keys[keys.length - 1].at) k = keys[keys.length - 1];
  else
    for (let i = 0; i + 1 < keys.length; i++) {
      const a = keys[i];
      const b = keys[i + 1];
      if (src < a.at) break;
      if (src <= b.at) {
        const p = smooth((src - a.at) / Math.max(0.001, b.at - a.at));
        k = {
          at: src,
          cx: a.cx + (b.cx - a.cx) * p,
          cy: a.cy + (b.cy - a.cy) * p,
          z: a.z + (b.z - a.z) * p,
        };
        break;
      }
    }
  const halfW = box.w / 2 / k.z;
  const halfH = box.h / 2 / k.z;
  return {
    ...k,
    cx: Math.min(1920 - halfW, Math.max(halfW, k.cx)),
    cy: Math.min(1080 - halfH, Math.max(halfH, k.cy)),
  };
}

/** Screen position of app point `p` in a shot at composition second `t`. */
export function toScreen(s: ShotSpec, t: number, p: Pt): Pt {
  const local = t - s.start;
  const src = s.from + Math.min(Math.max(0, local), shotSeconds(s)) * s.rate;
  const box = boxAt(s, local);
  const cam = camAt(s.keys, src, box);
  const dx = (p.x - cam.cx) * cam.z;
  const dy = (p.y - cam.cy) * cam.z;
  const r = (box.rot * Math.PI) / 180;
  return {
    x: box.x + box.w / 2 + dx * Math.cos(r) - dy * Math.sin(r),
    y: box.y + box.h / 2 + dx * Math.sin(r) + dy * Math.cos(r),
  };
}

/** The tilted box a shot (or a still) plays in. */
export const Frame: React.FC<{
  box: Box;
  children: React.ReactNode;
  glow?: string;
  radius?: number;
  style?: React.CSSProperties;
}> = ({ box, children, glow = '#34e6c4', radius = 18, style }) => (
  <div
    style={{
      position: 'absolute',
      left: box.x,
      top: box.y,
      width: box.w,
      height: box.h,
      rotate: `${box.rot}deg`,
      overflow: 'hidden',
      borderRadius: radius,
      background: '#0d1312',
      boxShadow: `0 0 0 2px ${glow}66, 0 40px 90px rgba(0,0,0,0.6)`,
      ...style,
    }}
  >
    {children}
  </div>
);

/** One shot: the clip at its rate inside its box, then its last frame held. */
export const Shot: React.FC<{
  spec: ShotSpec;
  glow?: string;
  tail?: number;
  style?: React.CSSProperties;
}> = ({ spec, glow, tail = 0.4, style }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps; // seconds into the shot (inside its Sequence)
  const seconds = shotSeconds(spec);
  const src = spec.from + Math.min(t, seconds) * spec.rate;
  const box = boxAt(spec, t);
  const cam = camAt(spec.keys, src, box);
  return (
    <Frame box={box} glow={glow} style={style}>
      <div
        style={{
          position: 'absolute',
          left: box.w / 2 - cam.cx * cam.z,
          top: box.h / 2 - cam.cy * cam.z,
          width: 1920 * cam.z,
          height: 1080 * cam.z,
        }}
      >
        <Sequence durationInFrames={Math.round(seconds * fps)} layout="none">
          <Video
            src={staticFile(`clips/${spec.clip}.mp4`)}
            trimBefore={Math.round(spec.from * fps)}
            playbackRate={spec.rate}
            muted
            style={{ width: '100%', height: '100%' }}
          />
        </Sequence>
        <Sequence
          from={Math.round(seconds * fps)}
          durationInFrames={Math.round(tail * fps) + 1}
          layout="none"
        >
          <Freeze frame={0}>
            <Video
              src={staticFile(`clips/${spec.clip}.mp4`)}
              trimBefore={Math.round(spec.to * fps)}
              muted
              style={{ width: '100%', height: '100%' }}
            />
          </Freeze>
        </Sequence>
      </div>
    </Frame>
  );
};

/** Mount a shot for its length (plus a held tail), from its start. */
export const ShotAt: React.FC<{
  spec: ShotSpec;
  glow?: string;
  tail?: number;
  style?: React.CSSProperties;
}> = (props) => {
  const { fps } = useVideoConfig();
  const tail = props.tail ?? 0.4;
  return (
    <Sequence
      from={Math.round(props.spec.start * fps)}
      durationInFrames={Math.round((shotSeconds(props.spec) + tail) * fps)}
      premountFor={fps}
    >
      <Shot {...props} />
    </Sequence>
  );
};

/** Seconds per key when the edit plays a take's typing stills. */
export const CHAR = 0.062;
export interface Stills {
  dir: string;
  /** First and last still of this bit of typing (inclusive). */
  first: number;
  last: number;
  rect: { x: number; y: number; w: number; h: number };
}
export const typingSeconds = (s: Stills) => (s.last - s.first) * CHAR;
/** Which still is up `t` seconds into the typing. */
export const stillAt = (s: Stills, t: number) =>
  Math.min(s.last, s.first + Math.max(0, Math.floor(t / CHAR)));

/**
 * A take's typing played from its sharp close-up stills, filling `box`
 * (the still's own aspect), starting at composition second `start`.
 */
export const TypingStrip: React.FC<{ stills: Stills; start: number; box: Box; glow?: string }> = ({
  stills,
  start,
  box,
  glow,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const n = stillAt(stills, frame / fps - start);
  return (
    <Frame box={box} glow={glow} radius={14}>
      <Img
        src={staticFile(`clips/${stills.dir}/${String(n).padStart(3, '0')}.jpg`)}
        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
      />
    </Frame>
  );
};

/** Where the caret is after `chars` keys, as a fraction across the still (estimate). */
export function caretAt(stills: Stills, chars: number): number {
  // Compose's textarea: text starts ~12 app px in; ~7.4 app px per character.
  return Math.min(0.95, (40 + 12 + chars * 7.4) / stills.rect.w);
}

/** A recorded mouse path (cursorless take), by clip. */
export const TRACKS = cursors as unknown as Record<Clip, CursorTrack>;

/** The take's mouse in a shot at composition second t (screen px). */
export function onTrack(s: ShotSpec, t: number): Pt {
  const local = Math.min(Math.max(0, t - s.start), shotSeconds(s));
  return toScreen(s, t, pointerAt(TRACKS[s.clip], s.from + local * s.rate));
}

/** A recorded click's composition time in a shot (or undefined if outside it). */
export function clickTimes(s: ShotSpec, near?: [number, number]): number[] {
  return TRACKS[s.clip].clicks
    .filter(([c]) => c >= s.from && c <= s.to && (!near || (c >= near[0] && c <= near[1])))
    .map(([c]) => s.start + (c - s.from) / s.rate);
}

export const fade = (t: number, a: number, b: number) => interpolate(t, [a, b], [0, 1], clamp);
