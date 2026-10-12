import { Video } from '@remotion/media';
import type React from 'react';
import {
  AbsoluteFill,
  Easing,
  Freeze,
  interpolate,
  Sequence,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';

// An accordion of four slanted slices sharing the frame.
//
// - Each slice is a color with its teammate's name centered in it; the name
//   grows with the slice, and a strip too narrow for the name shows just
//   its emoji (never vertical text).
// - A slice opens (to about 85% of the width) while its question is typed:
//   the recording slides up from the bottom, pushing the name up into a
//   header bar.
// - It closes as the next one opens: the recording slides up and off,
//   leaving a plain colored strip.
// - At the end the slices even out and every recording slides back up into
//   a band under its header showing the whole session, with the question
//   below, while the answers play. The last slice morphs straight into its
//   band instead of leaving.

export interface SliceSpec {
  clip: string;
  name: string;
  emoji: string;
  color: string;
  question: string;
  /** Clip marks (source seconds). */
  question0: number;
  sent: number;
  answered: number;
}

export interface SlicesTiming {
  /** When each slice starts opening (seconds, local to the segment). */
  openAt: number[];
  /** When the slices even out and the answers play. */
  revealAt: number;
  promptRate: number;
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
/** The band at the end: the whole session panel. */
const BAND_CAM: Cam = { cx: 1440, cy: 572, z: 0.5 };
const BAND_H = 1080 * BAND_CAM.z;

export const promptSeconds = (s: SliceSpec, rate: number) =>
  (s.sent - Math.max(0, s.question0 - 0.2)) / rate;

export const Slices: React.FC<{
  slices: SliceSpec[];
  timing: SlicesTiming;
  /** When each slice slides in at the start (staggered). */
  enterAt: number[];
  /** When the names fade on (under the section title). */
  namesAt: number;
}> = ({ slices, timing, enterAt, namesAt }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const f = (sec: number) => Math.round(sec * fps);
  const n = slices.length;
  const win = (a: number, d: number) =>
    interpolate(t, [a, a + d], [0, 1], { ...clamp, easing: ease });

  // How open each slice is (0..1); the last closes into the reveal.
  const closeAts = slices.map((_, i) => (i + 1 < n ? timing.openAt[i + 1] : timing.revealAt));
  const opened = slices.map((_, i) => win(timing.openAt[i], OPEN) * (1 - win(closeAts[i], OPEN)));
  const reveal = win(timing.revealAt, REVEAL);

  // Widths: share 1920 (+ the slants the outer slices hang past the edges).
  const weights = opened.map((o) => 1 + OPEN_WEIGHT * o);
  const sum = weights.reduce((a, b) => a + b, 0);
  const total = 1920 + (n + 1) * SLANT;
  const widths = weights.map((w) => (w / sum) * total);
  const xs: number[] = [];
  widths.forEach((_, i) => {
    xs.push(i === 0 ? -SLANT : xs[i - 1] + widths[i - 1] - SLANT);
  });

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
        const centerX = (y: number) => (left(y) + right(y)) / 2;

        // The recording's phases.
        const trimFrom = Math.max(0, s.question0 - 0.2);
        const arrive = win(timing.openAt[i], OPEN);
        const promptAt = timing.openAt[i] + PROMPT_LEAD;
        const sentAt = promptAt + promptSeconds(s, timing.promptRate);
        const leave = isLast ? 0 : win(closeAts[i], OPEN);
        const back = win(timing.revealAt, REVEAL);
        const answerAt = timing.revealAt + REVEAL * 0.5;
        const playFor = (s.answered + 1.5 - s.sent) / timing.answerRate;

        // Where the recording sits (top edge, height) and how it's framed.
        let top: number;
        let height: number;
        let cam: Cam;
        if (isLast) {
          top = lerp(1080, HEADER, arrive);
          height = lerp(1080 - HEADER, BAND_H, reveal);
          cam = mixCam(PROMPT_CAM, BAND_CAM, reveal);
        } else if (t < timing.revealAt) {
          // Slides up in as the slice opens, then up and off as it closes.
          top = lerp(1080, HEADER, arrive) - leave * 1080;
          height = 1080 - HEADER;
          cam = PROMPT_CAM;
        } else {
          top = lerp(1080, HEADER, back);
          height = BAND_H;
          cam = BAND_CAM;
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
        // The name and the emoji never overlap: one fades out before the other fades in.
        const namesOn = win(namesAt, 0.5);
        const fit = interpolate(w, [270, 330], [0, 1], clamp) * namesOn;
        const emojiOnly = interpolate(w, [190, 250], [1, 0], clamp) * namesOn;
        const nameSize = Math.min(92, Math.max(40, w * 0.1));

        return (
          <AbsoluteFill
            key={s.name}
            style={{
              translate: `0px ${(1 - enter) * from * 1150}px`,
              zIndex: opened[i] > 0 ? 2 : 1,
            }}
          >
            <AbsoluteFill style={{ background: s.color, clipPath: shape(0, 1080) }} />
            {/* The question, under the band at the end. */}
            <div
              style={{
                position: 'absolute',
                left: left(HEADER + BAND_H + 60) + 18,
                width: w - SLANT - 36,
                top: HEADER + BAND_H + 30,
                fontSize: 38,
                fontWeight: 600,
                lineHeight: 1.12,
                color: '#0b0d12',
                opacity: interpolate(back, [0.6, 1], [0, 1], clamp),
              }}
            >
              “{s.question}”
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
                    from={f(timing.openAt[i])}
                    durationInFrames={f(PROMPT_LEAD)}
                    premountFor={fps}
                  >
                    <Freeze frame={0}>{video({ trim: trimFrom })}</Freeze>
                  </Sequence>
                  <Sequence
                    from={f(promptAt)}
                    durationInFrames={f(sentAt) - f(promptAt)}
                    premountFor={fps}
                  >
                    {video({ trim: trimFrom, rate: timing.promptRate })}
                  </Sequence>
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
                </div>
              </AbsoluteFill>
            ) : null}

            {/* The name, or just the emoji on a narrow strip. */}
            <div
              style={{
                position: 'absolute',
                left: centerX(nameY) - 700,
                width: 1400,
                top: nameY - nameSize * 0.62,
                textAlign: 'center',
                whiteSpace: 'nowrap',
                fontSize: nameSize,
                fontWeight: 700,
                letterSpacing: '-0.02em',
                color: '#0b0d12',
                opacity: fit,
              }}
            >
              {s.emoji} {s.name}
            </div>
            <div
              style={{
                position: 'absolute',
                left: centerX(nameY) - 50,
                width: 100,
                top: nameY - 32,
                textAlign: 'center',
                fontSize: 52,
                opacity: emojiOnly,
              }}
            >
              {s.emoji}
            </div>
          </AbsoluteFill>
        );
      })}
    </AbsoluteFill>
  );
};
