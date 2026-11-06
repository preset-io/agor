import type { FeatureAnnouncementVisual } from '@agor-live/client';
import { AppstoreOutlined, NumberOutlined, RobotOutlined } from '@ant-design/icons';
import { type GlobalToken, theme } from 'antd';
import { type CSSProperties, useEffect, useState } from 'react';
import { useTheme } from '../../contexts/ThemeContext';
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';

/** One loop of an illustration: the "before" frame, then the "after" frame held until the next loop. */
const LOOP_MS = 3_600;
const BEFORE_MS = 500;

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

/** A hex token with an alpha suffix, for the faint tints the illustrations use. */
export const tint = (hex: string, alpha: string) =>
  /^#[0-9a-f]{6}$/i.test(hex) ? `${hex}${alpha}` : hex;

interface Palette {
  token: GlobalToken;
  isDark: boolean;
}

/** The dotted canvas behind each illustration, a step below the pop-up's surface. */
const frameStyle = ({ token, isDark }: Palette): CSSProperties => ({
  position: 'relative',
  boxSizing: 'border-box',
  overflow: 'hidden',
  borderRadius: 12,
  border: `${token.lineWidth}px solid ${token.colorBorderSecondary}`,
  background: isDark ? token.colorBgContainer : token.colorBgLayout,
  backgroundImage: `radial-gradient(${isDark ? token.colorFillQuaternary : token.colorFillTertiary} 1px, transparent 1px)`,
  backgroundSize: '14px 14px',
});

/** The channel illustration's soft blue (Agor's info color is teal). */
const channelBlue = ({ token, isDark }: Palette) => (isDark ? token.blue8 : token.blue6);

const SCATTER = [
  { x: 6, y: 58, r: -9 },
  { x: 62, y: 4, r: 7 },
  { x: 38, y: 62, r: 12 },
  { x: 74, y: 52, r: -6 },
  { x: 18, y: 8, r: 5 },
  { x: 48, y: 30, r: -12 },
];

const ZoneGrid: React.FC<Palette & { after: boolean; motion: boolean }> = ({
  token,
  after,
  motion,
  isDark,
}) => (
  <div style={{ ...frameStyle({ token, isDark }), padding: 18 }}>
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        borderRadius: 10,
        border: `1.5px solid ${tint(token.colorPrimary, '80')}`,
        background: tint(token.colorPrimary, '12'),
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 10px',
          borderBottom: `1px dashed ${tint(token.colorPrimary, '40')}`,
          fontSize: token.fontSizeSM,
        }}
      >
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            color: token.colorPrimaryText,
            fontWeight: 600,
          }}
        >
          <AppstoreOutlined /> Launch prep
        </span>
        <span
          style={{
            display: 'flex',
            gap: 2,
            padding: 2,
            borderRadius: 6,
            background: token.colorFillTertiary,
            color: token.colorTextTertiary,
            fontSize: 10.5,
          }}
        >
          {['Row', 'Column', 'Grid'].map((label) => {
            const on = after && label === 'Grid';
            return (
              <span
                key={label}
                style={{
                  padding: '2px 7px',
                  borderRadius: 4,
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
      <div style={{ position: 'relative', height: 150, margin: '0 6px' }}>
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
                borderRadius: 7,
                border: `1.5px solid ${after ? tint(token.colorPrimary, 'bf') : token.colorBorder}`,
                background: token.colorBgElevated,
                transition: motion
                  ? `left 0.6s cubic-bezier(0.34, 1.3, 0.5, 1) ${i * 70}ms, top 0.6s cubic-bezier(0.34, 1.3, 0.5, 1) ${i * 70}ms, transform 0.6s ease ${i * 70}ms, border-color 0.4s`
                  : undefined,
              }}
            >
              <span
                style={{ width: 6, height: 6, borderRadius: '50%', background: token.colorPrimary }}
              />
              <span style={{ height: 4, borderRadius: 2, background: token.colorFill }} />
              <span
                style={{
                  width: '60%',
                  height: 4,
                  borderRadius: 2,
                  background: token.colorFill,
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

const Channels: React.FC<Palette & { after: boolean; motion: boolean }> = ({
  token,
  after,
  motion,
  isDark,
}) => (
  <div style={{ ...frameStyle({ token, isDark }), height: 206 }}>
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
          padding: '6px 10px',
          borderRadius: 8,
          border: `1.5px solid ${after ? tint(channelBlue({ token, isDark }), '99') : token.colorBorder}`,
          background: token.colorBgElevated,
          color: after ? channelBlue({ token, isDark }) : token.colorTextTertiary,
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
            stroke: channelBlue({ token, isDark }),
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
      <span style={{ fontSize: 11.5, fontWeight: 500, color: token.colorTextSecondary }}>
        Agor teammate
      </span>
    </div>
  </div>
);

const ScreenshotFrame: React.FC<Palette & { after: boolean; motion: boolean }> = ({
  token,
  after,
  motion,
  isDark,
}) => (
  <div style={{ ...frameStyle({ token, isDark }), padding: '18px 22px' }}>
    <div
      style={{
        borderRadius: 10,
        border: `1.5px solid ${token.colorBorder}`,
        background: token.colorBgElevated,
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
        <Illustration token={token} isDark={isDark} after={after} motion={!reduced} />
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
