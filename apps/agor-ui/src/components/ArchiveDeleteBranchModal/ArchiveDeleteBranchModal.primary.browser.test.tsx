import type { AgorClient, Board } from '@agor-live/client';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { App } from 'antd';
import { afterEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { ConnectionProvider } from '../../contexts/ConnectionContext';
import { makeRepo, makeTeammateBranch, makeUser } from '../BranchModal/testUtils';
import { ArchiveDeleteBranchModal } from './ArchiveDeleteBranchModal';

afterEach(cleanup);
function mount(
  canEditBoard = true,
  canManageBranch = true,
  boardPrimary = true,
  boardRead: 'ok' | 'absent' | 'forbidden' | 'failed' | 'access-failed' = 'ok'
) {
  const branch = makeTeammateBranch({
    custom_context: { teammate: { kind: 'teammate', displayName: 'Fixture' } },
  });
  const user = makeUser({ role: 'member', primary_teammate_id: branch.branch_id });
  let board = {
    board_id: branch.board_id,
    name: 'Fixture board',
    url: '/ui/b/fixture/',
    primary_teammate_id: boardPrimary ? branch.branch_id : undefined,
  } as Board;
  const clear = vi.fn(async () => {
    board = { ...board, primary_teammate_id: undefined };
    return board;
  });
  const retire = vi.fn<() => Promise<void>>(async () => {
    throw new Error('Branch has unfinished tasks; stop or cancel them before maintenance');
  });
  const cancel = vi.fn();
  const confirm = vi.fn();
  const services = {
    branches: { get: async () => branch, on: vi.fn(), removeListener: vi.fn() },
    repos: { get: async () => makeRepo(), on: vi.fn(), removeListener: vi.fn() },
    boards: {
      get: async () => {
        if (boardRead === 'absent') return undefined;
        if (boardRead === 'forbidden') throw new Error('Forbidden');
        if (boardRead === 'failed') throw new Error('Network unavailable');
        return board;
      },
      clearPrimaryTeammate: clear,
    },
    'boards/:id/effective-access': {
      find: async () => {
        if (boardRead === 'access-failed') throw new Error('Access unavailable');
        return { capabilities: canEditBoard ? ['board.edit'] : [] };
      },
    },
    'branches/:id/effective-access': {
      find: async () => ({
        can: canManageBranch ? 'all' : 'view',
        is_owner: false,
        fs_access: 'none',
      }),
    },
    [`branches/${branch.branch_id}/retire-teammate`]: { create: retire },
  };
  const client = {
    service: (name: string) => services[name as keyof typeof services],
  } as unknown as AgorClient;
  render(
    <App>
      <ConnectionProvider
        value={{
          connected: true,
          connecting: false,
          authGeneration: 0,
          outOfSync: false,
          capturedSha: null,
          currentSha: null,
        }}
      >
        <ArchiveDeleteBranchModal
          client={client}
          currentUser={user}
          branch={branch}
          open
          onCancel={cancel}
          onConfirm={confirm}
        />
      </ConnectionProvider>
    </App>
  );
  return { clear, retire, cancel, confirm };
}
const click = (element: HTMLElement) => act(async () => userEvent.click(element));
async function waitForConfirmationClosed() {
  // Let AntD finish removing its exit mask BEFORE holding act around another
  // Playwright click; otherwise that click waits behind a mask React cannot flush.
  await waitFor(() => {
    const visible = [...document.querySelectorAll('.ant-modal-wrap')].filter(
      (wrap) => getComputedStyle(wrap).display !== 'none'
    );
    expect(visible).toHaveLength(1);
  });
}
for (const width of [1280, 390]) {
  it(`Archive explains primary protection, confirms clear/retire, and retains actionable errors at ${width}px`, async () => {
    await page.viewport(width, 850);
    const f = mount();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Clear board primary' })).toBeEnabled()
    );
    expect(screen.getByRole('button', { name: 'Archive Branch' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Retire teammate — keep files' })).toBeDisabled();
    expect(
      screen.getByRole('link', { name: 'Open board to replace primary' }).getAttribute('href')
    ).toBe('/ui/b/fixture/');
    await click(screen.getByRole('button', { name: 'Clear board primary' }));
    expect(f.clear).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Clear primary' })).toBeVisible()
    );
    await click(screen.getByRole('button', { name: 'Clear primary' }));
    await waitFor(() => expect(f.clear).toHaveBeenCalledOnce());
    await waitForConfirmationClosed();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Retire teammate — keep files' })).toBeEnabled()
    );
    await click(screen.getByRole('button', { name: 'Retire teammate — keep files' }));
    expect(f.retire).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Retire teammate' })).toBeVisible()
    );
    await click(screen.getByRole('button', { name: 'Retire teammate' }));
    await waitFor(() =>
      expect(screen.getByRole('alert', { name: 'Teammate action failed' }).textContent).toContain(
        'unfinished tasks'
      )
    );
    expect(f.cancel).not.toHaveBeenCalled();
    expect(f.confirm).not.toHaveBeenCalled();
    f.retire.mockResolvedValueOnce(undefined);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^(loading )?Retire teammate$/ })).toBeEnabled()
    );
    await click(screen.getByRole('button', { name: 'Retire teammate' }));
    await waitFor(() => expect(f.cancel).toHaveBeenCalledOnce());
    expect(f.retire).toHaveBeenCalledWith({});
  });
}
it('branch management does not confer board-primary authority', async () => {
  const f = mount(false);
  await screen.findByText('A board Editor or Manager must clear or replace the primary.');
  expect(screen.queryByRole('button', { name: 'Clear board primary' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Retire teammate — keep files' })).toBeDisabled();
  expect(f.clear).not.toHaveBeenCalled();
  expect(f.retire).not.toHaveBeenCalled();
});
it('a non-Manager cannot retire, even with board edit access', async () => {
  mount(true, false);
  await screen.findAllByText('Branch Manager authority is required to archive or delete.');
  expect(screen.getByRole('button', { name: 'Retire teammate — keep files' })).toBeDisabled();
});

for (const boardRead of ['absent', 'forbidden', 'failed', 'access-failed'] as const) {
  it(`board ${boardRead} leaves independent Manager retirement available, with server protection`, async () => {
    const f = mount(true, true, false, boardRead);
    await screen.findByText(/Board details or permissions are unavailable/);
    expect(screen.queryByText('Branch permissions could not be loaded.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Clear board primary' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Open board to replace primary' })).toBeNull();
    // Data can resolve before AntD's entrance animation makes the modal visible.
    await waitFor(() =>
      expect(
        screen.getByText(/Any active teammate may be someone else's private primary/)
      ).toBeVisible()
    );
    const trigger = screen.getByRole('button', { name: 'Retire teammate — keep files' });
    expect(trigger).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Archive Branch' })).toBeDisabled();
    f.retire.mockRejectedValueOnce(
      new Error('Clear or replace the board primary before retirement')
    );
    await click(trigger);
    const confirm = await screen.findByRole('button', { name: 'Retire teammate' });
    await waitFor(() => expect(confirm).toBeVisible());
    await click(confirm);
    await waitFor(() =>
      expect(screen.getByRole('alert', { name: 'Teammate action failed' }).textContent).toContain(
        'Clear or replace the board primary'
      )
    );
    expect(f.clear).not.toHaveBeenCalled();
    expect(f.cancel).not.toHaveBeenCalled();
  });
}

it('a known board primary still blocks retirement when its access lookup fails', async () => {
  mount(true, true, true, 'access-failed');
  await screen.findByText(/Board details or permissions are unavailable/);
  expect(screen.queryByRole('button', { name: 'Clear board primary' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Retire teammate — keep files' })).toBeDisabled();
});

it('unavailable board visibility does not grant a non-Manager retirement authority', async () => {
  mount(true, false, false, 'forbidden');
  await screen.findByText(/Board details or permissions are unavailable/);
  expect(screen.getByRole('button', { name: 'Retire teammate — keep files' })).toBeDisabled();
});

it('confirmation can be cancelled and an admitted retirement stays pending without duplicate submission', async () => {
  const f = mount(true, true, false);
  const trigger = await screen.findByRole('button', { name: 'Retire teammate — keep files' });
  await waitFor(() => expect(trigger).toBeEnabled());
  await click(trigger);
  await waitFor(() =>
    expect(
      screen.getByText('Retire teammate and keep all files?').closest('[role=dialog]')
    ).toBeVisible()
  );
  const dialog = screen
    .getByText('Retire teammate and keep all files?')
    .closest('[role=dialog]') as HTMLElement;
  await click(within(dialog).getByRole('button', { name: 'Cancel' }));
  await waitForConfirmationClosed();
  expect(f.retire).not.toHaveBeenCalled();
  let complete!: () => void;
  f.retire.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        complete = resolve;
      })
  );
  await click(trigger);
  const confirm = await screen.findByRole('button', { name: 'Retire teammate' });
  await waitFor(() => expect(confirm).toBeVisible());
  await click(confirm);
  await waitFor(() => expect(f.retire).toHaveBeenCalledOnce());
  expect(trigger).toBeDisabled();
  expect(confirm).toBeDisabled();
  expect(f.cancel).not.toHaveBeenCalled();
  await act(async () => complete());
  await waitFor(() => expect(f.cancel).toHaveBeenCalledOnce());
});
