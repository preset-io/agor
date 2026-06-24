import type { Session } from '@agor-live/client';
import { ThunderboltOutlined } from '@ant-design/icons';
import { Tooltip, Typography, theme } from 'antd';
import type React from 'react';
import { useState } from 'react';
import { getSessionDisplayTitle } from '../../utils/sessionTitle';
import { formatRelativeTime } from '../../utils/time';
import { glassCardStyle } from './homeStyles';
import { StatusDot } from './StatusDot';

const { Text } = Typography;

const JUMP_LIMIT = 5;

interface JumpBackInSectionProps {
  sessions: Session[];
  onSessionClick: (sessionId: string) => void;
}

const JumpBackInRow: React.FC<{
  session: Session;
  onSessionClick: (id: string) => void;
}> = ({ session, onSessionClick }) => {
  const { token } = theme.useToken();
  const [focused, setFocused] = useState(false);
  const title = getSessionDisplayTitle(session, { includeAgentFallback: true });

  return (
    <button
      type="button"
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={{
        display: 'flex',
        width: '100%',
        alignItems: 'center',
        gap: 10,
        padding: '8px 12px',
        cursor: 'pointer',
        background: 'none',
        border: 'none',
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
        fontFamily: 'inherit',
        textAlign: 'left',
        outline: focused ? `2px solid ${token.colorPrimary}` : undefined,
        outlineOffset: focused ? -2 : undefined,
      }}
      onClick={() => onSessionClick(session.session_id)}
    >
      <StatusDot status={session.status} />
      <Tooltip title={session.description || title}>
        <Text ellipsis style={{ flex: 1, fontSize: 14, fontWeight: 500, minWidth: 0 }}>
          {title}
        </Text>
      </Tooltip>
      <Text type="secondary" style={{ fontSize: 12, flexShrink: 0, whiteSpace: 'nowrap' }}>
        {formatRelativeTime(session.last_updated)}
      </Text>
    </button>
  );
};

export const JumpBackInSection: React.FC<JumpBackInSectionProps> = ({
  sessions,
  onSessionClick,
}) => {
  const { token } = theme.useToken();
  const visibleSessions = sessions.slice(0, JUMP_LIMIT);
  const hiddenCount = sessions.length - visibleSessions.length;

  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <ThunderboltOutlined style={{ color: token.colorWarning }} />
        <Text strong style={{ fontSize: 14 }}>
          Jump back in — {sessions.length} session{sessions.length !== 1 ? 's' : ''} waiting for
          your reply
        </Text>
      </div>
      <div
        style={{
          border: `1px solid ${token.colorBorderSecondary}`,
          borderRadius: token.borderRadiusLG,
          overflow: 'hidden',
          ...glassCardStyle(token, 0.3),
        }}
      >
        {visibleSessions.map((session) => (
          <JumpBackInRow
            key={session.session_id}
            session={session}
            onSessionClick={onSessionClick}
          />
        ))}
        {hiddenCount > 0 && (
          <div style={{ padding: '8px 12px', textAlign: 'center' }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              and {hiddenCount} more
            </Text>
          </div>
        )}
      </div>
    </div>
  );
};
