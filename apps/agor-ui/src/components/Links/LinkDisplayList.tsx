import { LinkOutlined, PushpinFilled, PushpinOutlined } from '@ant-design/icons';
import { Button, Empty, List, Space, Tag, Tooltip, Typography, theme } from 'antd';
import type React from 'react';
import {
  getCompactLinkDisplayName,
  getLinkDisplayGlyphLabel,
  getLinkDisplayPillLabel,
  getLinkDisplaySecondaryLabel,
  type LinkDisplayItem,
} from './linkDisplay';

interface LinkDisplayListProps {
  items: LinkDisplayItem[];
  emptyDescription?: string;
  compact?: boolean;
  showPinActions?: boolean;
  pinActionDisabled?: boolean;
  pinningLinkId?: string | null;
  onTogglePinned?: (item: LinkDisplayItem) => void;
}

function LinkTitle({ item }: { item: LinkDisplayItem }) {
  const label = getCompactLinkDisplayName(item);
  if (!item.href) return <Typography.Text>{label}</Typography.Text>;

  return (
    <Typography.Link
      href={item.href}
      target={item.navigation === 'external' ? '_blank' : undefined}
      rel={item.navigation === 'external' ? 'noopener noreferrer' : undefined}
      onClick={(event) => event.stopPropagation()}
    >
      {label}
    </Typography.Link>
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
        return (
          <List.Item
            key={item.key}
            style={{ padding: compact ? '6px 0' : undefined }}
            actions={
              canTogglePin
                ? [
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
                    </Tooltip>,
                  ]
                : undefined
            }
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
