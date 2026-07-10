import { Button, Flex, theme } from 'antd';
import type React from 'react';

interface ActionLinkRowProps {
  children: React.ReactNode;
  onActivate: () => void;
  ariaLabel: string;
  actions?: React.ReactNode;
  disabled?: boolean;
  compact?: boolean;
  bordered?: boolean;
  style?: React.CSSProperties;
}

/**
 * Shared accessible row for link collections. The primary target is a native
 * Ant Design button and secondary actions are siblings, so keyboard, focus,
 * disabled, and nested-action behavior do not need to be rebuilt per surface.
 */
export function ActionLinkRow({
  children,
  onActivate,
  ariaLabel,
  actions,
  disabled = false,
  compact = false,
  bordered = false,
  style,
}: ActionLinkRowProps) {
  const { token } = theme.useToken();

  return (
    <Flex
      align="center"
      gap={token.sizeXS}
      style={{
        width: '100%',
        minWidth: 0,
        borderBottom: bordered ? `1px solid ${token.colorBorderSecondary}` : undefined,
        borderRadius: token.borderRadius,
        ...style,
      }}
    >
      <Button
        type="text"
        block
        disabled={disabled}
        aria-label={ariaLabel}
        onClick={onActivate}
        style={{
          height: 'auto',
          minWidth: 0,
          flex: 1,
          padding: compact
            ? `${token.sizeXXS}px ${token.sizeXS}px`
            : `${token.sizeSM}px ${token.sizeXS}px`,
          alignItems: 'stretch',
          justifyContent: 'flex-start',
          whiteSpace: 'normal',
          textAlign: 'left',
        }}
      >
        {children}
      </Button>
      {actions && (
        <Flex align="center" gap={token.sizeXXS} style={{ flex: '0 0 auto' }}>
          {actions}
        </Flex>
      )}
    </Flex>
  );
}
