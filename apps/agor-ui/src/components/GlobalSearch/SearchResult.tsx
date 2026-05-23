import { Space, Typography, theme } from 'antd';
import type React from 'react';
import { getSessionDisplayTitle } from '../../utils/sessionTitle';
import { TYPE_CHIP_ICONS, type SearchResultItem } from './types';

const { Text } = Typography;

interface SearchResultProps {
  result: SearchResultItem;
  selected: boolean;
  onClick: () => void;
  onHover?: () => void;
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
}) => {
  const { token } = theme.useToken();
  const { title, tag, secondary, time, icon } = renderResult(result);

  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={onHover}
      aria-label={title}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
        width: '100%',
        padding: '8px 12px',
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
        time: relativeTime(result.item.updated_at),
      };
    }
    case 'worktree': {
      return {
        icon: TYPE_CHIP_ICONS.worktree,
        title: result.item.name,
        tag: result.item.ref,
        secondary: result.parentRepo?.name,
        time: relativeTime(result.item.updated_at),
      };
    }
    case 'assistant': {
      const assistantConfig =
        result.item.custom_context?.assistant ?? result.item.custom_context?.agent;
      const displayName =
        (assistantConfig as { displayName?: string } | undefined)?.displayName ?? result.item.name;
      const emoji = (assistantConfig as { emoji?: string } | undefined)?.emoji;
      return {
        icon: emoji || TYPE_CHIP_ICONS.assistant,
        title: displayName,
        secondary: result.parentRepo?.name,
        time: relativeTime(result.item.updated_at),
      };
    }
    case 'artifact': {
      return {
        icon: TYPE_CHIP_ICONS.artifact,
        title: result.item.name,
        tag: result.item.kind,
        secondary: result.parentWorktree
          ? `in ${result.parentWorktree.name}`
          : result.parentBoard
            ? `on ${result.parentBoard.name}`
            : undefined,
        time: relativeTime(result.item.updated_at),
      };
    }
    case 'board': {
      return {
        icon: result.item.icon || TYPE_CHIP_ICONS.board,
        title: result.item.name,
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

/** Minimal relative-time formatter — keeps the dropdown free of date-fns weight. */
function relativeTime(iso?: string): string | undefined {
  if (!iso) return undefined;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return undefined;
  const diffMs = Date.now() - then;
  if (diffMs < 0) return 'just now';
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}
