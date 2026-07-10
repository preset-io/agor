import { getTeammateConfig } from '@agor-live/client';
import { Typography, theme } from 'antd';
import type React from 'react';
import { getSessionDisplayTitle } from '../../utils/sessionTitle';
import { formatRelativeTimeSafe } from '../../utils/time';
import { HighlightMatch } from '../HighlightMatch';
import type { SearchResultItem } from './types';

const { Text } = Typography;

interface SearchResultProps {
  result: SearchResultItem;
  selected: boolean;
  onClick: () => void;
  onHover?: () => void;
  /** Stable DOM id so the input's aria-activedescendant can point at the row. */
  rowId?: string;
  /** Query tokens to highlight inside the visible title/secondary fields.
   * Empty array (recents view, or a no-token query) disables highlighting. */
  tokens?: string[];
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
  tokens = [],
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
      {/* Icon column is opt-in: rendered only when the entity itself has an
          emoji/icon (teammate `config.emoji`, board `item.icon`). For other
          types the section header above already conveys the kind, so we drop
          the per-row glyph to keep visual noise down. */}
      {icon && <span style={{ fontSize: 18, lineHeight: '20px', flexShrink: 0 }}>{icon}</span>}
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Title row: title takes remaining width and ellipsizes; tag + time
            stay on one line via whiteSpace:nowrap + flex-shrink:0. Plain flex
            instead of antd Space because Space wraps each child in a div that
            ignores parent's nowrap, which produced character-by-character
            wrapping in the right column on long titles. */}
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 8,
            width: '100%',
          }}
        >
          <Text
            strong
            style={{
              flex: 1,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            <HighlightMatch text={title} terms={tokens} />
          </Text>
          {tag && (
            <Text type="secondary" style={{ fontSize: 12, whiteSpace: 'nowrap', flexShrink: 0 }}>
              <HighlightMatch text={tag} terms={tokens} />
            </Text>
          )}
          {time && (
            <Text type="secondary" style={{ fontSize: 12, whiteSpace: 'nowrap', flexShrink: 0 }}>
              {time}
            </Text>
          )}
        </div>
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
            <HighlightMatch text={secondary} terms={tokens} />
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
  /** Only set when the entity itself has an emoji/icon (teammate config,
   * board icon). Generic per-type emojis dropped — section headers carry
   * the entity-kind affordance instead. */
  icon?: string;
} {
  switch (result.type) {
    case 'session': {
      const title = getSessionDisplayTitle(result.item, { includeAgentFallback: true });
      return {
        title,
        tag: result.item.agentic_tool,
        secondary: result.parentBranch ? `in ${result.parentBranch.name}` : undefined,
        time: formatRelativeTimeSafe(result.item.last_updated),
      };
    }
    case 'branch': {
      return {
        title: result.item.name,
        tag: result.item.ref,
        time: formatRelativeTimeSafe(result.item.updated_at),
      };
    }
    case 'teammate': {
      const config = getTeammateConfig(result.item);
      return {
        icon: config?.emoji,
        title: config?.displayName ?? result.item.name,
        time: formatRelativeTimeSafe(result.item.updated_at),
      };
    }
    case 'artifact': {
      return {
        title: result.item.name,
        tag: result.item.template,
        secondary: result.parentBranch ? `in ${result.parentBranch.name}` : undefined,
        time: formatRelativeTimeSafe(result.item.updated_at),
      };
    }
    case 'board': {
      return {
        icon: result.item.icon,
        title: result.item.name,
        time: formatRelativeTimeSafe(result.item.last_updated),
      };
    }
    case 'mcp': {
      return {
        title: result.item.display_name || result.item.name,
        tag: result.item.transport,
        secondary: result.item.description,
      };
    }
  }
}
