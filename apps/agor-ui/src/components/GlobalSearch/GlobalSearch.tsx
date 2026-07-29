import { CloseOutlined, SearchOutlined } from '@ant-design/icons';
import { Button, Input, type InputRef, Tooltip, theme } from 'antd';
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
        setOpen(true);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Focus the input whenever the popover opens — covers both icon click
  // and Cmd+K. Uses rAF because the Input mounts in the same render tick.
  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

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
    <div ref={containerRef} style={{ position: 'relative' }}>
      <Tooltip title="Search  ⌘K" open={open ? false : undefined}>
        <Button
          type="text"
          icon={<SearchOutlined style={{ fontSize: token.fontSizeLG }} />}
          aria-label="Open search"
          onClick={() => {
            if (open) {
              handleClose();
            } else {
              setOpen(true);
            }
          }}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        />
      </Tooltip>
      {open && (
        <div
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
          <div style={{ display: 'flex', alignItems: 'center', padding: '8px 8px 0', gap: 4 }}>
            <Input.Search
              ref={inputRef}
              placeholder="Search…"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setSelectedIndex(0);
              }}
              onKeyDown={handleKeyDown}
              onSearch={handleSubmit}
              allowClear
              aria-label="Global search"
              aria-autocomplete="list"
              aria-expanded={open}
              aria-controls={GLOBAL_SEARCH_LISTBOX_ID}
              aria-activedescendant={
                visibleRows[selectedIndex] ? rowDomId(visibleRows[selectedIndex]) : undefined
              }
              role="combobox"
              style={{ flex: 1 }}
            />
            <Button
              type="text"
              size="small"
              icon={<CloseOutlined />}
              onClick={handleClose}
              aria-label="Close search"
              style={{
                width: 28,
                height: 28,
                minWidth: 28,
                padding: 0,
                color: token.colorTextTertiary,
              }}
            />
          </div>
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
