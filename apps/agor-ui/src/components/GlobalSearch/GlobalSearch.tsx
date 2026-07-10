import { CloseOutlined } from '@ant-design/icons';
import { Button, Input, type InputRef, theme } from 'antd';
import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppNavigation } from '../../hooks/useAppNavigation';
import { GLOBAL_SEARCH_LISTBOX_ID, GlobalSearchDropdown, rowDomId } from './GlobalSearchDropdown';
import { SearchChipRow } from './SearchChipRow';
import {
  type ChipFilter,
  type GlobalSearchEntityMaps,
  MIN_QUERY_LENGTH,
  type SearchResultItem,
} from './types';
import { useGlobalSearch } from './useGlobalSearch';
import { useRecents } from './useRecents';
import { flattenResults, hasAnyEntries } from './utils';

const INPUT_WIDTH = 260;

interface GlobalSearchProps extends GlobalSearchEntityMaps {
  currentUserId?: string;
  /**
   * Open the Settings modal — used as a coarse landing for entity types
   * that don't live on the canvas (MCP servers today). Stays as a callback
   * because Settings is modal state, not URL-driven.
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
  branchById,
  artifactById,
  boardById,
  mcpServerById,
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

  const navigation = useAppNavigation({
    boardById,
    sessionById,
    branchById,
    artifactById,
  });

  const { results, counts, hasAnyResults, debouncedQuery, flush } = useGlobalSearch({
    query,
    ownedByMe,
    activeTypeChip: activeChip,
    currentUserId,
    sessionById,
    branchById,
    artifactById,
    boardById,
    mcpServerById,
  });

  const recents = useRecents({
    currentUserId,
    sessionById,
    branchById,
    artifactById,
    boardById,
    mcpServerById,
  });
  const hasAnyRecents = hasAnyEntries(recents);

  // Recents/results predicate is derived from the **raw** query so deleting
  // a long query back to <MIN_QUERY_LENGTH feels immediate — without this,
  // there's a 220ms window where the dropdown shows stale prior results.
  // Actual search results stay debounced (effectiveQuery uses debouncedQuery).
  const showRecents = query.trim().length < MIN_QUERY_LENGTH;
  const effectiveQuery = showRecents ? '' : debouncedQuery.trim();

  // Flatten current dropdown rows for keyboard nav. Recents and live results
  // share the same sectioned shape, so the flattening is identical.
  const visibleRows = useMemo<SearchResultItem[]>(
    () => flattenResults(showRecents ? recents : results),
    [showRecents, recents, results]
  );

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
        case 'board':
          navigation.goToBoard(result.item.board_id);
          break;
        case 'branch':
        case 'teammate':
          navigation.goToBranch(result.item.branch_id);
          break;
        case 'session':
          navigation.goToSession(result.item.session_id);
          break;
        case 'artifact':
          navigation.goToArtifact(result.item.artifact_id);
          break;
        case 'mcp':
          // MCP servers don't live on the canvas — fall back to opening
          // Settings. V2 will deep-link to the MCP tab + scroll-into-view.
          onSettingsClick?.();
          break;
      }
      setOpen(false);
      setQuery('');
    },
    [navigation, onSettingsClick]
  );

  const handleClose = useCallback(() => {
    setOpen(false);
    setQuery('');
    inputRef.current?.blur();
  }, []);

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
    // Enter is handled by `<Input.Search>`'s onSearch — see handleSubmit.
  };

  // Fired by `<Input.Search>` on both Enter keypress and click of the
  // built-in search-icon button. If the user submits before the 220ms
  // debounce settled, flush instead of navigating — next press will land
  // on fresh rows. Acceptable 2-press UX in the rare stale case.
  const handleSubmit = (value: string) => {
    if (value.trim() !== debouncedQuery.trim()) {
      flush();
      return;
    }
    const target = visibleRows[selectedIndex];
    if (target) navigateToResult(target);
  };

  return (
    <div ref={containerRef} style={{ position: 'relative', width: INPUT_WIDTH }}>
      <Input.Search
        ref={inputRef}
        placeholder="Search…  ⌘K"
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
        onSearch={handleSubmit}
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
          // Plain popover wrapper. `role="listbox"` lives on the inner result-rows
          // container in `GlobalSearchDropdown` — this outer div also holds the
          // chip row, close button, and BETA tag, which aren't list options.
          //
          // Anchored to the right edge of the input (input lives in the
          // right cluster of the navbar) so the popover grows leftward
          // and doesn't overflow the viewport.
          //
          // Flex column so the chip row stays sticky at the top and the
          // result body takes whatever vertical space is left up to 85vh.
          // Without `min-height: 0` on the scrollable child, flex children
          // refuse to shrink below their content height and scroll breaks.
          style={{
            position: 'absolute',
            top: '100%',
            right: 0,
            width: 600,
            maxHeight: '85vh',
            display: 'flex',
            flexDirection: 'column',
            marginTop: 4,
            background: token.colorBgElevated,
            border: `1px solid ${token.colorBorderSecondary}`,
            borderRadius: token.borderRadiusLG,
            boxShadow: token.boxShadowSecondary,
            zIndex: 1000,
          }}
        >
          {/*
           * Close affordance. Esc still works (combobox keyboard contract);
           * this is for users reaching for the mouse. Absolute-positioned so
           * it doesn't reflow the chip row, sized to match the BETA tag's
           * visual weight on the second chip row.
           */}
          <Button
            type="text"
            size="small"
            icon={<CloseOutlined />}
            onClick={handleClose}
            aria-label="Close search"
            style={{
              position: 'absolute',
              top: 4,
              right: 4,
              width: 24,
              height: 24,
              minWidth: 24,
              padding: 0,
              color: token.colorTextTertiary,
              zIndex: 1,
            }}
          />
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
            counts={showRecents ? undefined : counts}
          />
          <GlobalSearchDropdown
            query={effectiveQuery}
            results={results}
            hasAnyResults={hasAnyResults}
            recents={recents}
            hasAnyRecents={hasAnyRecents}
            selectedIndex={selectedIndex}
            onResultClick={navigateToResult}
            onResultHover={setSelectedIndex}
          />
        </div>
      )}
    </div>
  );
};
