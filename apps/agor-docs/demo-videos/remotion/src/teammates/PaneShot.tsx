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

/** A teammate's shot, in seconds local to the shot (0 = its prompt appears). */
export interface PaneTiming {
  /** Source second the shot starts from. */
  trimFrom: number;
  /** Source seconds of the marks. */
  sentSrc: number;
  answeredSrc: number;
  /** Prompt playback speed (typing). */
  promptRate: number;
  /** Answer playback speed, once the panes play out. */
  answerRate: number;
  /** When all panes start playing their answers together. */
  revealAt: number;
}

export interface PaneShotProps {
  clip: string;
  name: string;
  emoji: string;
  color: string;
  question: string;
  timing: PaneTiming;
  /** The pane this shot settles into (composition space). */
  pane: Rect;
  /** Slant of the pane's sides, px. */
  slant: number;
}

const ease = Easing.bezier(0.16, 1, 0.3, 1);
const SHRINK = 0.6;

/** Close-up on the question box while typing (app space): not too tight. */
const QUESTION_VIEW: Rect = { x: 760, y: 1080 - 652.5, w: 1160, h: 652.5 };
/** The session panel, whole height, as the pane shows it (app space). */
const PANEL_VIEW: Rect = { x: 970, y: 64, w: 940, h: 1016 };

const HEADER = 150;

/** Promptly typed full frame, then shrinks into a slanted pane and waits; plays its answer at revealAt. */
export const PaneShot: React.FC<PaneShotProps> = ({
  clip,
  name,
  emoji,
  color,
  question,
  timing,
  pane,
  slant,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const sentAt = (timing.sentSrc - timing.trimFrom) / timing.promptRate;
  const s = interpolate(t, [sentAt, sentAt + SHRINK], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: ease,
  });

  // The video sits in the pane's content area, below its name bar.
  // Inset by the slant on both sides so the recording stays inside its own
  // colored pane (neighbors overlap by the slant).
  const contentW = pane.w - 2 * slant;
  const contentH = (contentW * PANEL_VIEW.h) / PANEL_VIEW.w;
  const content: Rect = {
    x: pane.x + slant,
    y: pane.y + HEADER,
    w: contentW,
    h: contentH,
  };
  const target = mix(FULL, content, s);
  const v = mix(QUESTION_VIEW, PANEL_VIEW, s);
  const k = target.w / v.w;

  const playFor = (timing.answeredSrc + 1.5 - timing.sentSrc) / timing.answerRate;
  const f = (sec: number) => Math.round(sec * fps);

  return (
    <>
      {/* The pane: colored, slanted, with its name bar and the question in big type. */}
      <div
        style={{
          position: 'absolute',
          left: pane.x,
          top: pane.y,
          width: pane.w,
          height: pane.h,
          background: color,
          opacity: s,
          clipPath: `polygon(${slant}px 0, 100% 0, calc(100% - ${slant}px) 100%, 0 100%)`,
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
          }}
        >
          “{question}”
        </div>
      </div>

      {/* The recording: full frame on the question, then the pane's panel view. */}
      <div
        style={{
          position: 'absolute',
          left: target.x,
          top: target.y,
          width: target.w,
          height: target.h,
          overflow: 'hidden',
          boxShadow: `0 0 0 ${3 * s}px rgba(11,13,18,0.9)`,
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
          <Sequence durationInFrames={f(sentAt)} premountFor={fps}>
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

      {/* While full frame: the bot's name over the prompt. */}
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
          opacity: 1 - s,
          clipPath: 'polygon(18px 0, 100% 0, calc(100% - 18px) 100%, 0 100%)',
        }}
      >
        {emoji} @{name}
      </div>
    </>
  );
};
