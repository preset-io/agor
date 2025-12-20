/**
 * EventStreamPill - Reusable clickable ID pill for event stream
 *
 * Displays short IDs with copy-to-clipboard functionality
 * Optionally wraps in Popover for rich metadata display
 */

import type { AntdIconProps } from '@ant-design/icons/lib/components/AntdIcon';
import { message, Popover } from 'antd';
import type React from 'react';
import { Tag } from '../Tag';

export interface EventStreamPillProps {
  /** Full ID to copy to clipboard */
  id: string;
  /** Display label for the pill (defaults to short ID) */
  label?: string;
  /** Ant Design icon component */
  icon: React.ComponentType<Partial<AntdIconProps>>;
  /** Tag color (e.g., 'cyan', 'geekblue') */
  color: string;
  /** Human-readable label for copy notification */
  copyLabel: string;
  /** Optional metadata card to show in popover on hover */
  metadataCard?: React.ReactNode;
}

/**
 * Extract short ID (first 8 chars without hyphens)
 */
const toShortId = (id: string): string => {
  return id.replace(/-/g, '').slice(0, 8);
};

/**
 * Copy text to clipboard with notification
 */
const copyToClipboard = (text: string, label: string) => {
  navigator.clipboard.writeText(text).then(
    () => {
      message.success(`${label} copied: ${text}`);
    },
    () => {
      message.error('Failed to copy to clipboard');
    }
  );
};

export const EventStreamPill = ({
  id,
  label,
  icon: Icon,
  color,
  copyLabel,
  metadataCard,
}: EventStreamPillProps): React.JSX.Element => {
  // If metadata card provided, don't copy on click - just show popover
  // Otherwise, copy to clipboard on click
  const handleClick = metadataCard ? undefined : () => copyToClipboard(id, copyLabel);

  const pill = (
    <Tag
      icon={<Icon />}
      color={color}
      style={{
        margin: 0,
        fontSize: 10,
        cursor: 'pointer',
        fontFamily: 'monospace',
      }}
      onClick={handleClick}
    >
      {label ?? toShortId(id)}
    </Tag>
  );

  // If metadata card provided, wrap in popover
  if (metadataCard) {
    return (
      <Popover content={metadataCard} title={null} trigger="click" placement="left">
        {pill}
      </Popover>
    );
  }

  return pill;
};
