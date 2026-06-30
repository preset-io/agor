import type { Session } from '@agor-live/client';
import { shortId } from '@agor-live/client';
import { ArrowUpOutlined, LinkOutlined } from '@ant-design/icons';
import { Badge, Button, Tooltip, Typography, theme } from 'antd';
import type React from 'react';
import { useAppActions } from '../../contexts/AppActionsContext';
import { useAgorStore } from '../../store/agorStore';
import { selectSessionById } from '../../store/selectors';
import { getSessionDisplayTitle } from '../../utils/sessionTitle';

interface CallbackToggleButtonProps {
  session: Session;
}

function getRemoteCreateRelationship(session: Session) {
  return session.remote_relationships?.as_target?.find(
    (relationship) => relationship.relationship_type === 'remote_create'
  );
}

function getRemoteParentSessionId(session: Session): string | undefined {
  return getRemoteCreateRelationship(session)?.source_session_id;
}

function getCallbackTargetSessionId(session: Session): string | undefined {
  const relationship = getRemoteCreateRelationship(session);
  return (
    session.callback_config?.callback_session_id ??
    relationship?.callback_session_id ??
    getRemoteParentSessionId(session) ??
    session.genealogy?.parent_session_id
  );
}

function getCallbackEnabled(session: Session): boolean {
  return (
    session.callback_config?.enabled ??
    getRemoteCreateRelationship(session)?.callback_enabled ??
    true
  );
}

/**
 * Link-icon toggle in the conversation footer that shows ONLY when this
 * session has callbacks enabled. Clicking disables callbacks (one click,
 * no confirmation — re-enable lives in Session Settings).
 *
 * Lives in its own component so the `sessionById` store subscription needed
 * to look up the callback-target session's title doesn't pull SessionPanel
 * into the live-data subscription graph.
 */
export const CallbackToggleButton: React.FC<CallbackToggleButtonProps> = ({ session }) => {
  const { token } = theme.useToken();
  const { onUpdateSession, onSessionClick } = useAppActions();
  const sessionById = useAgorStore(selectSessionById);

  const targetId = getCallbackTargetSessionId(session);
  // Default in core: spawned sessions (have parent_session_id) have callbacks
  // implicitly ON unless explicitly disabled. Only treat as enabled if there's
  // an actual target — there's nothing to call back to otherwise.
  const enabled = getCallbackEnabled(session) && !!targetId;

  if (!enabled) return null;

  const target = sessionById.get(targetId);
  const targetTitle = target
    ? getSessionDisplayTitle(target, { includeAgentFallback: true, includeIdFallback: true })
    : `${shortId(targetId)}`;

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
      {statusBadge} on completion. Click to unlink callbacks while keeping the relationship. Also
      accessible in session settings.
    </span>
  );

  return (
    <Tooltip title={tooltipContent} mouseLeaveDelay={0.2}>
      <Button
        size="small"
        type="text"
        icon={<LinkOutlined style={{ color: token.colorPrimary }} />}
        onClick={handleDisable}
        aria-label="Callbacks linked — click to unlink"
      />
    </Tooltip>
  );
};

export const RemoteParentButton: React.FC<CallbackToggleButtonProps> = ({ session }) => {
  const { token } = theme.useToken();
  const { onSessionClick } = useAppActions();
  const sessionById = useAgorStore(selectSessionById);

  const remoteParentId = getRemoteParentSessionId(session);
  if (!remoteParentId || !onSessionClick) return null;

  const remoteParent = sessionById.get(remoteParentId);
  const remoteParentTitle = remoteParent
    ? getSessionDisplayTitle(remoteParent, { includeAgentFallback: true, includeIdFallback: true })
    : shortId(remoteParentId);

  const handleOpenRemoteParent = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onSessionClick(remoteParentId);
  };

  return (
    <Tooltip title={`Open remote parent session: ${remoteParentTitle}`}>
      <Button
        size="small"
        type="text"
        icon={<ArrowUpOutlined style={{ color: token.colorTextSecondary }} />}
        onClick={handleOpenRemoteParent}
        aria-label={`Open remote parent session ${remoteParentTitle}`}
      />
    </Tooltip>
  );
};
