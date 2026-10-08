import type { AgorClient, Board, BoardComment, Branch, Session } from '@agor-live/client';
import {
  AppstoreOutlined,
  BulbOutlined,
  CommentOutlined,
  DownOutlined,
  ExportOutlined,
  InfoCircleOutlined,
  LogoutOutlined,
  PlusOutlined,
  SearchOutlined,
  SettingOutlined,
  UserOutlined,
} from '@ant-design/icons';
import type { MenuProps } from 'antd';
import { Badge, Button, Collapse, Divider, Menu, Space, Spin, Typography, theme } from 'antd';
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { resolveExternalAppLink } from '@/utils/externalAppLink';
import { mapToArray } from '@/utils/mapHelpers';
import { getSessionDisplayTitle } from '@/utils/sessionTitle';
import { useBoardPartition } from '../../hooks/useBoardPartition';
import { useBranchCounts } from '../../hooks/useBranchCounts';
import { BoardCollapse } from '../BoardCollapse';
import { getBoardEmoji } from '../BoardTile';
import { type CreateModalKind, createMenuItems } from '../CreateMenu';

/** Prefix for the "Create new" submenu's leaf keys, e.g. `create:board`. */
const CREATE_KEY_PREFIX = 'create:';

const { Text } = Typography;

interface MobileNavTreeProps {
  client: AgorClient | null;
  canUseMemberWorkspaceServices: boolean;
  boardById: Map<string, Board>;
  branchById: Map<string, Branch>;
  sessionsByBranch: Map<string, Session[]>; // O(1) branch filtering
  commentById: Map<string, BoardComment>;
  onNavigate?: () => void;
  onOpenWorkspaceSettings: (section: string) => void;
  onOpenUserSettings: () => void;
  onLogout?: () => void;
  /** Settings link to an external app (e.g. a hosting console), opened in a new tab */
  externalAppLink?: string;
  externalAppLabel?: string;
  /** Opens the shared create flow for the picked kind (drawer closes first). Omit to hide the row. */
  onCreate?: (kind: CreateModalKind) => void;
  /** Shows the admin-only Repository create item. */
  isAdmin: boolean;
}

/**
 * An expanded board's body. Mounting it (boards are collapsed and destroyed
 * when hidden) loads the board's partition in the background, so its branches
 * and sessions come from that load rather than from workspace-wide data.
 */
const BoardPanel: React.FC<{
  client: AgorClient | null;
  boardId: string;
  canUseMemberWorkspaceServices: boolean;
  children: React.ReactNode;
}> = ({ client, boardId, canUseMemberWorkspaceServices, children }) => {
  const { boardReady } = useBoardPartition(client, boardId, {
    canUseMemberWorkspaceServices,
    background: true,
  });
  return boardReady ? children : <Spin size="small" style={{ display: 'block' }} />;
};

export const MobileNavTree: React.FC<MobileNavTreeProps> = ({
  client,
  canUseMemberWorkspaceServices,
  boardById,
  branchById,
  sessionsByBranch,
  commentById,
  onNavigate,
  onOpenWorkspaceSettings,
  onOpenUserSettings,
  onLogout,
  externalAppLink,
  externalAppLabel,
  onCreate,
  isAdmin,
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

  // The nav receives workspace-wide maps. Build its indexes once per map
  // revision rather than rescanning every comment for every board and sorting
  // the same sessions repeatedly while unrelated state changes.
  const { activeCommentCountByBoard, branchesByBoard, sortedSessionsByBranch } = useMemo(() => {
    const comments = new Map<string, number>();
    for (const comment of commentById.values()) {
      if (!comment.resolved && !comment.parent_comment_id) {
        comments.set(comment.board_id, (comments.get(comment.board_id) ?? 0) + 1);
      }
    }

    const sortedSessions = new Map<string, Session[]>();
    const latestActivity = new Map<string, number>();
    for (const [branchId, branchSessions] of sessionsByBranch) {
      const sorted = [...branchSessions].sort(
        (a, b) => new Date(b.last_updated).getTime() - new Date(a.last_updated).getTime()
      );
      sortedSessions.set(branchId, sorted);
      latestActivity.set(branchId, new Date(sorted[0]?.last_updated ?? 0).getTime());
    }

    const branches = new Map<string, Branch[]>();
    for (const branch of branchById.values()) {
      const boardId = branch.board_id || 'unassigned';
      const group = branches.get(boardId) ?? [];
      group.push(branch);
      branches.set(boardId, group);
    }
    for (const group of branches.values()) {
      group.sort(
        (a, b) => (latestActivity.get(b.branch_id) ?? 0) - (latestActivity.get(a.branch_id) ?? 0)
      );
    }

    return {
      activeCommentCountByBoard: comments,
      branchesByBoard: branches,
      sortedSessionsByBranch: sortedSessions,
    };
  }, [branchById, commentById, sessionsByBranch]);

  // Get session title with mobile-friendly 50-char limit
  const getSessionTitle = (session: Session): string => {
    return getSessionDisplayTitle(session, { fallbackChars: 50 });
  };

  // Get session status icon
  const getSessionStatusIcon = (session: Session): string => {
    if (session.status === 'running') return '▶️';
    if (session.status === 'completed') return '✅';
    if (session.status === 'failed') return '❌';
    return '⏸️';
  };

  const boards = useMemo(() => mapToArray(boardById), [boardById]);
  const branchCountByBoard = useBranchCounts(client);
  const boardPanel = (boardId: string, body: React.ReactNode) => (
    <BoardPanel
      client={client}
      boardId={boardId}
      canUseMemberWorkspaceServices={canUseMemberWorkspaceServices}
    >
      {body}
    </BoardPanel>
  );
  const openSettings = (section: string) => {
    onOpenWorkspaceSettings(section);
    onNavigate?.();
  };
  // Retired the 12-item settings accordion: a single entry opens the shared
  // SettingsModal, which renders full-screen on mobile with its own section list.
  const externalApp = resolveExternalAppLink(externalAppLink, externalAppLabel);
  const utilityItems: MenuProps['items'] = [
    { key: 'search', label: 'Search', icon: <SearchOutlined /> },
    { key: 'knowledge', label: 'Knowledge Base', icon: <BulbOutlined /> },
    // Expandable "Create new" row — an inline submenu, so it expands like its
    // siblings without introducing a separate accordion component.
    ...(onCreate
      ? [
          {
            key: 'create',
            label: 'Create new',
            icon: <PlusOutlined />,
            children: createMenuItems(isAdmin).map((item) => ({
              key: `${CREATE_KEY_PREFIX}${item.key}`,
              label: item.label,
              icon: item.icon,
            })),
          },
        ]
      : []),
    { key: 'workspace-settings', label: 'Workspace settings', icon: <SettingOutlined /> },
    { key: 'user-settings', label: 'User settings', icon: <UserOutlined /> },
    { key: 'documentation', label: 'Documentation', icon: <InfoCircleOutlined /> },
    ...(externalApp
      ? [{ key: 'external-app', label: externalApp.label, icon: <ExportOutlined /> }]
      : []),
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
        destroyOnHidden
        items={boards.map((board: Board) => {
          const boardBranches = branchesByBoard.get(board.board_id) ?? [];
          const activeComments = activeCommentCountByBoard.get(board.board_id) ?? 0;

          return {
            key: board.board_id,
            board,
            emoji: getBoardEmoji(board, branchById),
            badge: (
              <Space size={8}>
                <Badge
                  count={branchCountByBoard.get(board.board_id) ?? 0}
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
                    aria-label={`Open comments for ${board.name}`}
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
            children: boardPanel(
              board.board_id,
              boardBranches.length === 0 ? (
                <Text type="secondary">No branches on this board</Text>
              ) : (
                <Collapse
                  defaultActiveKey={[]}
                  destroyOnHidden
                  ghost
                  expandIcon={({ isActive }) => <DownOutlined rotate={isActive ? 180 : 0} />}
                  items={boardBranches.map((branch) => {
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
                              <Button
                                type="text"
                                block
                                key={session.session_id}
                                onClick={() => handleSessionClick(session.session_id)}
                                style={{
                                  height: 'auto',
                                  textAlign: 'left',
                                  padding: '6px 8px 6px 28px',
                                  borderRadius: 4,
                                }}
                                onMouseEnter={(e) => {
                                  (e.currentTarget as HTMLElement).style.background =
                                    token.colorFillTertiary;
                                }}
                                onMouseLeave={(e) => {
                                  (e.currentTarget as HTMLElement).style.background = 'transparent';
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
                                  <Text type="secondary" style={{ fontSize: 11, paddingLeft: 28 }}>
                                    {session.agentic_tool}
                                    {session.model_config?.model &&
                                      ` • ${session.model_config.model}`}
                                  </Text>
                                </div>
                              </Button>
                            ))}
                          </div>
                        ),
                    };
                  })}
                />
              )
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
          if (onCreate && key.startsWith(CREATE_KEY_PREFIX)) {
            // Close the drawer first, then open the create flow — same order the
            // settings rows rely on so the drawer mask never covers the modal.
            onNavigate?.();
            onCreate(key.slice(CREATE_KEY_PREFIX.length) as CreateModalKind);
            return;
          }
          if (key === 'search') navigate('/m/search');
          else if (key === 'workspace-settings') openSettings('boards');
          else if (key === 'knowledge') navigate('/knowledge');
          else if (key === 'user-settings') onOpenUserSettings();
          else if (key === 'documentation')
            window.open('https://agor.live/guide/getting-started', '_blank', 'noopener,noreferrer');
          else if (key === 'external-app' && externalApp)
            window.open(externalApp.href, '_blank', 'noopener,noreferrer');
          else if (key === 'logout') onLogout?.();
          // Close the navigation drawer for every destination. Workspace settings
          // render in their own bottom sheet; leaving this drawer open keeps its
          // mask above that sheet and makes the settings tap appear to do nothing.
          onNavigate?.();
        }}
      />
    </div>
  );
};
