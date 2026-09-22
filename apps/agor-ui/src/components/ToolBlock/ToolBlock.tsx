/**
 * ToolBlock — Reusable expand/collapse block for tool calls and thinking.
 *
 * Collapsed: single-line header with icon, name, truncated description.
 * Expanded: full description + body content.
 *
 * Used by AgentChain for every tool call and thinking block.
 */

import {
  DownOutlined,
  LoadingOutlined,
  RightOutlined,
  ToolOutlined,
  UpOutlined,
} from '@ant-design/icons';
import { ThoughtChain } from '@ant-design/x';
import { Button, Typography, theme } from 'antd';
import type React from 'react';
import { useState } from 'react';
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';

/** Shared disclosure for both lazy task hydration and already-loaded tool groups.
 * A button keeps keyboard semantics without requiring a fixed Collapse body:
 * hydration can replace the trigger with multiple chronological groups. */
export function ToolDisclosureHeader({
  label,
  expanded,
  onClick,
  loading = false,
  executing = false,
}: {
  label: string;
  expanded: boolean;
  onClick: () => void;
  loading?: boolean;
  executing?: boolean;
}) {
  const { token } = theme.useToken();
  const reducedMotion = usePrefersReducedMotion();
  return (
    <Button
      type="text"
      block
      disabled={loading}
      aria-busy={loading || executing}
      icon={loading ? <LoadingOutlined spin /> : <ToolOutlined />}
      aria-expanded={expanded}
      aria-label={label}
      onClick={onClick}
      style={{
        display: 'flex',
        justifyContent: 'flex-start',
        fontSize: token.fontSizeSM,
        gap: token.marginXS,
        paddingInline: 0,
        color: token.colorTextSecondary,
      }}
    >
      <span
        style={{
          flex: '0 1 auto',
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          textAlign: 'left',
        }}
      >
        <ThoughtChain.Item
          title={label}
          variant="text"
          blink={executing && !reducedMotion}
          style={{ padding: 0, fontSize: token.fontSizeSM, color: 'inherit' }}
          styles={{
            title: { fontSize: 'inherit', fontWeight: 'inherit', color: 'inherit' },
          }}
        />
      </span>
      {expanded ? (
        <UpOutlined style={{ flexShrink: 0, fontSize: '0.75em' }} />
      ) : (
        <DownOutlined style={{ flexShrink: 0, fontSize: '0.75em' }} />
      )}
    </Button>
  );
}

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
}

export const ToolBlock: React.FC<ToolBlockProps> = ({
  icon,
  name,
  description,
  descriptionNode,
  status,
  expandedByDefault = false,
  children,
}) => {
  const [expanded, setExpanded] = useState(expandedByDefault);
  const { token } = theme.useToken();
  const hasBody = !!children;

  const statusColor =
    status === 'error'
      ? token.colorWarning
      : status === 'pending'
        ? token.colorTextQuaternary
        : status === 'stale'
          ? token.colorWarning
          : token.colorTextSecondary;

  const header = (
    <Button
      type="text"
      disabled={!hasBody}
      aria-expanded={hasBody ? expanded : undefined}
      onClick={hasBody ? () => setExpanded(!expanded) : undefined}
      style={{
        padding: 0,
        height: 'auto',
        width: '100%',
        textAlign: 'left',
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
    </Button>
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
          style={{
            marginTop: 2,
            paddingLeft: token.sizeUnit * 4,
            minWidth: 0,
            maxWidth: '100%',
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
};
