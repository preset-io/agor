import type { Session } from '@agor-live/client';
import { Typography, theme } from 'antd';
import type React from 'react';

export type SessionForIds = Pick<Session, 'session_id' | 'sdk_session_id' | 'agentic_tool'>;

export interface SessionIdsListProps {
  session: SessionForIds;
}

interface IdRowProps {
  label: string;
  id: string;
}

const IdRow: React.FC<IdRowProps> = ({ label, id }) => {
  const { token } = theme.useToken();
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        gap: 8,
        padding: '2px 0',
      }}
    >
      <span
        style={{
          minWidth: 84,
          flexShrink: 0,
          color: token.colorTextSecondary,
          fontSize: '0.85em',
        }}
      >
        {label}
      </span>
      <Typography.Text
        copyable={{ text: id, tooltips: ['Copy', 'Copied!'] }}
        style={{
          fontFamily: token.fontFamilyCode,
          fontSize: '0.85em',
          wordBreak: 'break-all',
        }}
      >
        {id}
      </Typography.Text>
    </div>
  );
};

/**
 * Compact rows showing the session's Agor ID + agentic-tool SDK ID with
 * inline copy buttons (AntD Typography.Text copyable). Shared by the
 * SessionIdsButton popover, SessionSettingsModal, and SessionMetadataCard.
 */
export const SessionIdsList: React.FC<SessionIdsListProps> = ({ session }) => (
  <div>
    <IdRow label="Agor" id={session.session_id} />
    {session.sdk_session_id && (
      <IdRow label={session.agentic_tool || 'SDK'} id={session.sdk_session_id} />
    )}
  </div>
);
