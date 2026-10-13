import logos from '@iconify-json/logos/icons.json';
import type React from 'react';

export type BrandIcon = keyof typeof logos.icons;

/** An official brand mark from the CC0 `logos` icon set (unaltered). */
export const BrandMark: React.FC<{
  icon: BrandIcon;
  size: number;
  /** Crop a lockup to its symbol (e.g. the MCP mark without its wordmark). */
  viewBox?: string;
}> = ({ icon, size, viewBox }) => {
  const data = logos.icons[icon] as { body: string; width?: number; height?: number };
  const w = data.width ?? logos.width ?? 256;
  const h = data.height ?? logos.height ?? 256;
  return (
    <svg
      width={size}
      height={size}
      viewBox={viewBox ?? `0 0 ${w} ${h}`}
      aria-hidden="true"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: static SVG body from the logos icon set
      dangerouslySetInnerHTML={{ __html: data.body }}
    />
  );
};
