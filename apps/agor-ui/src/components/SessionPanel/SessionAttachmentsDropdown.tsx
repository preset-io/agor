import { LinkOutlined, SettingOutlined } from '@ant-design/icons';
import {
  Badge,
  Button,
  Drawer,
  Empty,
  Input,
  Popover,
  Select,
  Space,
  Tabs,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useThemedMessage } from '../../utils/message';
import {
  isFileLinkDisplayItem,
  LINK_CATEGORY_TAB_LABELS,
  LINK_SORT_LABELS,
  type LinkCategoryTabKey,
  type LinkSortKey,
} from '../Links';
import { LinkImagePreviewModal, type LinkImagePreviewTarget } from '../Links/LinkImagePreviewModal';
import {
  LinkMarkdownPreviewModal,
  type LinkMarkdownPreviewTarget,
} from '../Links/LinkMarkdownPreviewModal';
import { downloadLinkContent } from '../Links/linkContent';
import {
  SessionAttachmentDrawerRow,
  SessionAttachmentQuickRow,
  type SessionAttachmentTeammateState,
} from './SessionAttachmentRows';
import {
  canDownloadSessionFile as canDownloadFile,
  canPreviewSessionImage as canPreviewImage,
  canPreviewSessionMarkdown as canPreviewMarkdown,
  compareSessionAttachments as compareDrawerItems,
  sessionAttachmentDisabledReason as disabledReasonForItem,
  getSessionAttachmentCategoryCounts as getCategoryCounts,
  getSessionAttachmentTargetDisplay as getTargetDisplay,
  matchesSessionAttachmentSearch as itemMatchesSearch,
  matchesSessionAttachmentCategory as matchesCategory,
  type SessionAttachmentItem,
  targetForSessionAttachment as targetForItem,
} from './sessionAttachmentModel';

export type { SessionAttachmentItem } from './sessionAttachmentModel';
export { displayItemToSessionAttachmentItem } from './sessionAttachmentModel';

type LinksCategoryTab = LinkCategoryTabKey;
type LinksSort = LinkSortKey;

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
  const { showError } = useThemedMessage();
  const [popoverOpen, setPopoverOpen] = React.useState(false);
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const [activeCategory, setActiveCategory] = React.useState<LinksCategoryTab>('all');
  const [sortOrder, setSortOrder] = React.useState<LinksSort>('az');
  const [searchQuery, setSearchQuery] = React.useState('');
  const [previewTarget, setPreviewTarget] = React.useState<LinkImagePreviewTarget | null>(null);
  const [markdownTarget, setMarkdownTarget] = React.useState<LinkMarkdownPreviewTarget | null>(
    null
  );

  const visibleItems = items;
  const hasItems = visibleItems.length > 0;
  const pinnedItems = visibleItems.filter((item) => item.isPinned);
  const files = visibleItems.filter(isFileLinkDisplayItem);
  const nonPinnedNonFiles = visibleItems.filter(
    (item) => !item.isPinned && !isFileLinkDisplayItem(item)
  );
  const categoryCounts = React.useMemo(() => getCategoryCounts(visibleItems), [visibleItems]);
  const categoryTabs = React.useMemo(
    () =>
      (['all', 'files', 'links', 'knowledge', 'issues'] as const).map((key) => ({
        key,
        label: `${LINK_CATEGORY_TAB_LABELS[key]} ${categoryCounts[key]}`,
      })),
    [categoryCounts]
  );

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
    if (disabledReasonForItem(item)) return;
    if (canPreviewImage(item) && item.linkId) {
      setPopoverOpen(false);
      setPreviewTarget({ linkId: item.linkId, title: item.name, subtitle: getTargetDisplay(item) });
      return;
    }
    if (canPreviewMarkdown(item) && item.linkId) {
      setPopoverOpen(false);
      setMarkdownTarget({
        linkId: item.linkId,
        title: item.name,
        subtitle: getTargetDisplay(item),
      });
      return;
    }
    if (canDownloadFile(item) && item.linkId) {
      setPopoverOpen(false);
      downloadLinkContent(item.linkId, item.name).catch((err) => {
        showError(err instanceof Error ? err.message : 'Download failed');
      });
      return;
    }
    const target = targetForItem(item);
    if (!target) return;
    setPopoverOpen(false);
    if (target.navigation === 'spa') {
      navigate(target.href);
      return;
    }
    window.open(target.href, '_blank', 'noopener,noreferrer');
  };

  const drawerItems = visibleItems
    .filter((item) => matchesCategory(item, activeCategory))
    .filter((item) => itemMatchesSearch(item, searchQuery))
    .sort((a, b) => compareDrawerItems(a, b, sortOrder));

  const quickContent = (
    <div style={{ width: 312 }} data-testid="links-organizer-popover">
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <div style={{ minWidth: 0 }}>
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
      </div>

      {error && (
        <div style={{ marginTop: token.sizeSM }}>
          <Typography.Text type="danger" style={{ display: 'block', fontSize: 12 }}>
            {error}
          </Typography.Text>
          {onRetry && (
            <Button type="link" size="small" onClick={onRetry} style={{ paddingInline: 0 }}>
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
        <div
          style={{
            display: 'grid',
            gap: token.sizeXXS,
            marginTop: token.sizeSM,
            maxHeight: 308,
            overflowY: 'auto',
            paddingRight: token.sizeXXS,
          }}
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
        </div>
      )}
    </div>
  );

  return (
    <>
      <Space size={4} align="center" style={{ minWidth: 0 }}>
        <Popover
          open={popoverOpen}
          onOpenChange={setPopoverOpen}
          content={quickContent}
          trigger="click"
          placement="bottomRight"
          overlayInnerStyle={{
            border: `1px solid ${token.colorBorderSecondary}`,
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

      <LinkImagePreviewModal target={previewTarget} onClose={() => setPreviewTarget(null)} />
      <LinkMarkdownPreviewModal target={markdownTarget} onClose={() => setMarkdownTarget(null)} />

      <Drawer
        title="Manage links"
        open={drawerOpen}
        width={720}
        onClose={() => setDrawerOpen(false)}
      >
        <div data-testid="links-organizer-manage">
          <Space direction="vertical" size={token.sizeMD} style={{ width: '100%' }}>
            <Tabs
              className="agor-link-category-tabs"
              activeKey={activeCategory}
              items={categoryTabs}
              onChange={(key) => setActiveCategory(key as LinksCategoryTab)}
            />
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: token.sizeSM,
                width: '100%',
                flexWrap: 'wrap',
              }}
            >
              <Input.Search
                allowClear
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search links"
                aria-label="Search links"
                style={{ flex: '1 1 320px', minWidth: 220 }}
              />
              <Space size={token.sizeXS} style={{ flex: '0 0 auto' }}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  Sort
                </Typography.Text>
                <Select<LinksSort>
                  size="small"
                  value={sortOrder}
                  options={(Object.keys(LINK_SORT_LABELS) as LinksSort[]).map((key) => ({
                    value: key,
                    label: LINK_SORT_LABELS[key],
                  }))}
                  onChange={setSortOrder}
                  style={{ width: 128 }}
                />
              </Space>
            </div>
            {drawerItems.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No links in this view." />
            ) : (
              <div
                style={{
                  maxHeight: 'min(58vh, 560px)',
                  overflowY: 'auto',
                  paddingRight: token.sizeXS,
                }}
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
