import type { Session } from '@agor-live/client';
import { LinkOutlined, PhoneOutlined } from '@ant-design/icons';
import { Badge, Space, Typography, theme } from 'antd';
import type React from 'react';
import { useAppActions } from '../../contexts/AppActionsContext';
import { useAppLiveData } from '../../contexts/AppDataContext';
import { getSessionDisplayTitle } from '../../utils/sessionTitle';

interface CallbackTargetDisplayProps {
  session: Session;
  /** Called after the user clicks the parent link, so the host modal can close. */
  onNavigate?: () => void;
}

function statusBadgeStatus(
  status: string
): 'processing' | 'success' | 'error' | 'warning' | 'default' {
  switch (status) {
    case 'running':
      return 'processing';
    case 'completed':
      return 'success';
    case 'failed':
      return 'error';
    case 'timed_out':
      return 'warning';
    default:
      return 'default';
  }
}

/**
 * Inline display of a session's callback target (parent / explicit
 * callback_session_id). Renders inside the Callbacks panel of the
 * Session Settings modal. Hidden when there is no target at all.
 */
export const CallbackTargetDisplay: React.FC<CallbackTargetDisplayProps> = ({
  session,
  onNavigate,
}) => {
  const { token } = theme.useToken();
  const { onSessionClick } = useAppActions();
  const { sessionById } = useAppLiveData();

  const targetId =
    session.callback_config?.callback_session_id ?? session.genealogy?.parent_session_id;

  if (!targetId) return null;

  const target = sessionById.get(targetId);
  // Mirror CallbackToggleButton's resolution: spawned sessions default to
  // enabled unless explicitly disabled.
  const enabled = session.callback_config?.enabled !== false;
  const archived = target?.archived === true;

  const targetTitle = target
    ? getSessionDisplayTitle(target, { includeAgentFallback: true, includeIdFallback: true })
    : `${targetId.substring(0, 8)} (not loaded)`;

  const handleOpen = (e: React.MouseEvent) => {
    e.preventDefault();
    if (!onSessionClick) return;
    onSessionClick(targetId);
    onNavigate?.();
  };

  const targetLink = onSessionClick ? (
    <Typography.Link onClick={handleOpen}>
      <LinkOutlined style={{ marginRight: 4 }} />
      <strong>{targetTitle}</strong>
    </Typography.Link>
  ) : (
    <strong>{targetTitle}</strong>
  );

  const statusText = archived ? 'archived' : target?.status;
  const borderColor = enabled ? token.colorPrimaryBorder : token.colorBorder;
  const bg = enabled ? token.colorPrimaryBg : token.colorFillTertiary;
  const iconColor = enabled ? token.colorPrimary : token.colorTextSecondary;

  return (
    <div
      style={{
        marginBottom: 12,
        padding: `${token.sizeUnit * 2}px ${token.sizeUnit * 3}px`,
        border: `1px solid ${borderColor}`,
        background: bg,
        borderRadius: token.borderRadius,
      }}
    >
      <Space size={6} wrap>
        <PhoneOutlined style={{ color: iconColor }} />
        <Typography.Text strong style={{ color: iconColor }}>
          Callbacks {enabled ? 'ON' : 'OFF'}
        </Typography.Text>
        <Typography.Text type="secondary">
          {' — '}
          {enabled ? 'notifying' : 'would notify'}
        </Typography.Text>
        {targetLink}
        {target && (
          <Space size={4}>
            <Badge status={statusBadgeStatus(target.status)} />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {statusText}
            </Typography.Text>
          </Space>
        )}
      </Space>
    </div>
  );
};
