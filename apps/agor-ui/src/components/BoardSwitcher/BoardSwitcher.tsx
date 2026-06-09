import type { Board, Branch } from '@agor-live/client';
import { DownOutlined, HomeOutlined, SearchOutlined } from '@ant-design/icons';
import type { MenuProps } from 'antd';
import { Badge, Button, Divider, Dropdown, Input, Space, Typography, theme } from 'antd';
import type React from 'react';
import { useCallback, useMemo, useState } from 'react';

const { Text } = Typography;
const { useToken } = theme;

const FILTER_THRESHOLD = 8;

interface BoardSwitcherProps {
  boards: Board[];
  currentBoardId?: string | null;
  onBoardChange: (boardId: string) => void;
  onHomeClick?: () => void;
  branchById: Map<string, Branch>;
}

export const BoardSwitcher: React.FC<BoardSwitcherProps> = ({
  boards,
  currentBoardId,
  onBoardChange,
  onHomeClick,
  branchById,
}) => {
  const { token } = useToken();
  const [filterText, setFilterText] = useState('');
  const [dropdownOpen, setDropdownOpen] = useState(false);

  const currentBoard = boards.find((b) => b.board_id === currentBoardId);

  const branchCountByBoard = useMemo(() => {
    const counts = new Map<string, number>();
    boards.forEach((board) => {
      counts.set(board.board_id, 0);
    });
    for (const branch of branchById.values()) {
      if (branch.board_id) counts.set(branch.board_id, (counts.get(branch.board_id) || 0) + 1);
    }
    return counts;
  }, [boards, branchById]);

  const showFilter = boards.length >= FILTER_THRESHOLD;

  const closeDropdown = useCallback(() => {
    setDropdownOpen(false);
    setFilterText('');
  }, []);

  const handleHomeClick = useCallback(() => {
    onHomeClick?.();
    closeDropdown();
  }, [closeDropdown, onHomeClick]);

  const handleBoardClick = useCallback(
    (boardId: string) => {
      onBoardChange(boardId);
      closeDropdown();
    },
    [onBoardChange, closeDropdown]
  );

  const boardMenuItems: MenuProps['items'] = useMemo(() => {
    const sortedBoards = boards
      .filter((b) => !b.archived)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
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
      const branchCount = branchCountByBoard.get(board.board_id) || 0;
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
              count={branchCount}
              showZero
              style={{ backgroundColor: isActive ? token.colorPrimary : token.colorBgTextHover }}
            />
          </div>
        ),
        onClick: () => handleBoardClick(board.board_id),
      };
    });
  }, [boards, currentBoardId, branchCountByBoard, handleBoardClick, token, filterText, showFilter]);

  const homeRow = (
    <Button
      type="text"
      onClick={handleHomeClick}
      style={{
        width: '100%',
        height: 38,
        padding: '4px 12px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        background: !currentBoardId ? token.colorFillSecondary : undefined,
        borderRadius: token.borderRadiusSM,
      }}
    >
      <Space size={8}>
        <span style={{ fontSize: 18 }}>🏠</span>
        <Text strong={!currentBoardId}>Home</Text>
      </Space>
      <HomeOutlined style={{ color: token.colorTextTertiary }} />
    </Button>
  );

  return (
    <Dropdown
      menu={{ items: boardMenuItems }}
      trigger={['click']}
      placement="bottomLeft"
      open={dropdownOpen}
      onOpenChange={(open) => {
        setDropdownOpen(open);
        if (!open) setFilterText('');
      }}
      popupRender={(menu) => (
        <div
          style={{
            backgroundColor: token.colorBgElevated,
            borderRadius: token.borderRadiusLG,
            boxShadow: token.boxShadowSecondary,
            minWidth: 290,
          }}
        >
          <div
            style={{
              position: 'sticky',
              top: 0,
              zIndex: 1,
              padding: '8px 8px 0',
              background: token.colorBgElevated,
              borderTopLeftRadius: token.borderRadiusLG,
              borderTopRightRadius: token.borderRadiusLG,
            }}
          >
            {homeRow}
            <Divider style={{ margin: '8px 0 0' }} />
          </div>
          {showFilter && (
            <>
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
            </>
          )}
          <div style={{ maxHeight: 'calc(100vh - 240px)', overflowY: 'auto' }}>{menu}</div>
        </div>
      )}
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
          <span style={{ fontSize: 18 }}>{currentBoard ? currentBoard.icon || '📋' : '🏠'}</span>
          <Text strong>{currentBoard?.name || 'Home'}</Text>
        </Space>
        <DownOutlined style={{ fontSize: 12, color: token.colorTextSecondary }} />
      </Button>
    </Dropdown>
  );
};

export default BoardSwitcher;
