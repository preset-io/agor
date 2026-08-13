import type { AgorClient, Board, Branch, User } from '@agor-live/client';
import { DownOutlined, EditOutlined, HomeOutlined, SearchOutlined } from '@ant-design/icons';
import type { MenuProps } from 'antd';
import {
  Badge,
  Button,
  Divider,
  Dropdown,
  Grid,
  Input,
  Space,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import type React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useCanManageBoard } from '../../hooks/useCanManageBoard';
import { BoardEditModal } from '../BoardEditModal';
import { BoardTile, getBoardEmoji } from '../BoardTile';

const { Text } = Typography;
const { useToken } = theme;

const FILTER_THRESHOLD = 8;

function useCoarsePointer() {
  const [coarse, setCoarse] = useState(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia?.('(hover: none), (pointer: coarse)').matches
  );
  useEffect(() => {
    const query = window.matchMedia?.('(hover: none), (pointer: coarse)');
    if (!query) return;
    const update = () => setCoarse(query.matches);
    update();
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, []);
  return coarse;
}

interface BoardSwitcherProps {
  boards: Board[];
  currentBoardId?: string | null;
  onBoardChange: (boardId: string) => void;
  onHomeClick?: () => void;
  branchById: Map<string, Branch>;
  client?: AgorClient | null;
  currentUser?: User | null;
  onUpdateBoard?: (boardId: string, updates: Partial<Board>) => void | Promise<void>;
}

export const BoardSwitcher: React.FC<BoardSwitcherProps> = ({
  boards,
  currentBoardId,
  onBoardChange,
  onHomeClick,
  branchById,
  client = null,
  currentUser,
  onUpdateBoard,
}) => {
  const { token } = useToken();
  const [filterText, setFilterText] = useState('');
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [triggerActive, setTriggerActive] = useState(false);
  const screens = Grid.useBreakpoint();
  const coarsePointer = useCoarsePointer();

  const currentBoard = boards.find((b) => b.board_id === currentBoardId);
  const canManage = useCanManageBoard(client, currentBoard, currentUser);

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
              <BoardTile emoji={getBoardEmoji(board, branchById)} size={24} />
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
  }, [
    boards,
    currentBoardId,
    branchCountByBoard,
    branchById,
    handleBoardClick,
    token,
    filterText,
    showFilter,
  ]);

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
        <HomeOutlined style={{ fontSize: 18 }} />
        <Text strong={!currentBoardId}>Home</Text>
      </Space>
    </Button>
  );

  const editButton = canManage && currentBoard && (
    <Tooltip title="Edit current board">
      <Button
        type="text"
        size="small"
        icon={<EditOutlined />}
        aria-label={`Edit current board: ${currentBoard.name}`}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setDropdownOpen(false);
          setEditing(true);
        }}
      />
    </Tooltip>
  );

  return (
    <>
      <div
        style={{ position: 'relative', width: '100%' }}
        onPointerEnter={() => setTriggerActive(true)}
        onPointerLeave={() => setTriggerActive(false)}
        onFocus={() => setTriggerActive(true)}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setTriggerActive(false);
        }}
      >
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
            <Space size={8} style={{ minWidth: 0, overflow: 'hidden' }}>
              {currentBoard ? (
                <BoardTile emoji={getBoardEmoji(currentBoard, branchById)} size={24} />
              ) : (
                <HomeOutlined style={{ fontSize: 18 }} />
              )}
              <Text strong ellipsis style={{ minWidth: 0 }}>
                {currentBoard?.name || 'Home'}
              </Text>
            </Space>
            <DownOutlined style={{ fontSize: 12, color: token.colorTextSecondary }} />
          </Button>
        </Dropdown>
        {editButton && (
          <span
            style={{
              position: 'absolute',
              // Keep one base spacing unit between the overlay action and the
              // dropdown caret without reserving any navbar layout width.
              right: token.paddingLG + token.sizeUnit,
              top: '50%',
              transform: 'translateY(-50%)',
              opacity: !screens.md || coarsePointer || triggerActive ? 1 : 0,
              pointerEvents: !screens.md || coarsePointer || triggerActive ? 'auto' : 'none',
              transition: `opacity ${token.motionDurationFast}`,
            }}
          >
            {editButton}
          </span>
        )}
      </div>
      <BoardEditModal
        board={currentBoard ?? null}
        client={client}
        open={editing && Boolean(currentBoard)}
        onClose={() => setEditing(false)}
        onUpdate={onUpdateBoard}
      />
    </>
  );
};

export default BoardSwitcher;
