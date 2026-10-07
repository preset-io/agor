/**
 * Settings → Boards counts each board's active sessions with count-only reads,
 * so the counts are right with the store's branch and session maps empty
 * (Step 3).
 */
import type { Board } from '@agor-live/client';
import { screen, waitFor, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import { fakeFeathersClient, mount, page, withTestAuthority } from '../../test/harness';
import { BoardsTable } from './BoardsTable';

const board = (n: number) =>
  ({ board_id: `board-${n}`, name: `Board ${n}`, slug: `board-${n}` }) as unknown as Board;

withTestAuthority('me:member:1', { dataAuthority: false });

it('counts every board’s active sessions on the daemon', async () => {
  const fake = fakeFeathersClient({
    sessions: { find: ({ query }) => page([], query.board_id === 'board-1' ? 4 : 0) },
  });
  mount(
    <BoardsTable
      client={fake.client}
      boardById={new Map([board(1), board(2)].map((b) => [b.board_id, b]))}
      branchById={new Map()}
    />
  );
  const row = (await screen.findByText('Board 1')).closest('tr') as HTMLElement;
  expect(await within(row).findByText('4')).toBeInTheDocument();
  expect(fake.client.service('sessions').find).toHaveBeenCalledWith({
    query: { board_id: 'board-1', archived: false, $limit: 0 },
  });
});

it('counts sessions only for the boards on the visible page', async () => {
  const fake = fakeFeathersClient({ sessions: { find: () => page([], 1) } });
  const boards = Array.from({ length: 15 }, (_, i) => board(i + 10));
  mount(
    <BoardsTable
      client={fake.client}
      boardById={new Map(boards.map((b) => [b.board_id, b]))}
      branchById={new Map()}
    />
  );
  await screen.findByText('Board 10');
  await waitFor(() => expect(fake.client.service('sessions').find).toHaveBeenCalled());
  const counted = fake.queries('sessions', 'find').map((query) => query.board_id);
  expect(new Set(counted).size).toBe(10);
  expect(screen.queryByText('Board 24')).not.toBeInTheDocument();
});
