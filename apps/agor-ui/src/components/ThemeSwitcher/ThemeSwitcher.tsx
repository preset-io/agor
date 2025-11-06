import { BgColorsOutlined, CheckOutlined, EditOutlined } from '@ant-design/icons';
import type { MenuProps } from 'antd';
import { Button, Dropdown, theme } from 'antd';
import type React from 'react';
import { useTheme } from '../../contexts/ThemeContext';

export interface ThemeSwitcherProps {
  onOpenThemeEditor?: () => void;
}

export const ThemeSwitcher: React.FC<ThemeSwitcherProps> = ({ onOpenThemeEditor }) => {
  const { token } = theme.useToken();
  const { themeMode, setThemeMode } = useTheme();

  const menuItems: MenuProps['items'] = [
    {
      key: 'dark',
      label: 'Dark',
      icon:
        themeMode === 'dark' ? (
          <CheckOutlined />
        ) : (
          <span style={{ width: 14, display: 'inline-block' }} />
        ),
      onClick: () => setThemeMode('dark'),
    },
    {
      key: 'light',
      label: 'Light',
      icon:
        themeMode === 'light' ? (
          <CheckOutlined />
        ) : (
          <span style={{ width: 14, display: 'inline-block' }} />
        ),
      onClick: () => setThemeMode('light'),
    },
    {
      key: 'custom',
      label: 'Custom',
      icon:
        themeMode === 'custom' ? (
          <CheckOutlined />
        ) : (
          <span style={{ width: 14, display: 'inline-block' }} />
        ),
      onClick: () => setThemeMode('custom'),
      disabled: !onOpenThemeEditor, // Disable if no editor provided
    },
    {
      type: 'divider',
    },
    {
      key: 'edit-theme',
      label: 'Edit Custom Theme',
      icon: <EditOutlined />,
      onClick: onOpenThemeEditor,
      disabled: !onOpenThemeEditor,
    },
  ];

  return (
    <Dropdown menu={{ items: menuItems }} placement="bottomRight" trigger={['click']}>
      <Button
        type="text"
        icon={<BgColorsOutlined style={{ fontSize: token.fontSizeLG }} />}
        title="Change theme"
      />
    </Dropdown>
  );
};
