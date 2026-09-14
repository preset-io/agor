import type { Branch, Session, User } from '@agor-live/client';
import { Empty, List, Typography, theme } from 'antd';
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { getSessionDisplayTitle } from '../../utils/sessionTitle';
import { StatusPill } from '../Pill';
import { MobileHeader } from './MobileHeader';

interface MobileSessionsPageProps {
  sessionById: Map<string, Session>;
  branchById: Map<string, Branch>;
  currentUser?: User | null;
}

const GUTTER = 16;

/**
 * Sessions tab: the caller's active/recent sessions across the workspace, each
 * tagged with the shared StatusPill vocabulary (running agents surface as a
 * processing badge, not colour alone). Tapping a row opens the full-screen
 * session view.
 */
export const MobileSessionsPage: React.FC<MobileSessionsPageProps> = ({
  sessionById,
  branchById,
  currentUser,
}) => {
  const navigate = useNavigate();
  const { token } = theme.useToken();

  const sessions = useMemo(() => {
    const userId = currentUser?.user_id;
    return Array.from(sessionById.values())
      .filter((s) => !s.archived && (!userId || s.created_by === userId))
      .sort((a, b) => (b.last_updated ?? '').localeCompare(a.last_updated ?? ''));
  }, [sessionById, currentUser?.user_id]);

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <MobileHeader title="Sessions" user={currentUser} />
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {sessions.length === 0 ? (
          <Empty
            style={{ marginTop: token.marginXL }}
            description="No sessions yet — ask your primary assistant to get started"
          />
        ) : (
          <List
            dataSource={sessions}
            style={{ paddingInline: GUTTER }}
            renderItem={(session) => {
              const branch = session.branch_id ? branchById.get(session.branch_id) : undefined;
              const subtitle = [branch?.name, session.model_config?.model]
                .filter(Boolean)
                .join(' · ');
              return (
                <List.Item
                  onClick={() => navigate(`/m/session/${session.session_id}`)}
                  style={{ cursor: 'pointer', paddingInline: 0, minHeight: 44 }}
                >
                  <List.Item.Meta
                    title={
                      <Typography.Text ellipsis style={{ maxWidth: '100%' }}>
                        {getSessionDisplayTitle(session, {
                          fallbackChars: 40,
                          includeIdFallback: true,
                        })}
                      </Typography.Text>
                    }
                    description={
                      subtitle ? (
                        <Typography.Text
                          type="secondary"
                          ellipsis
                          style={{ fontSize: token.fontSizeSM }}
                        >
                          {subtitle}
                        </Typography.Text>
                      ) : undefined
                    }
                  />
                  <StatusPill status={session.status} />
                </List.Item>
              );
            }}
          />
        )}
      </div>
    </div>
  );
};
