import type { ActiveUser, Board, BoardID, User, Worktree } from '@agor/core/types';
import {
  ApiOutlined,
  CommentOutlined,
  LogoutOutlined,
  MenuOutlined,
  QuestionCircleOutlined,
  SettingOutlined,
  SoundOutlined,
  UserOutlined,
} from '@ant-design/icons';
import type { MenuProps } from 'antd';
import { Badge, Button, Divider, Dropdown, Layout, Space, Tooltip, Typography, theme } from 'antd';
import { useState } from 'react';
import { BoardSwitcher } from '../BoardSwitcher';
import { ConnectionStatus } from '../ConnectionStatus';
import { Facepile } from '../Facepile';
import { GettingStartedPopover } from '../GettingStartedPopover';
import { ThemeSwitcher } from '../ThemeSwitcher';

const { Header } = Layout;
const { Title } = Typography;

export interface AppHeaderProps {
  user?: User | null;
  activeUsers?: ActiveUser[];
  currentUserId?: string;
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
  boards?: Board[];
  currentBoardId?: string;
  onBoardChange?: (boardId: string) => void;
  worktreeById?: Map<string, Worktree>;
  repoCount?: number;
  worktreeCount?: number;
  hasAuthentication?: boolean;
  onDismissOnboarding?: () => void;
  onOpenRepoSettings?: () => void;
  onOpenAuthSettings?: () => void;
  onOpenNewWorktree?: () => void;
  boardById?: Map<string, Board>; // For looking up board names
  onUserClick?: (
    userId: string,
    boardId?: BoardID,
    cursorPosition?: { x: number; y: number }
  ) => void; // Navigate to user's board
}

export const AppHeader: React.FC<AppHeaderProps> = ({
  user,
  activeUsers = [],
  currentUserId,
  connected = false,
  connecting = false,
  onMenuClick,
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
  boards = [],
  currentBoardId,
  onBoardChange,
  worktreeById = new Map(),
  repoCount = 0,
  worktreeCount = 0,
  hasAuthentication = false,
  onDismissOnboarding,
  onOpenRepoSettings,
  onOpenAuthSettings,
  onOpenNewWorktree,
  boardById,
  onUserClick,
}) => {
  const { token } = theme.useToken();
  const userEmoji = user?.emoji || '👤';
  const [userDropdownOpen, setUserDropdownOpen] = useState(false);

  // Check if audio notifications are enabled
  const audioEnabled = user?.preferences?.audio?.enabled ?? false;

  const userMenuItems: MenuProps['items'] = [
    {
      key: 'user-info',
      label: (
        <div style={{ padding: '4px 0', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 20 }}>{userEmoji}</span>
          <div>
            <div style={{ fontWeight: 500 }}>{user?.name || 'User'}</div>
            <div style={{ fontSize: 12, color: token.colorTextDescription }}>{user?.email}</div>
          </div>
        </div>
      ),
      disabled: true,
    },
    {
      type: 'divider',
    },
    {
      key: 'user-settings',
      label: (
        <Space>
          <span>User Settings</span>
          {audioEnabled && (
            <Tooltip title="Audio notifications enabled">
              <SoundOutlined style={{ color: token.colorSuccess, fontSize: 12 }} />
            </Tooltip>
          )}
        </Space>
      ),
      icon: <UserOutlined />,
      onClick: () => {
        setUserDropdownOpen(false);
        onUserSettingsClick?.();
      },
    },
    {
      key: 'logout',
      label: 'Logout',
      icon: <LogoutOutlined />,
      onClick: () => {
        setUserDropdownOpen(false);
        onLogout?.();
      },
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
        <img
          src={`${import.meta.env.BASE_URL}favicon.png`}
          alt="Agor logo"
          style={{
            height: 50,
            borderRadius: '50%',
            objectFit: 'cover',
            display: 'block',
          }}
        />
        <Title level={3} style={{ margin: 0, marginTop: -6, color: token.colorText }}>
          agor
        </Title>
        <Divider type="vertical" style={{ height: 32, margin: '0 8px' }} />
        {currentBoardId && boards.length > 0 && (
          <div style={{ minWidth: 200 }}>
            <BoardSwitcher
              boards={boards}
              currentBoardId={currentBoardId}
              onBoardChange={onBoardChange || (() => {})}
              worktreeById={worktreeById}
            />
          </div>
        )}
        {currentBoardName && (
          <Tooltip title="Toggle session drawer" placement="bottom">
            <Button
              type="text"
              icon={<MenuOutlined style={{ fontSize: token.fontSizeLG }} />}
              onClick={onMenuClick}
            />
          </Tooltip>
        )}
        {currentBoardName && (
          <Badge
            count={unreadCommentsCount}
            offset={[-2, 2]}
            style={{
              backgroundColor: hasUserMentions ? token.colorError : token.colorPrimaryBgHover,
            }}
          >
            <Tooltip title="Toggle comments panel" placement="bottom">
              <Button
                type="text"
                icon={<CommentOutlined style={{ fontSize: token.fontSizeLG }} />}
                onClick={onCommentsClick}
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
        {activeUsers.length > 0 && (
          <>
            <Facepile
              activeUsers={activeUsers}
              currentUserId={currentUserId}
              maxVisible={5}
              boardById={boardById}
              onUserClick={onUserClick}
              style={{
                marginRight: 8,
              }}
            />
            <Divider type="vertical" style={{ height: 32, margin: '0 8px' }} />
          </>
        )}
        {eventStreamEnabled && (
          <Tooltip title="Live Event Stream" placement="bottom">
            <Button
              type="text"
              icon={<ApiOutlined style={{ fontSize: token.fontSizeLG }} />}
              onClick={onEventStreamClick}
            />
          </Tooltip>
        )}
        {user && !user.onboarding_completed ? (
          <GettingStartedPopover
            stats={{
              repoCount,
              worktreeCount,
              hasAuthentication,
            }}
            user={user}
            onOpenSettings={() => onSettingsClick?.()}
            onOpenRepoSettings={onOpenRepoSettings}
            onOpenAuthSettings={onOpenAuthSettings}
            onOpenNewWorktree={onOpenNewWorktree}
            onDismiss={onDismissOnboarding}
          >
            <Tooltip title="Getting Started" placement="bottom">
              <Button
                type="text"
                icon={<QuestionCircleOutlined style={{ fontSize: token.fontSizeLG }} />}
                style={{
                  position: 'relative',
                }}
              >
                <span
                  style={{
                    position: 'absolute',
                    top: 8,
                    right: 8,
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    backgroundColor: token.colorError,
                  }}
                />
              </Button>
            </Tooltip>
          </GettingStartedPopover>
        ) : (
          <Tooltip title="Documentation" placement="bottom">
            <Button
              type="text"
              icon={<QuestionCircleOutlined style={{ fontSize: token.fontSizeLG }} />}
              href="https://agor.live/guide/getting-started"
              target="_blank"
              rel="noopener noreferrer"
            />
          </Tooltip>
        )}
        <ThemeSwitcher onOpenThemeEditor={onThemeEditorClick} />
        <Tooltip title="Settings" placement="bottom">
          <Button
            type="text"
            icon={<SettingOutlined style={{ fontSize: token.fontSizeLG }} />}
            onClick={onSettingsClick}
          />
        </Tooltip>
        <Dropdown
          menu={{ items: userMenuItems }}
          placement="bottomRight"
          trigger={['click']}
          open={userDropdownOpen}
          onOpenChange={setUserDropdownOpen}
        >
          <Tooltip title={user?.name || 'User menu'} placement="bottom">
            <Button type="text" icon={<UserOutlined style={{ fontSize: token.fontSizeLG }} />} />
          </Tooltip>
        </Dropdown>
      </Space>
    </Header>
  );
};
