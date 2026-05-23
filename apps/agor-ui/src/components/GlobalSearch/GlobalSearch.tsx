import type { Artifact, Board, BoardID, MCPServer, Session, Worktree } from '@agor-live/client';
import { SearchOutlined } from '@ant-design/icons';
import { Input, type InputRef, theme } from 'antd';
import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GLOBAL_SEARCH_LISTBOX_ID, GlobalSearchDropdown, rowDomId } from './GlobalSearchDropdown';
import { SearchChipRow } from './SearchChipRow';
import { type ChipFilter, MIN_QUERY_LENGTH, SECTION_ORDER, type SearchResultItem } from './types';
import { useGlobalSearch } from './useGlobalSearch';
import { useRecents } from './useRecents';

const INPUT_WIDTH = 260;

interface GlobalSearchProps {
  currentUserId?: string;
  /** Live entity maps from useAgorData / contexts — passed in by AppHeader. */
  sessionById: Map<string, Session>;
  worktreeById: Map<string, Worktree>;
  artifactById: Map<string, Artifact>;
  boards: Board[];
  mcpServerById: Map<string, MCPServer>;

  /** Navigation callbacks (kept thin; reuse existing AppHeader primitives). */
  onBoardChange?: (boardId: BoardID) => void;
  /**
   * Sibling-PR primitive — when present, search clicks land directly on the
   * worktree's canvas card. When absent, we fall back to onBoardChange.
   */
  onWorktreeFocus?: (worktreeId: string) => void;
  /**
   * V1 stub for entities that don't live on a board (MCP server) — opens
   * the Settings modal as a coarse landing. Replaced in V2 with deep links
   * to the right tab + row scroll-into-view.
   */
  onSettingsClick?: () => void;
}

/**
 * Navbar global-search input + dropdown.
 *
 * Implementation per docs/internal/global-search-design-2026-05-23.md.
 * V1 scaffolding: client-side filtering over in-memory entity maps, sectioned
 * dropdown, type + scope chips, Cmd+K to focus.
 */
export const GlobalSearch: React.FC<GlobalSearchProps> = ({
  currentUserId,
  sessionById,
  worktreeById,
  artifactById,
  boards,
  mcpServerById,
  onBoardChange,
  onWorktreeFocus,
  onSettingsClick,
}) => {
  const { token } = theme.useToken();
  const inputRef = useRef<InputRef | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [activeChip, setActiveChip] = useState<ChipFilter>('all');
  const [ownedByMe, setOwnedByMe] = useState(true);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const { results, hasAnyResults, debouncedQuery, flush } = useGlobalSearch({
    query,
    ownedByMe,
    activeTypeChip: activeChip,
    currentUserId,
    sessionById,
    worktreeById,
    artifactById,
    boards,
    mcpServerById,
  });

  const recents = useRecents({
    currentUserId,
    sessionById,
    worktreeById,
    artifactById,
  });

  // Recents/results predicate is derived from the **raw** query so deleting
  // a long query back to <MIN_QUERY_LENGTH feels immediate — without this,
  // there's a 220ms window where the dropdown shows stale prior results.
  // Actual search results stay debounced (effectiveQuery uses debouncedQuery).
  const showRecents = query.trim().length < MIN_QUERY_LENGTH;
  const effectiveQuery = showRecents ? '' : debouncedQuery.trim();

  // Flatten current dropdown rows for keyboard nav. Order matches dropdown
  // section order; recents mode is a single flat list.
  const visibleRows = useMemo<SearchResultItem[]>(() => {
    if (showRecents) return recents;
    return SECTION_ORDER.flatMap((t) => results[t]);
  }, [showRecents, recents, results]);

  // Keep selection inside the row list when results change.
  useEffect(() => {
    setSelectedIndex((idx) => Math.min(Math.max(idx, 0), Math.max(visibleRows.length - 1, 0)));
  }, [visibleRows.length]);

  // Scroll the keyboard cursor into view when it moves past the visible area.
  // `block: 'nearest'` keeps the page steady when the row is already visible.
  useEffect(() => {
    if (!open) return;
    const target = visibleRows[selectedIndex];
    if (!target) return;
    document.getElementById(rowDomId(target))?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex, visibleRows, open]);

  // Global Cmd+K / Ctrl+K opens + focuses the input.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Click outside closes the dropdown.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const navigateToResult = useCallback(
    (result: SearchResultItem) => {
      switch (result.type) {
        case 'board': {
          onBoardChange?.(result.item.board_id);
          break;
        }
        case 'worktree':
        case 'assistant': {
          if (onWorktreeFocus) {
            onWorktreeFocus(result.item.worktree_id);
          } else if (result.item.board_id) {
            onBoardChange?.(result.item.board_id);
          }
          break;
        }
        case 'session': {
          const worktree = result.parentWorktree;
          if (worktree) {
            if (onWorktreeFocus) {
              onWorktreeFocus(worktree.worktree_id);
            } else if (worktree.board_id) {
              onBoardChange?.(worktree.board_id);
            }
          }
          break;
        }
        case 'artifact': {
          const worktree = result.parentWorktree;
          if (worktree && onWorktreeFocus) {
            onWorktreeFocus(worktree.worktree_id);
          } else if (worktree?.board_id) {
            onBoardChange?.(worktree.board_id);
          } else {
            // Artifact.board_id is required on the schema — always a safe fallback.
            onBoardChange?.(result.item.board_id);
          }
          break;
        }
        case 'mcp': {
          // V1 stub — open Settings; V2 will deep-link to the MCP tab + row.
          onSettingsClick?.();
          break;
        }
      }
      setOpen(false);
      setQuery('');
    },
    [onBoardChange, onWorktreeFocus, onSettingsClick]
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (query) {
        setQuery('');
      } else {
        setOpen(false);
        inputRef.current?.blur();
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((idx) => Math.min(idx + 1, Math.max(visibleRows.length - 1, 0)));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((idx) => Math.max(idx - 1, 0));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      // If the user pressed Enter before the 220ms debounce settled, flush
      // the debounced query so the dropdown shows fresh rows on the next
      // render. The current Enter doesn't navigate — the next one does.
      // This is intentionally a 2-press UX in the (rare) stale case; doing
      // a true single-press would require synchronous filter computation
      // outside React's render cycle. Acceptable since debounce is 220ms.
      if (query.trim() !== debouncedQuery.trim()) {
        flush();
        return;
      }
      const target = visibleRows[selectedIndex];
      if (target) navigateToResult(target);
      return;
    }
  };

  return (
    <div ref={containerRef} style={{ position: 'relative', width: INPUT_WIDTH }}>
      <Input
        ref={inputRef}
        placeholder="Search…  ⌘K"
        prefix={<SearchOutlined style={{ color: token.colorTextQuaternary }} />}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          // Reset the keyboard cursor on every keystroke so it doesn't track
          // a stale row across debounce boundaries.
          setSelectedIndex(0);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
        allowClear
        aria-label="Global search"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={GLOBAL_SEARCH_LISTBOX_ID}
        aria-activedescendant={
          open && visibleRows[selectedIndex] ? rowDomId(visibleRows[selectedIndex]) : undefined
        }
        role="combobox"
        style={{ width: '100%' }}
      />
      {open && (
        <div
          role="listbox"
          id={GLOBAL_SEARCH_LISTBOX_ID}
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            marginTop: 4,
            background: token.colorBgElevated,
            border: `1px solid ${token.colorBorderSecondary}`,
            borderRadius: token.borderRadiusLG,
            boxShadow: token.boxShadowSecondary,
            zIndex: 1000,
            minWidth: 480,
          }}
        >
          <SearchChipRow
            activeChip={activeChip}
            onChipChange={(chip) => {
              setActiveChip(chip);
              setSelectedIndex(0);
            }}
            ownedByMe={ownedByMe}
            onOwnedByMeToggle={() => {
              setOwnedByMe((v) => !v);
              setSelectedIndex(0);
            }}
          />
          <GlobalSearchDropdown
            query={effectiveQuery}
            results={results}
            hasAnyResults={hasAnyResults}
            recents={recents}
            selectedIndex={selectedIndex}
            onResultClick={navigateToResult}
            onResultHover={setSelectedIndex}
          />
        </div>
      )}
    </div>
  );
};
