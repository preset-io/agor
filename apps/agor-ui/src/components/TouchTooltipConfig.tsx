import { ConfigProvider, type TooltipProps } from 'antd';
import type React from 'react';
import { useIsTouchInput } from '../hooks/useCanHover';

const TOUCH_TOOLTIP: { trigger: TooltipProps['trigger'] } = { trigger: [] };

/**
 * App-wide tooltip default for touch screens. A tap emulates hover, so a hover
 * tooltip opened on the first tap and iOS swallowed the click, needing a second
 * tap. On touch, tooltips only open where a call site controls `open` or sets
 * its own `trigger`. Icon-only controls must carry an aria-label: a tooltip is
 * never their accessible name.
 */
export const TouchTooltipConfig: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const touch = useIsTouchInput();
  return <ConfigProvider tooltip={touch ? TOUCH_TOOLTIP : undefined}>{children}</ConfigProvider>;
};
