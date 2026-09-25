import type { AgorClient, Board, Branch, Repo, User } from '@agor-live/client';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { App } from 'antd';
import { beforeEach, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import '../../index.css';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { boardPatched } from '../../store/agorRealtimeActions';
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
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function mount(role: 'editor' | 'manager' | 'viewer' | 'error' = 'editor', inaccessible = false) {
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
      <div style={{ height: 700, width: '100%' }}>
        <Panel />
      </div>
    </App>
  );
  return { setPrimaryTeammate, clearPrimaryTeammate, find };
}
async function patchBoard(primary: Board['primary_teammate_id']) {
  await act(async () => boardPatched({ ...board, primary_teammate_id: primary }));
}

const click = (element: HTMLElement) => act(async () => userEvent.click(element));
const keyboard = (keys: string) => act(async () => userEvent.keyboard(keys));
async function waitForModalClosed() {
  await waitFor(() => {
    expect(screen.queryByRole('dialog')).toBeNull();
    // Wait through AntD's exit motion before the next Playwright action.
    // Holding act open while a click waits behind the exiting mask prevents
    // React from flushing that mask's final removal.
    for (const wrap of document.querySelectorAll('.ant-modal-wrap')) {
      expect(wrap).not.toBeVisible();
    }
  });
}

it.each(['editor', 'manager'] as const)(
  '%s can cancel and keyboard-confirm Clear; the panel follows realtime, not an optimistic retirement',
  async (role) => {
    const api = mount(role);
    const clear = await screen.findByRole('button', { name: 'Clear primary teammate' });
    clear.focus();
    await keyboard('{Enter}');
    let dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAccessibleName('Clear board primary teammate?');
    await keyboard('{Escape}');
    await waitForModalClosed();
    expect(api.clearPrimaryTeammate).not.toHaveBeenCalled();
    await click(clear);
    dialog = await screen.findByRole('dialog');
    const pending = deferred<Board>();
    api.clearPrimaryTeammate.mockReturnValueOnce(pending.promise);
    const confirm = within(dialog).getByRole('button', { name: 'Clear primary' });
    confirm.focus();
    await keyboard('{Enter}');
    await waitFor(() =>
      expect(api.clearPrimaryTeammate).toHaveBeenCalledExactlyOnceWith(board.board_id)
    );
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(confirm).toBeDisabled();
    await keyboard('{Escape}');
    await waitFor(() => expect(screen.getByRole('dialog')).toBeVisible());
    await act(async () => pending.resolve(board));
    await waitForModalClosed();
    expect(screen.getByRole('heading', { name: 'Old teammate' })).toBeVisible();
    await patchBoard(undefined);
    expect(screen.queryByRole('button', { name: 'Clear primary teammate' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Assign' })).toBeVisible();
    expect(api.setPrimaryTeammate).not.toHaveBeenCalled();
  }
);

it('replaces atomically, keeps errors retryable, and reflects the realtime designation', async () => {
  const api = mount();
  await click(await screen.findByRole('button', { name: 'Replace primary teammate' }));
  let dialog = await screen.findByRole('dialog');
  const picker = within(dialog).getByRole('combobox', { name: 'Replacement teammate' });
  picker.focus();
  await keyboard('{ArrowDown}{Enter}');
  api.setPrimaryTeammate.mockRejectedValueOnce(new Error('assignment refused'));
  await click(within(dialog).getByRole('button', { name: 'Replace primary' }));
  await screen.findByText('Failed to replace board primary teammate: assignment refused');
  expect(screen.getByRole('heading', { name: 'Old teammate' })).toBeVisible();
  dialog = screen.getByRole('dialog');
  await waitFor(() =>
    expect(within(dialog).getByRole('button', { name: 'Replace primary' })).toBeEnabled()
  );
  await click(within(dialog).getByRole('button', { name: 'Replace primary' }));
  await waitForModalClosed();
  expect(api.setPrimaryTeammate).toHaveBeenCalledWith({
    boardId: board.board_id,
    branchId: replacement.branch_id,
  });
  expect(api.clearPrimaryTeammate).not.toHaveBeenCalled();
  await patchBoard(replacement.branch_id);
  expect(screen.getByRole('heading', { name: 'New teammate' })).toBeVisible();
});

it.each(['viewer', 'error'] as const)(
  'fails closed for %s access with and without an existing primary',
  async (role) => {
    const api = mount(role);
    await waitFor(() => expect(api.find).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Clear primary teammate' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Replace primary teammate' })).toBeNull();
    await patchBoard(undefined);
    expect(screen.queryByRole('button', { name: 'Assign' })).toBeNull();
  }
);

it('board authority can clear an inaccessible primary; realtime change cancels stale confirmation', async () => {
  const api = mount('editor', true);
  await click(await screen.findByRole('button', { name: 'Clear primary teammate' }));
  await screen.findByRole('dialog');
  await patchBoard(replacement.branch_id);
  await waitForModalClosed();
  expect(api.clearPrimaryTeammate).not.toHaveBeenCalled();
  await click(screen.getByRole('button', { name: 'Clear primary teammate' }));
  api.clearPrimaryTeammate.mockRejectedValueOnce(new Error('access revoked'));
  await click(
    within(await screen.findByRole('dialog')).getByRole('button', { name: 'Clear primary' })
  );
  await screen.findByText('Failed to clear board primary teammate: access revoked');
  await click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
  await waitForModalClosed();
});
