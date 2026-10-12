/**
 * Settings → Boards counts each board's active sessions with the
 * `session-counts` aggregate, so the counts are right with the store's branch
 * and session maps empty (Step 3).
 */
import type { Board } from '@agor-live/client';
import { screen, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import { fakeFeathersClient, mount, withTestAuthority } from '../../test/harness';
import { BoardsTable } from './BoardsTable';

const board = (n: number) =>
  ({ board_id: `board-${n}`, name: `Board ${n}`, slug: `board-${n}` }) as unknown as Board;

withTestAuthority('me:member:1', { dataAuthority: false });

it('counts every board’s active sessions with one aggregate read', async () => {
  const fake = fakeFeathersClient({
    'session-counts': { find: () => [{ id: 'board-1', session_count: 4 }] },
  });
  const boards = [board(1), ...Array.from({ length: 14 }, (_, i) => board(i + 10))];
  mount(
    <BoardsTable
      client={fake.client}
      boardById={new Map(boards.map((b) => [b.board_id, b]))}
      branchById={new Map()}
    />
  );
  const row = (await screen.findByText('Board 1')).closest('tr') as HTMLElement;
  expect(await within(row).findByText('4')).toBeInTheDocument();
  // A board without active sessions counts 0; every board is listed.
  const other = (await screen.findByText('Board 23')).closest('tr') as HTMLElement;
  expect(within(other).getByText('0')).toBeInTheDocument();
  expect(fake.queries('session-counts', 'find')).toEqual([{ group_by: 'board_id' }]);
  expect(fake.callsTo('sessions')).toEqual([]);
});
