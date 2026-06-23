import type { Session } from '@agor-live/client';
import { ThunderboltOutlined } from '@ant-design/icons';
import { Button, Tooltip, Typography, theme } from 'antd';
import type React from 'react';
import { getSessionDisplayTitle } from '../../utils/sessionTitle';
import { formatRelativeTime } from '../../utils/time';
import { StatusDot } from './StatusDot';

const { Text } = Typography;

interface JumpBackInSectionProps {
  sessions: Session[];
  onSessionClick: (sessionId: string) => void;
}

const JumpBackInRow: React.FC<{
  session: Session;
  onSessionClick: (id: string) => void;
}> = ({ session, onSessionClick }) => {
  const { token } = theme.useToken();
  const title = getSessionDisplayTitle(session, { includeAgentFallback: true });

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 12px',
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
        cursor: 'pointer',
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
      <Button
        type="primary"
        size="small"
        ghost
        onClick={(e) => {
          e.stopPropagation();
          onSessionClick(session.session_id);
        }}
      >
        Reply
      </Button>
    </div>
  );
};

export const JumpBackInSection: React.FC<JumpBackInSectionProps> = ({
  sessions,
  onSessionClick,
}) => {
  const { token } = theme.useToken();
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <ThunderboltOutlined style={{ color: '#f97316' }} />
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
        }}
      >
        {sessions.map((session) => (
          <JumpBackInRow
            key={session.session_id}
            session={session}
            onSessionClick={onSessionClick}
          />
        ))}
      </div>
    </div>
  );
};
