import { Video } from '@remotion/media';
import {
  Easing,
  Freeze,
  interpolate,
  Sequence,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { APP, FULL, mix, type Rect } from './geometry';

/**
 * A teammate's timeline, in seconds local to the segment (0 = the slices
 * appear), plus source seconds of its clip's marks.
 */
export interface PaneTiming {
  /** When this slice starts expanding to full screen. */
  expandAt: number;
  /** Source second the prompt starts from, and the clip's marks. */
  trimFrom: number;
  sentSrc: number;
  answeredSrc: number;
  /** Prompt (typing) playback speed. */
  promptRate: number;
  /** Answer playback speed, once the slices play out together. */
  answerRate: number;
  /** When all slices start playing their answers together. */
  revealAt: number;
}

export interface PaneShotProps {
  clip: string;
  name: string;
  emoji: string;
  color: string;
  question: string;
  timing: PaneTiming;
  /** This teammate's slice (composition space). */
  pane: Rect;
  /** Slant of the slice's sides, px. */
  slant: number;
  /** When the slice slides in (staggered across the four). */
  enterAt: number;
  /** Slide in from above (-1) or below (1). */
  enterFrom: -1 | 1;
}

const ease = Easing.bezier(0.16, 1, 0.3, 1);
const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
export const EXPAND = 0.55;
export const SHRINK = 0.6;

/** Close-up on the question box while typing (app space). */
const QUESTION_VIEW: Rect = { x: 760, y: 1080 - 652.5, w: 1160, h: 652.5 };
/** The session panel, whole height, as a slice shows it (app space). */
const PANEL_VIEW: Rect = { x: 970, y: 64, w: 940, h: 1016 };
const HEADER = 150;

/** Seconds the prompt plays (full frame) before the question is sent. */
export const promptSeconds = (t: PaneTiming) => (t.sentSrc - t.trimFrom) / t.promptRate;

/**
 * One teammate: a colored slice with its name. In turn it expands to full
 * screen, its question is typed close up, and on send it shrinks back into
 * the slice, now showing the session. At revealAt its answer plays out.
 */
export const PaneShot: React.FC<PaneShotProps> = ({
  clip,
  name,
  emoji,
  color,
  question,
  timing,
  pane,
  slant,
  enterAt,
  enterFrom,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const f = (sec: number) => Math.round(sec * fps);

  const promptAt = timing.expandAt + EXPAND;
  const sentAt = promptAt + promptSeconds(timing);
  const enter = interpolate(t, [enterAt, enterAt + 0.5], [0, 1], { ...clamp, easing: ease });
  const grow = interpolate(t, [timing.expandAt, promptAt], [0, 1], { ...clamp, easing: ease });
  const shrink = interpolate(t, [sentAt, sentAt + SHRINK], [0, 1], { ...clamp, easing: ease });
  // 0 = in its slice, 1 = full screen.
  const open = grow * (1 - shrink);
  const videoOn = interpolate(t, [promptAt - 0.05, promptAt + 0.2], [0, 1], clamp);
  const asked = t >= sentAt;

  // The slice, opening to full screen and closing back.
  const slice = mix(pane, FULL, open);
  const cut = slant * (1 - open);

  // The recording: full frame on the prompt, then the slice's panel view.
  const contentW = pane.w - 2 * slant;
  const contentH = (contentW * PANEL_VIEW.h) / PANEL_VIEW.w;
  const content: Rect = { x: pane.x + slant, y: pane.y + HEADER, w: contentW, h: contentH };
  const target = mix(content, FULL, open);
  const v = asked ? mix(QUESTION_VIEW, PANEL_VIEW, shrink) : QUESTION_VIEW;
  const k = target.w / v.w;

  const playFor = (timing.answeredSrc + 1.5 - timing.sentSrc) / timing.answerRate;

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        // The slice that's open sits above the others.
        zIndex: open > 0 ? 10 : 1,
        translate: `0px ${(1 - enter) * enterFrom * 1150}px`,
      }}
    >
      <div
        style={{
          position: 'absolute',
          left: slice.x,
          top: slice.y,
          width: slice.w,
          height: slice.h,
          background: color,
          clipPath: `polygon(${cut}px 0, 100% 0, calc(100% - ${cut}px) 100%, 0 100%)`,
        }}
      >
        <div
          style={{
            position: 'absolute',
            left: slant + 24,
            top: 34,
            fontSize: 54,
            fontWeight: 700,
            color: '#0b0d12',
            letterSpacing: '-0.02em',
            opacity: 1 - open,
          }}
        >
          {emoji} {name}
        </div>
        <div
          style={{
            position: 'absolute',
            left: slant + 18,
            right: slant + 18,
            top: HEADER + contentH + 26,
            fontSize: 40,
            fontWeight: 600,
            lineHeight: 1.12,
            color: '#0b0d12',
            opacity: asked ? shrink : 0,
          }}
        >
          “{question}”
        </div>
      </div>

      {grow > 0 ? (
        <div
          style={{
            position: 'absolute',
            left: target.x,
            top: target.y,
            width: target.w,
            height: target.h,
            overflow: 'hidden',
            opacity: videoOn,
            boxShadow: `0 0 0 ${3 * shrink}px rgba(11,13,18,0.9)`,
          }}
        >
          <div
            style={{
              position: 'absolute',
              left: -v.x * k,
              top: -v.y * k,
              width: APP.w * k,
              height: APP.h * k,
            }}
          >
            <Sequence
              from={f(promptAt)}
              durationInFrames={f(promptSeconds(timing))}
              premountFor={fps}
            >
              <Video
                src={staticFile(`clips/${clip}`)}
                trimBefore={f(timing.trimFrom)}
                playbackRate={timing.promptRate}
                muted
                style={{ width: '100%', height: '100%' }}
              />
            </Sequence>
            <Sequence
              from={f(sentAt)}
              durationInFrames={f(timing.revealAt - sentAt)}
              premountFor={fps}
            >
              <Freeze frame={0}>
                <Video
                  src={staticFile(`clips/${clip}`)}
                  trimBefore={f(timing.sentSrc)}
                  muted
                  style={{ width: '100%', height: '100%' }}
                />
              </Freeze>
            </Sequence>
            <Sequence from={f(timing.revealAt)} durationInFrames={f(playFor)} premountFor={fps}>
              <Video
                src={staticFile(`clips/${clip}`)}
                trimBefore={f(timing.sentSrc)}
                playbackRate={timing.answerRate}
                muted
                style={{ width: '100%', height: '100%' }}
              />
            </Sequence>
            <Sequence from={f(timing.revealAt + playFor)} premountFor={fps}>
              <Freeze frame={0}>
                <Video
                  src={staticFile(`clips/${clip}`)}
                  trimBefore={f(timing.answeredSrc + 1.5)}
                  muted
                  style={{ width: '100%', height: '100%' }}
                />
              </Freeze>
            </Sequence>
          </div>
        </div>
      ) : null}

      {/* While open: the bot's name over the prompt. */}
      <div
        style={{
          position: 'absolute',
          left: 64,
          top: 56,
          padding: '16px 34px',
          background: color,
          color: '#0b0d12',
          fontSize: 64,
          fontWeight: 700,
          letterSpacing: '-0.02em',
          opacity: open * videoOn,
          clipPath: 'polygon(18px 0, 100% 0, calc(100% - 18px) 100%, 0 100%)',
        }}
      >
        {emoji} @{name}
      </div>
    </div>
  );
};
