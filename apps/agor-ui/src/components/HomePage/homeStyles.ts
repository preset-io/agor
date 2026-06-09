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
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }
  }

  const rgbMatch = color.match(/^rgba?\(([^)]+)\)$/);
  if (rgbMatch) {
    const [r, g, b] = rgbMatch[1]
      .split(',')
      .map((part) => part.trim())
      .slice(0, 3);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  return color;
};

export const glassCardStyle = (
  token: ReturnType<typeof theme.useToken>['token'],
  alpha = 0.5
): React.CSSProperties => ({
  background: withAlpha(token.colorBgContainer, alpha),
  backgroundColor: withAlpha(token.colorBgContainer, alpha),
  backdropFilter: 'blur(12px)',
  WebkitBackdropFilter: 'blur(12px)',
});
