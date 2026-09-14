import type { Board, Branch, Session, User } from '@agor-live/client';
import { RightOutlined, RobotOutlined } from '@ant-design/icons';
import { Button, Card, Empty, Flex, List, Typography, theme } from 'antd';
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { getSessionStatusTone } from '../../utils/sessionStatus';
import { getBoardEmoji } from '../BoardTile';
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

const JUMP_BACK_LIMIT = 5;
const NEEDS_YOU_LIMIT = 3;

/**
 * Home landing: a thin composition of existing pieces. It owns no session/board
 * data logic; it reads the same store maps the rest of the shell uses and
 * renders the shared MobileSessionRow, the Ask-primary flow, and board rows.
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

  const mySessions = useMemo(() => {
    const userId = currentUser?.user_id;
    return Array.from(sessionById.values())
      .filter((s) => !s.archived && (!userId || s.created_by === userId))
      .sort((a, b) => (b.last_updated ?? '').localeCompare(a.last_updated ?? ''));
  }, [sessionById, currentUser?.user_id]);

  // "Needs you": a running/awaiting agent (processing) or one that failed.
  const needsYou = useMemo(
    () =>
      mySessions
        .filter((s) => {
          const tone = getSessionStatusTone(s.status);
          return tone === 'processing' || tone === 'warning' || tone === 'error';
        })
        .slice(0, NEEDS_YOU_LIMIT),
    [mySessions]
  );

  const recent = mySessions.slice(0, JUMP_BACK_LIMIT);

  const boards = useMemo(
    () => Array.from(boardById.values()).filter((b) => !b.archived),
    [boardById]
  );

  const greetingName = currentUser?.name?.split(' ')[0];
  const askName = primaryTeammateName ?? 'your primary assistant';

  const sectionHeader = (title: string, action?: { label: string; onClick: () => void }) => (
    <Flex
      justify="space-between"
      align="center"
      style={{ paddingInline: token.padding, marginBottom: token.marginXS }}
    >
      <Typography.Text strong>{title}</Typography.Text>
      {action && (
        <Button type="link" size="small" style={{ paddingInline: 0 }} onClick={action.onClick}>
          {action.label}
        </Button>
      )}
    </Flex>
  );

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
        <Flex vertical gap={token.marginLG}>
          {/* Ask primary assistant */}
          <div style={{ paddingInline: token.padding }}>
            <Card size="small" styles={{ body: { padding: token.padding } }}>
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
            </Card>
          </div>

          {needsYou.length > 0 && (
            <div>
              {sectionHeader('Needs you')}
              <List
                style={{ paddingInline: token.padding }}
                dataSource={needsYou}
                renderItem={(session) => (
                  <MobileSessionRow
                    session={session}
                    branch={session.branch_id ? branchById.get(session.branch_id) : undefined}
                  />
                )}
              />
            </div>
          )}

          <div>
            {sectionHeader(
              'Jump back in',
              recent.length > 0
                ? { label: 'All sessions', onClick: () => navigate('/m/sessions') }
                : undefined
            )}
            {recent.length > 0 ? (
              <List
                style={{ paddingInline: token.padding }}
                dataSource={recent}
                renderItem={(session) => (
                  <MobileSessionRow
                    session={session}
                    branch={session.branch_id ? branchById.get(session.branch_id) : undefined}
                  />
                )}
              />
            ) : (
              <div style={{ paddingInline: token.padding }}>
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={`No sessions yet. Ask ${askName} to get started.`}
                />
              </div>
            )}
          </div>

          {boards.length > 0 && (
            <div>
              {sectionHeader('Your boards')}
              <List
                style={{ paddingInline: token.padding }}
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
                    style={{ cursor: 'pointer', paddingInline: 0, minHeight: 44 }}
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
            </div>
          )}
        </Flex>
      </div>
    </div>
  );
};
