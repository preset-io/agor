import type { ActiveUser, AgorClient, Board, BoardID, User } from '@agor-live/client';
import {
  ApiOutlined,
  BulbOutlined,
  CommentOutlined,
  QuestionCircleOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import { Badge, Button, Divider, Layout, Popover, Space, Tag, Tooltip, theme } from 'antd';
import { memo, useMemo } from 'react';
import { useHref, useNavigate } from 'react-router-dom';
import { mapToArray } from '@/utils/mapHelpers';
import { BRAND, brandMarkHref } from '../../branding/brand';
import { useConnectionDisabled } from '../../contexts/ConnectionContext';
import { useRecentBoards } from '../../hooks/useRecentBoards';
import { useAgorStore } from '../../store/agorStore';
import {
  selectArtifactById,
  selectBoardById,
  selectBranchById,
  selectMcpServerById,
  selectSessionById,
  selectUserById,
} from '../../store/selectors';
import { BoardSwitcher } from '../BoardSwitcher';
import { BrandLogo } from '../BrandLogo';
import { ConnectionStatus } from '../ConnectionStatus';
import { GlobalSearch } from '../GlobalSearch';
import { GlobalUserMenu } from '../GlobalUserMenu';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { ThemeSwitcher } from '../ThemeSwitcher';
import { GlobalPresenceFacepile } from './GlobalPresenceFacepile';

const { Header } = Layout;

export interface AppHeaderProps {
  user?: User | null;
  presenceClient?: AgorClient | null;
  currentUserId?: string;
  /** Demo/screenshot-only fixture: render static presence while keeping AppHeader chrome. */
  staticActiveUsers?: ActiveUser[];
  /** Demo/screenshot-only override for facepile composition. Normal product defaults remain in GlobalPresenceFacepile. */
  presenceMaxVisible?: number;
  connected?: boolean;
  connecting?: boolean;
  onMenuClick?: () => void;
  onCommentsClick?: () => void;
  onEventStreamClick?: () => void;
  onSettingsClick?: () => void;
  onUserSettingsClick?: () => void;
  onThemeEditorClick?: () => void;
  onLogout?: () => void;
  onRetryConnection?: () => void;
  currentBoardName?: string;
  currentBoardIcon?: string;
  unreadCommentsCount?: number;
  eventStreamEnabled?: boolean;
  hasUserMentions?: boolean; // True if current user is mentioned in active comments
  currentBoardId?: string;
  onBoardChange?: (boardId: string) => void;
  onHomeClick?: () => void;
  onUserClick?: (
    userId: string,
    boardId?: BoardID,
    cursorPosition?: { x: number; y: number }
  ) => void; // Navigate to user's board
  /** Instance label for deployment identification (displayed as a Tag) */
  instanceLabel?: string;
  /** Instance description (markdown) shown in popover around the instance label */
  instanceDescription?: string;
}

const RecentBoardPills: React.FC<{
  recentBoards: Board[];
  onBoardChange: (boardId: string) => void;
  token: ReturnType<typeof theme.useToken>['token'];
}> = ({ recentBoards, onBoardChange, token }) => {
  if (recentBoards.length === 0) return null;

  return (
    <Space size={4}>
      {recentBoards.map((board) => (
        <Tooltip key={board.board_id} title={board.name} placement="bottom">
          <Button
            type="text"
            size="small"
            aria-label={`Switch to board ${board.name}`}
            onClick={() => onBoardChange(board.board_id)}
            style={{
              width: 30,
              height: 30,
              minWidth: 30,
              padding: 0,
              borderRadius: '50%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 16,
              border: `1px solid ${token.colorBorderSecondary}`,
              background: token.colorBgElevated,
            }}
          >
            {board.icon || '📋'}
          </Button>
        </Tooltip>
      ))}
    </Space>
  );
};

const AppHeaderInner: React.FC<AppHeaderProps> = ({
  user,
  presenceClient = null,
  currentUserId,
  staticActiveUsers,
  presenceMaxVisible,
  connected = false,
  connecting = false,
  onCommentsClick,
  onEventStreamClick,
  onSettingsClick,
  onUserSettingsClick,
  onThemeEditorClick,
  onLogout,
  onRetryConnection,
  currentBoardName,
  currentBoardIcon,
  unreadCommentsCount = 0,
  eventStreamEnabled = false,
  hasUserMentions = false,
  currentBoardId,
  onBoardChange,
  onHomeClick,
  onUserClick,
  instanceLabel,
  instanceDescription,
}) => {
  const { token } = theme.useToken();
  const navigate = useNavigate();
  const knowledgeHref = useHref('/knowledge');

  // Entity state via narrow store subscriptions rather than props. Each
  // whole-map selector is a stable module-level reference, so the header
  // re-renders only when a slice it actually reads changes — not on every
  // top-down App render. The board list and presence directory are derived
  // here (instead of arriving as fresh `mapToArray(...)` props each render)
  // so React.memo's bailout isn't defeated by an unstable array identity.
  const boardById = useAgorStore(selectBoardById);
  const userById = useAgorStore(selectUserById);
  const branchById = useAgorStore(selectBranchById);
  const sessionById = useAgorStore(selectSessionById);
  const artifactById = useAgorStore(selectArtifactById);
  const mcpServerById = useAgorStore(selectMcpServerById);
  const boards = useMemo(() => mapToArray(boardById), [boardById]);
  const presenceUsers = useMemo(() => mapToArray(userById), [userById]);
  // Derive the recent-board pills here (not as a prop): the source array is the
  // store-derived `boards`, so unrelated App re-renders can't hand us a fresh
  // recents array and defeat React.memo. The localStorage-backed recents list is
  // shared across hook instances, so this stays in sync with App's visit tracker.
  const { recentBoards } = useRecentBoards(boards, currentBoardId ?? '');
  // Single source of truth for "is the daemon usable right now?". Captures
  // disconnected, the 1.5s reconnect grace window, and out-of-sync. Don't
  // gate off raw `connected` — it stays true through the grace window.
  const mutationDisabled = useConnectionDisabled();
  const headerIconButtonStyle = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  } as const;

  return (
    <Header
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 24px',
        background: token.colorBgContainer,
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
      }}
    >
      <Space size={16} align="center">
        <button
          type="button"
          aria-label="Go to Home"
          onClick={onHomeClick}
          style={{
            height: 54,
            padding: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            background: 'transparent',
            border: 0,
            cursor: 'pointer',
          }}
        >
          <img
            src={brandMarkHref()}
            alt={BRAND.name}
            style={{
              height: 50,
              borderRadius: '50%',
              objectFit: 'cover',
              display: 'block',
            }}
          />
          <BrandLogo level={3} style={{ marginTop: -6 }} />
        </button>
        {instanceLabel &&
          (instanceDescription ? (
            <Popover
              content={
                <div style={{ maxWidth: 400 }}>
                  <MarkdownRenderer content={instanceDescription} />
                </div>
              }
              title={instanceLabel}
              trigger="hover"
              placement="bottomLeft"
            >
              <Tag color="cyan" style={{ cursor: 'help', marginLeft: 8 }}>
                {instanceLabel}
              </Tag>
            </Popover>
          ) : (
            <Tag color="cyan" style={{ marginLeft: 8 }}>
              {instanceLabel}
            </Tag>
          ))}
        <Divider orientation="vertical" style={{ height: 32, margin: '0 8px' }} />
        {/* Disconnected pattern: navbar elements that lead to server-fetching
            or mutating surfaces are *disabled* (not hidden) via
            useConnectionDisabled (covers disconnect + reconnect grace window
            + out-of-sync). Local-only navigation (BoardSwitcher,
            RecentBoardPills, theme, external doc link, presence display)
            stays fully alive — those never depend on the daemon.
            See docs/disconnected-state-design.md. */}
        <div style={{ minWidth: 200 }}>
          <BoardSwitcher
            boards={boards}
            currentBoardId={currentBoardId}
            onBoardChange={onBoardChange || (() => {})}
            onHomeClick={onHomeClick}
            branchById={branchById}
          />
        </div>
        {boards.length > 0 && (
          <RecentBoardPills
            recentBoards={recentBoards}
            onBoardChange={onBoardChange || (() => {})}
            token={token}
          />
        )}
        {currentBoardName && (
          <Badge
            count={unreadCommentsCount}
            offset={[-2, 2]}
            style={{
              backgroundColor: hasUserMentions ? token.colorError : token.colorPrimaryBgHover,
            }}
            className="app-header-icon-badge"
          >
            <Tooltip title="Show comments tab" placement="bottom">
              <Button
                type="text"
                icon={<CommentOutlined style={{ fontSize: token.fontSizeLG }} />}
                style={headerIconButtonStyle}
                onClick={onCommentsClick}
                disabled={mutationDisabled}
              />
            </Tooltip>
          </Badge>
        )}
      </Space>

      <Space>
        <ConnectionStatus
          connected={connected}
          connecting={connecting}
          onRetry={onRetryConnection}
        />
        <GlobalPresenceFacepile
          client={presenceClient}
          currentBoardId={currentBoardId ? (currentBoardId as BoardID) : null}
          users={presenceUsers}
          currentUser={user}
          boardById={boardById}
          onUserClick={onUserClick}
          staticActiveUsers={staticActiveUsers}
          maxVisible={presenceMaxVisible}
        />
        <GlobalSearch
          currentUserId={currentUserId}
          sessionById={sessionById}
          branchById={branchById}
          artifactById={artifactById}
          boardById={boardById}
          mcpServerById={mcpServerById}
          onSettingsClick={onSettingsClick}
        />
        <Divider orientation="vertical" style={{ height: 32, margin: '0 8px' }} />
        {eventStreamEnabled && (
          <Tooltip title="Live Event Stream" placement="bottom">
            <Button
              type="text"
              icon={<ApiOutlined style={{ fontSize: token.fontSizeLG }} />}
              style={headerIconButtonStyle}
              onClick={onEventStreamClick}
              disabled={mutationDisabled}
            />
          </Tooltip>
        )}
        <Tooltip title="Knowledge" placement="bottom">
          <Button
            type="text"
            icon={<BulbOutlined style={{ fontSize: token.fontSizeLG }} />}
            style={headerIconButtonStyle}
            href={knowledgeHref}
            aria-label="Knowledge"
            onClick={(event) => {
              if (event.defaultPrevented) return;
              if (
                event.button !== 0 ||
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey
              ) {
                return;
              }
              event.preventDefault();
              navigate('/knowledge');
            }}
          />
        </Tooltip>
        <Tooltip title="Documentation" placement="bottom">
          <Button
            type="text"
            icon={<QuestionCircleOutlined style={{ fontSize: token.fontSizeLG }} />}
            style={headerIconButtonStyle}
            href="https://agor.live/guide/getting-started"
            target="_blank"
            rel="noopener noreferrer"
          />
        </Tooltip>
        <ThemeSwitcher onOpenThemeEditor={onThemeEditorClick} />
        <Tooltip title="Settings" placement="bottom">
          <Button
            type="text"
            icon={<SettingOutlined style={{ fontSize: token.fontSizeLG }} />}
            style={headerIconButtonStyle}
            onClick={onSettingsClick}
            disabled={mutationDisabled}
          />
        </Tooltip>
        <GlobalUserMenu
          user={user}
          disabled={mutationDisabled}
          onUserSettingsClick={onUserSettingsClick}
          onLogout={onLogout}
        />
      </Space>
    </Header>
  );
};

// Memoized so the always-mounted header is insulated from App's top-down
// re-renders: App re-renders on every live store patch, but AppHeader re-renders
// only when one of its own props actually changes OR one of its `useAgorStore`
// selector slices fires. The bailout holds only while the parent keeps every
// prop referentially stable (see the stabilized handlers at the App render site).
export const AppHeader = memo(AppHeaderInner);
