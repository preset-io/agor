import type { Session } from '@agor-live/client';
import { PhoneOutlined } from '@ant-design/icons';
import { Badge, Button, Tooltip, Typography, theme } from 'antd';
import type React from 'react';
import { useAppActions } from '../../contexts/AppActionsContext';
import { useAppLiveData } from '../../contexts/AppDataContext';
import { getSessionDisplayTitle } from '../../utils/sessionTitle';

interface CallbackToggleButtonProps {
  session: Session;
}

/**
 * Phone-icon toggle in the conversation footer that shows ONLY when this
 * session has callbacks enabled. Clicking disables callbacks (one click,
 * no confirmation — re-enable lives in Session Settings).
 *
 * Lives in its own component so the `useAppLiveData()` subscription needed
 * to look up the callback-target session's title doesn't pull SessionPanel
 * into the live-data subscription graph (see AppDataContext docs).
 */
export const CallbackToggleButton: React.FC<CallbackToggleButtonProps> = ({ session }) => {
  const { token } = theme.useToken();
  const { onUpdateSession, onSessionClick } = useAppActions();
  const { sessionById } = useAppLiveData();

  const targetId =
    session.callback_config?.callback_session_id ?? session.genealogy?.parent_session_id;
  // Default in core: spawned sessions (have parent_session_id) have callbacks
  // implicitly ON unless explicitly disabled. Only treat as enabled if there's
  // an actual target — there's nothing to call back to otherwise.
  const explicitlyDisabled = session.callback_config?.enabled === false;
  const enabled = !explicitlyDisabled && !!targetId;

  if (!enabled) return null;

  const target = sessionById.get(targetId);
  const targetTitle = target
    ? getSessionDisplayTitle(target, { includeAgentFallback: true, includeIdFallback: true })
    : `${targetId.substring(0, 8)}`;

  const statusBadge = (() => {
    if (!target) return null;
    switch (target.status) {
      case 'running':
        return <Badge status="processing" />;
      case 'completed':
        return <Badge status="success" />;
      case 'failed':
        return <Badge status="error" />;
      case 'timed_out':
        return <Badge status="warning" />;
      default:
        return <Badge status="default" />;
    }
  })();

  const handleDisable = (e: React.MouseEvent) => {
    e.stopPropagation();
    onUpdateSession?.(session.session_id, {
      callback_config: {
        ...session.callback_config,
        enabled: false,
      },
    });
  };

  const handleOpenParent = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onSessionClick?.(targetId);
  };

  const tooltipContent = (
    <span>
      Callbacks on — will notify{' '}
      {onSessionClick && target ? (
        <Typography.Link
          onClick={handleOpenParent}
          style={{ color: token.colorTextLightSolid, textDecoration: 'underline' }}
        >
          <strong>{targetTitle}</strong>
        </Typography.Link>
      ) : (
        <strong>{targetTitle}</strong>
      )}{' '}
      {statusBadge} on completion. Click to disable. Also accessible in session settings.
    </span>
  );

  return (
    <Tooltip title={tooltipContent} mouseLeaveDelay={0.2}>
      <Button
        size="small"
        type="text"
        icon={<PhoneOutlined style={{ color: token.colorPrimary }} />}
        onClick={handleDisable}
        aria-label="Callbacks on — click to disable"
      />
    </Tooltip>
  );
};
