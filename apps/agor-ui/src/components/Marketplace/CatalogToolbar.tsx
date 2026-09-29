/**
 * Search and every filter, in one toolbar directly under the page header
 * (REQ-CAT-2). Splitting them across regions makes the user hunt for the
 * control that is narrowing their results. It is always one row: when the full
 * row does not fit its container, the selects move into a bottom sheet behind
 * one Filters button.
 *
 * The search box publishes every keystroke. It used to hold a draft and debounce
 * it, because each change was a request; now narrowing is a pass over an array
 * the browser already holds, so delaying it only makes the grid feel slower than
 * it is.
 */

import type { MCPCatalogCategory, MCPCatalogSort } from '@agor/core/types';
import { FilterOutlined, SearchOutlined } from '@ant-design/icons';
import { Badge, Button, Drawer, Flex, Input, type InputRef, Select, Typography, theme } from 'antd';
import type { RefSelectProps } from 'antd/es/select';
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useElementWidth } from '../../hooks/useElementWidth';
import { reducedMotionSurface, usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';
import { glassSurfaceStyle } from '../GlassSurface/glassStyles';
import {
  ALL_CATEGORIES,
  ANY_CAPABILITY,
  CAPABILITY_GROUPS,
  CATEGORY_OPTIONS,
  type CategoryFilter,
  capabilityLabel,
  DEFAULT_SORT,
  SORT_OPTIONS,
} from './catalogPresentation';
import { isFilterActive } from './useCatalogSearch';

const { Text } = Typography;

const SEARCH_MIN = 240;
const FILTER_MIN = 180;
const SORT_WIDTH = 150;

const CAPABILITY_OPTIONS = [
  { label: 'Any', value: ANY_CAPABILITY },
  ...CAPABILITY_GROUPS.map((group) => ({
    label: group.label,
    options: group.capabilities.map((capability) => ({
      label: capabilityLabel(capability),
      value: capability,
    })),
  })),
];

export interface CatalogToolbarProps {
  category?: MCPCatalogCategory;
  capability?: string;
  sort: MCPCatalogSort;
  /** The active search term. */
  search: string;
  onSearchChange: (value: string) => void;
  onCategoryChange: (value?: MCPCatalogCategory) => void;
  onCapabilityChange: (value?: string) => void;
  onSortChange: (value: MCPCatalogSort) => void;
  /** `null` until the catalog has loaded. */
  matchSummary: { matched: number; total: number } | null;
}

const CatalogToolbarInner: React.FC<CatalogToolbarProps> = ({
  category,
  capability,
  sort,
  search,
  onSearchChange,
  onCategoryChange,
  onCapabilityChange,
  onSortChange,
  matchSummary,
}) => {
  const { token } = theme.useToken();
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<InputRef>(null);
  const categoryRef = useRef<RefSelectProps>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const returnToToolbar = useRef(false);
  const width = useElementWidth(rootRef);
  // Unmeasured (0) keeps the full row.
  const compact =
    width > 0 && width < SEARCH_MIN + 2 * FILTER_MIN + SORT_WIDTH + 3 * token.paddingSM;
  const reducedMotion = usePrefersReducedMotion();
  const [filtersOpen, setFiltersOpen] = useState(false);
  // Mount the sheet on demand: left mounted while closed, it broke the host modal's Escape.
  const [filtersMounted, setFiltersMounted] = useState(false);
  const [filtersEntered, setFiltersEntered] = useState(false);
  useEffect(() => {
    // With motion disabled, afterOpenChange can precede the drawer's focus lock.
    // Focus after its effects have run, not while the host still owns the lock.
    if (compact && filtersOpen && filtersEntered) categoryRef.current?.focus();
  }, [compact, filtersOpen, filtersEntered]);
  useEffect(() => {
    if (!filtersMounted && returnToToolbar.current) {
      returnToToolbar.current = false;
      searchRef.current?.focus();
    }
  }, [filtersMounted]);
  useLayoutEffect(() => {
    if (!compact) {
      // Keep the sheet mounted through this commit so focus ownership can be
      // checked before it disappears. Search is the stable toolbar entry point.
      // Transfer only after unmount has released the sheet's focus lock.
      returnToToolbar.current = !!sheetRef.current?.contains(document.activeElement);
      setFiltersOpen(false);
      setFiltersMounted(false);
      setFiltersEntered(false);
    }
  }, [compact]);
  const full = { width: '100%' };
  const filterStyle = compact ? full : { flex: `1 1 ${FILTER_MIN}px`, maxWidth: 220 };
  const selectStyles = { prefix: { color: token.colorTextSecondary } };
  const activeFilters = Number(!!category) + Number(!!capability);
  const resultCount = matchSummary?.matched ?? null;

  const searchInput = (
    <Input
      ref={searchRef}
      allowClear
      prefix={<SearchOutlined />}
      placeholder="Search MCP servers…"
      aria-label="Search MCP servers"
      value={search}
      onChange={(event) => onSearchChange(event.target.value)}
      style={compact ? { flex: 1, minWidth: 0 } : { flex: `1 1 ${SEARCH_MIN}px`, maxWidth: 360 }}
    />
  );
  const selects = (
    <>
      <Select<CategoryFilter>
        ref={compact ? categoryRef : undefined}
        prefix="Category"
        aria-label="Filter by category"
        value={category ?? ALL_CATEGORIES}
        onChange={(value) =>
          onCategoryChange(value === ALL_CATEGORIES ? undefined : (value as MCPCatalogCategory))
        }
        options={CATEGORY_OPTIONS}
        styles={selectStyles}
        style={filterStyle}
      />
      <Select
        showSearch
        optionFilterProp="label"
        prefix="Capability"
        aria-label="Filter by capability"
        value={capability ?? ANY_CAPABILITY}
        onChange={(value: string) =>
          onCapabilityChange(value === ANY_CAPABILITY ? undefined : value)
        }
        options={CAPABILITY_OPTIONS}
        popupMatchSelectWidth={false}
        styles={selectStyles}
        style={filterStyle}
      />
      <Select<MCPCatalogSort>
        prefix="Sort"
        value={sort}
        onChange={onSortChange}
        aria-label="Sort servers"
        options={SORT_OPTIONS}
        styles={selectStyles}
        style={compact ? full : { width: SORT_WIDTH, marginInlineStart: 'auto' }}
      />
    </>
  );

  return (
    <Flex ref={rootRef} vertical gap={token.paddingXS}>
      {compact ? (
        <Flex gap={token.paddingSM} align="center">
          {searchInput}
          <Badge count={activeFilters} size="small" color={token.colorPrimary}>
            <Button
              icon={<FilterOutlined />}
              aria-label={activeFilters ? `Filters, ${activeFilters} active` : 'Filters'}
              onClick={() => {
                setFiltersMounted(true);
                setFiltersOpen(true);
              }}
            >
              Filters
            </Button>
          </Badge>
        </Flex>
      ) : (
        <Flex gap={token.paddingSM} align="center">
          {searchInput}
          {selects}
        </Flex>
      )}
      {filtersMounted && (
        <Drawer
          panelRef={sheetRef}
          open={filtersOpen}
          onClose={() => setFiltersOpen(false)}
          afterOpenChange={(open) => {
            setFiltersEntered(open);
            if (!open) setFiltersMounted(false);
          }}
          placement="bottom"
          size="auto"
          title="Filters"
          {...reducedMotionSurface(reducedMotion)}
          styles={{
            content: glassSurfaceStyle(token, 0.85),
            footer: { paddingBottom: `max(${token.paddingSM}px, env(safe-area-inset-bottom))` },
          }}
          footer={
            <Flex justify="space-between" align="center">
              <Button
                type="text"
                disabled={activeFilters === 0 && sort === DEFAULT_SORT}
                onClick={() => {
                  onCategoryChange(undefined);
                  onCapabilityChange(undefined);
                  onSortChange(DEFAULT_SORT);
                }}
              >
                Reset
              </Button>
              <Button type="primary" onClick={() => setFiltersOpen(false)}>
                {resultCount === null
                  ? 'Show servers'
                  : `Show ${resultCount} ${resultCount === 1 ? 'server' : 'servers'}`}
              </Button>
            </Flex>
          }
        >
          <Flex vertical gap={token.paddingSM}>
            {selects}
          </Flex>
        </Drawer>
      )}
      {/* REQ-CAT-3: the count is a filtering aid, so it shows only while filtering. */}
      {matchSummary && isFilterActive({ search, category, capability, sort }) && (
        <Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
          {matchSummary.matched} of {matchSummary.total} servers match
        </Text>
      )}
    </Flex>
  );
};

export const CatalogToolbar = memo(CatalogToolbarInner);
