import { shortId } from '@agor-live/client';
import { LinkOutlined, PlusOutlined, SettingOutlined } from '@ant-design/icons';
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
  canEditLinkTarget,
  compareLinkDisplayItemsBySort,
  getLinkCategoryCounts,
  LINK_ACTION_LABEL,
  LINK_MANAGER_COPY,
  type LinkCategoryTabKey,
  type LinkDisplayItem,
  LinkEditorModal,
  type LinkSortKey,
  type ManualLinkDraft,
  matchesLinkCategoryTab,
  matchesLinkDisplaySearch,
  selectQuickLinkDisplayItems,
} from '../Links';
import { LinkCollectionControls } from '../Links/LinkCollectionControls';
import { getLinkUnavailableReason, getSafeLinkContentLabel } from '../Links/linkContent';
import linkStyles from '../Links/linkUi.module.css';
import { LinkPreviewModal, useLinkFileActions } from '../Links/SessionLinksControl';
import {
  SessionAttachmentDrawerRow,
  type SessionAttachmentLifecycleActions,
  type SessionAttachmentPlacementActions,
  SessionAttachmentQuickRow,
} from './SessionAttachmentRows';

type SessionAttachmentItem = LinkDisplayItem;

function matchesAttachmentSearch(item: LinkDisplayItem, query: string): boolean {
  return matchesLinkDisplaySearch(item, query, [
    item.filePath ? getSafeLinkContentLabel(item.filePath) : null,
    item.sourceSessionId ? shortId(item.sourceSessionId) : null,
  ]);
}

interface Props
  extends SessionAttachmentPlacementActions,
    Omit<SessionAttachmentLifecycleActions, 'onEditLink'> {
  items: SessionAttachmentItem[];
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  pinningKeys?: ReadonlySet<string>;
  onTogglePinned?: (item: SessionAttachmentItem) => void | Promise<void>;
  onRegisterOpenPinnedManager?: (openPinnedManager: (() => void) | null) => void;
  onCreateLink?: (draft: ManualLinkDraft) => Promise<boolean>;
  onUpdateLink?: (
    item: SessionAttachmentItem,
    changes: { title?: string | null; target?: string }
  ) => Promise<boolean>;
}

export const SessionAttachmentsDropdown: React.FC<Props> = ({
  items,
  loading = false,
  error = null,
  onRetry,
  pinningKeys,
  onTogglePinned,
  onRegisterOpenPinnedManager,
  getPlacementItems,
  onPlacementAction,
  onOpenPlacements,
  lifecycleBusyKeys,
  onDeleteLink,
  deleteLabel,
  onCreateLink,
  onUpdateLink,
}) => {
  const { token } = theme.useToken();
  const navigate = useNavigate();
  const { preview, setPreview, openItem } = useLinkFileActions(navigate);
  const [popoverOpen, setPopoverOpen] = React.useState(false);
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const [activeCategory, setActiveCategory] = React.useState<LinkCategoryTabKey>('all');
  const [sortOrder, setSortOrder] = React.useState<LinkSortKey>('az');
  const [searchQuery, setSearchQuery] = React.useState('');
  const [pinnedOnly, setPinnedOnly] = React.useState(false);
  const [editorOpen, setEditorOpen] = React.useState(false);
  const [editorItem, setEditorItem] = React.useState<SessionAttachmentItem | null>(null);

  const hasItems = items.length > 0;
  const managerItems = React.useMemo(
    () => (pinnedOnly ? items.filter((item) => item.isPinned) : items),
    [items, pinnedOnly]
  );
  const categoryCounts = React.useMemo(() => getLinkCategoryCounts(managerItems), [managerItems]);

  const openPinnedManager = React.useCallback(() => {
    setActiveCategory('all');
    setSearchQuery('');
    setPinnedOnly(true);
    setDrawerOpen(true);
  }, []);

  React.useEffect(() => {
    onRegisterOpenPinnedManager?.(openPinnedManager);
    return () => onRegisterOpenPinnedManager?.(null);
  }, [onRegisterOpenPinnedManager, openPinnedManager]);

  const quickItems = selectQuickLinkDisplayItems(items);

  const openTarget = (item: SessionAttachmentItem) => {
    if (getLinkUnavailableReason(item)) return;
    setPopoverOpen(false);
    openItem(item);
  };

  const drawerItems = managerItems
    .filter((item) => matchesLinkCategoryTab(item, activeCategory))
    .filter((item) => matchesAttachmentSearch(item, searchQuery))
    .sort((a, b) => compareLinkDisplayItemsBySort(a, b, sortOrder));

  const openAddLink = () => {
    setEditorItem(null);
    setEditorOpen(true);
  };

  const openEditLink = (item: SessionAttachmentItem) => {
    setEditorItem(item);
    setEditorOpen(true);
  };

  const submitEditor = (draft: ManualLinkDraft) => {
    if (!editorItem) return onCreateLink?.(draft) ?? Promise.resolve(false);
    return (
      onUpdateLink?.(editorItem, {
        title: draft.title,
        ...(canEditLinkTarget(editorItem) ? { target: draft.target } : {}),
      }) ?? Promise.resolve(false)
    );
  };

  const quickContent = (
    <div data-testid="links-organizer-popover" style={{ width: 312 }}>
      <Flex align="flex-start" justify="space-between" gap="small">
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
              setPinnedOnly(false);
              setDrawerOpen(true);
            }}
            style={{ color: token.colorTextTertiary }}
          />
        </Tooltip>
      </Flex>

      {error && (
        <div style={{ marginTop: token.sizeSM }}>
          <Typography.Text type="danger" style={{ display: 'block', fontSize: token.fontSizeSM }}>
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
        <Flex
          vertical
          gap={token.sizeXXS}
          style={{
            overflowY: 'auto',
            maxHeight: 308,
            marginTop: token.marginSM,
            paddingRight: token.paddingXXS,
          }}
        >
          {quickItems.map((item) => (
            <SessionAttachmentQuickRow
              key={item.key}
              item={item}
              pinningKeys={pinningKeys}
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
      <Space size={4} align="center" style={{ minWidth: 0 }}>
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
            <Badge count={items.length} color={token.colorPrimary} size="small" offset={[-4, 4]}>
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
      <LinkEditorModal
        open={editorOpen}
        item={editorItem}
        onCancel={() => setEditorOpen(false)}
        onSubmit={submitEditor}
      />

      <Drawer
        title={pinnedOnly ? LINK_MANAGER_COPY.pinnedTitle : LINK_MANAGER_COPY.title}
        open={drawerOpen}
        classNames={{ body: linkStyles.linkManagerDrawerBody }}
        size={720}
        onClose={() => setDrawerOpen(false)}
      >
        <div data-testid="links-organizer-manage" className={linkStyles.linkManagerBody}>
          <Flex vertical gap={token.sizeMD} className={linkStyles.linkManagerStack}>
            <LinkCollectionControls
              categoryCounts={categoryCounts}
              activeCategory={activeCategory}
              onCategoryChange={setActiveCategory}
              searchQuery={searchQuery}
              onSearchChange={setSearchQuery}
              sortOrder={sortOrder}
              onSortChange={setSortOrder}
              categoryAction={
                onCreateLink
                  ? {
                      label: LINK_ACTION_LABEL.add,
                      icon: <PlusOutlined />,
                      onClick: openAddLink,
                    }
                  : undefined
              }
            />
            {drawerItems.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No links in this view." />
            ) : (
              <div className={linkStyles.linkManagerList}>
                {drawerItems.map((item) => (
                  <SessionAttachmentDrawerRow
                    key={item.key}
                    item={item}
                    pinningKeys={pinningKeys}
                    onOpen={openTarget}
                    onTogglePinned={onTogglePinned}
                    getPlacementItems={getPlacementItems}
                    onPlacementAction={onPlacementAction}
                    onOpenPlacements={onOpenPlacements}
                    lifecycleBusyKeys={lifecycleBusyKeys}
                    onEditLink={openEditLink}
                    onDeleteLink={onDeleteLink}
                    deleteLabel={deleteLabel}
                  />
                ))}
              </div>
            )}
          </Flex>
        </div>
      </Drawer>
    </>
  );
};
