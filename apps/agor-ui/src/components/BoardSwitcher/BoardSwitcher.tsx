import type { Board, Worktree } from '@agor-live/client';
import { DownOutlined, SearchOutlined } from '@ant-design/icons';
import type { MenuProps } from 'antd';
import { Badge, Button, Divider, Dropdown, Input, Space, Typography, theme } from 'antd';
import type React from 'react';
import { useCallback, useMemo, useState } from 'react';

const { Text } = Typography;
const { useToken } = theme;

const FILTER_THRESHOLD = 8;

interface BoardSwitcherProps {
  boards: Board[];
  currentBoardId: string;
  onBoardChange: (boardId: string) => void;
  worktreeById: Map<string, Worktree>;
}

export const BoardSwitcher: React.FC<BoardSwitcherProps> = ({
  boards,
  currentBoardId,
  onBoardChange,
  worktreeById,
}) => {
  const { token } = useToken();
  const [filterText, setFilterText] = useState('');
  const [dropdownOpen, setDropdownOpen] = useState(false);

  // Get current board
  const currentBoard = boards.find((b) => b.board_id === currentBoardId);

  // Count worktrees per board
  const worktreeCountByBoard = useMemo(() => {
    const counts = new Map<string, number>();

    // Initialize all boards with 0
    boards.forEach((board) => {
      counts.set(board.board_id, 0);
    });

    // Count worktrees for each board
    for (const worktree of worktreeById.values()) {
      if (worktree.board_id) {
        counts.set(worktree.board_id, (counts.get(worktree.board_id) || 0) + 1);
      }
    }

    return counts;
  }, [boards, worktreeById]);

  const showFilter = boards.length >= FILTER_THRESHOLD;

  const handleBoardClick = useCallback(
    (boardId: string) => {
      onBoardChange(boardId);
      setDropdownOpen(false);
      setFilterText('');
    },
    [onBoardChange]
  );

  // Build menu items (board list only — filter input rendered separately via dropdownRender)
  const menuItems: MenuProps['items'] = useMemo(() => {
    // Filter out archived boards, then sort alphabetically by name
    const sortedBoards = boards
      .filter((b) => !b.archived)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

    // Apply text filter
    const filteredBoards = filterText
      ? sortedBoards.filter((board) => board.name.toLowerCase().includes(filterText.toLowerCase()))
      : sortedBoards;

    if (showFilter && filteredBoards.length === 0) {
      return [
        {
          key: '__empty__',
          label: (
            <Text type="secondary" style={{ fontStyle: 'italic' }}>
              No boards found
            </Text>
          ),
          disabled: true,
        },
      ];
    }

    return filteredBoards.map((board) => {
      const worktreeCount = worktreeCountByBoard.get(board.board_id) || 0;
      const isActive = board.board_id === currentBoardId;

      return {
        key: board.board_id,
        label: (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              minWidth: 250,
              padding: '4px 0',
            }}
          >
            <Space size={8}>
              <span style={{ fontSize: 18 }}>{board.icon || '📋'}</span>
              <Text strong={isActive}>{board.name}</Text>
            </Space>
            <Badge
              count={worktreeCount}
              showZero
              style={{
                backgroundColor: isActive ? token.colorPrimary : token.colorBgTextHover,
              }}
            />
          </div>
        ),
        onClick: () => handleBoardClick(board.board_id),
      };
    });
  }, [
    boards,
    currentBoardId,
    worktreeCountByBoard,
    handleBoardClick,
    token,
    filterText,
    showFilter,
  ]);

  return (
    <Dropdown
      menu={{ items: menuItems }}
      trigger={['click']}
      placement="bottomLeft"
      open={dropdownOpen}
      onOpenChange={(open) => {
        setDropdownOpen(open);
        if (!open) {
          setFilterText('');
        }
      }}
      popupRender={(menu) =>
        showFilter ? (
          <div
            style={{
              backgroundColor: token.colorBgElevated,
              borderRadius: token.borderRadiusLG,
              boxShadow: token.boxShadowSecondary,
            }}
          >
            <div style={{ padding: '8px 12px' }}>
              <Input
                placeholder="Filter boards..."
                prefix={<SearchOutlined style={{ color: token.colorTextQuaternary }} />}
                value={filterText}
                onChange={(e) => setFilterText(e.target.value)}
                size="small"
                allowClear
                autoFocus
                aria-label="Filter boards"
              />
            </div>
            <Divider style={{ margin: 0 }} />
            <div style={{ maxHeight: 'calc(100vh - 200px)', overflowY: 'auto' }}>{menu}</div>
          </div>
        ) : (
          menu
        )
      }
    >
      <Button
        type="text"
        style={{
          width: '100%',
          height: 'auto',
          padding: '8px 12px',
          textAlign: 'left',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <Space size={8}>
          <span style={{ fontSize: 18 }}>{currentBoard?.icon || '📋'}</span>
          <Text strong>{currentBoard?.name || 'Select Board'}</Text>
        </Space>
        <DownOutlined style={{ fontSize: 12, color: token.colorTextSecondary }} />
      </Button>
    </Dropdown>
  );
};

export default BoardSwitcher;
