import type { AgorClient, Board, Branch, User } from '@agor-live/client';
import { DownOutlined, EditOutlined, HomeOutlined, SearchOutlined } from '@ant-design/icons';
import type { MenuProps } from 'antd';
import {
  Badge,
  Button,
  Divider,
  Dropdown,
  Flex,
  Grid,
  Input,
  Space,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  const [keyboardTooltipBoardId, setKeyboardTooltipBoardId] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
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
    setKeyboardTooltipBoardId(null);
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
          <Flex align="center" gap={8} style={{ padding: '4px 0' }}>
            <Flex align="center" gap={8} style={{ flex: 1, minWidth: 0 }}>
              <BoardTile emoji={getBoardEmoji(board, branchById)} size={24} />
              <Text
                strong={isActive}
                ellipsis={{
                  tooltip:
                    keyboardTooltipBoardId === board.board_id
                      ? { title: board.name, open: true }
                      : board.name,
                }}
                style={{ flex: 1, minWidth: 0 }}
                data-board-name
              >
                {board.name}
              </Text>
            </Flex>
            <Badge
              count={branchCount}
              showZero
              styles={{
                root: { flexShrink: 0 },
                indicator: {
                  backgroundColor: isActive ? token.colorPrimary : token.colorBgTextHover,
                },
              }}
            />
          </Flex>
        ),
        onClick: () => handleBoardClick(board.board_id),
        onFocus: (event: React.FocusEvent<HTMLLIElement>) => {
          const name = event.currentTarget.querySelector<HTMLElement>('[data-board-name]');
          setKeyboardTooltipBoardId(
            name && name.scrollWidth > name.clientWidth ? board.board_id : null
          );
        },
        onBlur: () => setKeyboardTooltipBoardId(null),
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
    keyboardTooltipBoardId,
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

  // The edit button is overlaid absolutely (it can't be a DOM child of the
  // trigger <button>), so it reserves no layout width. Reserve matching room at
  // the end of the name row so the ellipsized board name truncates *before* the
  // pencil instead of rendering underneath it. Only reserve when the action can
  // actually appear, so boards without an edit shortcut keep the full width.
  const editActionReserve = editButton ? token.controlHeightSM + token.paddingSM : 0;

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
          styles={{ itemContent: { minWidth: 0 } }}
          trigger={['click']}
          placement="bottomLeft"
          open={dropdownOpen}
          onOpenChange={(open) => {
            const restoreTriggerFocus =
              !open && popupRef.current?.contains(document.activeElement) === true;
            setDropdownOpen(open);
            if (!open) {
              setFilterText('');
              setKeyboardTooltipBoardId(null);
              if (restoreTriggerFocus) {
                window.requestAnimationFrame(() => triggerRef.current?.focus());
              }
            }
          }}
          popupRender={(menu) => (
            <div
              ref={popupRef}
              data-testid="board-switcher-popup"
              tabIndex={-1}
              onFocus={(event) => {
                if (event.target === event.currentTarget) {
                  event.currentTarget.querySelector<HTMLElement>('[role="menu"]')?.focus();
                }
              }}
              style={{
                backgroundColor: token.colorBgElevated,
                borderRadius: token.borderRadiusLG,
                boxShadow: token.boxShadowSecondary,
                width: 320,
                maxWidth: `calc(100vw - ${token.marginLG * 2}px)`,
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
            ref={triggerRef}
            type="text"
            style={{
              width: '100%',
              height: 'auto',
              padding: '8px 12px',
              textAlign: 'left',
              display: 'flex',
              alignItems: 'center',
            }}
          >
            <Flex
              align="center"
              gap={8}
              style={{ flex: 1, minWidth: 0, marginRight: editActionReserve }}
            >
              {currentBoard ? (
                <BoardTile emoji={getBoardEmoji(currentBoard, branchById)} size={24} />
              ) : (
                <HomeOutlined style={{ fontSize: 18 }} />
              )}
              <Text strong ellipsis style={{ flex: 1, minWidth: 0 }} data-current-board-name>
                {currentBoard?.name || 'Home'}
              </Text>
            </Flex>
            <DownOutlined
              style={{ fontSize: 12, color: token.colorTextSecondary, flexShrink: 0 }}
            />
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
        currentUser={currentUser}
      />
    </>
  );
};

export default BoardSwitcher;
