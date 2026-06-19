import type { AgorClient, Session, User } from '@agor-live/client';
import { CloseOutlined } from '@ant-design/icons';
import { Button, Space, Typography, theme } from 'antd';
import React from 'react';
import { getSessionDisplayTitle } from '../../utils/sessionTitle';
import { ToolIcon } from '../ToolIcon';
import { SessionLatestTaskPeek } from './SessionLatestTaskPeek';

interface BranchSessionPeekSectionProps {
  client: AgorClient | null;
  sessions: Session[];
  userById: Map<string, User>;
  currentUserId?: string;
  branchName?: string;
  onCloseSession: (sessionId: string) => void;
}

export const BranchSessionPeekSection = React.memo<BranchSessionPeekSectionProps>(
  ({ client, sessions, userById, currentUserId, branchName, onCloseSession }) => {
    const { token } = theme.useToken();

    if (sessions.length === 0) return null;

    return (
      <div className="nodrag" style={{ marginTop: token.sizeSM }}>
        <Space size={6} align="baseline" style={{ marginBottom: token.sizeXS }}>
          <Typography.Text strong>Peek</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {sessions.length} session{sessions.length === 1 ? '' : 's'}
          </Typography.Text>
        </Space>

        <div style={{ display: 'flex', flexDirection: 'column', gap: token.sizeSM }}>
          {sessions.map((session) => (
            <section
              key={session.session_id}
              style={{
                borderTop: `1px solid ${token.colorBorderSecondary}`,
                paddingTop: token.sizeSM,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: token.sizeSM,
                  marginBottom: token.sizeXS,
                }}
              >
                <Space size={6} align="center" style={{ minWidth: 0 }}>
                  <ToolIcon tool={session.agentic_tool} size={16} />
                  <Typography.Text ellipsis style={{ maxWidth: 480, fontSize: 12 }}>
                    {getSessionDisplayTitle(session, { includeAgentFallback: true })}
                  </Typography.Text>
                </Space>
                <Button
                  className="nodrag nopan"
                  type="text"
                  size="small"
                  icon={<CloseOutlined />}
                  onClick={() => onCloseSession(session.session_id)}
                  title="Stop peeking this session"
                />
              </div>

              <SessionLatestTaskPeek
                client={client}
                session={session}
                userById={userById}
                currentUserId={currentUserId}
                branchName={branchName}
                enabled={true}
              />
            </section>
          ))}
        </div>
      </div>
    );
  }
);

BranchSessionPeekSection.displayName = 'BranchSessionPeekSection';
