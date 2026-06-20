import { InboxOutlined } from '@ant-design/icons';
import type { ButtonProps } from 'antd';
import { Button, Tooltip } from 'antd';
import type React from 'react';

type IconProps = React.ComponentProps<typeof InboxOutlined>;

type ArchiveButtonBaseProps = Omit<ButtonProps, 'icon'> & {
  'aria-label'?: string;
  ariaLabel?: string;
  tooltip?: React.ReactNode;
  stopPropagation?: boolean;
};

interface ArchiveToggleButtonProps
  extends Omit<ArchiveButtonBaseProps, 'children' | 'onClick' | 'onToggle'> {
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
  'aria-label': ariaLabelProp,
  size = 'small',
  type = 'text',
  ...buttonProps
}) => {
  const title = tooltip ?? (archived ? 'Archived • Click to unarchive' : 'Archive');
  const accessibleLabel = labelFromTooltip(title);
  const explicitAriaLabel = ariaLabelProp ?? ariaLabel;

  return (
    <Tooltip title={title}>
      <Button
        {...buttonProps}
        type={type}
        size={size}
        icon={<ArchiveIcon />}
        loading={loading}
        aria-label={explicitAriaLabel ?? accessibleLabel}
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
  tooltip,
  stopPropagation = true,
  ariaLabel,
  'aria-label': ariaLabelProp,
  size = 'small',
  type = 'text',
  onClick,
  onMouseEnter,
  onMouseLeave,
  children,
  ...buttonProps
}) => {
  const isIconOnly = children === undefined || children === null;
  const title = tooltip ?? (isIconOnly ? 'Archive' : undefined);
  const accessibleLabel = labelFromTooltip(title);
  const explicitAriaLabel = ariaLabelProp ?? ariaLabel;

  const button = (
    <Button
      {...buttonProps}
      type={type}
      size={size}
      icon={<ArchiveIcon />}
      aria-label={explicitAriaLabel ?? (isIconOnly ? accessibleLabel : undefined)}
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

  return title ? <Tooltip title={title}>{button}</Tooltip> : button;
};
