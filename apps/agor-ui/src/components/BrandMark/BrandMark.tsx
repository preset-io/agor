import { theme } from 'antd';
import type { CSSProperties } from 'react';
import { brandMarkHref } from '../../branding/brand';

export interface BrandMarkProps {
  /** Square rendered size in CSS pixels. */
  size?: number;
  style?: CSSProperties;
  className?: string;
}

/**
 * Theme-colored Agor display mark.
 *
 * The canonical SVG remains a fixed-color standalone asset for static
 * consumers. Using it as a mask lets product chrome color the same geometry
 * with the active Ant Design primary token without duplicating the paths in
 * JSX. This component is decorative; adjacent text or the containing control
 * provides the accessible name.
 */
export function BrandMark({ size = 32, style, className }: BrandMarkProps) {
  const { token } = theme.useToken();
  const maskImage = `url("${brandMarkHref()}")`;

  return (
    <span
      aria-hidden="true"
      className={className}
      data-brand-mark="themed"
      style={{
        display: 'block',
        width: size,
        height: size,
        flexShrink: 0,
        backgroundColor: token.colorPrimary,
        maskImage,
        maskPosition: 'center',
        maskRepeat: 'no-repeat',
        maskSize: 'contain',
        WebkitMaskImage: maskImage,
        WebkitMaskPosition: 'center',
        WebkitMaskRepeat: 'no-repeat',
        WebkitMaskSize: 'contain',
        ...style,
      }}
    />
  );
}
