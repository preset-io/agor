import { LinkOutlined, SettingOutlined } from '@ant-design/icons';
import {
  Badge,
  Button,
  Drawer,
  Empty,
  Flex,
  Popover,
  Space,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import React from 'react';
import { useNavigate } from 'react-router-dom';
import {
  compareLinkDisplayItemsBySort,
  getLinkCategoryCounts,
  isFileLinkDisplayItem,
  type LinkCategoryTabKey,
  type LinkDisplayItem,
  type LinkSortKey,
  matchesLinkCategoryTab,
  matchesLinkDisplaySearch,
} from '../Links';
import { LinkCollectionControls } from '../Links/LinkCollectionControls';
import { getLinkUnavailableReason, getSafeLinkContentLabel } from '../Links/linkContent';
import styles from '../Links/linkUi.module.css';
import { LinkPreviewModal, useLinkFileActions } from '../Links/SessionLinksControl';
import {
  SessionAttachmentDrawerRow,
  SessionAttachmentQuickRow,
  type SessionAttachmentTeammateState,
} from './SessionAttachmentRows';

export type SessionAttachmentItem = LinkDisplayItem;

function matchesAttachmentSearch(item: LinkDisplayItem, query: string): boolean {
  return matchesLinkDisplaySearch(item, query, [
    item.filePath ? getSafeLinkContentLabel(item.filePath) : null,
    item.sourceSessionId?.slice(0, 8),
  ]);
}

interface Props {
  items: SessionAttachmentItem[];
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  pinningLinkId?: string | null;
  onTogglePinned?: (item: SessionAttachmentItem) => void | Promise<void>;
  onRegisterOpenPinnedManager?: (openPinnedManager: (() => void) | null) => void;
  getTeammateActionState?: (item: SessionAttachmentItem) => SessionAttachmentTeammateState | null;
  onPromoteToTeammate?: (item: SessionAttachmentItem) => void | Promise<void>;
  onRemoveFromTeammate?: (
    item: SessionAttachmentItem,
    teammateLinkId: string
  ) => void | Promise<void>;
  teammatePromotionBusyKey?: string | null;
}

export const SessionAttachmentsDropdown: React.FC<Props> = ({
  items,
  loading = false,
  error = null,
  onRetry,
  pinningLinkId = null,
  onTogglePinned,
  onRegisterOpenPinnedManager,
  getTeammateActionState,
  onPromoteToTeammate,
  onRemoveFromTeammate,
  teammatePromotionBusyKey = null,
}) => {
  const { token } = theme.useToken();
  const navigate = useNavigate();
  const { preview, setPreview, openItem } = useLinkFileActions(navigate);
  const [popoverOpen, setPopoverOpen] = React.useState(false);
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const [activeCategory, setActiveCategory] = React.useState<LinkCategoryTabKey>('all');
  const [sortOrder, setSortOrder] = React.useState<LinkSortKey>('az');
  const [searchQuery, setSearchQuery] = React.useState('');

  const visibleItems = items;
  const hasItems = visibleItems.length > 0;
  const pinnedItems = visibleItems.filter((item) => item.isPinned);
  const files = visibleItems.filter(isFileLinkDisplayItem);
  const nonPinnedNonFiles = visibleItems.filter(
    (item) => !item.isPinned && !isFileLinkDisplayItem(item)
  );
  const categoryCounts = React.useMemo(() => getLinkCategoryCounts(visibleItems), [visibleItems]);

  const openPinnedManager = React.useCallback(() => {
    setActiveCategory('all');
    setDrawerOpen(true);
  }, []);

  React.useEffect(() => {
    onRegisterOpenPinnedManager?.(openPinnedManager);
    return () => onRegisterOpenPinnedManager?.(null);
  }, [onRegisterOpenPinnedManager, openPinnedManager]);

  if (!hasItems && !loading && !error) return null;

  const fileReserve = files.length > 0 ? Math.min(2, files.length) : 0;
  const quickPinned = pinnedItems.slice(0, Math.min(3, pinnedItems.length));
  const quickPinnedKeys = new Set(quickPinned.map((item) => item.key));
  const quickRecent = nonPinnedNonFiles.slice(0, Math.max(0, 7 - quickPinned.length - fileReserve));
  const quickRecentKeys = new Set(quickRecent.map((item) => item.key));
  const quickFiles = files
    .filter((item) => !quickPinnedKeys.has(item.key) && !quickRecentKeys.has(item.key))
    .slice(0, Math.max(0, 7 - quickPinned.length - quickRecent.length));
  const quickItems = [...quickPinned, ...quickRecent, ...quickFiles];

  const openTarget = (item: SessionAttachmentItem) => {
    if (getLinkUnavailableReason(item)) return;
    setPopoverOpen(false);
    openItem(item);
  };

  const drawerItems = visibleItems
    .filter((item) => matchesLinkCategoryTab(item, activeCategory))
    .filter((item) => matchesAttachmentSearch(item, searchQuery))
    .sort((a, b) => compareLinkDisplayItemsBySort(a, b, sortOrder));

  const quickContent = (
    <div className={styles.organizerPopover} data-testid="links-organizer-popover">
      <Flex align="flex-start" justify="space-between" gap="small">
        <div className={styles.minWidthZero}>
          <Typography.Text strong>Links</Typography.Text>
        </div>
        <Tooltip title="Manage links">
          <Button
            type="text"
            size="small"
            aria-label="Manage links"
            icon={<SettingOutlined />}
            onClick={() => {
              setPopoverOpen(false);
              setDrawerOpen(true);
            }}
            style={{ color: token.colorTextTertiary }}
          />
        </Tooltip>
      </Flex>

      {error && (
        <div style={{ marginTop: token.sizeSM }}>
          <Typography.Text type="danger" className={`${styles.blockText} ${styles.smallText}`}>
            {error}
          </Typography.Text>
          {onRetry && (
            <Button className={styles.noInlinePadding} type="link" size="small" onClick={onRetry}>
              Retry
            </Button>
          )}
        </div>
      )}

      {!hasItems ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={loading ? 'Loading links…' : 'No links collected yet.'}
          style={{ margin: `${token.sizeSM}px 0` }}
        />
      ) : (
        <Flex
          className={`${styles.organizerScroll} ${styles.organizerQuickList}`}
          vertical
          gap={token.sizeXXS}
        >
          {quickItems.map((item) => (
            <SessionAttachmentQuickRow
              key={item.key}
              item={item}
              pinningLinkId={pinningLinkId}
              onOpen={openTarget}
              onTogglePinned={onTogglePinned}
            />
          ))}
        </Flex>
      )}
    </div>
  );

  return (
    <>
      <Space className={styles.minWidthZero} size={4} align="center">
        <Popover
          open={popoverOpen}
          onOpenChange={setPopoverOpen}
          content={quickContent}
          trigger="click"
          placement="bottomRight"
          styles={{
            container: { border: `1px solid ${token.colorBorderSecondary}` },
          }}
        >
          <Tooltip title="Attachments">
            <Badge
              count={visibleItems.length}
              color={token.colorPrimary}
              size="small"
              offset={[-4, 4]}
            >
              <Button
                type="text"
                aria-label="Open links organizer"
                loading={loading}
                icon={<LinkOutlined style={{ color: token.colorTextSecondary }} />}
              />
            </Badge>
          </Tooltip>
        </Popover>
      </Space>

      <LinkPreviewModal preview={preview} onClose={() => setPreview(null)} />

      <Drawer
        title="Manage links"
        open={drawerOpen}
        size={720}
        onClose={() => setDrawerOpen(false)}
      >
        <div data-testid="links-organizer-manage">
          <Space className={styles.fullWidth} direction="vertical" size={token.sizeMD}>
            <LinkCollectionControls
              categoryCounts={categoryCounts}
              activeCategory={activeCategory}
              onCategoryChange={setActiveCategory}
              searchQuery={searchQuery}
              onSearchChange={setSearchQuery}
              sortOrder={sortOrder}
              onSortChange={setSortOrder}
            />
            {drawerItems.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No links in this view." />
            ) : (
              <div
                className={`${styles.organizerScroll} ${styles.organizerDrawerList} ${styles.drawerListPadding}`}
              >
                {drawerItems.map((item) => (
                  <SessionAttachmentDrawerRow
                    key={item.key}
                    item={item}
                    pinningLinkId={pinningLinkId}
                    onOpen={openTarget}
                    onTogglePinned={onTogglePinned}
                    getTeammateActionState={getTeammateActionState}
                    onPromoteToTeammate={onPromoteToTeammate}
                    onRemoveFromTeammate={onRemoveFromTeammate}
                    teammatePromotionBusyKey={teammatePromotionBusyKey}
                  />
                ))}
              </div>
            )}
          </Space>
        </div>
      </Drawer>
    </>
  );
};
