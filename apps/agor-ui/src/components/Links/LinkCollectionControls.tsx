import { Button, Flex, Input, Segmented, Select, Space, Tooltip, Typography, theme } from 'antd';
import type { ReactNode } from 'react';
import {
  LINK_CATEGORY_TAB_LABELS,
  LINK_SORT_LABELS,
  type LinkCategoryTabKey,
  type LinkSortKey,
} from './linkOrganizer';

const CATEGORY_KEYS: LinkCategoryTabKey[] = ['all', 'files', 'links', 'knowledge', 'issues'];
const CATEGORY_TABS_MIN_WIDTH = 520;
const SEARCH_MIN_WIDTH = 220;
const SEARCH_FLEX_BASIS = 320;
const SORT_SELECT_WIDTH = 128;

export function getLinkCategoryOptions(counts: Record<LinkCategoryTabKey, number>) {
  return CATEGORY_KEYS.map((value) => ({
    value,
    label: `${LINK_CATEGORY_TAB_LABELS[value]} ${counts[value]}`,
  }));
}

interface LinkCollectionControlsProps {
  categoryCounts: Record<LinkCategoryTabKey, number>;
  activeCategory: LinkCategoryTabKey;
  onCategoryChange: (category: LinkCategoryTabKey) => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  sortOrder: LinkSortKey;
  onSortChange: (sort: LinkSortKey) => void;
  categoryAction?: {
    label: string;
    icon: ReactNode;
    onClick: () => void;
  };
}

export function LinkCollectionControls({
  categoryCounts,
  activeCategory,
  onCategoryChange,
  searchQuery,
  onSearchChange,
  sortOrder,
  onSortChange,
  categoryAction,
}: LinkCollectionControlsProps) {
  const { token } = theme.useToken();

  return (
    <Flex vertical gap="middle" style={{ width: '100%' }}>
      <Flex align="center" gap="small" style={{ width: '100%' }}>
        <div style={{ minWidth: 0, flex: '1 1 auto', overflowX: 'auto' }}>
          <Segmented<LinkCategoryTabKey>
            block
            style={{ minWidth: CATEGORY_TABS_MIN_WIDTH }}
            value={activeCategory}
            options={getLinkCategoryOptions(categoryCounts)}
            onChange={onCategoryChange}
          />
        </div>
        {categoryAction && (
          <Flex flex="0 0 auto">
            <Tooltip title={categoryAction.label}>
              <Button
                type="primary"
                icon={categoryAction.icon}
                aria-label={categoryAction.label}
                onClick={categoryAction.onClick}
              />
            </Tooltip>
          </Flex>
        )}
      </Flex>
      <Flex align="center" gap="small" wrap style={{ width: '100%' }}>
        <Input.Search
          allowClear
          style={{ minWidth: SEARCH_MIN_WIDTH, flex: `1 1 ${SEARCH_FLEX_BASIS}px` }}
          value={searchQuery}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Search links"
          aria-label="Search links"
        />
        <Space size="small" style={{ flex: '0 0 auto' }}>
          <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
            Sort
          </Typography.Text>
          <Select<LinkSortKey>
            size="small"
            style={{ width: SORT_SELECT_WIDTH }}
            value={sortOrder}
            options={(Object.keys(LINK_SORT_LABELS) as LinkSortKey[]).map((value) => ({
              value,
              label: LINK_SORT_LABELS[value],
            }))}
            onChange={onSortChange}
          />
        </Space>
      </Flex>
    </Flex>
  );
}
