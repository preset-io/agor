import type { AgorClient, Board, Branch, Repo, User } from '@agor-live/client';
import { act, render, screen, waitFor } from '@testing-library/react';
import { App } from 'antd';
import { beforeEach, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import '../../index.css';
import { ConnectionProvider } from '../../contexts/ConnectionContext';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { boardPatched, branchPatched } from '../../store/agorRealtimeActions';
import { agorStore, useAgorStore } from '../../store/agorStore';
import { makeTeammateBranch } from '../BranchModal/testUtils';
import { BoardTeammatePanel } from './BoardTeammatePanel';

const board = {
  board_id: 'board-1',
  name: 'Board',
  primary_teammate_id: 'old',
  primary_owner_user_id: 'owner',
} as Board;
const old = makeTeammateBranch(
  {
    branch_id: 'old' as Branch['branch_id'],
    board_id: board.board_id,
    repo_id: 'repo-1' as Branch['repo_id'],
    name: 'Old',
    filesystem_status: 'ready',
  },
  { displayName: 'Old teammate' }
);
const replacement = makeTeammateBranch(
  {
    branch_id: 'new' as Branch['branch_id'],
    board_id: board.board_id,
    repo_id: old.repo_id,
    name: 'New',
    filesystem_status: 'ready',
  },
  { displayName: 'New teammate' }
);
const repo = { repo_id: old.repo_id, slug: 'test/repo' } as Repo;
const user = { user_id: 'editor', role: 'member', name: 'Editor' } as User;

beforeEach(() => {
  localStorage.clear();
  agorStore.setState({
    ...EMPTY_MAPS,
    boardById: new Map([[board.board_id, board]]),
    branchById: new Map([
      [old.branch_id, old],
      [replacement.branch_id, replacement],
    ]),
    repoById: new Map([[repo.repo_id, repo]]),
    userById: new Map([[user.user_id, user]]),
  });
});
function mount(role: 'editor' | 'manager' | 'viewer' | 'error' = 'editor', inaccessible = false) {
  const retryProvisioning = vi.fn().mockResolvedValue(old);
  const setPrimaryTeammate = vi.fn().mockResolvedValue(board);
  const clearPrimaryTeammate = vi.fn().mockResolvedValue({ ...board, primary_teammate_id: null });
  const find =
    role === 'error'
      ? vi.fn().mockRejectedValue(new Error('offline'))
      : vi.fn().mockResolvedValue({
          role,
          capabilities: role === 'viewer' ? ['board.view'] : ['board.view', 'board.edit'],
        });
  const client = {
    service: (path: string) =>
      path === 'boards/:id/effective-access'
        ? { find }
        : path === `branches/${old.branch_id}/retry-provisioning`
          ? { create: retryProvisioning }
          : { setPrimaryTeammate, clearPrimaryTeammate },
  } as unknown as AgorClient;
  function Panel() {
    const current = useAgorStore((state) => state.boardById.get(board.board_id))!;
    const branch = useAgorStore((state) =>
      current.primary_teammate_id ? state.branchById.get(current.primary_teammate_id) : undefined
    );
    return (
      <BoardTeammatePanel
        board={current}
        activeTab="teammate"
        currentUserId={user.user_id}
        primaryTeammateBranch={inaccessible ? undefined : branch}
        primaryTeammateRepo={repo}
        primaryTeammateInaccessible={inaccessible}
        onSessionClick={vi.fn()}
        client={client}
      />
    );
  }
  render(
    <App>
      <ConnectionProvider
        value={{
          connected: true,
          connecting: false,
          authGeneration: 1,
          outOfSync: false,
          capturedSha: null,
          currentSha: null,
        }}
      >
        <div style={{ height: 700, width: '100%' }}>
          <Panel />
        </div>
      </ConnectionProvider>
    </App>
  );
  return { setPrimaryTeammate, clearPrimaryTeammate, retryProvisioning, find };
}
async function patchBoard(primary: Board['primary_teammate_id']) {
  await act(async () => boardPatched({ ...board, primary_teammate_id: primary }));
}

const click = (element: HTMLElement) => act(async () => userEvent.click(element));
function expectNoPrimaryActions() {
  expect(screen.queryByRole('button', { name: 'Replace primary teammate' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Clear primary teammate' })).toBeNull();
  expect(screen.queryByRole('dialog')).toBeNull();
}

it.each(['editor', 'manager'] as const)(
  '%s sees the teammate and realtime changes without drawer primary actions',
  async (role) => {
    const api = mount(role);
    await waitFor(() => expect(api.find).toHaveBeenCalled());
    expect(screen.getByRole('heading', { name: 'Old teammate' })).toBeVisible();
    expectNoPrimaryActions();
    expect(screen.queryByRole('button', { name: 'Assign' })).toBeNull();
    for (const name of ['Teammate', 'Sessions', 'Branches', 'Comments']) {
      expect(screen.getByRole('tab', { name })).toBeVisible();
    }

    await patchBoard(replacement.branch_id);
    expect(screen.getByRole('heading', { name: 'New teammate' })).toBeVisible();
    expectNoPrimaryActions();
    expect(api.setPrimaryTeammate).not.toHaveBeenCalled();
    expect(api.clearPrimaryTeammate).not.toHaveBeenCalled();

    await patchBoard(undefined);
    expect(await screen.findByRole('button', { name: 'Assign' })).toBeEnabled();
    expectNoPrimaryActions();
  }
);

it.each(['editor', 'manager'] as const)(
  '%s cannot clear or replace an inaccessible primary from the drawer',
  async (role) => {
    const api = mount(role, true);
    await waitFor(() => expect(api.find).toHaveBeenCalled());
    expect(screen.getByText('Teammate unavailable')).toBeVisible();
    expectNoPrimaryActions();
    expect(screen.queryByRole('button', { name: 'Assign' })).toBeNull();
    expect(api.setPrimaryTeammate).not.toHaveBeenCalled();
    expect(api.clearPrimaryTeammate).not.toHaveBeenCalled();
  }
);

it.each(['viewer', 'error'] as const)(
  'keeps assignment fail-closed for %s access',
  async (role) => {
    const api = mount(role);
    await waitFor(() => expect(api.find).toHaveBeenCalled());
    expectNoPrimaryActions();
    await patchBoard(undefined);
    expect(screen.queryByRole('button', { name: 'Assign' })).toBeNull();
    expectNoPrimaryActions();
    expect(api.setPrimaryTeammate).not.toHaveBeenCalled();
    expect(api.clearPrimaryTeammate).not.toHaveBeenCalled();
  }
);

it('still assigns a teammate from another board when the board has no primary', async () => {
  const api = mount();
  await act(async () => {
    branchPatched({ ...replacement, board_id: 'other-board' as Board['board_id'] });
    boardPatched({ ...board, primary_teammate_id: undefined });
  });
  await click(await screen.findByRole('button', { name: 'Assign' }));
  await waitFor(() =>
    expect(api.setPrimaryTeammate).toHaveBeenCalledExactlyOnceWith({
      boardId: board.board_id,
      branchId: replacement.branch_id,
    })
  );
  expect(api.clearPrimaryTeammate).not.toHaveBeenCalled();
  expectNoPrimaryActions();
});

it.each([
  { status: 'failed', title: 'Provisioning failed', action: 'Retry' },
  { status: 'deleted', title: 'Filesystem unavailable', action: 'Recover' },
] as const)(
  'preserves $action for the primary teammate filesystem',
  async ({ status, title, action }) => {
    const api = mount();
    await act(async () =>
      branchPatched({ ...old, filesystem_status: status, error_message: 'Template fetch failed' })
    );
    expect(await screen.findByText(title)).toBeVisible();
    if (status === 'failed') {
      expect(screen.getByText(/Ask a workspace admin to check/)).toBeVisible();
      expect(screen.getByText(/no need to create another one/)).toBeVisible();
      const details = screen.getByText('Technical details').closest('details')!;
      expect(details).not.toHaveAttribute('open');
      await click(screen.getByText('Technical details'));
      expect(details).toHaveAttribute('open');
      expect(details).toHaveTextContent('Template fetch failed');
    }
    expectNoPrimaryActions();
    await click(screen.getByRole('button', { name: action }));
    await waitFor(() => expect(api.retryProvisioning).toHaveBeenCalledExactlyOnceWith({}));
    await act(async () =>
      branchPatched({ ...old, filesystem_status: 'creating', provisioning_operation: 'restore' })
    );
    expect(screen.getByText('Filesystem recovery in progress')).toBeVisible();
    expect(screen.queryByRole('button', { name: action })).toBeNull();
    await act(async () => branchPatched(old));
    expect(screen.queryByText('Filesystem recovery in progress')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Old teammate' })).toBeVisible();
    expectNoPrimaryActions();
    expect(api.setPrimaryTeammate).not.toHaveBeenCalled();
    expect(api.clearPrimaryTeammate).not.toHaveBeenCalled();
  }
);
