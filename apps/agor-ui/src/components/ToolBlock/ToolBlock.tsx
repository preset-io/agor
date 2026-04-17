/**
 * ToolBlock — Reusable expand/collapse block for tool calls and thinking.
 *
 * Collapsed: single-line header with icon, name, truncated description.
 * Expanded: full description + body content.
 *
 * Used by AgentChain for every tool call and thinking block.
 */

import { DownOutlined, RightOutlined } from '@ant-design/icons';
import { Typography, theme } from 'antd';
import type React from 'react';
import { useState } from 'react';

export interface ToolBlockProps {
  /** Tool/block icon (Ant Design icon element) */
  icon: React.ReactNode;
  /** Tool display name (e.g. "Edit", "Bash", "Thinking") */
  name: string;
  /** Short description shown after name — truncated with ellipsis in collapsed header */
  description?: string;
  /** Override the description display with custom ReactNode (e.g. code block) */
  descriptionNode?: React.ReactNode;
  /** Status indicator */
  status?: 'success' | 'error' | 'pending' | 'stale';
  /** Whether to expand by default */
  expandedByDefault?: boolean;
  /** Body content shown when expanded */
  children?: React.ReactNode;
}

export const ToolBlock: React.FC<ToolBlockProps> = ({
  icon,
  name,
  description,
  descriptionNode,
  status,
  expandedByDefault = true,
  children,
}) => {
  const [expanded, setExpanded] = useState(expandedByDefault);
  const { token } = theme.useToken();
  const hasBody = !!children;

  const statusColor =
    status === 'error'
      ? token.colorError
      : status === 'pending'
        ? token.colorTextQuaternary
        : status === 'stale'
          ? token.colorWarning
          : token.colorTextSecondary;

  const header = (
    <div
      onClick={hasBody ? () => setExpanded(!expanded) : undefined}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        cursor: hasBody ? 'pointer' : 'default',
        userSelect: 'none',
        minHeight: 24,
        maxWidth: '100%',
        overflow: 'hidden',
      }}
    >
      {/* Status icon */}
      <span style={{ flexShrink: 0, fontSize: 14, color: statusColor, lineHeight: 1 }}>{icon}</span>

      {/* Expand/collapse chevron (only when there's expandable content) */}
      {hasBody && (
        <span style={{ flexShrink: 0, fontSize: 9, color: token.colorTextQuaternary }}>
          {expanded ? <DownOutlined /> : <RightOutlined />}
        </span>
      )}

      {/* Name + description */}
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'baseline',
          gap: 4,
          minWidth: 0,
          flex: 1,
          overflow: 'hidden',
        }}
      >
        <strong style={{ flexShrink: 0, fontSize: token.fontSizeSM }}>{name}</strong>
        {descriptionNode ||
          (description && (
            <Typography.Text
              type="secondary"
              ellipsis
              style={{
                fontSize: token.fontSizeSM,
                fontWeight: 'normal',
              }}
            >
              {description}
            </Typography.Text>
          ))}
      </span>
    </div>
  );

  return (
    <div>
      {header}

      {/* Body — shown when expanded */}
      {expanded && children && (
        <div style={{ marginTop: 2, paddingLeft: token.sizeUnit * 4 }}>{children}</div>
      )}
    </div>
  );
};
