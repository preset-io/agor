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
      size="small"
      shape="round"
      disabled={disabled}
      aria-label={disabled ? `${label}: ${disabledReason}` : `Open pinned ${label}`}
      className={styles.pinnedLinkButton}
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
    >
      <Flex align="center" gap={token.sizeXXS} className={styles.pinnedLinkContent}>
        <span aria-hidden="true" className={styles.pinnedLinkIcon}>
          {icon}
        </span>
        <Typography.Text ellipsis disabled={disabled} className={styles.pinnedLinkLabel}>
          {label}
        </Typography.Text>
      </Flex>
    </Button>
  );
}
