import { Button, Flex, theme } from 'antd';
import type React from 'react';
import { useId } from 'react';
import { useIsTouchInput } from '../../hooks/useCanHover';
import { MOBILE_TOUCH_TARGET } from '../../utils/deviceDetection';

/**
 * A collapsed preview fades out at the bottom, with a quiet toggle below.
 * mask-image only reads alpha, so the fade works on any surface, glass included.
 */
export function ShowMoreFade({
  collapsed,
  onToggle,
  moreLabel = 'Show more',
  className,
  style,
  children,
}: {
  collapsed: boolean;
  onToggle: () => void;
  /** e.g. "Show all 42 lines" for tool output. */
  moreLabel?: string;
  className?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
}) {
  const { token } = theme.useToken();
  const touch = useIsTouchInput();
  const contentId = useId();
  const mask = `linear-gradient(to bottom, ${token.colorTextBase} calc(100% - ${token.sizeXXL}px), transparent)`;
  return (
    <div className={className}>
      <div
        id={contentId}
        data-fade={collapsed || undefined}
        style={{ ...style, ...(collapsed && { maskImage: mask, WebkitMaskImage: mask }) }}
      >
        {children}
      </div>
      <Flex justify="center">
        <Button
          type="text"
          size="small"
          shape="round"
          aria-expanded={!collapsed}
          aria-controls={contentId}
          onClick={(event) => {
            event.stopPropagation();
            onToggle();
          }}
          style={{
            color: token.colorTextSecondary,
            fontSize: token.fontSizeSM,
            minHeight: touch ? MOBILE_TOUCH_TARGET : undefined,
          }}
        >
          {collapsed ? moreLabel : 'Show less'}
        </Button>
      </Flex>
    </div>
  );
}
