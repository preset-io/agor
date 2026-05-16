import type { Notification } from '@agor-live/client';
import {
  BellOutlined,
  CheckOutlined,
  CloseOutlined,
  CommentOutlined,
  RobotOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { Badge, Button, Empty, Popover, Space, Tooltip, Typography, theme } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { formatAbsoluteTime, formatRelativeTime } from '../../utils/time';
import { ToolIcon } from '../ToolIcon';

const { Text } = Typography;

const HOVER_MARK_READ_DELAY_MS = 1500;
const PANEL_MAX_ITEMS = 20;

export interface NotificationBellProps {
  notifications: Notification[];
  unreadCount: number;
  onMarkRead: (notificationId: string) => void;
  onDismiss: (notificationId: string) => void;
  onMarkAllRead: () => void;
  /** Optional click-through handler — receives the notification so the host can route. */
  onOpen?: (notification: Notification) => void;
  /** Disabled state (mutation blocked, e.g. anonymous). */
  disabled?: boolean;
}

/**
 * Bell with badge counter + popover panel.
 * Lives on the AppHeader right side, between Facepile and Live Event Stream.
 *
 * Mark-read semantics:
 * - Hovering an item for 1.5s OR clicking it marks read (Linear-style).
 * - Dismiss is hard-delete (server-side).
 * - "Mark all read" affordance in the popover header.
 */
export const NotificationBell: React.FC<NotificationBellProps> = ({
  notifications,
  unreadCount,
  onMarkRead,
  onDismiss,
  onMarkAllRead,
  onOpen,
  disabled,
}) => {
  const { token } = theme.useToken();
  const [open, setOpen] = useState(false);

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
          icon={<CheckOutlined />}
          disabled={unreadCount === 0}
          onClick={(e) => {
            e.stopPropagation();
            onMarkAllRead();
          }}
        >
          Mark all read
        </Button>
      </div>

      <div style={{ overflowY: 'auto', flex: 1, paddingTop: token.paddingXS }}>
        {visible.length === 0 ? (
          <Empty
            style={{ padding: token.paddingLG }}
            image={
              <BellOutlined style={{ fontSize: 48, color: token.colorTextTertiary }} />
            }
            imageStyle={{ height: 60 }}
            description={
              <div>
                <Text type="secondary">You&apos;re all caught up.</Text>
                <br />
                <Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
                  Notifications about sessions you&apos;re working on, mentions, and
                  announcements appear here.
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
                onMarkRead={() => onMarkRead(n.notification_id)}
                onDismiss={() => onDismiss(n.notification_id)}
                onClick={() => {
                  onMarkRead(n.notification_id);
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
// NotificationCard — one row in the panel
// ============================================================================

interface NotificationCardProps {
  notification: Notification;
  onMarkRead: () => void;
  onDismiss: () => void;
  onClick: () => void;
}

const NotificationCard: React.FC<NotificationCardProps> = ({
  notification,
  onMarkRead,
  onDismiss,
  onClick,
}) => {
  const { token } = theme.useToken();
  const isUnread = !notification.read_at;

  // Hover-1.5s → mark read.
  const handleMouseEnter = () => {
    if (!isUnread) return;
    hoverTimerRef.current = setTimeout(onMarkRead, HOVER_MARK_READ_DELAY_MS);
  };
  const handleMouseLeave = () => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  };

  // Keep timer alive across re-renders.
  const hoverTimerRef = useHoverTimer();

  const { icon, stripeColor, label } = getVariant(notification, token);

  return (
    <div
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: token.paddingSM,
        padding: token.paddingSM,
        borderLeft: `3px solid ${stripeColor}`,
        backgroundColor: isUnread ? token.colorPrimaryBg : 'transparent',
        cursor: 'pointer',
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
        position: 'relative',
      }}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      role="button"
      tabIndex={0}
    >
      <div style={{ flexShrink: 0, marginTop: 2 }}>{icon}</div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            gap: token.paddingXS,
          }}
        >
          <Text
            strong={isUnread}
            ellipsis
            style={{ flex: 1, fontSize: token.fontSize }}
            aria-label={label}
          >
            {notification.title}
          </Text>
          <Tooltip title={formatAbsoluteTime(notification.created_at)} placement="left">
            <Text
              type="secondary"
              style={{ fontSize: token.fontSizeSM, whiteSpace: 'nowrap' }}
            >
              {formatRelativeTime(notification.created_at)}
            </Text>
          </Tooltip>
        </div>

        {notification.preview && (
          <Text
            type="secondary"
            ellipsis
            style={{ display: 'block', fontSize: token.fontSizeSM }}
          >
            {notification.preview}
          </Text>
        )}

        {notification.data?.agentic_tool && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              marginTop: 2,
              color: token.colorTextTertiary,
              fontSize: token.fontSizeSM,
            }}
          >
            <ToolIcon tool={notification.data.agentic_tool} size={14} />
            <span>{notification.data.agentic_tool}</span>
            {typeof notification.data.message_count === 'number' && (
              <span>· {notification.data.message_count} messages</span>
            )}
          </div>
        )}
      </div>

      <Button
        type="text"
        size="small"
        icon={<CloseOutlined />}
        aria-label="Dismiss notification"
        onClick={(e) => {
          e.stopPropagation();
          onDismiss();
        }}
        style={{ marginLeft: token.paddingXS }}
      />
    </div>
  );
};

// ============================================================================
// Helpers
// ============================================================================

function getVariant(
  n: Notification,
  token: ReturnType<typeof theme.useToken>['token']
): { icon: React.ReactNode; stripeColor: string; label: string } {
  switch (n.type) {
    case 'mention':
      return {
        icon: <CommentOutlined style={{ color: token.colorPrimary, fontSize: 18 }} />,
        stripeColor: token.colorPrimary,
        label: 'Mention',
      };
    case 'session_returned':
      return {
        icon: <RobotOutlined style={{ color: token.colorSuccess, fontSize: 18 }} />,
        stripeColor: token.colorSuccess,
        label: 'Session returned',
      };
    case 'global_admin':
      return {
        icon: <WarningOutlined style={{ color: token.colorWarning, fontSize: 18 }} />,
        stripeColor: token.colorWarning,
        label: 'Announcement',
      };
    default:
      return {
        icon: <BellOutlined style={{ color: token.colorInfo, fontSize: 18 }} />,
        stripeColor: token.colorInfo,
        label: 'Notification',
      };
  }
}

function useHoverTimer(): React.MutableRefObject<ReturnType<typeof setTimeout> | null> {
  const ref = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (ref.current) clearTimeout(ref.current);
    };
  }, []);
  return ref;
}
