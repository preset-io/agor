import type { AgorClient, Board } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { expect, it, onTestFinished, vi } from 'vitest';
import { useAgorData } from '../../hooks/useAgorData';
import { useBoardPartition } from '../../hooks/useBoardPartition';
import { agorStore, useAgorStore } from '../../store/agorStore';
import { makeBoardReadySelector } from '../../store/boardPartitions';
import { fakeFeathersClient, ME, withTestAuthority } from '../../test/harness';
import { BoardPartitionStatus } from '../SessionCanvas/BoardPartitionStatus';
import { MobileBoardPage } from './MobileBoardPage';

// The board tab's canvas, reduced to the partition overlay it renders (React Flow
// and live cursors need a real socket).
vi.mock('../SessionCanvas/SessionCanvas', () => ({
  default: ({ board }: { board: Board }) => <BoardPartitionStatus boardId={board.board_id} />,
}));

// A real id: the cold route resolves its board by id or short-id prefix.
const BOARD = '01a012d8-1b9b-7909-b6f4-2024dfc7c51e';
const board = { board_id: BOARD, slug: 'delivery', name: 'Delivery', objects: {} } as Board;

/** The mobile shell's board route, wired as `MobileApp` wires it. */
function MobileBoardRoute({ client }: { client: AgorClient }) {
  useAgorData(client, {
    authenticatedUserId: ME,
    authenticatedUserRole: 'member',
    authGeneration: 1,
    connectionReady: true,
  });
  const { boardReady } = useBoardPartition(client, BOARD, { canUseMemberWorkspaceServices: true });
  const state = useAgorStore((s) => s);
  return (
    <MobileBoardPage
      client={client}
      boardById={state.boardById}
      branchById={state.branchById}
      onOpenBranch={vi.fn()}
      onNewSession={vi.fn()}
      onForkSession={vi.fn(async () => {})}
      onSpawnSession={vi.fn(async () => {})}
      onSendComment={vi.fn()}
      boardReady={boardReady}
    />
  );
}

withTestAuthority();

it('a cold mobile board whose partition fails offers Retry, and Retry loads it', async () => {
  window.history.pushState({}, '', `/m/board/${BOARD}`);
  onTestFinished(() => window.history.pushState({}, '', '/'));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  let partitionDown = true;
  const { client } = fakeFeathersClient({
    boards: { findAll: () => [board], get: () => board },
    branches: {
      findAll: ({ query }) => {
        if (query.board_id && partitionDown) throw new Error('board read failed');
        return [];
      },
    },
  });
  render(
    <MemoryRouter initialEntries={[`/m/board/${BOARD}`]}>
      <Routes>
        <Route path="/m/board/:boardId" element={<MobileBoardRoute client={client} />} />
      </Routes>
    </MemoryRouter>
  );

  // The global lists load; the board's partition fails: the canvas shows an error, not a spinner forever.
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent("Couldn't load this board.");
  expect(screen.queryByTestId('board-partition-loading')).toBeNull();

  partitionDown = false;
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(makeBoardReadySelector(BOARD)(agorStore.getState())).toBe(true));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
});
