import type { Board, Branch, Session, User } from '@agor-live/client';
import { RightOutlined, RobotOutlined } from '@ant-design/icons';
import { Button, Empty, Flex, List, Typography, theme } from 'antd';
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { getBoardEmoji } from '../BoardTile';
import { GlassPanel } from '../GlassSurface/GlassPanel';
import { JumpBackInSection } from '../HomePage/JumpBackInSection';
import { MobileHeader } from './MobileHeader';
import { MobileSessionRow } from './MobileSessionRow';

interface MobileHomePageProps {
  sessionById: Map<string, Session>;
  branchById: Map<string, Branch>;
  boardById: Map<string, Board>;
  currentUser?: User | null;
  onAsk: () => void;
  primaryTeammateName?: string;
  primaryTeammateEmoji?: string;
}

const RECENT_LIMIT = 5;

/**
 * Home landing: a thin composition of existing pieces. It owns no session/board
 * data logic; it reuses the desktop JumpBackInSection (self-subscribing), the
 * shared MobileSessionRow, board selectors, and the glass surface components.
 */
export const MobileHomePage: React.FC<MobileHomePageProps> = ({
  sessionById,
  branchById,
  boardById,
  currentUser,
  onAsk,
  primaryTeammateName,
  primaryTeammateEmoji,
}) => {
  const navigate = useNavigate();
  const { token } = theme.useToken();

  const recent = useMemo(() => {
    const userId = currentUser?.user_id;
    return Array.from(sessionById.values())
      .filter((s) => !s.archived && (!userId || s.created_by === userId))
      .sort((a, b) => (b.last_updated ?? '').localeCompare(a.last_updated ?? ''))
      .slice(0, RECENT_LIMIT);
  }, [sessionById, currentUser?.user_id]);

  const boards = useMemo(
    () => Array.from(boardById.values()).filter((b) => !b.archived),
    [boardById]
  );

  const greetingName = currentUser?.name?.split(' ')[0];
  const askName = primaryTeammateName ?? 'your primary assistant';

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <MobileHeader
        title={greetingName ? `Welcome back, ${greetingName}` : 'Home'}
        onSearch={() => navigate('/m/search')}
      />
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          paddingBlock: token.paddingMD,
          paddingBottom: `calc(${token.paddingXL}px + env(safe-area-inset-bottom))`,
        }}
      >
        <Flex vertical gap={token.marginLG} style={{ paddingInline: token.padding }}>
          {/* Ask primary assistant hero */}
          <GlassPanel
            size="small"
            highlights={{ intensity: 'subtle' }}
            styles={{ body: { padding: token.padding } }}
          >
            <Flex align="center" gap={token.margin}>
              <span style={{ fontSize: token.fontSizeHeading2, lineHeight: 1 }}>
                {primaryTeammateEmoji ?? <RobotOutlined />}
              </span>
              <Flex vertical style={{ flex: 1, minWidth: 0 }}>
                <Typography.Text strong>Ask {askName}</Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
                  Kick off a task, ask a question, or get help.
                </Typography.Text>
              </Flex>
              <Button type="primary" onClick={onAsk}>
                Ask
              </Button>
            </Flex>
          </GlassPanel>

          {/* Awaiting sessions (reused desktop section; renders nothing when none) */}
          <JumpBackInSection
            currentUserId={currentUser?.user_id}
            onSessionClick={(id) => navigate(`/m/session/${id}`)}
          />

          <GlassPanel
            size="small"
            title="Recent sessions"
            extra={
              recent.length > 0 ? (
                <Button type="link" size="small" onClick={() => navigate('/m/sessions')}>
                  All sessions
                </Button>
              ) : undefined
            }
            styles={{ body: { padding: recent.length > 0 ? 0 : token.padding } }}
          >
            {recent.length > 0 ? (
              <List
                dataSource={recent}
                renderItem={(session) => (
                  <MobileSessionRow
                    session={session}
                    branch={session.branch_id ? branchById.get(session.branch_id) : undefined}
                  />
                )}
              />
            ) : (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={`No sessions yet. Ask ${askName} to get started.`}
              />
            )}
          </GlassPanel>

          {boards.length > 0 && (
            <GlassPanel size="small" title="Your boards" styles={{ body: { padding: 0 } }}>
              <List
                dataSource={boards}
                renderItem={(board) => (
                  <List.Item
                    role="button"
                    tabIndex={0}
                    aria-label={`Open ${board.name}`}
                    onClick={() => navigate(`/m/board/${board.board_id}`)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        navigate(`/m/board/${board.board_id}`);
                      }
                    }}
                    style={{ cursor: 'pointer', paddingInline: token.padding, minHeight: 44 }}
                  >
                    <List.Item.Meta
                      avatar={
                        <span aria-hidden style={{ fontSize: token.fontSizeHeading4 }}>
                          {getBoardEmoji(board, branchById)}
                        </span>
                      }
                      title={
                        <Typography.Text ellipsis style={{ maxWidth: '100%' }}>
                          {board.name}
                        </Typography.Text>
                      }
                    />
                    <RightOutlined aria-hidden style={{ color: token.colorTextTertiary }} />
                  </List.Item>
                )}
              />
            </GlassPanel>
          )}
        </Flex>
      </div>
    </div>
  );
};
