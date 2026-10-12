import { loadFont } from '@remotion/google-fonts/SpaceGrotesk';
import { Video } from '@remotion/media';
import type React from 'react';
import {
  AbsoluteFill,
  Easing,
  interpolate,
  Sequence,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { AQUA, BG, GREEN, INK, MUTED, SKY, TEAL } from '../brand/palette';
import { FadeToBlack } from '../teammates/Bebop';

const { fontFamily } = loadFont('normal', { weights: ['500', '600', '700'] });

// "Raise AI teammates together": from black, the title rises in; then four
// pillars, each a big word on the left ("with personality", ...) and the
// real product on the right in a window, the camera moving over the UI
// beat by beat (clips: e2e raise-<pillar>, synced by `npm run sync`). The
// word rolls over to the next pillar while the window cross-cuts. Ends on
// black.

const ease = Easing.bezier(0.16, 1, 0.3, 1);
const smooth = Easing.bezier(0.45, 0, 0.55, 1);
const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

/** A camera on the recording (app px, 1920x1080): center and zoom (window px per app px). */
interface Cam {
  cx: number;
  cy: number;
  z: number;
}
/** One stretch of a pillar's clip: source seconds, playback rate, and a camera move. */
interface Beat {
  from: number;
  to: number;
  rate: number;
  cam: [Cam, Cam];
}
interface Pillar {
  key: 'personality' | 'integrity' | 'capability' | 'agency';
  word: string;
  line: string;
  color: string;
  beats: Beat[];
}

/** A beat: source seconds [from, to] at `rate`, the camera easing from `a` to `b` ([cx, cy, z]). */
const beat = (
  from: number,
  to: number,
  rate: number,
  a: [number, number, number],
  b: [number, number, number]
): Beat => ({
  from,
  to,
  rate,
  cam: [
    { cx: a[0], cy: a[1], z: a[2] },
    { cx: b[0], cy: b[1], z: b[2] },
  ],
});

const PILLARS: Pillar[] = [
  {
    key: 'personality',
    word: 'personality',
    line: 'Every teammate gets a name, a role and a persona. Start from a template or from scratch.',
    color: TEAL,
    beats: [
      beat(1.0, 5.2, 1.6, [470, 400, 1.9], [470, 440, 2.1]), // the picker: a dozen teammates
      beat(17.0, 22.4, 2, [960, 600, 1.35], [960, 820, 1.45]), // the starter personas
      beat(26.8, 33.6, 2.4, [960, 560, 1.3], [960, 760, 1.4]), // naming one, giving it a job
    ],
  },
  {
    key: 'integrity',
    word: 'integrity',
    line: 'Grounded in what your company knows, with a knowledge base they read and write.',
    color: AQUA,
    beats: [
      beat(2.6, 8.2, 1.8, [900, 620, 1.45], [900, 660, 1.6]), // home namespace: the Handbook
      beat(17.8, 20.8, 1, [1180, 560, 2.6], [1100, 540, 0.95]), // its graph, close in to all of it
    ],
  },
  {
    key: 'capability',
    word: 'capability',
    line: 'Plug into the tools your team already uses, from a catalog of MCP servers.',
    color: SKY,
    beats: [
      beat(2.1, 9.0, 2, [960, 420, 1.0], [960, 440, 1.15]), // the MCP Catalog
      beat(10.6, 22.0, 2.8, [960, 300, 1.5], [960, 900, 1.5]), // wiring up Linear
    ],
  },
  {
    key: 'agency',
    word: 'agency',
    line: 'A heartbeat and schedules, so they get work done without being asked.',
    color: GREEN,
    beats: [
      beat(5.9, 7.4, 0.6, [960, 470, 1.05], [960, 430, 1.25]), // HEARTBEAT.md
      beat(8.6, 10.4, 1.2, [960, 360, 1.6], [960, 360, 1.75]), // its schedules
      beat(10.6, 16.6, 2.4, [965, 300, 1.35], [965, 620, 1.45]), // a new hourly heartbeat...
      beat(18.4, 19.2, 0.6, [960, 380, 1.5], [960, 380, 1.65]), // ...and it's on the list
    ],
  },
];

const TITLE = 2.2; // the section title, alone
const FADE = 0.6;
const XFADE = 0.25; // cross-cut between beats
const beatSeconds = (b: Beat) => (b.to - b.from) / b.rate;
const pillarSeconds = (p: Pillar) => p.beats.reduce((s, b) => s + beatSeconds(b), 0);
const PILLAR_AT: number[] = [];
PILLARS.reduce((t, p) => {
  PILLAR_AT.push(t);
  return t + pillarSeconds(p);
}, TITLE);
const BODY_END = PILLAR_AT[PILLAR_AT.length - 1] + pillarSeconds(PILLARS[PILLARS.length - 1]);
export const RAISE_SECONDS = BODY_END + 0.4 + FADE;

// The window the product plays in.
const WIN = { x: 820, y: 170, w: 1000, h: 740 };

/** One beat: the clip at its rate, framed by an eased camera move. */
const BeatView: React.FC<{ clip: string; beat: Beat; seconds: number; fadeIn: boolean }> = ({
  clip,
  beat,
  seconds,
  fadeIn,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const p = interpolate(t, [0, seconds], [0, 1], { ...clamp, easing: smooth });
  const [a, b] = beat.cam;
  const z = a.z + (b.z - a.z) * p;
  // Keep the view inside the recording.
  const halfW = WIN.w / 2 / z;
  const halfH = WIN.h / 2 / z;
  const cx = Math.min(1920 - halfW, Math.max(halfW, a.cx + (b.cx - a.cx) * p));
  const cy = Math.min(1080 - halfH, Math.max(halfH, a.cy + (b.cy - a.cy) * p));
  return (
    <AbsoluteFill style={{ opacity: fadeIn ? interpolate(t, [0, XFADE], [0, 1], clamp) : 1 }}>
      <div
        style={{
          position: 'absolute',
          left: WIN.w / 2 - cx * z,
          top: WIN.h / 2 - cy * z,
          width: 1920 * z,
          height: 1080 * z,
        }}
      >
        <Video
          src={staticFile(`clips/${clip}`)}
          trimBefore={Math.round(beat.from * fps)}
          playbackRate={beat.rate}
          muted
          style={{ width: '100%', height: '100%' }}
        />
      </div>
    </AbsoluteFill>
  );
};

export const RaiseTogether: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const f = (sec: number) => Math.round(sec * fps);

  // Which pillar is up, and how far into the change to the next.
  const current = Math.max(0, PILLAR_AT.filter((at) => t >= at).length - 1);
  const title = interpolate(t, [TITLE - 0.45, TITLE], [0, 1], { ...clamp, easing: ease });
  const windowIn = interpolate(t, [TITLE - 0.3, TITLE + 0.5], [0, 1], { ...clamp, easing: ease });

  return (
    <AbsoluteFill style={{ background: BG, fontFamily }}>
      {/* The section title: rises in, then lifts up and away as the pillars arrive. */}
      <AbsoluteFill
        style={{
          justifyContent: 'center',
          alignItems: 'center',
          translate: `0px ${-title * 120}px`,
          opacity: 1 - title,
        }}
      >
        <div style={{ color: INK, fontSize: 116, fontWeight: 700, letterSpacing: '-0.03em' }}>
          {'Raise AI teammates together'.split(' ').map((word, i) => {
            const rise = interpolate(t, [0.2 + i * 0.08, 0.65 + i * 0.08], [0, 1], {
              ...clamp,
              easing: ease,
            });
            return (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: words of a fixed string
                key={i}
                style={{ display: 'inline-block', overflow: 'hidden', verticalAlign: 'bottom' }}
              >
                <span style={{ display: 'inline-block', translate: `0px ${(1 - rise) * 110}%` }}>
                  {word}&nbsp;
                </span>
              </span>
            );
          })}
        </div>
      </AbsoluteFill>

      {/* The pillar's words: "with" + the big word (rolling over to the next), and a line. */}
      <div style={{ position: 'absolute', left: 110, top: 300, width: 660, opacity: windowIn }}>
        <div style={{ color: MUTED, fontSize: 44, fontWeight: 500 }}>AI teammates with</div>
        <div style={{ position: 'relative', height: 132, overflow: 'hidden' }}>
          {PILLARS.map((p, i) => {
            const inP = interpolate(t, [PILLAR_AT[i] - 0.1, PILLAR_AT[i] + 0.45], [0, 1], {
              ...clamp,
              easing: ease,
            });
            const next = PILLAR_AT[i + 1];
            const outP =
              next === undefined
                ? 0
                : interpolate(t, [next - 0.1, next + 0.35], [0, 1], { ...clamp, easing: ease });
            return (
              <div
                key={p.key}
                style={{
                  position: 'absolute',
                  top: 0,
                  color: p.color,
                  fontSize: 116,
                  fontWeight: 700,
                  letterSpacing: '-0.035em',
                  lineHeight: 1.1,
                  translate: `0px ${(1 - inP) * 110 - outP * 110}%`,
                }}
              >
                {p.word}
              </div>
            );
          })}
        </div>
        <div style={{ position: 'relative', marginTop: 28, height: 180 }}>
          {PILLARS.map((p, i) => (
            <div
              key={p.key}
              style={{
                position: 'absolute',
                color: INK,
                fontSize: 36,
                fontWeight: 500,
                lineHeight: 1.3,
                opacity:
                  i === current
                    ? interpolate(t, [PILLAR_AT[i] + 0.15, PILLAR_AT[i] + 0.6], [0, 1], clamp)
                    : 0,
              }}
            >
              {p.line}
            </div>
          ))}
        </div>
      </div>

      {/* The window. */}
      <div
        style={{
          position: 'absolute',
          left: WIN.x,
          top: WIN.y,
          width: WIN.w,
          height: WIN.h,
          borderRadius: 22,
          overflow: 'hidden',
          background: '#141414',
          boxShadow: `0 0 0 2px ${PILLARS[current].color}55, 0 30px 80px rgba(0,0,0,0.55)`,
          translate: `${(1 - windowIn) * 220}px 0px`,
          opacity: windowIn,
        }}
      >
        {PILLARS.map((p, i) => {
          let at = PILLAR_AT[i];
          return p.beats.map((b, j) => {
            const start = at;
            const seconds = beatSeconds(b);
            at += seconds;
            const first = i === 0 && j === 0;
            return (
              <Sequence
                key={`${p.key}-${b.from}`}
                from={f(start) - (first ? f(0.6) : 0)}
                durationInFrames={f(seconds + XFADE) + (first ? f(0.6) : 0)}
                premountFor={fps}
              >
                <BeatView clip={`raise-${p.key}.mp4`} beat={b} seconds={seconds} fadeIn={!first} />
              </Sequence>
            );
          });
        })}
      </div>

      <FadeToBlack at={BODY_END + 0.4} seconds={FADE} />
    </AbsoluteFill>
  );
};
