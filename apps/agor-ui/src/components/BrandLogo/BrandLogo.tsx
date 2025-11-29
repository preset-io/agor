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
 * Renders "agor" with a teal gradient from brand color to lighter cyan
 * Uses a plain element instead of Ant Design Typography to ensure gradient works
 */
export const BrandLogo: React.FC<BrandLogoProps> = ({ level = 3, style, className }) => {
  const gradientStyle: CSSProperties = {
    margin: 0,
    fontSize: LEVEL_SIZES[level],
    lineHeight: 1.35,
    background: 'linear-gradient(90deg, #2e9a92 0%, #7fe8df 50%, #a8f5ed 100%)',
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
