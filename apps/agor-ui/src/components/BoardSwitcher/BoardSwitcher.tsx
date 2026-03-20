import type { Board, Worktree } from '@agor/core/types';
import { DownOutlined, SearchOutlined } from '@ant-design/icons';
import type { MenuProps } from 'antd';
import { Badge, Button, Dropdown, Input, Space, Typography, theme } from 'antd';
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

  // Build menu items
  const menuItems: MenuProps['items'] = useMemo(() => {
    // Sort boards alphabetically by name
    const sortedBoards = [...boards].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    );

    // Apply text filter
    const filteredBoards = filterText
      ? sortedBoards.filter((board) => board.name.toLowerCase().includes(filterText.toLowerCase()))
      : sortedBoards;

    const boardItems: NonNullable<MenuProps['items']> = filteredBoards.map((board) => {
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

    if (!showFilter) {
      return boardItems;
    }

    // Prepend the search input as a non-clickable menu item
    return [
      {
        key: '__filter__',
        label: (
          <div
            style={{ padding: '4px 0' }}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <Input
              placeholder="Filter boards..."
              prefix={<SearchOutlined style={{ color: token.colorTextQuaternary }} />}
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              size="small"
              allowClear
              autoFocus
            />
          </div>
        ),
        disabled: true,
        style: { cursor: 'default', opacity: 1 },
      },
      { type: 'divider' as const },
      ...boardItems,
    ];
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
      menu={{
        items: menuItems,
        style: showFilter ? { maxHeight: 400, overflowY: 'auto' } : undefined,
      }}
      trigger={['click']}
      placement="bottomLeft"
      open={dropdownOpen}
      onOpenChange={(open) => {
        setDropdownOpen(open);
        if (!open) {
          setFilterText('');
        }
      }}
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
