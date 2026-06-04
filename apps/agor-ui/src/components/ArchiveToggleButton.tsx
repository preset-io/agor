import { CodeSandboxOutlined, DropboxOutlined } from '@ant-design/icons';
import type { ButtonProps } from 'antd';
import { Button, Tooltip, theme } from 'antd';
import type React from 'react';
import { useState } from 'react';

interface ArchiveIconProps {
  archived?: boolean;
  hovered?: boolean;
}

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

export const ArchiveIcon: React.FC<ArchiveIconProps> = ({ archived = false, hovered = false }) => {
  const { token } = theme.useToken();

  if (archived) {
    return hovered ? (
      <DropboxOutlined style={{ color: token.colorSuccess }} />
    ) : (
      <CodeSandboxOutlined style={{ color: token.colorWarning }} />
    );
  }

  return hovered ? (
    <CodeSandboxOutlined style={{ color: token.colorWarning }} />
  ) : (
    <DropboxOutlined style={{ color: token.colorWarning }} />
  );
};

export const ArchiveToggleButton: React.FC<ArchiveToggleButtonProps> = ({
  archived,
  loading = false,
  onToggle,
  tooltip,
  stopPropagation = true,
  disabled,
  style,
}) => {
  const [hovered, setHovered] = useState(false);

  const title = tooltip ?? (archived ? 'Archived • Click to unarchive' : 'Archive');

  return (
    <Tooltip title={title}>
      <Button
        type="text"
        size="small"
        icon={<ArchiveIcon archived={archived} hovered={hovered} />}
        loading={loading}
        disabled={disabled}
        style={style}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
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
  const [hovered, setHovered] = useState(false);

  const button = (
    <Button
      {...buttonProps}
      type={type}
      size={size}
      icon={<ArchiveIcon hovered={hovered} />}
      onMouseEnter={(event) => {
        setHovered(true);
        onMouseEnter?.(event);
      }}
      onMouseLeave={(event) => {
        setHovered(false);
        onMouseLeave?.(event);
      }}
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
