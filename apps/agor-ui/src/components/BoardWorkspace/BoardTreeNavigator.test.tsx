import type { AgorClient, Board, User } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import { ConnectionProvider } from '../../contexts/ConnectionContext';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import { BoardTreeNavigator } from './BoardTreeNavigator';
import { parseBoardViewPreferences } from './useBoardViewPreferences';

vi.mock('../BoardTeammatePanel/BoardTeammatePanel', () => ({ BoardTeammatePanel: () => null }));
const user = { user_id: 'member', role: 'member' } as User;
const board = { board_id: 'one', name: 'One', objects: {} } as Board;
const connected = {
  connected: true,
  connecting: false,
  authGeneration: 1,
  outOfSync: false,
  capturedSha: null,
  currentSha: null,
};
const find = vi.fn(async () => ({ capabilities: ['board.view', 'board.edit'] }));
const client = { service: () => ({ find }) } as unknown as AgorClient;
const onCreateBranch = vi.fn();
function View({ target = board, online = true, ready = true, canCreate = true } = {}) {
  return (
    <MemoryRouter>
      <App>
        <ConnectionProvider value={{ ...connected, connected: online }}>
          <BoardTreeNavigator
            board={target}
            branches={[]}
            actions={{
              client,
              board: target,
              currentUserId: user.user_id,
              boardReady: ready,
              primaryTeammateInaccessible: false,
              onSessionClick: vi.fn(),
            }}
            preferences={parseBoardViewPreferences(null)}
            updatePreferences={vi.fn()}
            onBranchClick={vi.fn()}
            onContentClick={vi.fn()}
            onCreateBranch={canCreate ? onCreateBranch : undefined}
          />
        </ConnectionProvider>
      </App>
    </MemoryRouter>
  );
}
beforeEach(() => {
  onCreateBranch.mockClear();
  find.mockReset().mockResolvedValue({ capabilities: ['board.view', 'board.edit'] });
  agorStore.setState({ ...EMPTY_MAPS, userById: new Map([[user.user_id, user]]) });
});
it('offers the existing branch creation flow even on an empty tree', async () => {
  render(<View />);
  expect(screen.getByText('No branches yet')).toBeInTheDocument();
  const button = screen.getByRole('button', { name: 'New branch' });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  expect(onCreateBranch).toHaveBeenCalledOnce();
});
it('cannot reuse board A permission to open creation on board B', async () => {
  const view = render(<View />);
  const button = screen.getByRole('button', { name: 'New branch' });
  await waitFor(() => expect(button).toBeEnabled());
  find.mockResolvedValue({ capabilities: ['board.view'] });
  view.rerender(<View target={{ ...board, board_id: 'two' } as Board} />);
  expect(button).toBeDisabled();
  await waitFor(() => expect(find).toHaveBeenCalledTimes(2));
  fireEvent.click(button);
  expect(onCreateBranch).not.toHaveBeenCalled();
});
it('disables creation while disconnected or loading, and omits it without a creation flow', async () => {
  const view = render(<View online={false} />);
  await waitFor(() => expect(find).toHaveBeenCalled());
  expect(screen.getByRole('button', { name: 'New branch' })).toBeDisabled();
  view.rerender(<View ready={false} />);
  expect(screen.getByRole('button', { name: 'New branch' })).toBeDisabled();
  view.rerender(<View canCreate={false} />);
  expect(screen.queryByRole('button', { name: 'New branch' })).not.toBeInTheDocument();
});
