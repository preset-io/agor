import { Video } from '@remotion/media';
import { Easing, Freeze, interpolate, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { APP, FULL, mix, type Rect } from './geometry';

/** One teammate's beat, as the composition times it (all in output seconds). */
export interface ShotTiming {
  /** Source second the shot starts from (just before the question is typed). */
  trimFrom: number;
  /** Source playback speed. */
  rate: number;
  /** When the question is sent: the camera starts moving to the answer. */
  sentAt: number;
  /** When the answer has landed: hold, then shrink into the corner. */
  answeredAt: number;
  /** Seconds to hold on the answer, full frame, before shrinking. */
  hold: number;
  /** Seconds the shrink into the corner takes. */
  shrink: number;
}

export interface TeammateShotProps {
  /** Video in public/clips/ (synced from the e2e clips). */
  clip: string;
  name: string;
  emoji: string;
  timing: ShotTiming;
  /** Close-up on the question being typed (app space). */
  questionView: Rect;
  /** Where the answer reads best (app space). */
  answerView: Rect;
  /** Grid tile this shot ends in (composition space). */
  tile: Rect;
}

const ease = Easing.bezier(0.16, 1, 0.3, 1);

/**
 * A teammate Q&A beat: full frame on the question as it's typed, a glide up to
 * the answer as it lands, a hold, then a shrink into its grid tile, where the
 * answer stays (frozen) for the rest of the piece.
 */
export const TeammateShot: React.FC<TeammateShotProps> = ({
  clip,
  name,
  emoji,
  timing,
  questionView,
  answerView,
  tile,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const settleAt = timing.answeredAt + timing.hold;

  // Where in the recording we look: question close-up, then the answer.
  const toAnswer = interpolate(t, [timing.sentAt, timing.sentAt + 0.8], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: ease,
  });
  const v = mix(questionView, answerView, toAnswer);

  // Where on screen it plays: full frame, then its tile.
  const toTile = interpolate(t, [settleAt, settleAt + timing.shrink], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: ease,
  });
  const target = mix(FULL, tile, toTile);

  const k = target.w / v.w;
  // The recording stops moving once the shot settles into its tile.
  const freezeAt = Math.round(settleAt * fps);

  return (
    <div
      style={{
        position: 'absolute',
        left: target.x,
        top: target.y,
        width: target.w,
        height: target.h,
        overflow: 'hidden',
        borderRadius: interpolate(toTile, [0, 1], [0, 18]),
        boxShadow: `0 ${24 * toTile}px ${60 * toTile}px rgba(0,0,0,${0.55 * toTile})`,
        outline: `${2 * toTile}px solid rgba(255,255,255,${0.12 * toTile})`,
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
        <Freeze frame={freezeAt} active={(f) => f >= freezeAt}>
          <Video
            src={staticFile(`clips/${clip}`)}
            trimBefore={Math.round(timing.trimFrom * fps)}
            playbackRate={timing.rate}
            muted
            style={{ width: '100%', height: '100%' }}
          />
        </Freeze>
      </div>
      <Label emoji={emoji} name={name} scale={target.w / FULL.w} />
    </div>
  );
};

const Label: React.FC<{ emoji: string; name: string; scale: number }> = ({
  emoji,
  name,
  scale,
}) => (
  <div
    style={{
      position: 'absolute',
      left: 36 * scale,
      top: 32 * scale,
      display: 'flex',
      alignItems: 'center',
      gap: 14 * scale,
      padding: `${12 * scale}px ${26 * scale}px`,
      borderRadius: 999,
      background: 'rgba(11,13,18,0.82)',
      border: '1px solid rgba(255,255,255,0.16)',
      color: '#f2f5f9',
      fontSize: 46 * scale,
      fontWeight: 600,
      letterSpacing: '-0.01em',
    }}
  >
    <span>{emoji}</span>
    <span>@{name}</span>
  </div>
);
