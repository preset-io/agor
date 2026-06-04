import { InboxOutlined } from '@ant-design/icons';
import type { ButtonProps } from 'antd';
import { Button, Tooltip } from 'antd';
import type React from 'react';

type IconProps = React.ComponentProps<typeof InboxOutlined>;

type ArchiveButtonBaseProps = Omit<ButtonProps, 'icon'> & {
  ariaLabel?: string;
  tooltip?: React.ReactNode;
  stopPropagation?: boolean;
};

interface ArchiveToggleButtonProps extends Omit<ArchiveButtonBaseProps, 'children' | 'onClick'> {
  archived: boolean;
  onToggle: (nextArchived: boolean) => void;
}

export const ArchiveIcon: React.FC<IconProps> = (props) => <InboxOutlined {...props} />;

const labelFromTooltip = (tooltip: React.ReactNode): string | undefined =>
  typeof tooltip === 'string' && tooltip.trim().length > 0 ? tooltip : undefined;

export const ArchiveToggleButton: React.FC<ArchiveToggleButtonProps> = ({
  archived,
  loading = false,
  onToggle,
  tooltip,
  stopPropagation = true,
  ariaLabel,
  size = 'small',
  type = 'text',
  ...buttonProps
}) => {
  const title = tooltip ?? (archived ? 'Archived • Click to unarchive' : 'Archive');
  const accessibleLabel = labelFromTooltip(title);

  return (
    <Tooltip title={title}>
      <Button
        {...buttonProps}
        type={type}
        size={size}
        icon={<ArchiveIcon />}
        loading={loading}
        aria-label={ariaLabel ?? accessibleLabel}
        title={buttonProps.title ?? accessibleLabel}
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

export const ArchiveActionButton: React.FC<ArchiveButtonBaseProps> = ({
  tooltip = 'Archive',
  stopPropagation = true,
  ariaLabel,
  size = 'small',
  type = 'text',
  onClick,
  onMouseEnter,
  onMouseLeave,
  children,
  ...buttonProps
}) => {
  const accessibleLabel = labelFromTooltip(tooltip);
  const isIconOnly = children === undefined || children === null;

  const button = (
    <Button
      {...buttonProps}
      type={type}
      size={size}
      icon={<ArchiveIcon />}
      aria-label={ariaLabel ?? (isIconOnly ? accessibleLabel : undefined)}
      title={buttonProps.title ?? (isIconOnly ? accessibleLabel : undefined)}
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
