import type { FeatureAnnouncementVisual } from '@agor-live/client';
import { AppstoreOutlined, NumberOutlined, RobotOutlined } from '@ant-design/icons';
import { type GlobalToken, theme } from 'antd';
import { type CSSProperties, useEffect, useState } from 'react';
import { useTheme } from '../../contexts/ThemeContext';
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';

/** One loop of an illustration: the "before" frame, then the "after" frame held until the next loop. */
const LOOP_MS = 3_600;
const BEFORE_MS = 500;
const ILLUSTRATION_HEIGHT = 190;

/** False for the "before" frame, true for the "after" one. Reduced motion holds the "after" frame. */
function useLoop(reduced: boolean): boolean {
  const [after, setAfter] = useState(reduced);
  useEffect(() => {
    if (reduced) {
      setAfter(true);
      return;
    }
    let timer: number | undefined;
    const play = () => {
      setAfter(false);
      timer = window.setTimeout(() => setAfter(true), BEFORE_MS);
    };
    play();
    const loop = window.setInterval(play, LOOP_MS);
    return () => {
      window.clearInterval(loop);
      window.clearTimeout(timer);
    };
  }, [reduced]);
  return after;
}

const frameStyle = (token: GlobalToken): CSSProperties => ({
  position: 'relative',
  boxSizing: 'border-box',
  height: ILLUSTRATION_HEIGHT,
  overflow: 'hidden',
  borderRadius: token.borderRadiusLG,
  border: `${token.lineWidth}px solid ${token.colorBorderSecondary}`,
  background: token.colorFillQuaternary,
  backgroundImage: `radial-gradient(${token.colorBorder} 1px, transparent 1px)`,
  backgroundSize: '14px 14px',
});

const SCATTER = [
  { x: 6, y: 58, r: -9 },
  { x: 62, y: 4, r: 7 },
  { x: 38, y: 62, r: 12 },
  { x: 74, y: 52, r: -6 },
  { x: 18, y: 8, r: 5 },
  { x: 48, y: 30, r: -12 },
];

const ZoneGrid: React.FC<{ token: GlobalToken; after: boolean; motion: boolean }> = ({
  token,
  after,
  motion,
}) => (
  <div style={{ ...frameStyle(token), padding: token.padding }}>
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        borderRadius: token.borderRadius,
        border: `1.5px solid ${token.colorPrimaryBorder}`,
        background: token.colorPrimaryBg,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: `${token.paddingXXS}px ${token.paddingXS}px`,
          borderBottom: `1px dashed ${token.colorPrimaryBorder}`,
          fontSize: token.fontSizeSM,
        }}
      >
        <span style={{ color: token.colorPrimaryText, fontWeight: 600 }}>
          <AppstoreOutlined /> Launch prep
        </span>
        <span style={{ display: 'flex', gap: 2, color: token.colorTextTertiary }}>
          {['Row', 'Column', 'Grid'].map((label) => {
            const on = after && label === 'Grid';
            return (
              <span
                key={label}
                style={{
                  padding: '0 6px',
                  borderRadius: token.borderRadiusSM,
                  background: on ? token.colorPrimary : 'transparent',
                  color: on ? token.colorTextLightSolid : undefined,
                  transition: motion ? 'background 0.3s, color 0.3s' : undefined,
                }}
              >
                {label}
              </span>
            );
          })}
        </span>
      </div>
      <div style={{ position: 'relative', flex: 1, margin: `0 ${token.marginXS}px` }}>
        {SCATTER.map((spot, i) => {
          const col = i % 3;
          const row = Math.floor(i / 3);
          return (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: a fixed decorative layout
              key={i}
              style={{
                position: 'absolute',
                boxSizing: 'border-box',
                width: '29%',
                height: '40%',
                left: after ? `${4 + col * 32.5}%` : `${spot.x}%`,
                top: after ? `${6 + row * 48}%` : `${spot.y}%`,
                transform: after ? 'rotate(0deg)' : `rotate(${spot.r}deg)`,
                display: 'flex',
                flexDirection: 'column',
                gap: 5,
                padding: '7px 8px',
                borderRadius: token.borderRadiusSM,
                border: `1.5px solid ${after ? token.colorPrimary : token.colorBorder}`,
                background: token.colorBgContainer,
                transition: motion
                  ? `left 0.6s cubic-bezier(0.34, 1.3, 0.5, 1) ${i * 70}ms, top 0.6s cubic-bezier(0.34, 1.3, 0.5, 1) ${i * 70}ms, transform 0.6s ease ${i * 70}ms, border-color 0.4s`
                  : undefined,
              }}
            >
              <span
                style={{ width: 6, height: 6, borderRadius: '50%', background: token.colorPrimary }}
              />
              <span style={{ height: 4, borderRadius: 2, background: token.colorFillSecondary }} />
              <span
                style={{
                  width: '60%',
                  height: 4,
                  borderRadius: 2,
                  background: token.colorFillSecondary,
                }}
              />
            </div>
          );
        })}
      </div>
    </div>
  </div>
);

const CHANNELS = ['product', 'support', 'design'];

const Channels: React.FC<{ token: GlobalToken; after: boolean; motion: boolean }> = ({
  token,
  after,
  motion,
}) => (
  <div style={frameStyle(token)}>
    {CHANNELS.map((channel, i) => (
      <div
        key={channel}
        style={{
          position: 'absolute',
          boxSizing: 'border-box',
          left: token.paddingLG,
          top: `${20 + i * 30}%`,
          width: 104,
          transform: 'translateY(-50%)',
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: `${token.paddingXXS}px ${token.paddingXS}px`,
          borderRadius: token.borderRadius,
          border: `1.5px solid ${after ? token.colorPrimaryBorder : token.colorBorder}`,
          background: token.colorBgContainer,
          color: after ? token.colorPrimaryText : token.colorTextTertiary,
          fontSize: token.fontSizeSM,
          fontWeight: 500,
          transition: motion
            ? `border-color 0.4s ${300 + i * 220}ms, color 0.4s ${300 + i * 220}ms`
            : undefined,
        }}
      >
        <NumberOutlined />
        {channel}
      </div>
    ))}
    <svg
      aria-hidden="true"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      style={{
        position: 'absolute',
        top: 0,
        height: '100%',
        left: token.paddingLG + 104,
        width: `calc(100% - ${token.paddingLG * 2 + 104 + 74}px)`,
        overflow: 'visible',
      }}
    >
      {[20, 50, 80].map((y, i) => (
        <path
          key={y}
          d={`M0 ${y} C 50 ${y}, 50 50, 100 50`}
          vectorEffect="non-scaling-stroke"
          style={{
            fill: 'none',
            stroke: token.colorPrimary,
            strokeWidth: 1.5,
            strokeDasharray: 400,
            strokeDashoffset: after ? 0 : 400,
            opacity: 0.7,
            transition: motion ? `stroke-dashoffset 0.9s ease ${i * 220}ms` : undefined,
          }}
        />
      ))}
    </svg>
    <div
      style={{
        position: 'absolute',
        right: token.paddingLG,
        top: '50%',
        width: 96,
        transform: 'translateY(-50%)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: token.marginXS,
      }}
    >
      <span
        style={{
          width: 52,
          height: 52,
          display: 'grid',
          placeItems: 'center',
          borderRadius: 14,
          background: token.colorPrimary,
          color: token.colorTextLightSolid,
          fontSize: 22,
          boxShadow: `0 0 0 6px ${token.colorPrimaryBg}`,
        }}
      >
        <RobotOutlined />
      </span>
      <span style={{ fontSize: token.fontSizeSM, color: token.colorTextSecondary }}>
        Agor teammate
      </span>
    </div>
  </div>
);

const ScreenshotFrame: React.FC<{ token: GlobalToken; after: boolean; motion: boolean }> = ({
  token,
  after,
  motion,
}) => (
  <div style={{ ...frameStyle(token), padding: `${token.padding}px ${token.paddingLG}px` }}>
    <div
      style={{
        borderRadius: token.borderRadius,
        border: `1.5px solid ${token.colorBorder}`,
        background: token.colorBgContainer,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          gap: token.marginSM,
          padding: '6px 8px 0',
          background: token.colorFillTertiary,
        }}
      >
        <span style={{ display: 'flex', gap: 4, paddingBottom: 8 }}>
          {[0, 1, 2].map((dot) => (
            <i
              key={dot}
              style={{
                width: 7,
                height: 7,
                borderRadius: '50%',
                background: token.colorBorder,
              }}
            />
          ))}
        </span>
        <span
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '5px 10px',
            borderRadius: `${token.borderRadiusSM}px ${token.borderRadiusSM}px 0 0`,
            background: token.colorBgContainer,
            maxWidth: after ? 200 : 0,
            overflow: 'hidden',
            whiteSpace: 'nowrap',
            transition: motion ? 'max-width 0.9s ease' : undefined,
          }}
        >
          <span
            style={{
              width: 10,
              height: 10,
              flexShrink: 0,
              borderRadius: 3,
              background: token.colorPrimary,
            }}
          />
          <span style={{ fontSize: token.fontSizeSM, color: token.colorText, fontWeight: 500 }}>
            Launch dashboard
          </span>
        </span>
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr 1fr',
          gap: token.marginXS,
          padding: token.paddingSM,
          height: 110,
        }}
      >
        <span
          style={{
            gridColumn: '1 / -1',
            borderRadius: token.borderRadiusSM,
            background: token.colorPrimaryBg,
          }}
        />
        {[0, 1, 2].map((block) => (
          <span
            key={block}
            style={{ borderRadius: token.borderRadiusSM, background: token.colorFillSecondary }}
          />
        ))}
      </div>
    </div>
  </div>
);

const ILLUSTRATIONS = {
  'zone-grid': ZoneGrid,
  channels: Channels,
  'screenshot-frame': ScreenshotFrame,
} as const;

/**
 * An announcement's picture: a drawn illustration template on a short loop, or
 * a hosted image or muted looping video. Reduced motion gets a still frame.
 * Media that fails to load disappears, so the copy must stand on its own.
 */
export const AnnouncementVisual: React.FC<{
  visual: FeatureAnnouncementVisual;
  alt: string | null;
}> = ({ visual, alt }) => {
  const { token } = theme.useToken();
  const { isDark } = useTheme();
  const reduced = usePrefersReducedMotion();
  const after = useLoop(reduced || visual.type === 'media');
  const [failed, setFailed] = useState(false);

  if (visual.type === 'illustration') {
    const Illustration = ILLUSTRATIONS[visual.key];
    return (
      <div role="img" aria-label={alt ?? undefined} aria-hidden={alt ? undefined : true}>
        <Illustration token={token} after={after} motion={!reduced} />
      </div>
    );
  }
  if (failed) return null;
  const src = (isDark && visual.url_dark) || visual.url;
  const style: CSSProperties = {
    display: 'block',
    width: '100%',
    aspectRatio: '16 / 9',
    objectFit: 'cover',
    borderRadius: token.borderRadiusLG,
    border: `${token.lineWidth}px solid ${token.colorBorderSecondary}`,
    background: token.colorFillQuaternary,
  };
  return visual.mime.startsWith('video/') ? (
    <video
      key={src}
      src={src}
      muted
      loop
      playsInline
      // Reduced motion: no autoplay, so the first frame stays as a still.
      autoPlay={!reduced}
      preload="metadata"
      aria-label={alt ?? undefined}
      onError={() => setFailed(true)}
      style={style}
    />
  ) : (
    <img key={src} src={src} alt={alt ?? ''} onError={() => setFailed(true)} style={style} />
  );
};
