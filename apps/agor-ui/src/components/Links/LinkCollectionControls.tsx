import { Flex, Input, Segmented, Select, Space, Typography, theme } from 'antd';
import {
  LINK_CATEGORY_TAB_LABELS,
  LINK_SORT_LABELS,
  type LinkCategoryTabKey,
  type LinkSortKey,
} from './linkOrganizer';
import styles from './linkUi.module.css';

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
    <Flex vertical gap="middle" className={styles.fullWidth}>
      <div className={styles.segmentedScroll}>
        <Segmented<LinkCategoryTabKey>
          className={styles.segmented}
          block
          value={activeCategory}
          options={getLinkCategoryOptions(categoryCounts)}
          onChange={onCategoryChange}
        />
      </div>
      <Flex className={styles.collectionToolbar} align="center" gap="small" wrap>
        <Input.Search
          className={styles.collectionSearch}
          allowClear
          value={searchQuery}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Search links"
          aria-label="Search links"
        />
        <Space className={styles.collectionSort} size={token.sizeXS}>
          <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
            Sort
          </Typography.Text>
          <Select<LinkSortKey>
            className={styles.collectionSortSelect}
            size="small"
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
