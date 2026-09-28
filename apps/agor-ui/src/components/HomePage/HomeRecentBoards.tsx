import type { Board } from '@agor-live/client';
import { Badge, Button, Flex, Typography, theme } from 'antd';
import { memo, useMemo } from 'react';
import { agorStore, shallow, useAgorStore, useStoreWithEqualityFn } from '../../store/agorStore';
import { makeBoardSessionActivitySelector } from '../../store/selectors';
import { BoardTile, getBoardEmoji } from '../BoardTile';
import { glassCardStyle } from '../GlassSurface/glassStyles';
import { HomeLink, useHomeCompact } from './HomeSection';

const RecentBoardPill: React.FC<{ board: Board; onClick: (boardId: string) => void }> = ({
  board,
  onClick,
}) => {
  const { token } = theme.useToken();
  const isMobile = useHomeCompact();
  const activity = useStoreWithEqualityFn(
    agorStore,
    useMemo(() => makeBoardSessionActivitySelector(board.board_id), [board.board_id]),
    shallow
  );
  const status = activity.hasReady ? 'needs you' : activity.hasRunning ? 'running' : null;
  return (
    <Button
      shape="round"
      size="small"
      aria-label={status ? `${board.name}, ${status}` : board.name}
      title={board.name}
      styles={{ content: { minWidth: 0, overflow: 'hidden' } }}
      onClick={() => onClick(board.board_id)}
      style={{
        ...glassCardStyle(token, 0.3),
        maxWidth: isMobile ? 110 : 190,
      }}
    >
      <BoardTile
        emoji={getBoardEmoji(board)}
        size={18}
        style={{ background: 'transparent', fontSize: token.fontSize }}
      />
      <Typography.Text ellipsis style={{ minWidth: 0 }}>
        {board.name}
      </Typography.Text>
      {status && <Badge status={activity.hasReady ? 'warning' : 'success'} />}
    </Button>
  );
};

/** One slim row of the caller's last visited boards. */
export const HomeRecentBoards = memo(function HomeRecentBoards({
  recentBoardIds,
  onBoardClick,
  onAllBoards,
}: {
  recentBoardIds: string[];
  onBoardClick: (boardId: string) => void;
  onAllBoards: () => void;
}) {
  const { token } = theme.useToken();
  const isMobile = useHomeCompact();
  const limit = isMobile ? 3 : 5;
  const boardById = useAgorStore((s) => s.boardById);
  const boards = useMemo(
    () =>
      recentBoardIds
        .map((id) => boardById.get(id))
        .filter((board): board is Board => !!board && !board.archived)
        .slice(0, limit),
    [boardById, recentBoardIds, limit]
  );
  if (boards.length === 0) return null;
  return (
    <Flex align="center" gap={token.marginXS} wrap aria-label="Recent boards" role="group">
      {!isMobile && (
        <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
          Recent boards
        </Typography.Text>
      )}
      {boards.map((board) => (
        <RecentBoardPill key={board.board_id} board={board} onClick={onBoardClick} />
      ))}
      <HomeLink onClick={onAllBoards}>All boards</HomeLink>
    </Flex>
  );
});
