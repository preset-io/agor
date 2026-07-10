import { PushpinFilled } from '@ant-design/icons';
import { Button, Flex, Typography, theme } from 'antd';
import type React from 'react';
import styles from './linkUi.module.css';

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
      className={styles.pinnedButton}
      size="small"
      shape="round"
      disabled={disabled}
      aria-label={disabled ? `${label}: ${disabledReason}` : `Open pinned ${label}`}
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
    >
      <Flex align="center" gap={token.sizeXXS} className={styles.minWidthZero}>
        <PushpinFilled style={{ color: token.colorWarning, fontSize: token.fontSizeSM }} />
        <span className={styles.pinnedIcon} aria-hidden="true">
          {icon}
        </span>
        <Typography.Text
          ellipsis
          disabled={disabled}
          style={{ fontSize: token.fontSizeSM, minWidth: 0 }}
        >
          {label}
        </Typography.Text>
      </Flex>
    </Button>
  );
}
