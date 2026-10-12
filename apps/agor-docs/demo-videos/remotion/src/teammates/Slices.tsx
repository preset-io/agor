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

// An accordion of four slanted slices sharing the frame. A slice opens (to
// about 85% of the width, the others squeezing into strips) while its
// teammate's question is typed, its recording sliding up into the slice;
// it closes as the next one opens, its video cropped down with it. At the
// end the slices even out and each video settles into a band showing the
// whole session panel, with the name above and the question below.

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

export const OPEN = 0.65; // seconds a slice takes to open (and the previous to close)
export const REVEAL = 0.7;
export const SLANT = 60;
const HEADER = 150;
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
/** While typing: the question box, bottom right. */
const PROMPT_CAM: Cam = { cx: 1440, cy: 1000, z: 1.9 };
/** A narrow strip: a sliver down the middle of the session. */
const STRIP_CAM: Cam = { cx: 1440, cy: 560, z: 1 };
/** The band at the end: the whole session panel. */
const BAND_CAM: Cam = { cx: 1440, cy: 572, z: 0.5 };

export const promptSeconds = (s: SliceSpec, rate: number) =>
  (s.sent - Math.max(0, s.question0 - 0.2)) / rate;

export const Slices: React.FC<{
  slices: SliceSpec[];
  timing: SlicesTiming;
  /** When each slice slides in at the start (staggered), and from where. */
  enterAt: number[];
}> = ({ slices, timing, enterAt }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const f = (sec: number) => Math.round(sec * fps);
  const n = slices.length;

  // How open each slice is (0..1): opens at openAt[i], closes as the next opens
  // (the last one closes into the reveal).
  const opened = slices.map((_, i) => {
    const up = interpolate(t, [timing.openAt[i], timing.openAt[i] + OPEN], [0, 1], {
      ...clamp,
      easing: ease,
    });
    const closeAt = i + 1 < n ? timing.openAt[i + 1] : timing.revealAt;
    const down = interpolate(t, [closeAt, closeAt + OPEN], [0, 1], { ...clamp, easing: ease });
    return up * (1 - down);
  });
  const reveal = interpolate(t, [timing.revealAt, timing.revealAt + REVEAL], [0, 1], {
    ...clamp,
    easing: ease,
  });

  // Widths: share 1920 (+ the slants the outer slices hang past the edges).
  const weights = opened.map((o) => 1 + OPEN_WEIGHT * o);
  const sum = weights.reduce((a, b) => a + b, 0);
  const total = 1920 + (n + 1) * SLANT;
  const widths = weights.map((w) => (w / sum) * total);
  const xs: number[] = [];
  widths.forEach((w, i) => {
    xs.push(i === 0 ? -SLANT : xs[i - 1] + widths[i - 1] - SLANT);
  });

  return (
    <AbsoluteFill>
      {slices.map((s, i) => {
        const x = xs[i];
        const w = widths[i];
        const enter = interpolate(t, [enterAt[i], enterAt[i] + 0.5], [0, 1], {
          ...clamp,
          easing: ease,
        });
        const from = i % 2 === 0 ? -1 : 1;
        const shape = (y0: number, y1: number) => {
          // The slice's slanted edges, cut between y0 and y1.
          const left = (y: number) => x + SLANT * (1 - y / 1080);
          const right = (y: number) => x + w - SLANT * (y / 1080);
          return `polygon(${left(y0)}px ${y0}px, ${right(y0)}px ${y0}px, ${right(y1)}px ${y1}px, ${left(y1)}px ${y1}px)`;
        };

        // The recording in this slice.
        const trimFrom = Math.max(0, s.question0 - 0.2);
        const promptAt = timing.openAt[i] + OPEN * 0.45;
        const sentAt = promptAt + promptSeconds(s, timing.promptRate);
        const arrive = interpolate(t, [timing.openAt[i], timing.openAt[i] + OPEN], [0, 1], {
          ...clamp,
          easing: ease,
        });
        const closeAt = i + 1 < n ? timing.openAt[i + 1] : timing.revealAt;
        const asked = interpolate(t, [closeAt, closeAt + OPEN], [0, 1], { ...clamp, easing: ease });
        let cam = mixCam(PROMPT_CAM, STRIP_CAM, i + 1 < n ? asked : 0);
        cam = mixCam(cam, BAND_CAM, reveal);
        const bandTop = lerp(0, HEADER, reveal);
        const bandH = lerp(1080, 1080 * BAND_CAM.z, reveal);
        // Keep the view inside the recording.
        const halfW = w / 2 / cam.z;
        const halfH = bandH / 2 / cam.z;
        const cx = Math.min(1920 - halfW, Math.max(halfW, cam.cx));
        const cy = Math.min(1080 - halfH, Math.max(halfH, cam.cy));
        // Slides up into the slice as it opens.
        const slideY = (1 - arrive) * 1080;
        const playFor = (s.answered + 1.5 - s.sent) / timing.answerRate;
        const video = (props: { trim: number; rate?: number }) => (
          <Video
            src={staticFile(`clips/${s.clip}`)}
            trimBefore={f(props.trim)}
            playbackRate={props.rate ?? 1}
            muted
            style={{ width: '100%', height: '100%' }}
          />
        );

        const nameSize = w > 360 ? 54 : 0;
        return (
          <AbsoluteFill
            key={s.name}
            style={{
              translate: `0px ${(1 - enter) * from * 1150}px`,
              zIndex: opened[i] > 0 ? 2 : 1,
            }}
          >
            <AbsoluteFill style={{ background: s.color, clipPath: shape(0, 1080) }} />
            {t >= timing.openAt[i] ? (
              <AbsoluteFill style={{ clipPath: shape(bandTop, bandTop + bandH) }}>
                <div
                  style={{
                    position: 'absolute',
                    left: x + w / 2 - cx * cam.z,
                    top: bandTop + bandH / 2 - cy * cam.z + slideY,
                    width: 1920 * cam.z,
                    height: 1080 * cam.z,
                  }}
                >
                  <Sequence
                    from={f(promptAt)}
                    durationInFrames={f(sentAt - promptAt)}
                    premountFor={fps}
                  >
                    {video({ trim: trimFrom, rate: timing.promptRate })}
                  </Sequence>
                  <Sequence
                    from={f(sentAt)}
                    durationInFrames={f(timing.revealAt - sentAt)}
                    premountFor={fps}
                  >
                    <Freeze frame={0}>{video({ trim: s.sent })}</Freeze>
                  </Sequence>
                  <Sequence
                    from={f(timing.revealAt)}
                    durationInFrames={f(playFor)}
                    premountFor={fps}
                  >
                    {video({ trim: s.sent, rate: timing.answerRate })}
                  </Sequence>
                  <Sequence from={f(timing.revealAt + playFor)} premountFor={fps}>
                    <Freeze frame={0}>{video({ trim: s.answered + 1.5 })}</Freeze>
                  </Sequence>
                </div>
              </AbsoluteFill>
            ) : null}

            {/* Name: across the top when the slice is wide enough, else up the strip. */}
            <div
              style={{
                position: 'absolute',
                left: x + SLANT + 22,
                top: 36,
                fontSize: nameSize,
                fontWeight: 700,
                color: '#0b0d12',
                letterSpacing: '-0.02em',
                whiteSpace: 'nowrap',
                opacity: (1 - opened[i]) * (w > 360 ? 1 : 0),
              }}
            >
              {s.emoji} {s.name}
            </div>
            <div
              style={{
                position: 'absolute',
                left: x + w / 2 - 540,
                top: 540 - 30,
                width: 1080,
                height: 60,
                rotate: '-90deg',
                textAlign: 'center',
                fontSize: 46,
                fontWeight: 700,
                color: '#0b0d12',
                letterSpacing: '0.04em',
                whiteSpace: 'nowrap',
                opacity: w < 260 ? 1 - reveal : 0,
              }}
            >
              {s.name.toUpperCase()}
            </div>

            {/* The question, under the band at the end. */}
            <div
              style={{
                position: 'absolute',
                left: x + SLANT + 18,
                width: w - 2 * SLANT - 36,
                top: HEADER + 1080 * BAND_CAM.z + 28,
                fontSize: 38,
                fontWeight: 600,
                lineHeight: 1.12,
                color: '#0b0d12',
                opacity: reveal,
              }}
            >
              “{s.question}”
            </div>

            {/* While open: the name tag over the prompt. */}
            <div
              style={{
                position: 'absolute',
                left: x + SLANT + 40,
                top: 54,
                padding: '14px 32px',
                background: s.color,
                color: '#0b0d12',
                fontSize: 60,
                fontWeight: 700,
                letterSpacing: '-0.02em',
                opacity: interpolate(opened[i], [0.6, 1], [0, 1], clamp) * (t < sentAt ? 1 : 0),
                clipPath: 'polygon(16px 0, 100% 0, calc(100% - 16px) 100%, 0 100%)',
              }}
            >
              {s.emoji} @{s.name}
            </div>
          </AbsoluteFill>
        );
      })}
    </AbsoluteFill>
  );
};
