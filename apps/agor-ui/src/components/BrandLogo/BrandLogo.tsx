import { theme } from 'antd';
import type { CSSProperties } from 'react';

export interface BrandLogoProps {
  /**
   * Typography level (1-5)
   * @default 3
   */
  level?: 1 | 2 | 3 | 4 | 5;
  /**
   * Additional styles to apply
   */
  style?: CSSProperties;
  /**
   * Custom class name
   */
  className?: string;
}

// Font size mapping based on Ant Design's Title levels (increased by ~12.5%)
const LEVEL_SIZES = {
  1: '43px',
  2: '34px',
  3: '27px',
  4: '23px',
  5: '18px',
} as const;

/**
 * BrandLogo component with gradient text effect
 *
 * Renders "agor" with a theme-aware teal gradient
 * Uses a plain element instead of Ant Design Typography to ensure gradient works
 */
export const BrandLogo: React.FC<BrandLogoProps> = ({ level = 3, style, className }) => {
  const { token } = theme.useToken();
  const gradientStyle: CSSProperties = {
    margin: 0,
    fontSize: LEVEL_SIZES[level],
    lineHeight: 1.35,
    background: `linear-gradient(90deg, ${token.colorPrimaryActive} 0%, ${token.colorPrimary} 52%, ${token.colorPrimaryHover} 100%)`,
    WebkitBackgroundClip: 'text',
    WebkitTextFillColor: 'transparent',
    backgroundClip: 'text',
    fontWeight: 700,
    width: 'fit-content',
    ...style,
  };

  return (
    <h1 className={className} style={gradientStyle}>
      agor
    </h1>
  );
};
