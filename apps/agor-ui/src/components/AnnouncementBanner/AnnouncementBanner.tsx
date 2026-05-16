import type { Notification } from '@agor-live/client';
import { CloseOutlined, WarningOutlined } from '@ant-design/icons';
import { Button, Tooltip, Typography, theme } from 'antd';
import { formatAbsoluteTime, formatRelativeTime } from '../../utils/time';

const { Text } = Typography;

const MAX_TITLE_CHARS = 80;

export interface AnnouncementBannerProps {
  notification: Notification | null;
  onDismiss?: (notification: Notification) => void;
}

/**
 * Sticky admin announcement banner — renders in the navbar's center slot when
 * an unexpired `global_admin` notification with `data.banner === true` exists.
 *
 * Per design doc §3.4:
 * - Only one banner shown at a time (caller resolves "most recent wins").
 * - Per-user dismiss is a hard-delete via the notifications service.
 * - Banner respects `expires_at` — caller filters expired rows out.
 * - Title capped at ~80 chars in the navbar; longer content lives in the panel.
 */
export const AnnouncementBanner: React.FC<AnnouncementBannerProps> = ({
  notification,
  onDismiss,
}) => {
  const { token } = theme.useToken();

  if (!notification) return null;

  const title =
    notification.title.length > MAX_TITLE_CHARS
      ? `${notification.title.slice(0, MAX_TITLE_CHARS - 1)}…`
      : notification.title;

  return (
    <output
      aria-live="polite"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: token.paddingSM,
        padding: `${token.paddingXS}px ${token.paddingSM}px`,
        background: token.colorWarningBg,
        border: `1px solid ${token.colorWarningBorder}`,
        borderRadius: token.borderRadius,
        maxWidth: 520,
        overflow: 'hidden',
      }}
    >
      <WarningOutlined style={{ color: token.colorWarning, flexShrink: 0 }} />
      <Tooltip title={notification.preview || notification.title} placement="bottom">
        <Text
          ellipsis
          style={{
            fontSize: token.fontSizeSM,
            color: token.colorWarningText,
            maxWidth: 360,
          }}
        >
          {title}
        </Text>
      </Tooltip>
      <Tooltip title={formatAbsoluteTime(notification.created_at)} placement="bottom">
        <Text
          type="secondary"
          style={{
            fontSize: token.fontSizeSM,
            whiteSpace: 'nowrap',
            flexShrink: 0,
          }}
        >
          {formatRelativeTime(notification.created_at)}
        </Text>
      </Tooltip>
      <Button
        type="text"
        size="small"
        icon={<CloseOutlined />}
        aria-label="Dismiss announcement"
        onClick={() => onDismiss?.(notification)}
      />
    </output>
  );
};
