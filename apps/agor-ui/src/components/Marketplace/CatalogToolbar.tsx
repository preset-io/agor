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
import { Card, Col, Input, Row, Segmented, Select, Space, Typography, theme } from 'antd';
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

  return (
    <Card size="small" styles={{ body: { padding: token.padding } }}>
      <Space orientation="vertical" size={token.paddingSM} style={{ width: '100%' }}>
        <Input
          size="large"
          allowClear
          prefix={<SearchOutlined />}
          placeholder="Search MCP servers…"
          aria-label="Search MCP servers"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
        />
        <Segmented<CategoryFilter>
          options={CATEGORY_OPTIONS}
          value={category ?? ALL_CATEGORIES}
          onChange={(value) =>
            onCategoryChange(value === ALL_CATEGORIES ? undefined : (value as MCPCatalogCategory))
          }
        />
        <Row gutter={[token.paddingSM, token.paddingSM]} align="middle">
          <Col flex="auto" style={{ minWidth: 220 }}>
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              style={{ width: '100%' }}
              placeholder="Filter by capability (e.g. Issues, Logs, Databases)"
              aria-label="Filter by capability"
              value={capability ?? undefined}
              onChange={(value?: string) => onCapabilityChange(value || undefined)}
              options={CAPABILITY_OPTIONS}
            />
          </Col>
          {/* The "Hide key-only" switch stood here. It hid the entries the
              marketplace could not install, which since the API-key field is
              none of them: `CONNECTABLE_AUTH_TYPES` now names every stated auth
              type, so the switch removed nothing from any catalog the loader
              would serve. A control that provably cannot change the result set
              is worse than no control — it reads as a filter that is broken.
              What it used to distinguish, the card still says per entry. */}
          <Col flex="none">
            <Select<MCPCatalogSort>
              value={sort}
              onChange={onSortChange}
              aria-label="Sort servers"
              style={{ width: 200 }}
              options={SORT_OPTIONS}
            />
          </Col>
        </Row>
        {matchSummary && (
          <Text type="secondary">
            {matchSummary.matched} of {matchSummary.total} servers match
          </Text>
        )}
      </Space>
    </Card>
  );
};

export const CatalogToolbar = memo(CatalogToolbarInner);
