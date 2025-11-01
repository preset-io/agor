import type { Board } from '@agor/core/types';
import { Collapse, Typography, theme } from 'antd';
import type { ReactNode } from 'react';

const { Text } = Typography;

export interface BoardCollapseItem {
  key: string;
  board: Board;
  badge?: ReactNode;
  children: ReactNode;
}

interface BoardCollapseProps {
  items: BoardCollapseItem[];
  defaultActiveKey?: string[];
}

/**
 * Reusable Board-level collapse component with panel styling
 * Matches CommentsPanel aesthetic with board icon + name in header
 */
export const BoardCollapse: React.FC<BoardCollapseProps> = ({ items, defaultActiveKey }) => {
  const { token } = theme.useToken();

  return (
    <Collapse
      defaultActiveKey={defaultActiveKey}
      style={{
        border: 'none',
        backgroundColor: 'transparent',
        width: '100%',
      }}
      items={items.map(({ key, board, badge, children }) => ({
        key,
        label: (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {board.icon && <span style={{ fontSize: 16 }}>{board.icon}</span>}
            <Text strong style={{ fontSize: 14 }}>
              {board.name}
            </Text>
            {badge}
          </div>
        ),
        style: {
          marginBottom: 8,
          backgroundColor: token.colorBgContainer,
          borderRadius: 0,
          border: `1px solid ${token.colorBorder}`,
        },
        children: (
          <div
            style={{
              backgroundColor: token.colorBgLayout,
              margin: -16,
              padding: 16,
            }}
          >
            {children}
          </div>
        ),
      }))}
    />
  );
};
