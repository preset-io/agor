import type { CardProps } from 'antd';
import { Card, theme } from 'antd';
import { glassCardStyle, withAlpha } from './glassStyles';

const GLASS_HIGHLIGHT_ANIMATION = `
  @keyframes agor-glass-highlight-primary {
    0%, 100% { transform: translate(0, 0) scale(1); opacity: 0.8; }
    50% { transform: translate(-28px, -18px) scale(1.15); opacity: 1; }
  }
  @keyframes agor-glass-highlight-secondary {
    0%, 100% { transform: translate(0, 0) scale(1); opacity: 0.5; }
    50% { transform: translate(20px, 28px) scale(1.1); opacity: 0.8; }
  }
  .agor-glass-highlight-primary {
    animation: agor-glass-highlight-primary 9s ease-in-out infinite;
  }
  .agor-glass-highlight-secondary {
    animation: agor-glass-highlight-secondary 12s ease-in-out infinite;
  }
  @media (prefers-reduced-motion: reduce) {
    .agor-glass-highlight-primary,
    .agor-glass-highlight-secondary {
      animation: none !important;
    }
  }
`;

export interface GlassPanelHighlightsProps {
  intensity?: 'subtle' | 'strong';
  animated?: boolean;
}

export function GlassPanelHighlights({
  intensity = 'subtle',
  animated = false,
}: GlassPanelHighlightsProps) {
  const { token } = theme.useToken();
  const isStrong = intensity === 'strong';

  return (
    <div
      aria-hidden="true"
      data-glass-highlights={intensity}
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 0,
        overflow: 'hidden',
        pointerEvents: 'none',
        borderRadius: 'inherit',
      }}
    >
      {animated && <style>{GLASS_HIGHLIGHT_ANIMATION}</style>}
      <div
        className={animated ? 'agor-glass-highlight-primary' : undefined}
        data-glass-highlight="bottom-right"
        style={{
          position: 'absolute',
          width: isStrong ? 360 : 280,
          height: isStrong ? 360 : 280,
          borderRadius: '50%',
          background: `radial-gradient(circle, ${withAlpha(token.colorPrimary, isStrong ? 0.3 : 0.2)} 0%, transparent 70%)`,
          bottom: isStrong ? -130 : -110,
          right: isStrong ? -90 : -100,
        }}
      />
      <div
        className={animated ? 'agor-glass-highlight-secondary' : undefined}
        data-glass-highlight="top-left"
        style={{
          position: 'absolute',
          width: isStrong ? 220 : 180,
          height: isStrong ? 220 : 180,
          borderRadius: '50%',
          background: `radial-gradient(circle, ${withAlpha(token.geekblue5, isStrong ? 0.18 : 0.12)} 0%, transparent 70%)`,
          top: isStrong ? -70 : -65,
          left: isStrong ? -50 : -55,
        }}
      />
    </div>
  );
}

export interface GlassPanelProps extends CardProps {
  surfaceAlpha?: number;
  highlights?: boolean | GlassPanelHighlightsProps;
}

export function GlassPanel({
  surfaceAlpha = 0.7,
  highlights = false,
  style,
  children,
  ...cardProps
}: GlassPanelProps) {
  const { token } = theme.useToken();
  const glassStyle = glassCardStyle(token, surfaceAlpha);
  const highlightProps = highlights === true ? {} : highlights || null;

  return (
    <Card
      {...cardProps}
      data-glass-panel="true"
      style={{
        ...glassStyle,
        ...style,
        position: 'relative',
        overflow: 'hidden',
        boxShadow: [style?.boxShadow, glassStyle.boxShadow].filter(Boolean).join(', '),
      }}
    >
      {highlightProps && <GlassPanelHighlights {...highlightProps} />}
      <div style={{ position: 'relative', zIndex: 1 }}>{children}</div>
    </Card>
  );
}
