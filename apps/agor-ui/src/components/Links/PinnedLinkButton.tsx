import { PushpinFilled } from '@ant-design/icons';
import { Button, Flex, Typography, theme } from 'antd';
import type React from 'react';

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
      style={{ minWidth: 0, maxWidth: 156, height: 26, flex: '0 1 auto' }}
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
    >
      <Flex align="center" gap={token.sizeXXS} style={{ minWidth: 0 }}>
        <PushpinFilled style={{ color: token.colorWarning, fontSize: token.fontSizeSM }} />
        <span aria-hidden="true" style={{ display: 'inline-flex', flex: '0 0 auto' }}>
          {icon}
        </span>
        <Typography.Text
          ellipsis
          disabled={disabled}
          style={{ minWidth: 0, fontSize: token.fontSizeSM }}
        >
          {label}
        </Typography.Text>
      </Flex>
    </Button>
  );
}
