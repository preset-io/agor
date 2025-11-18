/**
 * EventStreamPill - Reusable clickable ID pill for event stream
 *
 * Displays short IDs with copy-to-clipboard functionality
 */

import type { AntdIconProps } from '@ant-design/icons/lib/components/AntdIcon';
import { message, Tag } from 'antd';
import type React from 'react';

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
}: EventStreamPillProps): React.JSX.Element => {
  return (
    <Tag
      icon={<Icon />}
      color={color}
      style={{
        margin: 0,
        fontSize: 10,
        cursor: 'pointer',
        fontFamily: 'monospace',
      }}
      onClick={() => copyToClipboard(id, copyLabel)}
    >
      {label ?? toShortId(id)}
    </Tag>
  );
};
