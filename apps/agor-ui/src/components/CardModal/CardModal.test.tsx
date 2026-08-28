import type { AgorClient, Board, CardWithType } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { __resetAuthConfigForTests, __setAuthConfigForTests } from '../../hooks/useAuthConfig';
import CardModal from './CardModal';

function renderWithApp(ui: React.ReactElement) {
  return render(<AntApp>{ui}</AntApp>);
}

const board: Board = { board_id: 'board-1', name: 'Team Board' } as Board;

const card: CardWithType = {
  card_id: 'card-1',
  board_id: 'board-1',
  title: 'A card',
  note: 'Existing note',
  description: 'Existing description',
} as CardWithType;

function makeClient(capabilities: string[]) {
  const patch = vi.fn(async (id: string, data: unknown) => ({ ...card, ...(data as object) }));
  const remove = vi.fn(async () => undefined);
  const effectiveAccessFind = vi.fn(async () => ({
    capabilities,
    fs_access: 'none',
    source: 'direct_user',
    group_ids: [],
    is_primary_owner: false,
  }));
  const client = {
    service: (path: string) => {
      if (path === 'cards') return { patch, remove };
      if (path === 'boards/:id/effective-access') return { find: effectiveAccessFind };
      return {};
    },
  } as unknown as AgorClient;
  return { client, patch, remove, effectiveAccessFind };
}

describe('CardModal permission gating', () => {
  afterEach(() => {
    __resetAuthConfigForTests();
  });

  it('leaves edit/archive/delete enabled by default when RBAC is disabled', async () => {
    __setAuthConfigForTests({ requireAuth: true }, { branchRbac: false });
    const { client } = makeClient(['board.view']);

    renderWithApp(<CardModal open card={card} board={board} client={client} onClose={vi.fn()} />);

    for (const el of screen.getAllByText('Edit')) {
      expect(el.closest('button')).not.toBeDisabled();
    }
    expect(screen.getByText('Archive').closest('button')).not.toBeDisabled();
    expect(screen.getByText('Delete').closest('button')).not.toBeDisabled();
  });

  it('disables note/description editing, archive, and delete when the caller lacks board.edit', async () => {
    __setAuthConfigForTests({ requireAuth: true }, { branchRbac: true });
    const { client, effectiveAccessFind } = makeClient(['board.view']);

    renderWithApp(<CardModal open card={card} board={board} client={client} onClose={vi.fn()} />);

    await waitFor(() => expect(effectiveAccessFind).toHaveBeenCalled());

    const editButtons = screen.getAllByText('Edit').map((el) => el.closest('button'));
    for (const button of editButtons) {
      expect(button).toBeDisabled();
    }
    expect(screen.getByText('Archive').closest('button')).toBeDisabled();
    expect(screen.getByText('Delete').closest('button')).toBeDisabled();
    expect(screen.getByText('Save').closest('button')).toBeDisabled();
  });

  it('enables editing once the caller has board.edit, and saves through cards.patch', async () => {
    __setAuthConfigForTests({ requireAuth: true }, { branchRbac: true });
    const { client, patch, effectiveAccessFind } = makeClient(['board.view', 'board.edit']);

    renderWithApp(<CardModal open card={card} board={board} client={client} onClose={vi.fn()} />);
    await waitFor(() => expect(effectiveAccessFind).toHaveBeenCalled());

    const editButtons = screen.getAllByText('Edit').map((el) => el.closest('button'));
    for (const button of editButtons) {
      expect(button).not.toBeDisabled();
    }

    fireEvent.click(editButtons[0] as HTMLButtonElement);
    fireEvent.change(screen.getByPlaceholderText("Agent's live commentary..."), {
      target: { value: 'Updated note' },
    });
    fireEvent.click(screen.getByText('Save').closest('button') as HTMLButtonElement);

    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith(
        'card-1',
        expect.objectContaining({
          note: 'Updated note',
        })
      )
    );
  });
});
