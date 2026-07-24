import { theme } from 'antd';
import { memo } from 'react';

type GradientTokens = Pick<
  ReturnType<typeof theme.useToken>['token'],
  'colorPrimary' | 'colorPrimaryHover' | 'colorInfo'
>;

export interface GradientBackdropProps {
  /**
   * Page backdrops carry a little more color than backdrops embedded inside
   * an existing surface such as the About settings tab.
   */
  variant?: 'page' | 'panel';
}

export function getGradientBackgroundImage(
  token: GradientTokens,
  variant: NonNullable<GradientBackdropProps['variant']>
): string {
  const isPanel = variant === 'panel';
  const primaryStrength = isPanel ? 14 : 24;
  const mintStrength = isPanel ? 10 : 18;
  const accentStrength = isPanel ? 7 : 12;

  const primaryGlow = `color-mix(in srgb, ${token.colorPrimary} ${primaryStrength}%, transparent)`;
  const mintGlow = `color-mix(in srgb, ${token.colorPrimaryHover} ${mintStrength}%, transparent)`;
  const accentGlow = `color-mix(in srgb, ${token.colorInfo} ${accentStrength}%, transparent)`;

  return [
    `radial-gradient(ellipse 85% 68% at 8% 2%, ${primaryGlow} 0%, transparent 70%)`,
    `radial-gradient(ellipse 72% 62% at 96% 100%, ${mintGlow} 0%, transparent 72%)`,
    `radial-gradient(ellipse 48% 42% at 72% 12%, ${accentGlow} 0%, transparent 68%)`,
    `linear-gradient(145deg, transparent 18%, ${accentGlow} 48%, transparent 76%)`,
  ].join(', ');
}

/**
 * Lightweight, theme-aware version of the teal/mint ambient gradients used by
 * Agor's polished website surfaces. The gradient is deliberately static:
 * there is no canvas, animation loop, pointer tracking, or reduced-motion
 * exception to maintain.
 */
export const GradientBackdrop = memo(function GradientBackdrop({
  variant = 'page',
}: GradientBackdropProps) {
  const { token } = theme.useToken();

  return (
    <div
      aria-hidden="true"
      data-gradient-backdrop={variant}
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 0,
        overflow: 'hidden',
        pointerEvents: 'none',
        borderRadius: 'inherit',
        backgroundColor: token.colorBgLayout,
        backgroundImage: getGradientBackgroundImage(token, variant),
      }}
    />
  );
});
