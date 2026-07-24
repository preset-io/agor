import { CheckOutlined, SettingOutlined } from '@ant-design/icons';
import type { MenuProps } from 'antd';
import { Button, Dropdown, theme } from 'antd';
import type React from 'react';
import type { ThemeMode } from '../../contexts/ThemeContext';

export interface SettingsDropdownProps {
  items: MenuProps['items'];
}

export const SettingsDropdown: React.FC<SettingsDropdownProps> = ({ items }) => {
  const { token } = theme.useToken();
  return (
    <Dropdown menu={{ items }} placement="bottomRight" trigger={['click']}>
      <Button
        type="text"
        icon={<SettingOutlined style={{ fontSize: token.fontSizeLG }} />}
        aria-label="Settings menu"
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      />
    </Dropdown>
  );
};

const themeCheckIcon = <CheckOutlined />;
const themeBlankIcon = <span style={{ width: 14, display: 'inline-block' }} />;

export function buildThemeMenuItems(
  themeMode: ThemeMode,
  setThemeMode: (mode: ThemeMode) => void,
  onThemeEditorClick?: () => void
): NonNullable<MenuProps['items']>[number] {
  return {
    key: 'theme',
    label: 'Theme',
    children: [
      {
        key: 'theme-dark',
        label: 'Dark',
        icon: themeMode === 'dark' ? themeCheckIcon : themeBlankIcon,
        onClick: () => setThemeMode('dark'),
      },
      {
        key: 'theme-light',
        label: 'Light',
        icon: themeMode === 'light' ? themeCheckIcon : themeBlankIcon,
        onClick: () => setThemeMode('light'),
      },
      {
        key: 'theme-custom',
        label: 'Custom',
        icon: themeMode === 'custom' ? themeCheckIcon : themeBlankIcon,
        onClick: () => setThemeMode('custom'),
        disabled: !onThemeEditorClick,
      },
      { type: 'divider' as const },
      {
        key: 'theme-edit',
        label: 'Edit Custom Theme',
        onClick: onThemeEditorClick,
        disabled: !onThemeEditorClick,
      },
    ],
  };
}
