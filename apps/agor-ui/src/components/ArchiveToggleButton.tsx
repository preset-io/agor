import { InboxOutlined } from '@ant-design/icons';
import type { ButtonProps } from 'antd';
import { Button, Tooltip } from 'antd';
import type React from 'react';

interface ArchiveToggleButtonProps {
  archived: boolean;
  loading?: boolean;
  onToggle: (nextArchived: boolean) => void;
  tooltip?: string;
  stopPropagation?: boolean;
  disabled?: boolean;
  style?: React.CSSProperties;
}

interface ArchiveActionButtonProps extends Omit<ButtonProps, 'icon'> {
  tooltip?: string;
  stopPropagation?: boolean;
}

export const ArchiveIcon: React.FC = () => <InboxOutlined />;

export const ArchiveToggleButton: React.FC<ArchiveToggleButtonProps> = ({
  archived,
  loading = false,
  onToggle,
  tooltip,
  stopPropagation = true,
  disabled,
  style,
}) => {
  const title = tooltip ?? (archived ? 'Archived • Click to unarchive' : 'Archive');

  return (
    <Tooltip title={title}>
      <Button
        type="text"
        size="small"
        icon={<ArchiveIcon />}
        loading={loading}
        disabled={disabled}
        style={style}
        onClick={(event) => {
          if (stopPropagation) {
            event.stopPropagation();
          }
          onToggle(!archived);
        }}
      />
    </Tooltip>
  );
};

export const ArchiveActionButton: React.FC<ArchiveActionButtonProps> = ({
  tooltip = 'Archive',
  stopPropagation = true,
  size = 'small',
  type = 'text',
  onClick,
  onMouseEnter,
  onMouseLeave,
  children,
  ...buttonProps
}) => {
  const button = (
    <Button
      {...buttonProps}
      type={type}
      size={size}
      icon={<ArchiveIcon />}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onClick={(event) => {
        if (stopPropagation) {
          event.stopPropagation();
        }
        onClick?.(event);
      }}
    >
      {children}
    </Button>
  );

  return tooltip ? <Tooltip title={tooltip}>{button}</Tooltip> : button;
};
