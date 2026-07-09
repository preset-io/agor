import { EllipsisOutlined, LinkOutlined, PushpinFilled, PushpinOutlined } from '@ant-design/icons';
import { Button, Dropdown, Empty, List, Space, Tag, Tooltip, Typography, theme } from 'antd';
import type React from 'react';
import { useState } from 'react';
import { useThemedMessage } from '../../utils/message';
import { LinkDisplayTargetLink } from './LinkDisplayTargetLink';
import { LinkImagePreviewModal, type LinkImagePreviewTarget } from './LinkImagePreviewModal';
import {
  LinkMarkdownPreviewModal,
  type LinkMarkdownPreviewTarget,
} from './LinkMarkdownPreviewModal';
import { downloadLinkContent, getLinkContentAction, getLinkPreviewKind } from './linkContent';
import {
  getCompactLinkDisplayName,
  getLinkDisplayGlyphLabel,
  getLinkDisplayPillLabel,
  getLinkDisplaySecondaryLabel,
  type LinkDisplayItem,
} from './linkDisplay';

export interface AssistantLinkDisplayActionState {
  isPromoted: boolean;
  assistantLinkId?: string;
  disabled?: boolean;
  loading?: boolean;
}

interface LinkDisplayListProps {
  items: LinkDisplayItem[];
  emptyDescription?: string;
  compact?: boolean;
  showPinActions?: boolean;
  pinActionDisabled?: boolean;
  pinningLinkId?: string | null;
  onTogglePinned?: (item: LinkDisplayItem) => void;
  getAssistantActionState?: (item: LinkDisplayItem) => AssistantLinkDisplayActionState | null;
  onPromoteToAssistant?: (item: LinkDisplayItem) => void;
  onRemoveFromAssistant?: (item: LinkDisplayItem, assistantLinkId: string) => void;
}

function LinkTitle({
  item,
  onPreviewImage,
  onPreviewMarkdown,
  onDownload,
}: {
  item: LinkDisplayItem;
  onPreviewImage: (target: LinkImagePreviewTarget) => void;
  onPreviewMarkdown: (target: LinkMarkdownPreviewTarget) => void;
  onDownload: (item: LinkDisplayItem) => void;
}) {
  const label = getCompactLinkDisplayName(item);
  const contentAction = getLinkContentAction(item);
  const previewKind = getLinkPreviewKind(item);
  if (contentAction && item.linkId) {
    return (
      <Typography.Link
        onClick={(event) => {
          event.stopPropagation();
          if (contentAction === 'download') {
            onDownload(item);
          } else if (previewKind === 'image') {
            onPreviewImage({ linkId: item.linkId!, title: label, subtitle: item.filePath });
          } else {
            onPreviewMarkdown({ linkId: item.linkId!, title: label, subtitle: item.filePath });
          }
        }}
      >
        {label}
      </Typography.Link>
    );
  }
  if (!item.href) return <Typography.Text>{label}</Typography.Text>;

  return (
    <LinkDisplayTargetLink item={item} onClick={(event) => event.stopPropagation()}>
      {label}
    </LinkDisplayTargetLink>
  );
}

export const LinkDisplayList: React.FC<LinkDisplayListProps> = ({
  items,
  emptyDescription = 'No links yet',
  compact = false,
  showPinActions = false,
  pinActionDisabled = false,
  pinningLinkId = null,
  onTogglePinned,
  getAssistantActionState,
  onPromoteToAssistant,
  onRemoveFromAssistant,
}) => {
  const { token } = theme.useToken();
  const { showError } = useThemedMessage();
  const [imagePreviewTarget, setImagePreviewTarget] = useState<LinkImagePreviewTarget | null>(null);
  const [markdownPreviewTarget, setMarkdownPreviewTarget] =
    useState<LinkMarkdownPreviewTarget | null>(null);

  const handleDownload = (item: LinkDisplayItem) => {
    if (!item.linkId) return;
    downloadLinkContent(item.linkId, getCompactLinkDisplayName(item)).catch((error) => {
      showError(error instanceof Error ? error.message : 'Download failed');
    });
  };

  if (items.length === 0) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyDescription} />;
  }

  return (
    <>
      <List
        size={compact ? 'small' : 'default'}
        dataSource={items}
        split={!compact}
        renderItem={(item) => {
          const secondary = getLinkDisplaySecondaryLabel(item);
          const canTogglePin = showPinActions && Boolean(item.linkId) && onTogglePinned;
          const assistantAction = getAssistantActionState?.(item) ?? null;
          const actions: React.ReactNode[] = [];
          if (canTogglePin) {
            actions.push(
              <Tooltip
                key="pin"
                title={item.isPinned ? 'Unpin from quick links' : 'Pin to quick links'}
              >
                <Button
                  type="text"
                  size="small"
                  aria-label={item.isPinned ? `Unpin ${item.name}` : `Pin ${item.name}`}
                  icon={item.isPinned ? <PushpinFilled /> : <PushpinOutlined />}
                  disabled={pinActionDisabled}
                  loading={pinningLinkId === item.linkId}
                  onClick={(event) => {
                    event.stopPropagation();
                    onTogglePinned?.(item);
                  }}
                />
              </Tooltip>
            );
          }
          if (assistantAction) {
            const itemKey = assistantAction.isPromoted ? 'remove-assistant' : 'promote-assistant';
            actions.push(
              <Dropdown
                key="assistant"
                trigger={['click']}
                menu={{
                  items: [
                    {
                      key: itemKey,
                      label: assistantAction.isPromoted
                        ? 'Remove from assistant'
                        : 'Promote to assistant',
                      disabled: assistantAction.disabled || assistantAction.loading,
                    },
                  ],
                  onClick: ({ domEvent }) => {
                    domEvent.stopPropagation();
                    if (assistantAction.disabled || assistantAction.loading) return;
                    if (assistantAction.isPromoted && assistantAction.assistantLinkId) {
                      onRemoveFromAssistant?.(item, assistantAction.assistantLinkId);
                    } else {
                      onPromoteToAssistant?.(item);
                    }
                  },
                }}
              >
                <Button
                  type="text"
                  size="small"
                  aria-label={`Assistant actions for ${item.name}`}
                  icon={<EllipsisOutlined />}
                  loading={assistantAction.loading}
                  disabled={assistantAction.disabled}
                  onClick={(event) => event.stopPropagation()}
                />
              </Dropdown>
            );
          }
          return (
            <List.Item
              key={item.key}
              style={{ padding: compact ? '6px 0' : undefined }}
              actions={actions.length > 0 ? actions : undefined}
            >
              <List.Item.Meta
                avatar={
                  <Tag
                    color={item.isPinned ? 'processing' : 'default'}
                    style={{ minWidth: 42, textAlign: 'center', marginInlineEnd: 0 }}
                  >
                    {getLinkDisplayGlyphLabel(item.category)}
                  </Tag>
                }
                title={
                  <Space size={6} wrap>
                    <LinkTitle
                      item={item}
                      onPreviewImage={setImagePreviewTarget}
                      onPreviewMarkdown={setMarkdownPreviewTarget}
                      onDownload={handleDownload}
                    />
                    {item.isPinned && <PushpinFilled style={{ color: token.colorPrimary }} />}
                  </Space>
                }
                description={
                  <Space size={6} wrap>
                    <Tag>{getLinkDisplayPillLabel(item.category)}</Tag>
                    <Tag>{item.ownerScope === 'branch' ? 'Branch link' : 'This session'}</Tag>
                    {secondary && (
                      <Typography.Text type="secondary" ellipsis style={{ maxWidth: 360 }}>
                        {secondary}
                      </Typography.Text>
                    )}
                    {!item.href && (item.url || item.refUri) && (
                      <Tooltip title="This target is not directly openable from the UI.">
                        <LinkOutlined style={{ color: token.colorTextTertiary }} />
                      </Tooltip>
                    )}
                  </Space>
                }
              />
            </List.Item>
          );
        }}
      />
      <LinkImagePreviewModal
        target={imagePreviewTarget}
        onClose={() => setImagePreviewTarget(null)}
      />
      <LinkMarkdownPreviewModal
        target={markdownPreviewTarget}
        onClose={() => setMarkdownPreviewTarget(null)}
      />
    </>
  );
};

export default LinkDisplayList;
