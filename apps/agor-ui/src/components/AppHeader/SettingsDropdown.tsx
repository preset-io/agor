import { SettingOutlined } from '@ant-design/icons';
import type { MenuProps } from 'antd';
import { Button, Dropdown, theme } from 'antd';
import type React from 'react';

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
