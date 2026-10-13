import { Video } from '@remotion/media';
import type React from 'react';
import {
  AbsoluteFill,
  Easing,
  Freeze,
  Img,
  interpolate,
  Sequence,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { INK } from '../brand/palette';

// An accordion of four slanted slices sharing the frame.
//
// - Each slice is a color with its teammate's name centered in it; the name
//   grows with the slice, and a strip too narrow for it is a plain color
//   bar (never vertical text).
// - The names pop up onto their slices one at a time, left to right.
// - A slice opens (to about 85% of the width) while its question is typed:
//   the recording slides up from the bottom, pushing the name up into a
//   header bar. The typing plays from sharp close-up stills (one per key,
//   e2e typeStills), not the video, so the tight zoom stays crisp.
// - It closes as the next one opens: the recording slides up and off,
//   leaving a plain colored strip.
// - At the end the slices even out and every recording slides back up into
//   a band under its header, framed close on the left side of the reply
//   (where the telling part lands) while the answers play. The last slice
//   goes straight from the prompt close-up to that framing.
// - While the answers pour in, the one-line takeaways slide up under the
//   bands, one at a time, left to right.
// - Then the slices slide off, alternately up and down.

export interface SliceSpec {
  clip: string;
  name: string;
  color: string;
  question: string;
  /** The answer's takeaway, shown under the band once it lands. */
  insight: string;
  /** Where the telling part of the reply sits in the final frame (app px). */
  focus: { cx: number; cy: number };
  /** Clip marks (source seconds). */
  question0: number;
  sent: number;
  answered: number;
  /** The typing's close-up stills (public/clips/<stillsDir>/NNN.jpg): region (app px) and count. */
  stillsDir: string;
  stills: { rect: { x: number; y: number; w: number; h: number }; count: number };
}

export interface SlicesTiming {
  /** When each slice starts opening (seconds, local to the segment). */
  openAt: number[];
  /** When the slices even out and the answers play. */
  revealAt: number;
  answerRate: number;
}

export const OPEN = 0.75; // seconds a slice takes to open (and the previous to close)
/** Typing starts this far into the opening. */
export const PROMPT_LEAD = OPEN * 0.6;
export const REVEAL = 0.8;
export const SLANT = 60;
const HEADER = 130;
/** Where a strip's name rests: below the title band across the middle. */
const NAME_REST = 790;
// Weight of the open slice relative to a closed one (open ≈ 15/18 of the width).
const OPEN_WEIGHT = 14;

const ease = Easing.bezier(0.16, 1, 0.3, 1);
const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
const lerp = (a: number, b: number, p: number) => a + (b - a) * p;

/** A camera on the recording: app-space center and zoom (output px per app px). */
interface Cam {
  cx: number;
  cy: number;
  z: number;
}
const mixCam = (a: Cam, b: Cam, p: number): Cam => ({
  cx: lerp(a.cx, b.cx, p),
  cy: lerp(a.cy, b.cy, p),
  z: lerp(a.z, b.z, p),
});
/** While typing: close on the input row (the text starts at x≈1000, y≈1024). */
const PROMPT_CAM: Cam = { cx: 1160, cy: 1000, z: 4.2 };
/** The band at the end: half the frame's height. */
const BAND_H = 540;
const FOCUS_Z = 1.1;
const TAKEAWAY_Y = HEADER + BAND_H + 34;
/** The takeaways slide up this long after the answers start, one per stagger. */
const TAKEAWAY_LEAD = 0.9;
const TAKEAWAY_STAGGER = 0.4;
/** The names pop on one at a time, this far apart. */
export const NAME_STAGGER = 0.3;
/** Slices slide off (alternately up and down) over this long. */
export const EXIT = 0.75;
const easeIn = Easing.bezier(0.7, 0, 0.84, 0);

/** Seconds per typed character (a touch slower than the capture's snappy pace). */
export const CHAR = 0.062;
/** A beat on the finished question before it's sent. */
const TYPE_TAIL = 0.35;
export const promptSeconds = (s: SliceSpec) => (s.stills.count - 1) * CHAR + TYPE_TAIL;
/** When character k (1-based) of slice i's question is typed. */
export const keyAt = (timing: SlicesTiming, i: number, k: number) =>
  timing.openAt[i] + PROMPT_LEAD + (k - 1) * CHAR;

/** Each slice's left edge (at the top) and width at time t. */
export function layoutAt(t: number, n: number, timing: SlicesTiming) {
  const win = (a: number, d: number) =>
    interpolate(t, [a, a + d], [0, 1], { ...clamp, easing: ease });
  const closeAts = Array.from({ length: n }, (_, i) =>
    i + 1 < n ? timing.openAt[i + 1] : timing.revealAt
  );
  const opened = closeAts.map((c, i) => win(timing.openAt[i], OPEN) * (1 - win(c, OPEN)));
  const weights = opened.map((o) => 1 + OPEN_WEIGHT * o);
  const sum = weights.reduce((a, b) => a + b, 0);
  const total = 1920 + (n + 1) * SLANT;
  const widths = weights.map((w) => (w / sum) * total);
  const xs: number[] = [];
  widths.forEach((_, i) => {
    xs.push(i === 0 ? -SLANT : xs[i - 1] + widths[i - 1] - SLANT);
  });
  return { xs, widths, opened, closeAts };
}

/** A slice's center line at height y (it leans with the slant). */
export const sliceCenter = (x: number, w: number, y: number) =>
  x + w / 2 + SLANT * (0.5 - y / 1080);

/** Where app point (ax, ay) of slice i's recording shows on screen while its question is typed. */
export function promptPoint(
  t: number,
  n: number,
  timing: SlicesTiming,
  i: number,
  ax: number,
  ay: number
) {
  const { xs, widths } = layoutAt(t, n, timing);
  const height = 1080 - HEADER;
  const halfW = widths[i] / 2 / PROMPT_CAM.z;
  const halfH = height / 2 / PROMPT_CAM.z;
  const cx = Math.min(1920 - halfW, Math.max(halfW, PROMPT_CAM.cx));
  const cy = Math.min(1080 - halfH, Math.max(halfH, PROMPT_CAM.cy));
  const midY = HEADER + height / 2;
  return {
    x: sliceCenter(xs[i], widths[i], midY) + (ax - cx) * PROMPT_CAM.z,
    y: midY + (ay - cy) * PROMPT_CAM.z,
  };
}

/** Where slice i's name sits before any slice opens (for a cursor to click it). */
export const NAME_SPOT = (i: number, n: number) => {
  const w = (1920 + (n + 1) * SLANT) / n;
  const x = -SLANT + i * (w - SLANT);
  return { x: sliceCenter(x, w, NAME_REST), y: NAME_REST };
};

export const Slices: React.FC<{
  slices: SliceSpec[];
  timing: SlicesTiming;
  /** When each slice slides in at the start (staggered). */
  enterAt: number[];
  /** When the names start popping on (under the section title), one per NAME_STAGGER. */
  namesAt: number;
  /** When the slices start sliding off. */
  exitAt: number;
}> = ({ slices, timing, enterAt, namesAt, exitAt }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const f = (sec: number) => Math.round(sec * fps);
  const n = slices.length;
  const win = (a: number, d: number) =>
    interpolate(t, [a, a + d], [0, 1], { ...clamp, easing: ease });

  // How open each slice is (0..1); the last closes into the reveal.
  const { xs, widths, opened, closeAts } = layoutAt(t, n, timing);
  const reveal = win(timing.revealAt, REVEAL);
  const answerAt = timing.revealAt + REVEAL * 0.5;

  return (
    <AbsoluteFill>
      {slices.map((s, i) => {
        const x = xs[i];
        const w = widths[i];
        const isLast = i === n - 1;
        const enter = win(enterAt[i], 0.5);
        const from = i % 2 === 0 ? -1 : 1;
        const left = (y: number) => x + SLANT * (1 - y / 1080);
        const right = (y: number) => x + w - SLANT * (y / 1080);
        const shape = (y0: number, y1: number) =>
          `polygon(${left(y0)}px ${y0}px, ${right(y0)}px ${y0}px, ${right(y1)}px ${y1}px, ${left(y1)}px ${y1}px)`;
        const centerX = (y: number) => sliceCenter(x, w, y);

        // The recording's phases.
        const arrive = win(timing.openAt[i], OPEN);
        const promptAt = timing.openAt[i] + PROMPT_LEAD;
        const sentAt = promptAt + promptSeconds(s);
        const leave = isLast ? 0 : win(closeAts[i], OPEN);
        const back = win(timing.revealAt, REVEAL);
        const playFor = (s.answered + 1.5 - s.sent) / timing.answerRate;
        // The takeaway slides up while the answers are still pouring in.
        const takeaway = win(answerAt + TAKEAWAY_LEAD + i * TAKEAWAY_STAGGER, 0.6);
        const focusCam: Cam = { ...s.focus, z: FOCUS_Z };
        const exit = interpolate(t, [exitAt + i * 0.07, exitAt + i * 0.07 + EXIT], [0, 1], {
          ...clamp,
          easing: easeIn,
        });

        // Where the recording sits (top edge, height) and how it's framed.
        let top: number;
        let height: number;
        let cam: Cam;
        if (isLast) {
          top = lerp(1080, HEADER, arrive);
          height = lerp(1080 - HEADER, BAND_H, reveal);
          cam = mixCam(PROMPT_CAM, focusCam, reveal);
        } else if (t < timing.revealAt) {
          // Slides up in as the slice opens, then up and off as it closes.
          top = lerp(1080, HEADER, arrive) - leave * 1080;
          height = 1080 - HEADER;
          cam = PROMPT_CAM;
        } else {
          top = lerp(1080, HEADER, back);
          height = BAND_H;
          cam = focusCam;
        }
        const showVideo = t >= timing.openAt[i] && top < 1080 && top + height > HEADER;
        // Keep the view inside the recording.
        const halfW = w / 2 / cam.z;
        const halfH = height / 2 / cam.z;
        const cx = Math.min(1920 - halfW, Math.max(halfW, cam.cx));
        const cy = Math.min(1080 - halfH, Math.max(halfH, cam.cy));
        const video = (props: { trim: number; rate?: number }) => (
          <Video
            src={staticFile(`clips/${s.clip}`)}
            trimBefore={f(props.trim)}
            playbackRate={props.rate ?? 1}
            muted
            style={{ width: '100%', height: '100%' }}
          />
        );

        // The name rides just above the recording (pushed up into the header
        // bar), and drops back to the middle once the recording has left.
        const pushed = Math.min(NAME_REST, Math.max(HEADER / 2, top - HEADER / 2));
        const settle = win(closeAts[i] + OPEN * 0.6, 0.45); // once the recording has cleared
        const nameY =
          leave > 0 && t < timing.revealAt ? lerp(HEADER / 2, NAME_REST, settle) : pushed;
        // Each name pops up onto its slice in turn, with a little overshoot.
        const popAt = namesAt + i * NAME_STAGGER;
        const pop = interpolate(t, [popAt, popAt + 0.45], [0, 1], {
          ...clamp,
          easing: Easing.bezier(0.34, 1.56, 0.64, 1),
        });
        const fit =
          interpolate(w, [200, 260], [0, 1], clamp) *
          interpolate(t, [popAt, popAt + 0.12], [0, 1], clamp);
        const nameSize = Math.min(92, Math.max(40, w * 0.1));

        return (
          <AbsoluteFill
            key={s.name}
            style={{
              translate: `0px ${((1 - enter) * from + exit * (i % 2 === 0 ? -1 : 1)) * 1150}px`,
              zIndex: opened[i] > 0 ? 2 : 1,
            }}
          >
            <AbsoluteFill style={{ background: s.color, clipPath: shape(0, 1080) }} />
            {/* The takeaway, sliding up under the band while the answer pours in. */}
            <div
              style={{
                position: 'absolute',
                left: Math.max(36, left(TAKEAWAY_Y) + 24),
                width:
                  Math.min(1884, right(TAKEAWAY_Y + 200) - 24) -
                  Math.max(36, left(TAKEAWAY_Y) + 24),
                top: TAKEAWAY_Y,
                overflow: 'hidden',
                paddingBottom: 8,
              }}
            >
              <div
                style={{
                  fontSize: 44,
                  fontWeight: 700,
                  letterSpacing: '-0.015em',
                  lineHeight: 1.1,
                  color: INK,
                  // Even lines, no one-word orphan on the second.
                  textWrap: 'balance',
                  translate: `0px ${(1 - takeaway) * 120}%`,
                }}
              >
                {s.insight}
              </div>
            </div>
            {showVideo ? (
              <AbsoluteFill
                style={{ clipPath: shape(Math.max(HEADER, top), Math.min(1080, top + height)) }}
              >
                <div
                  style={{
                    position: 'absolute',
                    left: centerX(top + height / 2) - cx * cam.z,
                    top: top + height / 2 - cy * cam.z,
                    width: 1920 * cam.z,
                    height: 1080 * cam.z,
                  }}
                >
                  <Sequence
                    from={f(sentAt)}
                    durationInFrames={f(answerAt) - f(sentAt)}
                    premountFor={fps}
                  >
                    <Freeze frame={0}>{video({ trim: s.sent })}</Freeze>
                  </Sequence>
                  <Sequence from={f(answerAt)} durationInFrames={f(playFor)} premountFor={fps}>
                    {video({ trim: s.sent, rate: timing.answerRate })}
                  </Sequence>
                  <Sequence from={f(answerAt) + f(playFor)} premountFor={fps}>
                    <Freeze frame={0}>{video({ trim: s.answered + 1.5 })}</Freeze>
                  </Sequence>
                  {/* The typing, from the close-up stills (they cover the whole view). */}
                  {t < (isLast ? sentAt : timing.revealAt) ? (
                    <Img
                      src={staticFile(
                        `clips/${s.stillsDir}/${String(
                          Math.min(
                            s.stills.count - 1,
                            Math.max(0, Math.floor((t - promptAt) / CHAR) + 1)
                          )
                        ).padStart(3, '0')}.jpg`
                      )}
                      style={{
                        position: 'absolute',
                        left: s.stills.rect.x * cam.z,
                        top: s.stills.rect.y * cam.z,
                        width: s.stills.rect.w * cam.z,
                        height: s.stills.rect.h * cam.z,
                      }}
                    />
                  ) : null}
                </div>
              </AbsoluteFill>
            ) : null}

            {/* The name (hidden on a narrow strip). */}
            <div
              style={{
                position: 'absolute',
                left: centerX(nameY) - 700,
                width: 1400,
                top: nameY - nameSize * 0.62 + (1 - pop) * 90,
                scale: String(0.6 + 0.4 * pop),
                textAlign: 'center',
                whiteSpace: 'nowrap',
                fontSize: nameSize,
                fontWeight: 700,
                letterSpacing: '-0.02em',
                color: INK,
                opacity: fit,
              }}
            >
              {s.name}
            </div>
          </AbsoluteFill>
        );
      })}
    </AbsoluteFill>
  );
};
