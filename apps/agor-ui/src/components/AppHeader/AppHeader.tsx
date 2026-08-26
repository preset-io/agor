import type { ActiveUser, AgorClient, Board, BoardID, Branch, User } from '@agor-live/client';
import { hasMinimumRole, ROLES } from '@agor-live/client';
import { BulbOutlined, ShopOutlined } from '@ant-design/icons';
import type { MenuProps } from 'antd';
import { Button, Divider, Layout, Popover, Space, Tag, Tooltip, theme } from 'antd';
import { memo, useMemo } from 'react';
import { useHref, useNavigate } from 'react-router-dom';
import { mapToArray } from '@/utils/mapHelpers';
import { useConnectionDisabled } from '../../contexts/ConnectionContext';
import { useTheme } from '../../contexts/ThemeContext';
import type { NewSessionConfig, SessionCreationResult } from '../../domain/sessionCreation';
import { useRecentBoards } from '../../hooks/useRecentBoards';
import { useAgorStore } from '../../store/agorStore';
import { selectBoardById, selectBranchById, selectUserById } from '../../store/selectors';
import { BoardSwitcher } from '../BoardSwitcher';
import { BoardTile, getBoardEmoji } from '../BoardTile';
import { BrandLogo } from '../BrandLogo';
import { BrandMark } from '../BrandMark';
import { ConnectionStatus } from '../ConnectionStatus';
import { GlobalUserMenu } from '../GlobalUserMenu';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { buildThemeMenuItems } from '../ThemeSwitcher';
import { AppHeaderGlobalSearch } from './AppHeaderGlobalSearch';
import { GlobalPresenceFacepile } from './GlobalPresenceFacepile';
import { NavbarComposeButton } from './NavbarComposeButton';
import { SettingsDropdown } from './SettingsDropdown';

const { Header } = Layout;

export interface AppHeaderProps {
  user?: User | null;
  authenticationGeneration?: number;
  isAuthenticationGenerationCurrent?: (generation: number) => boolean;
  presenceClient?: AgorClient | null;
  currentUserId?: string;
  /** Demo/screenshot-only fixture: render static presence while keeping AppHeader chrome. */
  staticActiveUsers?: ActiveUser[];
  /** Demo/screenshot-only override for facepile composition. Normal product defaults remain in GlobalPresenceFacepile. */
  presenceMaxVisible?: number;
  connected?: boolean;
  connecting?: boolean;
  onMenuClick?: () => void;
  onEventStreamClick?: () => void;
  onSettingsClick?: () => void;
  onUserSettingsClick?: () => void;
  onThemeEditorClick?: () => void;
  onLogout?: () => void;
  onRetryConnection?: () => void;
  eventStreamEnabled?: boolean;
  currentBoardId?: string;
  onBoardChange?: (boardId: string) => void;
  onHomeClick?: () => void;
  onUpdateBoard?: (boardId: string, updates: Partial<Board>) => void | Promise<void>;
  onUserClick?: (
    userId: string,
    boardId?: BoardID,
    cursorPosition?: { x: number; y: number }
  ) => void; // Navigate to user's board
  /** Instance label for deployment identification (displayed as a Tag) */
  instanceLabel?: string;
  /** Instance description (markdown) shown in popover around the instance label */
  instanceDescription?: string;
  /** Session-creation seam behind the navbar compose affordance. */
  onCreateSession?: (
    config: NewSessionConfig,
    boardId: string
  ) => Promise<SessionCreationResult | null>;
}

const RecentBoardPills: React.FC<{
  recentBoards: Board[];
  branchById: Map<string, Branch>;
  onBoardChange: (boardId: string) => void;
  token: ReturnType<typeof theme.useToken>['token'];
}> = ({ recentBoards, branchById, onBoardChange, token }) => {
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
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <BoardTile
              emoji={getBoardEmoji(board, branchById)}
              size={30}
              style={{
                background: token.colorBgElevated,
                border: `1px solid ${token.colorBorderSecondary}`,
              }}
            />
          </Button>
        </Tooltip>
      ))}
    </Space>
  );
};

/**
 * True when a click on an `href`-bearing Button should be handled by the
 * router. Modified clicks and middle clicks keep the browser's native
 * open-in-new-tab behaviour, which the `href` exists to preserve.
 */
function isPlainLeftClick(event: React.MouseEvent): boolean {
  if (event.defaultPrevented) return false;
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

const AppHeaderInner: React.FC<AppHeaderProps> = ({
  user,
  authenticationGeneration = 0,
  isAuthenticationGenerationCurrent,
  presenceClient = null,
  currentUserId,
  staticActiveUsers,
  presenceMaxVisible,
  connected = false,
  connecting = false,
  onEventStreamClick,
  onSettingsClick,
  onUserSettingsClick,
  onThemeEditorClick,
  onLogout,
  onRetryConnection,
  eventStreamEnabled = false,
  currentBoardId,
  onBoardChange,
  onHomeClick,
  onUpdateBoard,
  onUserClick,
  instanceLabel,
  instanceDescription,
  onCreateSession,
}) => {
  const { token } = theme.useToken();
  const navigate = useNavigate();
  const knowledgeHref = useHref('/knowledge');
  const marketplaceHref = useHref('/marketplace');
  const { themeMode, setThemeMode } = useTheme();

  // Entity state via narrow store subscriptions rather than props. Each
  // whole-map selector is a stable module-level reference, so the header
  // re-renders only when a slice it actually reads changes — not on every
  // top-down App render. The board list and presence directory are derived
  // here (instead of arriving as fresh `mapToArray(...)` props each render)
  // so React.memo's bailout isn't defeated by an unstable array identity.
  const boardById = useAgorStore(selectBoardById);
  const userById = useAgorStore(selectUserById);
  const branchById = useAgorStore(selectBranchById);
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

  const settingsItems: MenuProps['items'] = [
    ...(eventStreamEnabled
      ? [
          {
            key: 'event-stream',
            label: 'Live Events',
            disabled: mutationDisabled,
            onClick: onEventStreamClick,
          },
          { type: 'divider' as const },
        ]
      : []),
    {
      key: 'documentation',
      label: (
        <a href="https://agor.live/guide/getting-started" target="_blank" rel="noopener noreferrer">
          Documentation
        </a>
      ),
    },
    {
      key: 'theme',
      label: 'Theme',
      children: buildThemeMenuItems(themeMode, setThemeMode, onThemeEditorClick),
    },
    { type: 'divider' as const },
    {
      key: 'settings',
      label: 'Settings',
      disabled: mutationDisabled,
      onClick: onSettingsClick,
    },
  ];

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
          <BrandMark size={50} />
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
        <div style={{ width: 200 }}>
          <BoardSwitcher
            boards={boards}
            currentBoardId={currentBoardId}
            onBoardChange={onBoardChange || (() => {})}
            onHomeClick={onHomeClick}
            branchById={branchById}
            client={presenceClient}
            currentUser={user}
            onUpdateBoard={onUpdateBoard}
          />
        </div>
        {boards.length > 0 && (
          <RecentBoardPills
            recentBoards={recentBoards}
            branchById={branchById}
            onBoardChange={onBoardChange || (() => {})}
            token={token}
          />
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
        {onCreateSession && hasMinimumRole(user?.role, ROLES.MEMBER) && (
          <NavbarComposeButton
            key={`${user?.user_id ?? 'anonymous'}:${authenticationGeneration}`}
            client={presenceClient}
            currentUser={user}
            authenticationGeneration={authenticationGeneration}
            isAuthenticationGenerationCurrent={isAuthenticationGenerationCurrent}
            currentBoardId={currentBoardId}
            onCreateSession={onCreateSession}
            disabled={mutationDisabled}
          />
        )}
        <AppHeaderGlobalSearch
          currentUserId={currentUserId}
          branchById={branchById}
          boardById={boardById}
          onSettingsClick={onSettingsClick}
        />
        <Tooltip title="Knowledge Base">
          <Button
            type="text"
            icon={<BulbOutlined style={{ fontSize: token.fontSizeLG }} />}
            href={knowledgeHref}
            aria-label="Knowledge Base"
            onClick={(event) => {
              if (isPlainLeftClick(event)) {
                event.preventDefault();
                navigate('/knowledge');
              }
            }}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          />
        </Tooltip>
        {/* A marketplace is a surface people are meant to come back to, so it
            gets promoted chrome next to the gear rather than a line inside the
            gear's menu. Ungated by role: the catalog read is authenticated-only
            (`mcp-catalog` takes `requireAuth` and nothing more), so everyone who
            can see this header can browse it. Connecting is narrower, and
            CatalogDetailDrawer asks the MCP member policy before offering it —
            without that this entry would send a viewer to a Connect button that
            403s, which is why the two changed together. */}
        <Tooltip title="Marketplace">
          <Button
            type="text"
            icon={<ShopOutlined style={{ fontSize: token.fontSizeLG }} />}
            href={marketplaceHref}
            aria-label="Marketplace"
            onClick={(event) => {
              if (isPlainLeftClick(event)) {
                event.preventDefault();
                navigate('/marketplace');
              }
            }}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          />
        </Tooltip>
        <SettingsDropdown items={settingsItems} />
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
