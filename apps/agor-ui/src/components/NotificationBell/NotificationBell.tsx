import type { Notification } from '@agor-live/client';
import {
  BellOutlined,
  CloseOutlined,
  CommentOutlined,
  DeleteOutlined,
  RobotOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { Badge, Button, Empty, Popover, Space, Tooltip, Typography, theme } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { formatAbsoluteTime, formatRelativeTime } from '../../utils/time';

const { Text } = Typography;

const PANEL_MAX_ITEMS = 20;

export interface NotificationBellProps {
  notifications: Notification[];
  unreadCount: number;
  /** Called when the popover opens with unread items — stamps read_at on all. */
  onMarkAllRead: () => void;
  /** "Clear" button — hard-deletes every row currently in the panel. */
  onClear: () => void;
  /** Per-row dismiss (×) — hard-delete that row. */
  onDismiss: (notificationId: string) => void;
  /** Per-row click — navigation only; rows are already read by panel-open. */
  onOpen?: (notification: Notification) => void;
  /** Disabled state (mutation blocked, e.g. anonymous). */
  disabled?: boolean;
}

/**
 * Bell with badge counter + popover panel.
 * Lives on the AppHeader right side, between Facepile and Live Event Stream.
 *
 * Per design doc §3.2:
 * - Opening the panel marks every unread row read (open ≈ seen ≈ read).
 * - Per-row click navigates (no extra state — already read).
 * - Per-row × hard-deletes that row.
 * - Header "Clear" button hard-deletes everything in the panel (no confirm).
 *
 * No hover-to-mark-read timer (overthinking) and no per-type colored accent
 * stripes (variant-creep) — the icon is the type signifier.
 */
export const NotificationBell: React.FC<NotificationBellProps> = ({
  notifications,
  unreadCount,
  onMarkAllRead,
  onClear,
  onDismiss,
  onOpen,
  disabled,
}) => {
  const { token } = theme.useToken();
  const [open, setOpen] = useState(false);

  // Open the panel → mark every unread row read. Reads `unreadCount` and
  // `onMarkAllRead` via a ref so this effect only re-runs on the open
  // transition, not whenever unreadCount ticks down.
  const openHandlerRef = useRef<() => void>(() => {});
  openHandlerRef.current = () => {
    if (unreadCount > 0) onMarkAllRead();
  };
  useEffect(() => {
    if (open) openHandlerRef.current();
  }, [open]);

  const hasUserMention = notifications.some((n) => n.type === 'mention' && !n.read_at);

  const visible = notifications.slice(0, PANEL_MAX_ITEMS);

  const content = (
    <div style={{ width: 380, maxHeight: 460, display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingBottom: token.paddingSM,
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
        }}
      >
        <Text strong>Notifications</Text>
        <Button
          type="text"
          size="small"
          danger
          icon={<DeleteOutlined />}
          disabled={visible.length === 0}
          onClick={(e) => {
            e.stopPropagation();
            onClear();
          }}
        >
          Clear
        </Button>
      </div>

      <div style={{ overflowY: 'auto', flex: 1, paddingTop: token.paddingXS }}>
        {visible.length === 0 ? (
          <Empty
            style={{ padding: token.paddingLG }}
            image={<BellOutlined style={{ fontSize: 48, color: token.colorTextTertiary }} />}
            imageStyle={{ height: 60 }}
            description={
              <div>
                <Text type="secondary">You&apos;re all caught up.</Text>
                <br />
                <Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
                  Notifications about sessions you&apos;re working on, mentions, and announcements
                  appear here.
                </Text>
              </div>
            }
          />
        ) : (
          <Space direction="vertical" size={0} style={{ width: '100%' }}>
            {visible.map((n) => (
              <NotificationCard
                key={n.notification_id}
                notification={n}
                onDismiss={() => onDismiss(n.notification_id)}
                onClick={() => {
                  onOpen?.(n);
                  setOpen(false);
                }}
              />
            ))}
          </Space>
        )}
      </div>
    </div>
  );

  return (
    <Popover
      content={content}
      trigger="click"
      placement="bottomRight"
      open={open}
      onOpenChange={setOpen}
      destroyTooltipOnHide
    >
      <Badge
        count={unreadCount}
        offset={[-2, 2]}
        overflowCount={99}
        style={{
          backgroundColor: hasUserMention ? token.colorError : token.colorPrimaryBgHover,
        }}
      >
        <Tooltip title="Notifications" placement="bottom">
          <Button
            type="text"
            icon={<BellOutlined style={{ fontSize: token.fontSizeLG }} />}
            aria-label="Open notifications"
            disabled={disabled}
          />
        </Tooltip>
      </Badge>
    </Popover>
  );
};

// ============================================================================
// NotificationCard — one row in the panel. Single layout for every type.
// ============================================================================

interface NotificationCardProps {
  notification: Notification;
  onDismiss: () => void;
  onClick: () => void;
}

const NotificationCard: React.FC<NotificationCardProps> = ({
  notification,
  onDismiss,
  onClick,
}) => {
  const { token } = theme.useToken();
  const isUnread = !notification.read_at;
  const { icon, label } = getTypeIconAndLabel(notification, token);

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'stretch',
        gap: 0,
        backgroundColor: isUnread ? token.colorPrimaryBg : 'transparent',
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
        position: 'relative',
      }}
    >
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          alignItems: 'flex-start',
          gap: token.paddingSM,
          padding: token.paddingSM,
          textAlign: 'left',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          color: 'inherit',
          font: 'inherit',
        }}
      >
        <span style={{ flexShrink: 0, marginTop: 2 }}>{icon}</span>

        <span style={{ flex: 1, minWidth: 0, display: 'block' }}>
          <span
            style={{
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              gap: token.paddingXS,
            }}
          >
            <Text strong={isUnread} ellipsis style={{ flex: 1, fontSize: token.fontSize }}>
              {notification.title}
            </Text>
            <Tooltip title={formatAbsoluteTime(notification.created_at)} placement="left">
              <Text type="secondary" style={{ fontSize: token.fontSizeSM, whiteSpace: 'nowrap' }}>
                {formatRelativeTime(notification.created_at)}
              </Text>
            </Tooltip>
          </span>

          {notification.preview && (
            <Text
              type="secondary"
              ellipsis
              style={{ display: 'block', fontSize: token.fontSizeSM }}
            >
              {notification.preview}
            </Text>
          )}
        </span>
      </button>

      <Button
        type="text"
        size="small"
        icon={<CloseOutlined />}
        aria-label="Dismiss notification"
        onClick={(e) => {
          e.stopPropagation();
          onDismiss();
        }}
        style={{ margin: token.paddingSM, alignSelf: 'flex-start' }}
      />
    </div>
  );
};

// ============================================================================
// Helpers
// ============================================================================

function getTypeIconAndLabel(
  n: Notification,
  token: ReturnType<typeof theme.useToken>['token']
): { icon: React.ReactNode; label: string } {
  switch (n.type) {
    case 'mention':
      return {
        icon: <CommentOutlined style={{ color: token.colorPrimary, fontSize: 18 }} />,
        label: 'Mention',
      };
    case 'session_returned':
      return {
        icon: <RobotOutlined style={{ color: token.colorSuccess, fontSize: 18 }} />,
        label: 'Session returned',
      };
    case 'global_admin':
      return {
        icon: <WarningOutlined style={{ color: token.colorWarning, fontSize: 18 }} />,
        label: 'Announcement',
      };
    default:
      return {
        icon: <BellOutlined style={{ color: token.colorInfo, fontSize: 18 }} />,
        label: 'Notification',
      };
  }
}
