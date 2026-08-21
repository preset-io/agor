import type { Board, BoardComment, Branch, Session, User } from '@agor-live/client';
import { hasMinimumRole, ROLES } from '@agor-live/client';
import {
  ApiOutlined,
  AppstoreOutlined,
  BranchesOutlined,
  BulbOutlined,
  CommentOutlined,
  CreditCardOutlined,
  DownOutlined,
  ExperimentOutlined,
  FolderOutlined,
  InfoCircleOutlined,
  LogoutOutlined,
  MessageOutlined,
  RobotOutlined,
  SettingOutlined,
  TeamOutlined,
  ThunderboltOutlined,
  UserOutlined,
} from '@ant-design/icons';
import type { MenuProps } from 'antd';
import { Badge, Button, Collapse, Divider, Menu, Space, Typography, theme } from 'antd';
import { useNavigate } from 'react-router-dom';
import { mapToArray } from '@/utils/mapHelpers';
import { getSessionDisplayTitle } from '@/utils/sessionTitle';
import { BoardCollapse } from '../BoardCollapse';
import { getBoardEmoji } from '../BoardTile';

const { Text } = Typography;

interface MobileNavTreeProps {
  boardById: Map<string, Board>;
  branchById: Map<string, Branch>;
  sessionsByBranch: Map<string, Session[]>; // O(1) branch filtering
  commentById: Map<string, BoardComment>;
  onNavigate?: () => void;
  onOpenWorkspaceSettings: (section: string) => void;
  onOpenUserSettings: () => void;
  onLogout?: () => void;
  currentUser?: User | null;
}

export const MobileNavTree: React.FC<MobileNavTreeProps> = ({
  boardById,
  branchById,
  sessionsByBranch,
  commentById,
  onNavigate,
  onOpenWorkspaceSettings,
  onOpenUserSettings,
  onLogout,
  currentUser,
}) => {
  const navigate = useNavigate();
  const { token } = theme.useToken();

  const handleSessionClick = (sessionId: string) => {
    navigate(`/m/session/${sessionId}`);
    onNavigate?.();
  };

  const handleCommentsClick = (boardId: string, e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent board collapse toggle
    navigate(`/m/comments/${boardId}`);
    onNavigate?.();
  };

  const handleBoardClick = (boardId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    navigate(`/m/board/${boardId}`);
    onNavigate?.();
  };

  // Count active comments per board (unresolved)
  const getActiveCommentCount = (boardId: string): number => {
    return mapToArray(commentById).filter(
      (c: BoardComment) => c.board_id === boardId && !c.resolved && !c.parent_comment_id
    ).length;
  };

  // Group branches by board
  const branchesByBoard = {} as Record<string, Branch[]>;
  for (const branch of branchById.values()) {
    const boardId = branch.board_id || 'unassigned';
    if (!branchesByBoard[boardId]) {
      branchesByBoard[boardId] = [];
    }
    branchesByBoard[boardId].push(branch);
  }

  // Sort sessions within each branch by last_updated (most recent first)
  // Convert Map to sorted Map for consistent rendering
  const sortedSessionsByBranch = new Map(
    Array.from(sessionsByBranch.entries()).map(([branchId, branchSessions]) => [
      branchId,
      [...branchSessions].sort((a, b) => {
        const aTime = new Date(a.last_updated).getTime();
        const bTime = new Date(b.last_updated).getTime();
        return bTime - aTime; // DESC (most recent first)
      }),
    ])
  );

  // Get session title with mobile-friendly 50-char limit
  const getSessionTitle = (session: Session): string => {
    return getSessionDisplayTitle(session, {
      fallbackChars: 50,
      includeIdFallback: true,
    });
  };

  // Get session status icon
  const getSessionStatusIcon = (session: Session): string => {
    if (session.status === 'running') return '▶️';
    if (session.status === 'completed') return '✅';
    if (session.status === 'failed') return '❌';
    return '⏸️';
  };

  const boards = mapToArray(boardById);
  const isAdmin = hasMinimumRole(currentUser?.role, ROLES.ADMIN);
  const openSettings = (section: string) => {
    onOpenWorkspaceSettings(section);
    onNavigate?.();
  };
  const utilityItems: MenuProps['items'] = [
    { key: 'home', label: 'Home', icon: <AppstoreOutlined /> },
    { key: 'knowledge', label: 'Knowledge Base', icon: <BulbOutlined /> },
    {
      key: 'workspace-settings',
      label: 'Workspace settings',
      icon: <SettingOutlined />,
      children: [
        { key: 'settings:boards', label: 'Boards', icon: <AppstoreOutlined /> },
        { key: 'settings:repos', label: 'Repositories', icon: <FolderOutlined /> },
        { key: 'settings:branches', label: 'Branches', icon: <BranchesOutlined /> },
        { key: 'settings:teammates', label: 'Teammates', icon: <RobotOutlined /> },
        { key: 'settings:cards', label: 'Cards (Beta)', icon: <CreditCardOutlined /> },
        { key: 'settings:artifacts', label: 'Artifacts', icon: <ExperimentOutlined /> },
        ...(isAdmin
          ? [
              {
                key: 'settings:agentic-tools',
                label: 'Agentic Tools',
                icon: <ThunderboltOutlined />,
              },
              { key: 'settings:mcp', label: 'MCP Servers', icon: <ApiOutlined /> },
              { key: 'settings:gateway', label: 'Gateway Channels', icon: <MessageOutlined /> },
              { key: 'settings:groups', label: 'Groups', icon: <TeamOutlined /> },
            ]
          : []),
        { key: 'settings:users', label: 'Users', icon: <TeamOutlined /> },
        { key: 'settings:about', label: 'About', icon: <InfoCircleOutlined /> },
      ],
    },
    { key: 'user-settings', label: 'User settings', icon: <UserOutlined /> },
    { key: 'documentation', label: 'Documentation', icon: <InfoCircleOutlined /> },
    { type: 'divider' },
    { key: 'logout', label: 'Logout', icon: <LogoutOutlined />, danger: true },
  ];

  return (
    <div
      style={{
        overflowY: 'auto',
        height: 'calc(100vh - 64px)',
      }}
    >
      <BoardCollapse
        items={boards.map((board: Board) => {
          const boardBranches = branchesByBoard[board.board_id] || [];
          const activeComments = getActiveCommentCount(board.board_id);

          return {
            key: board.board_id,
            board,
            emoji: getBoardEmoji(board, branchById),
            badge: (
              <Space size={8}>
                <Badge
                  count={boardBranches.length}
                  style={{ backgroundColor: token.colorPrimaryBg }}
                  showZero
                />
                <Button
                  type="text"
                  aria-label={`Open ${board.name} board`}
                  icon={<AppstoreOutlined style={{ fontSize: 18 }} />}
                  onClick={(e) => handleBoardClick(board.board_id, e)}
                  style={{ padding: '6px 10px', height: 'auto' }}
                />
                <Badge
                  count={activeComments}
                  offset={[-6, 6]}
                  styles={{
                    indicator: {
                      backgroundColor: `${token.colorPrimary}80`, // 0.5 opacity (80 in hex = 128/255 ≈ 0.5)
                      boxShadow: `0 0 0 2px ${token.colorBgMask}`,
                    },
                  }}
                >
                  <Button
                    type="text"
                    icon={<CommentOutlined style={{ fontSize: 18 }} />}
                    onClick={(e) => handleCommentsClick(board.board_id, e)}
                    style={{
                      padding: '6px 10px',
                      height: 'auto',
                      color: activeComments > 0 ? token.colorPrimary : token.colorTextSecondary,
                    }}
                  />
                </Badge>
              </Space>
            ),
            children:
              boardBranches.length === 0 ? (
                <Text type="secondary">No branches on this board</Text>
              ) : (
                <Collapse
                  defaultActiveKey={[]}
                  ghost
                  expandIcon={({ isActive }) => <DownOutlined rotate={isActive ? 180 : 0} />}
                  items={boardBranches
                    .sort((a, b) => {
                      // Sort branches by most recent session activity
                      const aMaxActivity = Math.max(
                        ...(sortedSessionsByBranch.get(a.branch_id) || []).map((s) =>
                          new Date(s.last_updated).getTime()
                        ),
                        0
                      );
                      const bMaxActivity = Math.max(
                        ...(sortedSessionsByBranch.get(b.branch_id) || []).map((s) =>
                          new Date(s.last_updated).getTime()
                        ),
                        0
                      );
                      return bMaxActivity - aMaxActivity; // DESC (most recent first)
                    })
                    .map((branch) => {
                      const branchSessions = sortedSessionsByBranch.get(branch.branch_id) || [];

                      return {
                        key: branch.branch_id,
                        label: (
                          <div
                            style={{
                              display: 'flex',
                              flexDirection: 'column',
                              gap: 2,
                              padding: '2px 0',
                            }}
                          >
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <span>🌳</span>
                              <Text strong>{branch.name}</Text>
                            </div>
                            <Text type="secondary" style={{ fontSize: 12, paddingLeft: 28 }}>
                              {branchSessions.length} sessions
                            </Text>
                          </div>
                        ),
                        children:
                          branchSessions.length === 0 ? (
                            <Text
                              type="secondary"
                              style={{ padding: '8px 0 8px 28px', display: 'block' }}
                            >
                              No sessions yet
                            </Text>
                          ) : (
                            <div>
                              {branchSessions.map((session) => (
                                <div
                                  key={session.session_id}
                                  onClick={() => handleSessionClick(session.session_id)}
                                  style={{
                                    cursor: 'pointer',
                                    padding: '6px 8px 6px 28px',
                                    borderRadius: 4,
                                  }}
                                  onMouseEnter={(e) => {
                                    (e.currentTarget as HTMLElement).style.background =
                                      token.colorFillTertiary;
                                  }}
                                  onMouseLeave={(e) => {
                                    (e.currentTarget as HTMLElement).style.background =
                                      'transparent';
                                  }}
                                >
                                  <div
                                    style={{
                                      display: 'flex',
                                      flexDirection: 'column',
                                      gap: 2,
                                      width: '100%',
                                    }}
                                  >
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                      <span>{getSessionStatusIcon(session)}</span>
                                      <Text>{getSessionTitle(session)}</Text>
                                    </div>
                                    <Text
                                      type="secondary"
                                      style={{ fontSize: 11, paddingLeft: 28 }}
                                    >
                                      {session.agentic_tool}
                                      {session.model_config?.model &&
                                        ` • ${session.model_config.model}`}
                                    </Text>
                                  </div>
                                </div>
                              ))}
                            </div>
                          ),
                      };
                    })}
                />
              ),
          };
        })}
      />
      <Divider style={{ marginBlock: token.marginSM }} />
      <Menu
        mode="inline"
        selectable={false}
        items={utilityItems}
        onClick={({ key }) => {
          if (key === 'home') navigate('/m');
          else if (key === 'knowledge') navigate('/knowledge');
          else if (key === 'user-settings') onOpenUserSettings();
          else if (key === 'documentation')
            window.open('https://agor.live/guide/getting-started', '_blank', 'noopener,noreferrer');
          else if (key === 'logout') onLogout?.();
          else if (key.startsWith('settings:')) openSettings(key.slice('settings:'.length));
          if (!key.startsWith('settings:')) onNavigate?.();
        }}
      />
    </div>
  );
};
