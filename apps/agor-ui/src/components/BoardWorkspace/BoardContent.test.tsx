import type { Board, User } from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { agorStore } from '../../store/agorStore';
import { boardScopeKey } from '../../store/scopeMerge';
import {
  type FakeCall,
  fakeFeathersClient,
  Providers,
  withTestAuthority,
} from '../../test/harness';
import { boardCoverage } from '../../test/userScopeCoverage';
import { BoardContentDetail } from './BoardContent';

withTestAuthority();
const user = { user_id: 'owner', role: 'member' } as User;
const board = {
  board_id: 'content-board',
  primary_owner_user_id: user.user_id,
  objects: {
    note: { type: 'markdown', x: 100, y: 200, width: 500, content: 'Shared note' },
  },
} as unknown as Board;

function setup() {
  agorStore.getState().setCoverage(boardScopeKey(board.board_id), boardCoverage());
  const patch = vi.fn(async (_call: FakeCall) => board);
  const { client } = fakeFeathersClient({ boards: { patch } });
  const ui = (current = board, viewer = user) => (
    <Providers>
      <BoardContentDetail
        board={current}
        user={viewer}
        client={client}
        selection={{ kind: 'object', id: 'note' }}
        onClose={vi.fn()}
      />
    </Providers>
  );
  return { ...render(ui()), patch, ui };
}

it('opening content does not write spatial state; editing merges only content', async () => {
  const { patch } = setup();
  expect(screen.getByText('Shared note')).toBeVisible();
  expect(patch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Edit note' }));
  fireEvent.change(screen.getByLabelText('Note content'), { target: { value: 'Revised note' } });
  fireEvent.click(screen.getByRole('button', { name: 'OK' }));
  await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
  expect(patch.mock.calls[0][0]).toMatchObject({
    id: board.board_id,
    data: { _action: 'mergeObjectFields', objects: { note: { content: 'Revised note' } } },
  });
});

it('a draft cannot write into another board after a scope change', async () => {
  const { patch, rerender, ui } = setup();
  fireEvent.click(screen.getByRole('button', { name: 'Edit note' }));
  fireEvent.change(screen.getByLabelText('Note content'), { target: { value: 'Keep my draft' } });
  const other = { ...board, board_id: 'other-tenant-board' } as Board;
  agorStore.getState().setCoverage(boardScopeKey(other.board_id), boardCoverage());
  rerender(ui(other));
  expect(screen.getByLabelText('Note content')).toHaveValue('Keep my draft');
  expect(screen.getByRole('button', { name: 'OK' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'OK' }));
  expect(patch).not.toHaveBeenCalled();
});

it('a board reload invalidates the editor while preserving its draft', async () => {
  const { patch } = setup();
  fireEvent.click(screen.getByRole('button', { name: 'Edit note' }));
  act(() => agorStore.getState().resetBoardPartitions());
  act(() => agorStore.getState().setCoverage(boardScopeKey(board.board_id), boardCoverage()));
  expect(screen.getByRole('button', { name: 'OK' })).toBeDisabled();
  expect(screen.getByLabelText('Note content')).toHaveValue('Shared note');
  expect(patch).not.toHaveBeenCalled();
});

it('changing identity cannot retain the previous owner’s edit permission', () => {
  const { patch, rerender, ui } = setup();
  const edit = screen.getByRole('button', { name: 'Edit note' });
  fireEvent.click(edit);
  const save = screen.getByRole('button', { name: 'OK' });
  rerender(ui(board, { user_id: 'viewer', role: 'viewer' } as User));
  // Hold the controls across the identity change; avoid jsdom's CSS-variable
  // visibility parser when querying newly disabled AntD controls.
  expect(save).toBeDisabled();
  expect(edit).toBeDisabled();
  fireEvent.click(save);
  expect(patch).not.toHaveBeenCalled();
});

it('does not restore a note deleted while its editor is open', () => {
  const { patch, rerender, ui } = setup();
  fireEvent.click(screen.getByRole('button', { name: 'Edit note' }));
  rerender(ui({ ...board, objects: {} }));
  expect(screen.getByLabelText('Note content')).toHaveValue('Shared note');
  expect(screen.getByRole('button', { name: 'OK' })).toBeDisabled();
  expect(patch).not.toHaveBeenCalled();
});
