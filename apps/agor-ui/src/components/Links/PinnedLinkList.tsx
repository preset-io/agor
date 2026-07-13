import { PushpinFilled, SettingOutlined } from '@ant-design/icons';
import { Button, Flex, Space, Spin, Tooltip, Typography } from 'antd';
import { useMemo } from 'react';
import type { LinkDisplayItem } from './linkDisplay';
import styles from './linkUi.module.css';
import { LINK_MANAGER_COPY } from './linkUiConstants';
import { LinkPreviewModal, LinkRow, useLinkFileActions } from './SessionLinksControl';

interface PinnedLinkListProps {
  items: LinkDisplayItem[];
  loading?: boolean;
  error?: string | null;
  onTogglePinned?: (item: LinkDisplayItem) => void | Promise<void>;
  pinningKeys?: ReadonlySet<string>;
  onOpenMore?: () => void;
  onManage?: () => void;
  countMode?: 'hidden' | 'total';
  loadingLabel?: string;
  className?: string;
  'data-testid'?: string;
}

const INLINE_LIMIT = 6;

export function PinnedLinkList({
  items,
  loading = false,
  error = null,
  onTogglePinned,
  pinningKeys,
  onOpenMore,
  onManage,
  countMode = 'hidden',
  loadingLabel = 'Loading links…',
  className,
  'data-testid': dataTestId,
}: PinnedLinkListProps) {
  const { preview, setPreview, openPreview, downloadItem } = useLinkFileActions();
  const pinnedItems = useMemo(() => items.filter((item) => item.isPinned), [items]);
  const inlineItems = pinnedItems.slice(0, INLINE_LIMIT);
  const hiddenCount = pinnedItems.length - inlineItems.length;

  if (!loading && !error && pinnedItems.length === 0) return null;

  return (
    <>
      <div
        className={[styles.pinnedList, className].filter(Boolean).join(' ')}
        data-testid={dataTestId}
      >
        <Flex
          align="center"
          justify="space-between"
          gap="small"
          className={styles.pinnedListHeader}
        >
          <Flex align="center" gap="small">
            <PushpinFilled className={styles.pinnedListIcon} />
            <Typography.Text type="secondary" strong className={styles.pinnedListText}>
              {LINK_MANAGER_COPY.pinnedTitle}
            </Typography.Text>
            {pinnedItems.length > 0 && countMode === 'total' && (
              <Typography.Text type="secondary" className={styles.pinnedListText}>
                {pinnedItems.length}
              </Typography.Text>
            )}
            {hiddenCount > 0 && countMode === 'hidden' && (
              <Typography.Text type="secondary" className={styles.pinnedListText}>
                +{hiddenCount} more
              </Typography.Text>
            )}
          </Flex>
          <Flex align="center" gap="small">
            {loading && <Spin size="small" />}
            {onManage && (
              <Tooltip title={LINK_MANAGER_COPY.managePinnedTooltip}>
                <Button
                  type="text"
                  size="small"
                  aria-label={LINK_MANAGER_COPY.managePinnedTooltip}
                  icon={<SettingOutlined />}
                  onClick={(event) => {
                    event.stopPropagation();
                    onManage();
                  }}
                />
              </Tooltip>
            )}
          </Flex>
        </Flex>

        {error ? (
          <Typography.Text type="danger" className={styles.pinnedListText}>
            {error}
          </Typography.Text>
        ) : inlineItems.length > 0 ? (
          <Space direction="vertical" size="small" className={styles.pinnedListItems}>
            {inlineItems.map((item) => (
              <LinkRow
                key={item.key}
                item={item}
                compact
                onPreview={openPreview}
                onDownload={downloadItem}
                onTogglePinned={onTogglePinned}
                pinning={pinningKeys?.has(item.linkId ?? item.key) ?? false}
              />
            ))}
            {hiddenCount > 0 && onOpenMore && (
              <Button type="link" size="small" onClick={onOpenMore}>
                +{hiddenCount} more
              </Button>
            )}
          </Space>
        ) : loading ? (
          <Typography.Text type="secondary" className={styles.pinnedListText}>
            {loadingLabel}
          </Typography.Text>
        ) : null}
      </div>
      <LinkPreviewModal preview={preview} onClose={() => setPreview(null)} />
    </>
  );
}
