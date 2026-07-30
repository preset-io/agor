import { BgColorsOutlined, CheckOutlined, EditOutlined } from '@ant-design/icons';
import type { MenuProps } from 'antd';
import { Button, Dropdown, theme } from 'antd';
import type React from 'react';
import { type ThemeMode, useTheme } from '../../contexts/ThemeContext';

export interface ThemeSwitcherProps {
  onOpenThemeEditor?: () => void;
}

const themeCheckIcon = <CheckOutlined />;
const themeBlankIcon = <span style={{ width: 14, display: 'inline-block' }} />;

export function buildThemeMenuItems(
  themeMode: ThemeMode,
  setThemeMode: (mode: ThemeMode) => void,
  onOpenThemeEditor?: () => void
): NonNullable<MenuProps['items']> {
  return [
    {
      key: 'dark',
      label: 'Dark',
      icon: themeMode === 'dark' ? themeCheckIcon : themeBlankIcon,
      onClick: () => setThemeMode('dark'),
    },
    {
      key: 'light',
      label: 'Light',
      icon: themeMode === 'light' ? themeCheckIcon : themeBlankIcon,
      onClick: () => setThemeMode('light'),
    },
    {
      key: 'custom',
      label: 'Custom',
      icon: themeMode === 'custom' ? themeCheckIcon : themeBlankIcon,
      onClick: () => setThemeMode('custom'),
      disabled: !onOpenThemeEditor,
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
}

export const ThemeSwitcher: React.FC<ThemeSwitcherProps> = ({ onOpenThemeEditor }) => {
  const { token } = theme.useToken();
  const { themeMode, setThemeMode } = useTheme();

  const menuItems = buildThemeMenuItems(themeMode, setThemeMode, onOpenThemeEditor);

  return (
    <Dropdown menu={{ items: menuItems }} placement="bottomRight" trigger={['click']}>
      <Button
        type="text"
        icon={<BgColorsOutlined style={{ fontSize: token.fontSizeLG }} />}
        title="Change theme"
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      />
    </Dropdown>
  );
};
