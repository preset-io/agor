import type { ActiveUser, Board, User, Worktree } from '@agor/core/types';
import {
  ApiOutlined,
  CommentOutlined,
  LogoutOutlined,
  MenuOutlined,
  QuestionCircleOutlined,
  SettingOutlined,
  UserOutlined,
} from '@ant-design/icons';
import type { MenuProps } from 'antd';
import { Badge, Button, Divider, Dropdown, Layout, Space, Tooltip, Typography, theme } from 'antd';
import { useState } from 'react';
import { BoardSwitcher } from '../BoardSwitcher';
import { ConnectionStatus } from '../ConnectionStatus';
import { Facepile } from '../Facepile';
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
  boards?: Board[];
  currentBoardId?: string;
  onBoardChange?: (boardId: string) => void;
  worktreeById?: Map<string, Worktree>;
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
  boards = [],
  currentBoardId,
  onBoardChange,
  worktreeById = new Map(),
}) => {
  const { token } = theme.useToken();
  const userEmoji = user?.emoji || '👤';
  const [userDropdownOpen, setUserDropdownOpen] = useState(false);

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
      label: 'User Settings',
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
            style={{ backgroundColor: token.colorPrimaryBgHover }}
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
        <Tooltip title="Documentation" placement="bottom">
          <Button
            type="text"
            icon={<QuestionCircleOutlined style={{ fontSize: token.fontSizeLG }} />}
            href="https://agor.live/guide"
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
