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
import { useId, useState } from 'react';
import {
  COMPACT_CONTENT_OFFSET,
  COMPACT_GUTTER_GAP,
  COMPACT_GUTTER_SIZE,
  COMPACT_NESTED_INDENT,
} from '../ConversationView/compactLayout';

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
  /** Whether to expand by default. Defaults to false; the caller decides
   *  which tools should land open. */
  expandedByDefault?: boolean;
  /** Body content shown when expanded */
  children?: React.ReactNode;
  /** Compact transcript grid: icon centered in the shared gutter, chevron last. */
  compact?: boolean;
  /**
   * Compact only. Set when the body is itself a list of compact rows, so they
   * read as children of this row: slightly inset behind a guide line, keeping
   * their own gutter rather than aligning to this row's content edge.
   */
  nestedRows?: boolean;
}

export const ToolBlock: React.FC<ToolBlockProps> = ({
  icon,
  name,
  description,
  descriptionNode,
  status,
  expandedByDefault = false,
  children,
  compact = false,
  nestedRows = false,
}) => {
  const [expanded, setExpanded] = useState(expandedByDefault);
  const bodyId = useId();
  const { token } = theme.useToken();
  const hasBody = !!children;
  const Header = hasBody ? 'button' : 'div';

  const statusColor =
    status === 'error'
      ? token.colorWarning
      : status === 'pending'
        ? token.colorTextQuaternary
        : status === 'stale'
          ? token.colorWarning
          : token.colorTextSecondary;

  // Compact moves the chevron to the end of the row so the label can start at
  // the shared content edge.
  const chevron = hasBody ? (
    <span style={{ flexShrink: 0, fontSize: 9, color: token.colorTextQuaternary }}>
      {expanded ? <DownOutlined /> : <RightOutlined />}
    </span>
  ) : null;

  const header = (
    <Header
      type={hasBody ? 'button' : undefined}
      aria-expanded={hasBody ? expanded : undefined}
      aria-controls={hasBody ? bodyId : undefined}
      onClick={hasBody ? () => setExpanded((value) => !value) : undefined}
      style={{
        // Keep the transcript row's appearance and the native button's
        // keyboard activation and focus outline.
        border: 0,
        padding: 0,
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        textAlign: 'left',
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        gap: compact ? COMPACT_GUTTER_GAP : 6,
        cursor: hasBody ? 'pointer' : 'default',
        userSelect: 'none',
        minHeight: 24,
        maxWidth: '100%',
        overflow: 'hidden',
      }}
    >
      {/* Status icon — centered in the gutter column when compact */}
      <span
        style={{
          flexShrink: 0,
          fontSize: 14,
          color: statusColor,
          lineHeight: 1,
          ...(compact
            ? {
                width: COMPACT_GUTTER_SIZE,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }
            : null),
        }}
      >
        {icon}
      </span>

      {/* Expand/collapse chevron (only when there's expandable content) */}
      {!compact && chevron}

      {/* Name + description */}
      <span
        style={{
          display: 'inline-flex',
          alignItems: compact ? 'center' : 'baseline',
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

      {compact && chevron}
    </Header>
  );

  return (
    <div style={{ minWidth: 0, maxWidth: '100%' }}>
      {header}

      {/* Body — shown when expanded.
          `minWidth: 0` lets this shrink inside flex parents so wide children
          (e.g. long Bash commands) scroll inside their own container rather
          than forcing the whole conversation pane to scroll horizontally. */}
      {expanded && children && (
        <div
          id={bodyId}
          style={{
            marginTop: 2,
            paddingLeft: compact
              ? nestedRows
                ? COMPACT_NESTED_INDENT
                : COMPACT_CONTENT_OFFSET
              : token.sizeUnit * 4,
            minWidth: 0,
            maxWidth: '100%',
            // Nested rows are children of this one: a slight inset with a quiet
            // guide line down the middle of it, while each child keeps its own
            // [gutter][content] inside.
            ...(compact && nestedRows
              ? {
                  marginLeft: COMPACT_NESTED_INDENT,
                  borderLeft: `1px solid ${token.colorSplit}`,
                }
              : null),
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
};
