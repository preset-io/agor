import { Typography, theme } from 'antd';
import type React from 'react';
import { SearchResult } from './SearchResult';
import { type ResultsByType, SECTION_LABELS, SECTION_ORDER, type SearchResultItem } from './types';

const { Text } = Typography;

interface GlobalSearchDropdownProps {
  /** Trimmed query (post-debounce). Empty string = render Recents view. */
  query: string;
  results: ResultsByType;
  hasAnyResults: boolean;
  recents: SearchResultItem[];
  selectedIndex: number;
  onResultClick: (result: SearchResultItem) => void;
  onResultHover: (index: number) => void;
}

export const GlobalSearchDropdown: React.FC<GlobalSearchDropdownProps> = ({
  query,
  results,
  hasAnyResults,
  recents,
  selectedIndex,
  onResultClick,
  onResultHover,
}) => {
  const { token } = theme.useToken();

  const showRecents = query.length === 0;

  return (
    <div
      // Fills the remaining space inside the popover's flex column. The
      // popover caps total height at 85vh; the chip row above is fixed
      // height, so this scroll area grows to use whatever's left.
      style={{
        flex: 1,
        minHeight: 0,
        overflowY: 'auto',
        padding: '2px 0',
      }}
    >
      {showRecents ? (
        <SectionShell title="Recent" token={token}>
          {recents.length === 0 ? (
            <EmptyHint text="Recent items you've created will show up here." token={token} />
          ) : (
            recents.map((result, index) => (
              <SearchResult
                key={resultKey(result)}
                rowId={rowDomId(result)}
                result={result}
                selected={index === selectedIndex}
                onClick={() => onResultClick(result)}
                onHover={() => onResultHover(index)}
              />
            ))
          )}
        </SectionShell>
      ) : !hasAnyResults ? (
        <EmptyHint text={`No matches for "${query}"`} token={token} />
      ) : (
        SECTION_ORDER.map((type) => {
          const items = results[type];
          if (items.length === 0) return null;

          // Compute global index offset so the keyboard cursor lines up.
          let offset = 0;
          for (const t of SECTION_ORDER) {
            if (t === type) break;
            offset += results[t].length;
          }

          return (
            <SectionShell
              key={type}
              title={`${SECTION_LABELS[type]} · ${items.length}`}
              token={token}
            >
              {items.map((result, i) => {
                const flatIndex = offset + i;
                return (
                  <SearchResult
                    key={resultKey(result)}
                    rowId={rowDomId(result)}
                    result={result}
                    selected={flatIndex === selectedIndex}
                    onClick={() => onResultClick(result)}
                    onHover={() => onResultHover(flatIndex)}
                  />
                );
              })}
            </SectionShell>
          );
        })
      )}
    </div>
  );
};

interface SectionShellProps {
  title: string;
  token: ReturnType<typeof theme.useToken>['token'];
  children: React.ReactNode;
}

const SectionShell: React.FC<SectionShellProps> = ({ title, token, children }) => (
  <div style={{ padding: '2px 0' }}>
    <div
      style={{
        padding: '2px 16px 1px',
        fontSize: 11,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
        color: token.colorTextTertiary,
      }}
    >
      {title}
    </div>
    {children}
  </div>
);

const EmptyHint: React.FC<{
  text: string;
  token: ReturnType<typeof theme.useToken>['token'];
}> = ({ text, token }) => (
  <div style={{ padding: '24px 16px', textAlign: 'center' }}>
    <Text type="secondary" style={{ fontSize: 13, color: token.colorTextSecondary }}>
      {text}
    </Text>
  </div>
);

/** Stable React key per result row. Uses `-` separator so the same value is a
 * valid CSS selector when reused as a DOM id (see rowDomId). */
function resultKey(result: SearchResultItem): string {
  switch (result.type) {
    case 'session':
      return `session-${result.item.session_id}`;
    case 'worktree':
    case 'assistant':
      return `${result.type}-${result.item.worktree_id}`;
    case 'artifact':
      return `artifact-${result.item.artifact_id}`;
    case 'board':
      return `board-${result.item.board_id}`;
    case 'mcp':
      return `mcp-${result.item.mcp_server_id}`;
  }
}

/** DOM id namespace for combobox aria-activedescendant wiring. */
export const GLOBAL_SEARCH_LISTBOX_ID = 'global-search-listbox';

/** Stable DOM id for a result row — used by aria-activedescendant. */
export function rowDomId(result: SearchResultItem): string {
  return `global-search-row-${resultKey(result)}`;
}
