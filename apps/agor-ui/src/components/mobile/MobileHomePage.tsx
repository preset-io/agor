import type { Board, Branch, Session, User } from '@agor-live/client';
import { RightOutlined, RobotOutlined } from '@ant-design/icons';
import { Button, Empty, Flex, List, Typography, theme } from 'antd';
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { MOBILE_TOUCH_TARGET } from '../../utils/deviceDetection';
import { isOwnActiveSession, sortSessions } from '../../utils/sessionSearch';
import { getBoardEmoji } from '../BoardTile';
import { GlassPanel } from '../GlassSurface/GlassPanel';
import { JumpBackInSection } from '../HomePage/JumpBackInSection';
import { mobilePageStyle, mobileScrollAreaStyle } from './constants';
import { MobileHeader } from './MobileHeader';
import { MobileListRow } from './MobileListRow';
import { MobileSessionRow } from './MobileSessionRow';

interface MobileHomePageProps {
  sessionById: Map<string, Session>;
  branchById: Map<string, Branch>;
  boardById: Map<string, Board>;
  currentUser?: User | null;
  onAsk: () => void;
  /** A session is being created for Ask; the button shows it and refuses a repeated tap. */
  askPending?: boolean;
  primaryTeammateName?: string;
  primaryTeammateEmoji?: string;
  /** Number of the primary assistant's own sessions (shown on the hero). */
  assistantSessionCount?: number;
  /** Opens the assistant's session list; when set, the hero body becomes tappable. */
  onOpenAssistantSessions?: () => void;
  /** Unread comments count for the header bell. */
  commentsBadge?: number;
  /** Opens comments/mentions from the header bell. */
  onOpenComments?: () => void;
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
  askPending,
  primaryTeammateName,
  primaryTeammateEmoji,
  assistantSessionCount,
  onOpenAssistantSessions,
  commentsBadge,
  onOpenComments,
}) => {
  const navigate = useNavigate();
  const { token } = theme.useToken();

  const recent = useMemo(() => {
    const own = Array.from(sessionById.values()).filter((s) =>
      isOwnActiveSession(s, currentUser?.user_id)
    );
    return sortSessions(own, 'recent').slice(0, RECENT_LIMIT);
  }, [sessionById, currentUser?.user_id]);

  const boards = useMemo(
    () => Array.from(boardById.values()).filter((b) => !b.archived),
    [boardById]
  );

  const greetingName = currentUser?.name?.split(' ')[0];
  const askName = primaryTeammateName ?? 'your primary assistant';

  // One inner padding for every card (header + body) so titles, rows, and the
  // Ask hero content all line up on a single left edge. The outer 16px gutter
  // lives once on the scroll Flex; rows inside defer to the body (paddingInline
  // 0) instead of adding a second inset.
  const cardStyles = {
    header: { paddingInline: token.padding },
    body: { padding: token.padding },
  } as const;

  const heroContent = (
    <>
      <span style={{ fontSize: token.fontSizeHeading2, lineHeight: 1 }}>
        {primaryTeammateEmoji ?? <RobotOutlined />}
      </span>
      <Flex vertical style={{ flex: 1, minWidth: 0 }}>
        <Typography.Text strong>Ask {askName}</Typography.Text>
        <Typography.Text type="secondary" ellipsis style={{ fontSize: token.fontSizeSM }}>
          {assistantSessionCount && assistantSessionCount > 0
            ? `${assistantSessionCount} session${assistantSessionCount === 1 ? '' : 's'} · tap to view`
            : 'Kick off a task, ask a question, or get help.'}
        </Typography.Text>
      </Flex>
    </>
  );

  return (
    <div style={mobilePageStyle}>
      <MobileHeader
        title={greetingName ? `Welcome back, ${greetingName}` : 'Home'}
        onSearch={() => navigate('/m/search')}
        commentsBadge={commentsBadge}
        onOpenComments={onOpenComments}
      />
      <div
        style={{
          ...mobileScrollAreaStyle,
          paddingBlock: token.paddingMD,
          paddingBottom: `calc(${token.paddingXL}px + env(safe-area-inset-bottom))`,
        }}
      >
        <Flex vertical gap={token.marginLG} style={{ paddingInline: token.padding }}>
          {/* Ask primary assistant hero */}
          <GlassPanel
            size="small"
            blur={false}
            highlights={{ intensity: 'subtle' }}
            styles={cardStyles}
          >
            <Flex align="center" gap={token.margin}>
              {/* Body opens the assistant's session list; the Ask button stays
                  the quick-compose action. */}
              {onOpenAssistantSessions ? (
                <button
                  type="button"
                  aria-label={`View ${askName}'s sessions`}
                  onClick={onOpenAssistantSessions}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: token.margin,
                    flex: 1,
                    minWidth: 0,
                    minHeight: MOBILE_TOUCH_TARGET,
                    cursor: 'pointer',
                    background: 'none',
                    border: 'none',
                    padding: 0,
                    textAlign: 'left',
                    font: 'inherit',
                    color: 'inherit',
                  }}
                >
                  {heroContent}
                  <RightOutlined aria-hidden style={{ color: token.colorTextTertiary }} />
                </button>
              ) : (
                <Flex align="center" gap={token.margin} style={{ flex: 1, minWidth: 0 }}>
                  {heroContent}
                </Flex>
              )}
              <Button
                type="primary"
                onClick={onAsk}
                loading={askPending}
                style={{ minHeight: MOBILE_TOUCH_TARGET }}
              >
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
            blur={false}
            title="Recent sessions"
            extra={
              recent.length > 0 ? (
                <Button
                  type="link"
                  size="small"
                  onClick={() => navigate('/m/sessions')}
                  style={{ minHeight: MOBILE_TOUCH_TARGET }}
                >
                  All sessions
                </Button>
              ) : undefined
            }
            styles={cardStyles}
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
            <GlassPanel size="small" blur={false} title="Your boards" styles={cardStyles}>
              <List
                dataSource={boards}
                renderItem={(board) => (
                  <MobileListRow
                    title={board.name}
                    ariaLabel={`Open ${board.name}`}
                    onPress={() => navigate(`/m/board/${board.board_id}`)}
                    avatar={
                      <span aria-hidden style={{ fontSize: token.fontSizeHeading4 }}>
                        {getBoardEmoji(board, branchById)}
                      </span>
                    }
                    trailing={
                      <RightOutlined aria-hidden style={{ color: token.colorTextTertiary }} />
                    }
                  />
                )}
              />
            </GlassPanel>
          )}
        </Flex>
      </div>
    </div>
  );
};
