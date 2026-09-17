import type { CSSProperties } from 'react';

/**
 * Base style for a mobile page's vertical scroll region. `overflowX` is pinned
 * hidden because a `overflow-y: auto` box computes `overflow-x` to `auto` too,
 * so sub-pixel width rounding at fractional device-pixel-ratios (2-3) would
 * otherwise spawn a spurious horizontal scroll and clip the right edge. The
 * content is laid out to fit the viewport width; `minWidth: 0` keeps this flex
 * child from being forced wider by its content. Spread it and add padding.
 */
export const mobileScrollAreaStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  minWidth: 0,
  overflowY: 'auto',
  overflowX: 'hidden',
};

/** Root style for a mobile page: fills the shell's content area and stacks its header above its scroll region. */
export const mobilePageStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
};
