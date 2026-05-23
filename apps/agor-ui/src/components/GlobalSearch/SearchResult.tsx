import { getAssistantConfig } from '@agor-live/client';
import { Space, Typography, theme } from 'antd';
import type React from 'react';
import { getSessionDisplayTitle } from '../../utils/sessionTitle';
import { formatRelativeTime } from '../../utils/time';
import { type SearchResultItem, TYPE_CHIP_ICONS } from './types';

const { Text } = Typography;

interface SearchResultProps {
  result: SearchResultItem;
  selected: boolean;
  onClick: () => void;
  onHover?: () => void;
  /** Stable DOM id so the input's aria-activedescendant can point at the row. */
  rowId?: string;
}

/**
 * Single result row in the global-search dropdown.
 *
 * Discriminated union by entity type → renders entity-specific icon, title,
 * tag, secondary line, and relative time. Anatomy spec lives in
 * docs/internal/global-search-design-2026-05-23.md §3.6.
 */
export const SearchResult: React.FC<SearchResultProps> = ({
  result,
  selected,
  onClick,
  onHover,
  rowId,
}) => {
  const { token } = theme.useToken();
  const { title, tag, secondary, time, icon } = renderResult(result);

  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={onHover}
      aria-label={title}
      role="option"
      aria-selected={selected}
      id={rowId}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
        width: '100%',
        padding: '4px 12px',
        border: 'none',
        background: selected ? token.colorBgTextHover : 'transparent',
        cursor: 'pointer',
        textAlign: 'left',
        borderRadius: token.borderRadiusSM,
      }}
    >
      <span style={{ fontSize: 18, lineHeight: '20px', flexShrink: 0 }}>{icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <Space size={8} align="center" style={{ width: '100%', justifyContent: 'space-between' }}>
          <Text
            strong
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              maxWidth: 340,
            }}
          >
            {title}
          </Text>
          <Space size={8} style={{ flexShrink: 0 }}>
            {tag && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                {tag}
              </Text>
            )}
            {time && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                {time}
              </Text>
            )}
          </Space>
        </Space>
        {secondary && (
          <Text
            type="secondary"
            style={{
              display: 'block',
              fontSize: 12,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {secondary}
          </Text>
        )}
      </div>
    </button>
  );
};

function renderResult(result: SearchResultItem): {
  title: string;
  tag?: string;
  secondary?: string;
  time?: string;
  icon: string;
} {
  switch (result.type) {
    case 'session': {
      const title = getSessionDisplayTitle(result.item, { includeAgentFallback: true });
      return {
        icon: TYPE_CHIP_ICONS.session,
        title,
        tag: result.item.agentic_tool,
        secondary: result.parentWorktree ? `in ${result.parentWorktree.name}` : undefined,
        time: safeRelativeTime(result.item.last_updated),
      };
    }
    case 'worktree': {
      return {
        icon: TYPE_CHIP_ICONS.worktree,
        title: result.item.name,
        tag: result.item.ref,
        time: safeRelativeTime(result.item.updated_at),
      };
    }
    case 'assistant': {
      const config = getAssistantConfig(result.item);
      return {
        icon: config?.emoji || TYPE_CHIP_ICONS.assistant,
        title: config?.displayName ?? result.item.name,
        time: safeRelativeTime(result.item.updated_at),
      };
    }
    case 'artifact': {
      return {
        icon: TYPE_CHIP_ICONS.artifact,
        title: result.item.name,
        tag: result.item.template,
        secondary: result.parentWorktree ? `in ${result.parentWorktree.name}` : undefined,
        time: safeRelativeTime(result.item.updated_at),
      };
    }
    case 'board': {
      return {
        icon: result.item.icon || TYPE_CHIP_ICONS.board,
        title: result.item.name,
        time: safeRelativeTime(result.item.last_updated),
      };
    }
    case 'mcp': {
      return {
        icon: TYPE_CHIP_ICONS.mcp,
        title: result.item.display_name || result.item.name,
        tag: result.item.transport,
        secondary: result.item.description,
      };
    }
  }
}

/**
 * Optional- and invalid-tolerant wrapper around formatRelativeTime — undefined
 * in, undefined out. Without the invalid-date guard, a bad timestamp would
 * render as "NaNy ago" via the shared formatter.
 */
function safeRelativeTime(ts: string | Date | undefined | null): string | undefined {
  if (!ts) return undefined;
  const date = typeof ts === 'string' ? new Date(ts) : ts;
  if (Number.isNaN(date.getTime())) return undefined;
  return formatRelativeTime(date);
}
