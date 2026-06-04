import type { User } from '@agor-live/client';
import { LogoutOutlined, SoundOutlined, UserOutlined } from '@ant-design/icons';
import type { MenuProps } from 'antd';
import { Button, Dropdown, Space, Tooltip, theme } from 'antd';
import type React from 'react';
import { useState } from 'react';

export interface GlobalUserMenuProps {
  user?: User | null;
  disabled?: boolean;
  onUserSettingsClick?: () => void;
  onLogout?: () => void;
}

/**
 * Surface-agnostic current-user menu.
 *
 * This deliberately depends only on the current authenticated user and global
 * callbacks. It must not read workspace maps (`userById`, boards, sessions,
 * etc.) so lightweight surfaces like Knowledge can show identity affordances
 * without starting the heavy Workspace store.
 */
export const GlobalUserMenu: React.FC<GlobalUserMenuProps> = ({
  user,
  disabled = false,
  onUserSettingsClick,
  onLogout,
}) => {
  const { token } = theme.useToken();
  const [open, setOpen] = useState(false);
  const userEmoji = user?.emoji || '👤';
  const audioEnabled = user?.preferences?.audio?.enabled ?? false;

  const items: MenuProps['items'] = [
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
    { type: 'divider' },
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
        setOpen(false);
        onUserSettingsClick?.();
      },
    },
    {
      key: 'logout',
      label: 'Logout',
      icon: <LogoutOutlined />,
      onClick: () => {
        setOpen(false);
        onLogout?.();
      },
    },
  ];

  return (
    <Dropdown
      menu={{ items }}
      placement="bottomRight"
      trigger={['click']}
      open={open}
      onOpenChange={setOpen}
      disabled={disabled}
    >
      <Tooltip title={user?.name || 'User menu'} placement="bottom">
        <Button
          type="text"
          icon={<UserOutlined style={{ fontSize: token.fontSizeLG }} />}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          disabled={disabled}
        />
      </Tooltip>
    </Dropdown>
  );
};
