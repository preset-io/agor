import type { theme } from 'antd';
import type React from 'react';

export const withAlpha = (color: string, alpha: number): string => {
  if (color.startsWith('#')) {
    const hex = color.slice(1);
    const fullHex =
      hex.length === 3
        ? hex
            .split('')
            .map((char) => `${char}${char}`)
            .join('')
        : hex;
    if (fullHex.length === 6) {
      const value = Number.parseInt(fullHex, 16);
      const r = (value >> 16) & 255;
      const g = (value >> 8) & 255;
      const b = value & 255;
      // biome-ignore lint/plugin/noHardcodedColorLiteral: centralized theme-color alpha resolver emits CSS syntax from token channels
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }
  }

  const rgbMatch = color.match(/^rgba?\(([^)]+)\)$/);
  if (rgbMatch) {
    const [r, g, b] = rgbMatch[1]
      .split(',')
      .map((part) => part.trim())
      .slice(0, 3);
    if (r == null || g == null || b == null) return color;
    // biome-ignore lint/plugin/noHardcodedColorLiteral: centralized theme-color alpha resolver emits CSS syntax from token channels
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  return color;
};

export const glassCardStyle = (
  token: ReturnType<typeof theme.useToken>['token'],
  alpha = 0.3
): React.CSSProperties => ({
  ...glassSurfaceStyle(token, alpha),
  boxShadow: `inset 0 1px 0 ${withAlpha(token.colorWhite, 0.12)}`,
});

/**
 * A token-driven glass fill without interaction styling. Keeping the
 * backdrop-filter on a static layer avoids repainting it when hover/focus
 * affordances change on the surrounding component.
 */
export const glassSurfaceStyle = (
  token: ReturnType<typeof theme.useToken>['token'],
  alpha = 0.3
): React.CSSProperties => ({
  background: withAlpha(token.colorBgContainer, alpha),
  backdropFilter: 'blur(20px) saturate(180%)',
  WebkitBackdropFilter: 'blur(20px) saturate(180%)',
});
