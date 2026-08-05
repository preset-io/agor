import type { Board, Branch, Session } from '@agor-live/client';
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
  sessionById: Map<string, Session>;
}

export const BoardSwitcher: React.FC<BoardSwitcherProps> = ({
  boards,
  currentBoardId,
  onBoardChange,
  onHomeClick,
  branchById,
  sessionById,
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

  // Per-board count of branches needing attention, surfaced here so users
  // can spot boards with waiting work without visiting each one. A branch
  // counts when its `needs_attention` flag is set (new branches default to
  // true) OR any of its active (non-archived) sessions is `ready_for_prompt`
  // — the same predicate that drives the glow halo on branch cards, so the
  // badge and the canvas never disagree. Archived branches are hidden from
  // boards and therefore excluded.
  const attentionCountByBoard = useMemo(() => {
    const readyBranchIds = new Set<string>();
    for (const session of sessionById.values()) {
      if (session.branch_id && !session.archived && session.ready_for_prompt === true) {
        readyBranchIds.add(session.branch_id);
      }
    }
    const counts = new Map<string, number>();
    for (const branch of branchById.values()) {
      if (!branch.board_id || branch.archived) continue;
      if (branch.needs_attention || readyBranchIds.has(branch.branch_id)) {
        counts.set(branch.board_id, (counts.get(branch.board_id) || 0) + 1);
      }
    }
    return counts;
  }, [branchById, sessionById]);

  // Attention on the *current* board is already visible on the canvas
  // itself, so the closed-trigger dot only fires for other boards.
  const otherBoardsNeedAttention = useMemo(() => {
    for (const [boardId, count] of attentionCountByBoard) {
      if (count > 0 && boardId !== currentBoardId) return true;
    }
    return false;
  }, [attentionCountByBoard, currentBoardId]);

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
      const attentionCount = attentionCountByBoard.get(board.board_id) || 0;
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
            <Space size={6}>
              {attentionCount > 0 && (
                <Badge
                  count={attentionCount}
                  title={`${attentionCount} ${attentionCount === 1 ? 'branch needs' : 'branches need'} attention`}
                  style={{ backgroundColor: token.colorWarning }}
                />
              )}
              <Badge
                count={branchCount}
                showZero
                title={`${branchCount} ${branchCount === 1 ? 'branch' : 'branches'} on this board`}
                style={{ backgroundColor: isActive ? token.colorPrimary : token.colorBgTextHover }}
              />
            </Space>
          </div>
        ),
        onClick: () => handleBoardClick(board.board_id),
      };
    });
  }, [
    boards,
    currentBoardId,
    branchCountByBoard,
    attentionCountByBoard,
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
          <Badge
            dot={otherBoardsNeedAttention}
            color={token.colorWarning}
            offset={[-2, 4]}
            title={otherBoardsNeedAttention ? 'Another board has branches needing attention' : ''}
          >
            <span style={{ fontSize: 18 }}>{currentBoard ? currentBoard.icon || '📋' : '🏠'}</span>
          </Badge>
          <Text strong>{currentBoard?.name || 'Home'}</Text>
        </Space>
        <DownOutlined style={{ fontSize: 12, color: token.colorTextSecondary }} />
      </Button>
    </Dropdown>
  );
};

export default BoardSwitcher;
