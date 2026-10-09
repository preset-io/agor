import { Spin, Typography, theme } from 'antd';
import { memo, useMemo } from 'react';
import { useAgorStore } from '../../store/agorStore';
import {
  makeBoardPartitionSelector,
  makeBoardReadySelector,
  retryBoardPartition,
} from '../../store/boardPartitions';
import { CompactNotice } from '../CompactNotice';

/** A failed partition load, with a Try again that loads it again (`retryBoardPartition`). */
export function BoardPartitionError({
  boardId,
  style,
}: {
  boardId: string;
  style?: React.CSSProperties;
}) {
  const partition = useAgorStore(useMemo(() => makeBoardPartitionSelector(boardId), [boardId]));
  const raw = partition?.status === 'error' ? partition.error : undefined;
  return (
    <div style={style} data-testid="board-partition-error">
      <CompactNotice
        type="error"
        role="alert"
        message="Couldn't load this board."
        details={raw ? [{ label: 'Error', value: raw, code: true }] : undefined}
        actions={[{ label: 'Try again', onClick: () => retryBoardPartition(boardId) }]}
      />
    </div>
  );
}

/**
 * Canvas overlay for a board whose partition is not complete yet (invariant
 * I1): a centered spinner while the board has no placements at all, otherwise
 * a small "Syncing · read-only" pill over the partially known board (the
 * canvas pauses structural edits until it is loaded); an inline retry when
 * the load failed. Self-subscribes so the canvas never re-renders for it.
 */
export const BoardPartitionStatus = memo(function BoardPartitionStatus({
  boardId,
}: {
  boardId: string | undefined;
}) {
  const { token } = theme.useToken();
  const ready = useAgorStore(useMemo(() => makeBoardReadySelector(boardId), [boardId]));
  const partition = useAgorStore(useMemo(() => makeBoardPartitionSelector(boardId), [boardId]));
  const hasPlacements = useAgorStore((s) =>
    boardId ? (s.boardObjectsByBoardId.get(boardId)?.length ?? 0) > 0 : false
  );
  if (!boardId || ready) return null;

  const pillStyle: React.CSSProperties = {
    position: 'absolute',
    top: token.marginSM,
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: 5,
    display: 'flex',
    alignItems: 'center',
    gap: token.marginXS,
    padding: `${token.paddingXXS}px ${token.paddingSM}px`,
    borderRadius: token.borderRadiusLG,
    background: token.colorBgElevated,
    border: `1px solid ${token.colorBorderSecondary}`,
    boxShadow: token.boxShadowTertiary,
  };

  if (partition?.status === 'error')
    return (
      <BoardPartitionError
        boardId={boardId}
        style={{
          position: 'absolute',
          top: token.marginSM,
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 5,
          maxWidth: `calc(100% - ${token.marginLG * 2}px)`,
        }}
      />
    );

  if (!hasPlacements) {
    return (
      <div
        data-testid="board-partition-loading"
        style={{
          position: 'absolute',
          inset: 0,
          zIndex: 5,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: token.marginSM,
          pointerEvents: 'none',
        }}
      >
        <Spin />
        <Typography.Text type="secondary">Loading board…</Typography.Text>
      </div>
    );
  }

  return (
    <div style={pillStyle} data-testid="board-syncing-pill" aria-live="polite">
      <Spin size="small" />
      <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
        Syncing · read-only
      </Typography.Text>
    </div>
  );
});
