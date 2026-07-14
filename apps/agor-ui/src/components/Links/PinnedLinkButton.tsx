import { Button, Flex, Typography, theme } from 'antd';
import type React from 'react';

const PINNED_LINK_MAX_WIDTH = 156;

interface PinnedLinkButtonProps {
  label: string;
  icon: React.ReactNode;
  disabled?: boolean;
  disabledReason?: string | null;
  onOpen: () => void;
}

export function PinnedLinkButton({
  label,
  icon,
  disabled = false,
  disabledReason,
  onOpen,
}: PinnedLinkButtonProps) {
  const { token } = theme.useToken();

  return (
    <Button
      size="small"
      shape="round"
      disabled={disabled}
      aria-label={disabled ? `${label}: ${disabledReason}` : `Open pinned ${label}`}
      style={{ minWidth: 0, maxWidth: PINNED_LINK_MAX_WIDTH, flex: '0 1 auto' }}
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
    >
      <Flex align="center" gap={token.sizeXXS} style={{ minWidth: 0 }}>
        <span aria-hidden="true" style={{ display: 'inline-flex', flex: '0 0 auto' }}>
          {icon}
        </span>
        <Typography.Text ellipsis disabled={disabled} style={{ minWidth: 0 }}>
          {label}
        </Typography.Text>
      </Flex>
    </Button>
  );
}
