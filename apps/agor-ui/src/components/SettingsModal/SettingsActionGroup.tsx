import type { SpaceProps } from 'antd';
import { Space, theme } from 'antd';

/**
 * Compact-but-clickable spacing for icon-only actions in Settings tables.
 * Ant's `small` Space is 8px, which gets wide when rows have 4+ icon buttons.
 */
export function SettingsActionGroup({ children, size, ...props }: SpaceProps) {
  const { token } = theme.useToken();
  return (
    <Space size={size ?? token.sizeUnit} {...props}>
      {children}
    </Space>
  );
}
