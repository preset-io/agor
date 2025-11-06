import type { ActiveUser, User } from '@agor/core/types';
import {
  CodeOutlined,
  CommentOutlined,
  GithubOutlined,
  LogoutOutlined,
  MenuOutlined,
  SettingOutlined,
  UserOutlined,
} from '@ant-design/icons';
import type { MenuProps } from 'antd';
import { Badge, Button, Dropdown, Layout, Space, Typography, theme } from 'antd';
import { Facepile } from '../Facepile';
import { ThemeSwitcher } from '../ThemeSwitcher';

const { Header } = Layout;
const { Title } = Typography;

export interface AppHeaderProps {
  user?: User | null;
  activeUsers?: ActiveUser[];
  currentUserId?: string;
  onMenuClick?: () => void;
  onCommentsClick?: () => void;
  onSettingsClick?: () => void;
  onTerminalClick?: () => void;
  onThemeEditorClick?: () => void;
  onLogout?: () => void;
  currentBoardName?: string;
  currentBoardIcon?: string;
  unreadCommentsCount?: number;
}

export const AppHeader: React.FC<AppHeaderProps> = ({
  user,
  activeUsers = [],
  currentUserId,
  onMenuClick,
  onCommentsClick,
  onSettingsClick,
  onTerminalClick,
  onThemeEditorClick,
  onLogout,
  currentBoardName,
  currentBoardIcon,
  unreadCommentsCount = 0,
}) => {
  const { token } = theme.useToken();
  const userEmoji = user?.emoji || '👤';

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
      key: 'logout',
      label: 'Logout',
      icon: <LogoutOutlined />,
      onClick: onLogout,
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
        <Title level={3} style={{ margin: 0, color: token.colorText }}>
          agor
        </Title>
        {currentBoardName && (
          <Space
            size={4}
            align="center"
            style={{
              cursor: 'pointer',
              padding: '4px 8px',
              borderRadius: token.borderRadius,
              transition: 'background 0.2s',
            }}
            onMouseEnter={e => {
              e.currentTarget.style.background = token.colorBgTextHover;
            }}
            onMouseLeave={e => {
              e.currentTarget.style.background = 'transparent';
            }}
            onClick={onMenuClick}
          >
            {currentBoardIcon && <span style={{ fontSize: 16 }}>{currentBoardIcon}</span>}
            <Typography.Text style={{ color: token.colorTextSecondary, fontSize: 14 }}>
              {currentBoardName}
            </Typography.Text>
          </Space>
        )}
      </Space>

      <Space>
        {activeUsers.length > 0 && (
          <Facepile
            activeUsers={activeUsers}
            currentUserId={currentUserId}
            maxVisible={5}
            style={{
              marginRight: 8,
            }}
          />
        )}
        <Button
          type="text"
          icon={<GithubOutlined style={{ fontSize: token.fontSizeLG }} />}
          href="https://github.com/preset-io/agor"
          target="_blank"
          rel="noopener noreferrer"
          title="View on GitHub"
        />
        <Badge
          count={unreadCommentsCount}
          offset={[-2, 2]}
          style={{ backgroundColor: token.colorPrimaryBgHover }}
        >
          <Button
            type="text"
            icon={<CommentOutlined style={{ fontSize: token.fontSizeLG }} />}
            onClick={onCommentsClick}
            title="Toggle comments panel"
          />
        </Badge>
        <Button
          type="text"
          icon={<MenuOutlined style={{ fontSize: token.fontSizeLG }} />}
          onClick={onMenuClick}
        />
        <Button
          type="text"
          icon={<CodeOutlined style={{ fontSize: token.fontSizeLG }} />}
          onClick={onTerminalClick}
          title="Open Terminal"
        />
        <ThemeSwitcher onOpenThemeEditor={onThemeEditorClick} />
        <Button
          type="text"
          icon={<SettingOutlined style={{ fontSize: token.fontSizeLG }} />}
          onClick={onSettingsClick}
        />
        <Dropdown menu={{ items: userMenuItems }} placement="bottomRight" trigger={['click']}>
          <Button
            type="text"
            icon={<UserOutlined style={{ fontSize: token.fontSizeLG }} />}
            title={user?.name || 'User menu'}
          />
        </Dropdown>
      </Space>
    </Header>
  );
};
