/**
 * Search and every filter, in one toolbar directly under the page header
 * (REQ-CAT-2). Splitting them across regions makes the user hunt for the
 * control that is narrowing their results.
 *
 * The search box publishes every keystroke. It used to hold a draft and debounce
 * it, because each change was a request; now narrowing is a pass over an array
 * the browser already holds, so delaying it only makes the grid feel slower than
 * it is.
 */

import type { MCPCatalogCategory, MCPCatalogSort } from '@agor/core/types';
import { SearchOutlined } from '@ant-design/icons';
import { Card, Flex, Grid, Input, Select, Typography, theme } from 'antd';
import { memo } from 'react';
import {
  ALL_CATEGORIES,
  CAPABILITY_GROUPS,
  CATEGORY_OPTIONS,
  type CategoryFilter,
  capabilityLabel,
  SORT_OPTIONS,
} from './catalogPresentation';

const { Text } = Typography;

const CAPABILITY_OPTIONS = CAPABILITY_GROUPS.map((group) => ({
  label: group.label,
  options: group.capabilities.map((capability) => ({
    label: capabilityLabel(capability),
    value: capability,
  })),
}));

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
  /** `null` while the unfiltered catalog size is still unknown. */
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
  const screens = Grid.useBreakpoint();
  const compact = screens.xs === true && screens.md !== true;
  const full = { width: '100%' };
  const filterStyle = compact ? full : { flex: '1 1 180px', maxWidth: 220 };
  const selectStyles = { prefix: { color: token.colorTextSecondary } };

  return (
    <Card size="small" styles={{ body: { padding: token.padding } }}>
      <Flex vertical gap={token.paddingXS}>
        <Flex wrap gap={token.paddingSM} align="center">
          <Input
            allowClear
            prefix={<SearchOutlined />}
            placeholder="Search MCP servers…"
            aria-label="Search MCP servers"
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            style={compact ? full : { flex: '1 1 240px', maxWidth: 360 }}
          />
          <Select<CategoryFilter>
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
            allowClear
            showSearch
            optionFilterProp="label"
            placeholder="Capability"
            aria-label="Filter by capability"
            value={capability ?? undefined}
            onChange={(value?: string) => onCapabilityChange(value || undefined)}
            options={CAPABILITY_OPTIONS}
            popupMatchSelectWidth={false}
            style={filterStyle}
          />
          <Select<MCPCatalogSort>
            prefix="Sort"
            value={sort}
            onChange={onSortChange}
            aria-label="Sort servers"
            options={SORT_OPTIONS}
            styles={selectStyles}
            style={compact ? full : { width: 150, marginInlineStart: 'auto' }}
          />
        </Flex>
        {matchSummary && (
          <Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
            {matchSummary.matched} of {matchSummary.total} servers match
          </Text>
        )}
      </Flex>
    </Card>
  );
};

export const CatalogToolbar = memo(CatalogToolbarInner);
