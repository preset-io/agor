import type { ActiveUser, Board, BoardID, User, Worktree } from '@agor/core/types';
import {
  ApiOutlined,
  CommentOutlined,
  LogoutOutlined,
  QuestionCircleOutlined,
  SettingOutlined,
  SoundOutlined,
  UnorderedListOutlined,
  UserOutlined,
} from '@ant-design/icons';
import type { MenuProps } from 'antd';
import {
  Badge,
  Button,
  Divider,
  Dropdown,
  Layout,
  Popover,
  Space,
  Tag,
  Tooltip,
  theme,
} from 'antd';
import { useState } from 'react';
import { BoardSwitcher } from '../BoardSwitcher';
import { BrandLogo } from '../BrandLogo';
import { ConnectionStatus } from '../ConnectionStatus';
import { Facepile } from '../Facepile';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { ThemeSwitcher } from '../ThemeSwitcher';

const { Header } = Layout;

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
  boardById?: Map<string, Board>; // For looking up board names
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
  boardById,
  onUserClick,
  instanceLabel,
  instanceDescription,
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
        <BrandLogo level={3} style={{ marginTop: -6 }} />
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
              icon={<UnorderedListOutlined style={{ fontSize: token.fontSizeLG }} />}
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
            <Divider orientation="vertical" style={{ height: 32, margin: '0 8px' }} />
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
        <Tooltip title="Documentation" placement="bottom">
          <Button
            type="text"
            icon={<QuestionCircleOutlined style={{ fontSize: token.fontSizeLG }} />}
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
