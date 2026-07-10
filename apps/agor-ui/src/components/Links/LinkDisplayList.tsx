import { EllipsisOutlined, LinkOutlined, PushpinFilled, PushpinOutlined } from '@ant-design/icons';
import { Button, Dropdown, Empty, List, Space, Tag, Tooltip, Typography, theme } from 'antd';
import type React from 'react';
import { LinkDisplayTargetLink } from './LinkDisplayTargetLink';
import {
  getCompactLinkDisplayName,
  getLinkDisplayGlyphLabel,
  getLinkDisplayPillLabel,
  getLinkDisplaySecondaryLabel,
  type LinkDisplayItem,
} from './linkDisplay';

export interface TeammateLinkDisplayActionState {
  isPromoted: boolean;
  teammateLinkId?: string;
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
  getTeammateActionState?: (item: LinkDisplayItem) => TeammateLinkDisplayActionState | null;
  onPromoteToTeammate?: (item: LinkDisplayItem) => void;
  onRemoveFromTeammate?: (item: LinkDisplayItem, teammateLinkId: string) => void;
}

function LinkTitle({ item }: { item: LinkDisplayItem }) {
  const label = getCompactLinkDisplayName(item);
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
  getTeammateActionState,
  onPromoteToTeammate,
  onRemoveFromTeammate,
}) => {
  const { token } = theme.useToken();

  if (items.length === 0) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyDescription} />;
  }

  return (
    <List
      size={compact ? 'small' : 'default'}
      dataSource={items}
      split={!compact}
      renderItem={(item) => {
        const secondary = getLinkDisplaySecondaryLabel(item);
        const canTogglePin = showPinActions && Boolean(item.linkId) && onTogglePinned;
        const teammateAction = getTeammateActionState?.(item) ?? null;
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
        if (teammateAction) {
          const itemKey = teammateAction.isPromoted ? 'remove-teammate' : 'promote-teammate';
          actions.push(
            <Dropdown
              key="teammate"
              trigger={['click']}
              menu={{
                items: [
                  {
                    key: itemKey,
                    label: teammateAction.isPromoted ? 'Remove from teammate' : 'Add to teammate',
                    danger: teammateAction.isPromoted,
                    disabled: teammateAction.disabled || teammateAction.loading,
                  },
                ],
                onClick: ({ domEvent }) => {
                  domEvent.stopPropagation();
                  if (teammateAction.disabled || teammateAction.loading) return;
                  if (teammateAction.isPromoted && teammateAction.teammateLinkId) {
                    onRemoveFromTeammate?.(item, teammateAction.teammateLinkId);
                  } else {
                    onPromoteToTeammate?.(item);
                  }
                },
              }}
            >
              <Button
                type="text"
                size="small"
                aria-label={`Teammate actions for ${item.name}`}
                icon={<EllipsisOutlined />}
                loading={teammateAction.loading}
                disabled={teammateAction.disabled}
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
                  <LinkTitle item={item} />
                  {item.isPinned && <PushpinFilled style={{ color: token.colorPrimary }} />}
                </Space>
              }
              description={
                <Space size={6} wrap>
                  <Tag>{getLinkDisplayPillLabel(item.category)}</Tag>
                  <Tag>{item.ownerScope === 'branch' ? 'Branch' : 'Session'}</Tag>
                  {secondary && (
                    <Typography.Text type="secondary" ellipsis style={{ maxWidth: 360 }}>
                      {secondary}
                    </Typography.Text>
                  )}
                  {!item.href && (item.url || item.refUri) && (
                    <Tooltip title="This saved target is not directly openable from the UI.">
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
  );
};

export default LinkDisplayList;
