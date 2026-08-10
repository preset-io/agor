/**
 * Search and every filter, in one toolbar directly under the page header
 * (REQ-CAT-2). Splitting them across regions makes the user hunt for the
 * control that is narrowing their results.
 *
 * The search box keeps its own value and publishes a debounced one, so typing
 * re-renders this component and nothing else — the grid below it only re-renders
 * once a query actually changes.
 */

import type { MCPCatalogCategory, MCPCatalogSort } from '@agor/core/types';
import { SearchOutlined } from '@ant-design/icons';
import {
  Card,
  Col,
  Input,
  Row,
  Segmented,
  Select,
  Space,
  Switch,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import { memo, useEffect, useRef, useState } from 'react';
import {
  ALL_CATEGORIES,
  CAPABILITY_GROUPS,
  CATEGORY_OPTIONS,
  type CategoryFilter,
  capabilityLabel,
  SORT_OPTIONS,
} from './catalogPresentation';

const { Text } = Typography;

const SEARCH_DEBOUNCE_MS = 250;

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
  reviewedOnly: boolean;
  connectableOnly: boolean;
  sort: MCPCatalogSort;
  /** Debounced search term, for controlled resets (e.g. "clear filters"). */
  search: string;
  onSearchChange: (value: string) => void;
  onCategoryChange: (value?: MCPCatalogCategory) => void;
  onCapabilityChange: (value?: string) => void;
  onReviewedOnlyChange: (value: boolean) => void;
  onConnectableOnlyChange: (value: boolean) => void;
  onSortChange: (value: MCPCatalogSort) => void;
  /** `null` while the unfiltered catalog size is still unknown. */
  matchSummary: { matched: number; total: number } | null;
}

const CatalogToolbarInner: React.FC<CatalogToolbarProps> = ({
  category,
  capability,
  reviewedOnly,
  connectableOnly,
  sort,
  search,
  onSearchChange,
  onCategoryChange,
  onCapabilityChange,
  onReviewedOnlyChange,
  onConnectableOnlyChange,
  onSortChange,
  matchSummary,
}) => {
  const { token } = theme.useToken();
  const [draft, setDraft] = useState(search);

  // Keep the box in step when the term is reset from outside; typing already
  // owns `draft`, so this only fires on an external change.
  useEffect(() => {
    setDraft((current) => (current.trim() === search.trim() ? current : search));
  }, [search]);

  const publish = useRef(onSearchChange);
  publish.current = onSearchChange;

  useEffect(() => {
    const timer = setTimeout(() => publish.current(draft), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draft]);

  return (
    <Card size="small" styles={{ body: { padding: token.padding } }}>
      <Space orientation="vertical" size={token.paddingSM} style={{ width: '100%' }}>
        <Input
          size="large"
          allowClear
          prefix={<SearchOutlined />}
          placeholder="Search MCP servers…"
          aria-label="Search MCP servers"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
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
          <Col flex="none">
            <Space size={token.marginXS}>
              <Text type="secondary">Reviewed only</Text>
              <Switch
                size="small"
                checked={reviewedOnly}
                onChange={onReviewedOnlyChange}
                aria-label="Show only servers reviewed by Preset"
              />
            </Space>
          </Col>
          <Col flex="none">
            <Space size={token.marginXS}>
              {/* Named for what it removes, because what it keeps includes
                  endpoints nobody has checked yet. */}
              <Tooltip title="Hides servers Agor knows need an account. Unchecked endpoints stay — connecting is what checks them.">
                <Text type="secondary" style={{ cursor: 'help' }}>
                  Hide account-only
                </Text>
              </Tooltip>
              <Switch
                size="small"
                checked={connectableOnly}
                onChange={onConnectableOnlyChange}
                aria-label="Hide servers known to need an account"
              />
            </Space>
          </Col>
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
