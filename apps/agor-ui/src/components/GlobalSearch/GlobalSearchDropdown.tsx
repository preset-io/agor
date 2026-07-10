import { tokenizeSearchQuery } from '@agor-live/client';
import {
  ApiOutlined,
  AppstoreOutlined,
  BranchesOutlined,
  ExperimentOutlined,
  MessageOutlined,
  RobotOutlined,
} from '@ant-design/icons';
import { Typography, theme } from 'antd';
import type React from 'react';
import { useMemo } from 'react';
import { SearchResult } from './SearchResult';
import {
  type ResultsByType,
  SECTION_LABELS,
  SECTION_ORDER,
  type SearchEntityType,
  type SearchResultItem,
} from './types';
import { sectionOffsets } from './utils';

const { Text } = Typography;

/**
 * AntD icon per entity type for the dropdown's section headers. Mirrors the
 * Settings modal's tab icons (apps/agor-ui/src/components/SettingsModal/
 * SettingsModal.tsx) so users see the same glyph in both surfaces. Sessions
 * don't have a Settings tab — `MessageOutlined` is the conversational match.
 */
const SECTION_ICONS: Record<SearchEntityType, React.ReactNode> = {
  session: <MessageOutlined />,
  branch: <BranchesOutlined />,
  teammate: <RobotOutlined />,
  artifact: <ExperimentOutlined />,
  board: <AppstoreOutlined />,
  mcp: <ApiOutlined />,
};

interface GlobalSearchDropdownProps {
  /** Trimmed query (post-debounce). Empty string = render Recents view. */
  query: string;
  results: ResultsByType;
  hasAnyResults: boolean;
  /** Recents reuse `ResultsByType` so the section renderer is shared. */
  recents: ResultsByType;
  hasAnyRecents: boolean;
  selectedIndex: number;
  onResultClick: (result: SearchResultItem) => void;
  onResultHover: (index: number) => void;
}

export const GlobalSearchDropdown: React.FC<GlobalSearchDropdownProps> = ({
  query,
  results,
  hasAnyResults,
  recents,
  hasAnyRecents,
  selectedIndex,
  onResultClick,
  onResultHover,
}) => {
  const { token } = theme.useToken();

  const showRecents = query.length === 0;
  const sectioned = showRecents ? recents : results;
  // Tokens drive hit highlighting inside rendered result rows. Reusing the
  // same tokenizer that the search hook uses keeps highlight ranges aligned
  // with what the filter actually matched against. Empty in recents mode.
  const tokens = useMemo(
    () => (showRecents ? [] : tokenizeSearchQuery(query)),
    [showRecents, query]
  );

  // Precompute per-section flat-index offsets so the keyboard cursor index
  // resolves to the right row across sections — single pass instead of
  // re-scanning the section order for each row.
  const offsets = useMemo(() => sectionOffsets(sectioned), [sectioned]);

  return (
    // The listbox role is anchored here, not on the outer popover: the popover
    // also contains the chip row, switch, close button, and BETA tag — none
    // are list options. The Input's `aria-controls` points at this id so the
    // combobox contract is intact.
    <div
      role="listbox"
      id={GLOBAL_SEARCH_LISTBOX_ID}
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
      {showRecents && !hasAnyRecents ? (
        <EmptyHint text="Recent items you've created will show up here." token={token} />
      ) : !showRecents && !hasAnyResults ? (
        <EmptyHint text={`No matches for "${query}"`} token={token} />
      ) : (
        SECTION_ORDER.map((type) => {
          const items = sectioned[type];
          if (items.length === 0) return null;
          const offset = offsets.get(type) ?? 0;

          // Recents reuse the live-search section labels (e.g. "Sessions") so
          // the visual contract stays identical between empty-query and
          // typed-query states. A single header rule above the column makes it
          // clear the whole list is "recent."
          return (
            <SectionShell
              key={type}
              title={SECTION_LABELS[type]}
              icon={SECTION_ICONS[type]}
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
                    tokens={tokens}
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
  /** AntD icon rendered to the left of the section label, matching the
   * Settings modal's tab glyphs. */
  icon?: React.ReactNode;
  token: ReturnType<typeof theme.useToken>['token'];
  children: React.ReactNode;
}

const SectionShell: React.FC<SectionShellProps> = ({ title, icon, token, children }) => (
  <div style={{ padding: '2px 0' }}>
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '2px 16px 1px',
        fontSize: 11,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
        color: token.colorTextTertiary,
      }}
    >
      {icon}
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
    case 'branch':
    case 'teammate':
      return `${result.type}-${result.item.branch_id}`;
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
