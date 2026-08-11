import type { AgorClient, Board, User } from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BoardSwitcher } from './BoardSwitcher';

const modalProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
vi.mock('../BoardEditModal', () => ({
  BoardEditModal: (props: Record<string, unknown>) => {
    modalProps.current = props;
    return props.open ? <div role="dialog">board editor</div> : null;
  },
}));

const board = {
  board_id: 'board-1',
  name: 'A board with a very long name that should not move its action',
  created_by: 'owner-1',
  created_at: '',
  last_updated: '',
} as Board;
const owner = { user_id: 'owner-1', role: 'member' } as User;

function clientFor({ owners = [owner], reject }: { owners?: User[]; reject?: unknown } = {}) {
  return {
    service: (name: string) => ({
      find: vi
        .fn()
        .mockImplementation(() =>
          reject ? Promise.reject(reject) : Promise.resolve(name.includes('owners') ? owners : [])
        ),
      findAll: vi.fn().mockResolvedValue([]),
    }),
  } as unknown as AgorClient;
}

function renderSwitcher(client = clientFor(), user: User = owner) {
  const onBoardChange = vi.fn();
  render(
    <BoardSwitcher
      boards={[board]}
      currentBoardId={board.board_id}
      onBoardChange={onBoardChange}
      branchById={new Map()}
      client={client}
      currentUser={user}
      onUpdateBoard={vi.fn()}
    />
  );
  return { onBoardChange };
}

describe('BoardSwitcher current-board edit shortcut', () => {
  it('allows the board creator even when legacy owner rows are missing', async () => {
    renderSwitcher(clientFor({ reject: { code: 500 } }));
    expect(await screen.findByRole('button', { name: /Edit current board:/ })).toBeVisible();
  });

  it('passes only the current board to the canonical editor and does not navigate', async () => {
    const { onBoardChange } = renderSwitcher();
    const edit = await screen.findByRole('button', { name: /Edit current board:/ });

    fireEvent.click(edit);

    expect(onBoardChange).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toHaveTextContent('board editor');
    expect(modalProps.current?.board).toBe(board);
  });

  it('overlays the edit action without reserving trigger width', async () => {
    renderSwitcher();
    const edit = await screen.findByRole('button', { name: /Edit current board:/ });
    const trigger = edit.closest('div')?.querySelector('button.ant-dropdown-trigger');

    expect(trigger).toHaveStyle({ padding: '8px 12px' });
    expect(edit.closest('span[style*="position: absolute"]')).toHaveStyle({ right: '28px' });
  });

  it('keeps the action keyboard reachable and reveals it on focus-within', async () => {
    renderSwitcher();
    const edit = await screen.findByRole('button', { name: /Edit current board:/ });
    act(() => edit.focus());
    expect(edit).toHaveFocus();
    await waitFor(() =>
      expect(edit.closest('span[style*="opacity"]')).toHaveStyle({
        opacity: '1',
        pointerEvents: 'auto',
      })
    );
  });

  it('hides the action when the canonical owner/group inputs deny management', async () => {
    renderSwitcher(clientFor({ owners: [] }), { user_id: 'member-2', role: 'member' } as User);
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /Edit current board:/ })).not.toBeInTheDocument()
    );
  });

  it('keeps the action visible without hover on small/touch layouts', async () => {
    renderSwitcher();
    const edit = await screen.findByRole('button', { name: /Edit current board:/ });
    expect(edit).toBeVisible();
  });
});
