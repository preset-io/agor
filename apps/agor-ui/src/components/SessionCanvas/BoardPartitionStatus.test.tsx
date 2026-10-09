import type { BoardEntityObject } from '@agor-live/client';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agorStore } from '../../store/agorStore';
import { boardScopeKey } from '../../store/scopeMerge';
import { boardCoverage } from '../../test/userScopeCoverage';
import { BoardPartitionStatus } from './BoardPartitionStatus';

const BOARD = 'board-1';
const setPartition = (status: 'loading' | 'loaded' | 'error') =>
  agorStore.getState().setCoverage(boardScopeKey(BOARD), boardCoverage(status));

describe('BoardPartitionStatus', () => {
  beforeEach(() => agorStore.getState().reset());
  afterEach(() => agorStore.getState().reset());

  it('centers a loading spinner while the board has no placements', () => {
    setPartition('loading');
    render(<BoardPartitionStatus boardId={BOARD} />);
    expect(screen.getByTestId('board-partition-loading')).toHaveTextContent('Loading board');
  });

  it('shows a syncing pill over a partially known board, and nothing once ready', () => {
    setPartition('loading');
    agorStore
      .getState()
      .setMap(
        'boardObjectsByBoardId',
        new Map([[BOARD, [{ object_id: 'o-1', board_id: BOARD } as BoardEntityObject]]])
      );
    render(<BoardPartitionStatus boardId={BOARD} />);
    expect(screen.getByTestId('board-syncing-pill')).toBeInTheDocument();
    act(() => setPartition('loaded'));
    expect(screen.queryByTestId('board-syncing-pill')).not.toBeInTheDocument();
  });

  it('offers an inline retry after a failed load', () => {
    setPartition('error');
    render(<BoardPartitionStatus boardId={BOARD} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(agorStore.getState().coverage.has(boardScopeKey(BOARD))).toBe(false);
  });
});
