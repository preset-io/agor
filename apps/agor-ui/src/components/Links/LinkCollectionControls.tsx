import { Flex, Input, Segmented, Select, Space, Typography, theme } from 'antd';
import {
  LINK_CATEGORY_TAB_LABELS,
  LINK_SORT_LABELS,
  type LinkCategoryTabKey,
  type LinkSortKey,
} from './linkOrganizer';

const CATEGORY_KEYS: LinkCategoryTabKey[] = ['all', 'files', 'links', 'knowledge', 'issues'];

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
}

export function LinkCollectionControls({
  categoryCounts,
  activeCategory,
  onCategoryChange,
  searchQuery,
  onSearchChange,
  sortOrder,
  onSortChange,
}: LinkCollectionControlsProps) {
  const { token } = theme.useToken();

  return (
    <Flex vertical gap="middle" style={{ width: '100%' }}>
      <div style={{ width: '100%', overflowX: 'auto' }}>
        <Segmented<LinkCategoryTabKey>
          block
          style={{ minWidth: 520 }}
          value={activeCategory}
          options={getLinkCategoryOptions(categoryCounts)}
          onChange={onCategoryChange}
        />
      </div>
      <Flex align="center" gap="small" wrap style={{ width: '100%' }}>
        <Input.Search
          allowClear
          style={{ minWidth: 220, flex: '1 1 320px' }}
          value={searchQuery}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Search links"
          aria-label="Search links"
        />
        <Space size={token.sizeXS} style={{ flex: '0 0 auto' }}>
          <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
            Sort
          </Typography.Text>
          <Select<LinkSortKey>
            size="small"
            style={{ width: 128 }}
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
