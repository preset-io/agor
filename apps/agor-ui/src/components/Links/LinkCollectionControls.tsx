import { Button, Flex, Input, Segmented, Select, Space, Tooltip, Typography } from 'antd';
import type { ReactNode } from 'react';
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
  return (
    <Flex vertical gap="middle" className={styles.linkCollectionControls}>
      <Flex align="center" gap="small" className={styles.linkCategoryRow}>
        <div className={styles.linkCategoryScroller}>
          <Segmented<LinkCategoryTabKey>
            block
            className={styles.linkCategoryTabs}
            value={activeCategory}
            options={getLinkCategoryOptions(categoryCounts)}
            onChange={onCategoryChange}
          />
        </div>
        {categoryAction && (
          <div className={styles.linkCategoryAction}>
            <Tooltip title={categoryAction.label}>
              <Button
                type="primary"
                icon={categoryAction.icon}
                aria-label={categoryAction.label}
                onClick={categoryAction.onClick}
              />
            </Tooltip>
          </div>
        )}
      </Flex>
      <Flex align="center" gap="small" wrap className={styles.linkSecondaryControls}>
        <Input.Search
          allowClear
          className={styles.linkSearchInput}
          value={searchQuery}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Search links"
          aria-label="Search links"
        />
        <Space size="small" className={styles.linkSortControls}>
          <Typography.Text type="secondary" className={styles.linkSortLabel}>
            Sort
          </Typography.Text>
          <Select<LinkSortKey>
            size="small"
            className={styles.linkSortSelect}
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
