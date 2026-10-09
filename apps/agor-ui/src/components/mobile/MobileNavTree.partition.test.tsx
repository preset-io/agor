/**
 * The mobile nav tree loads a board's branches and sessions when the board is
 * expanded (its partition, in the background), so it works with the store's
 * branch and session maps empty (Step 3).
 */
import type { AgorClient } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import { agorStore, useAgorStore } from '../../store/agorStore';
import { getDisplayedBoardId } from '../../store/boardPartitions';
import { selectBranchById, selectSessionsByBranch } from '../../store/selectors';
import {
  fakeFeathersClient,
  makeBoard,
  makeBranch,
  makeSession,
  withTestAuthority,
} from '../../test/harness';
import { MobileNavTree } from './MobileNavTree';

const board = makeBoard('board-1', { name: 'Delivery' });
const branch = makeBranch('branch-1', { name: 'checkout-flow' });
const session = makeSession('session-1', 'branch-1', {
  title: 'Fix the cart',
  last_updated: '2026-10-01T00:00:00.000Z',
});

function makeClient() {
  const fake = fakeFeathersClient({
    branches: { findAll: () => [branch] },
    sessions: { findAll: () => [session] },
    boards: { get: () => ({ ...board, objects: {} }) },
    'branch-counts': { find: () => [{ board_id: board.board_id, branch_count: 4 }] },
  });
  const reads = () => fake.calls.filter((c) => c.method === 'findAll').map((c) => c.service);
  return { client: fake.client, reads };
}

function Tree({ client }: { client: AgorClient }) {
  const branchById = useAgorStore(selectBranchById);
  const sessionsByBranch = useAgorStore(selectSessionsByBranch);
  return (
    <MemoryRouter>
      <MobileNavTree
        client={client}
        canUseMemberWorkspaceServices
        boardById={new Map([[board.board_id, board]])}
        branchById={branchById}
        sessionsByBranch={sessionsByBranch}
        commentById={new Map()}
        onOpenWorkspaceSettings={vi.fn()}
        onOpenUserSettings={vi.fn()}
      />
    </MemoryRouter>
  );
}

withTestAuthority('user-a:member:1');
beforeEach(() => agorStore.getState().setMap('boardById', new Map([[board.board_id, board]])));

it('loads an expanded board in the background and lists its branches and sessions', async () => {
  const { client, reads } = makeClient();
  render(<Tree client={client} />);
  // Collapsed boards read nothing.
  expect(reads()).toEqual([]);

  const expand = () =>
    screen.getAllByRole('button').find((el) => el.getAttribute('aria-expanded') === 'false');
  fireEvent.click(expand() as HTMLElement);
  expect(await screen.findByText('checkout-flow')).toBeInTheDocument();
  fireEvent.click(expand() as HTMLElement);
  expect(await screen.findByText('Fix the cart')).toBeInTheDocument();
  await waitFor(() => expect(reads()).toContain('sessions'));
  // A navigation list never takes the displayed board's place.
  expect(getDisplayedBoardId()).toBeUndefined();
});

it("badges a collapsed board with its branch-counts aggregate, not the store's branches", async () => {
  const { client, reads } = makeClient();
  render(<Tree client={client} />);
  await waitFor(() => expect(document.querySelector('.ant-badge-count')).toHaveTextContent('4'));
  expect(reads()).toEqual([]);
});

it('says so when there are no boards', () => {
  const { client } = makeClient();
  render(
    <MemoryRouter>
      <MobileNavTree
        client={client}
        canUseMemberWorkspaceServices
        boardById={new Map()}
        branchById={new Map()}
        sessionsByBranch={new Map()}
        commentById={new Map()}
        onOpenWorkspaceSettings={vi.fn()}
        onOpenUserSettings={vi.fn()}
      />
    </MemoryRouter>
  );
  expect(screen.getByText('No boards yet.')).toBeInTheDocument();
});
