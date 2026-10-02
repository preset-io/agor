import type { AgorClient, Board, CardWithType } from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp, Modal } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionProvider } from '../../contexts/ConnectionContext';
import { agorStore } from '../../store/agorStore';
import CardModal from './CardModal';

const { showWarning } = vi.hoisted(() => ({ showWarning: vi.fn() }));
vi.mock('../../utils/message', () => ({
  useThemedMessage: () => ({
    showError: vi.fn(),
    showSuccess: vi.fn(),
    showWarning,
    showInfo: vi.fn(),
    showLoading: vi.fn(),
    destroy: vi.fn(),
  }),
}));

const CONNECTED = {
  connected: true,
  connecting: false,
  authGeneration: 1,
  outOfSync: false,
  capturedSha: null,
  currentSha: null,
};

function withApp(ui: React.ReactElement, connection = CONNECTED) {
  return (
    <ConnectionProvider value={connection}>
      <AntApp>{ui}</AntApp>
    </ConnectionProvider>
  );
}

function renderWithApp(ui: React.ReactElement, connection = CONNECTED) {
  return render(withApp(ui, connection));
}

function loadBoard() {
  agorStore.getState().setBoardPartition('board-1', {
    status: 'loaded',
    authorityScope: 'fixture',
    loadEpoch: 0,
  });
}

beforeEach(() => {
  agorStore.setState({ boardPartitions: new Map() });
  showWarning.mockClear();
});

afterEach(async () => {
  // Confirmations are static dialogs outside the render container; wait out
  // their close so none is counted by the next test.
  Modal.destroyAll();
  await waitFor(() => expect(document.querySelectorAll('.ant-modal-confirm')).toHaveLength(0));
});

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
  it('disables note/description editing, archive, and delete when the caller lacks board.edit', async () => {
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

  it('is read-only while its board is still loading, even with board.edit', async () => {
    const { client, effectiveAccessFind } = makeClient(['board.view', 'board.edit']);
    renderWithApp(
      <CardModal
        open
        card={card}
        board={board}
        client={client}
        onClose={vi.fn()}
        readOnlyReason="This board is still loading."
      />
    );
    await waitFor(() => expect(effectiveAccessFind).toHaveBeenCalled());
    for (const button of screen.getAllByText('Edit').map((el) => el.closest('button'))) {
      expect(button).toBeDisabled();
    }
    expect(screen.getByText('Archive').closest('button')).toBeDisabled();
    expect(screen.getByText('Delete').closest('button')).toBeDisabled();
  });

  it('is read-only while disconnected, even with board.edit', async () => {
    const { client, effectiveAccessFind } = makeClient(['board.view', 'board.edit']);
    renderWithApp(<CardModal open card={card} board={board} client={client} onClose={vi.fn()} />, {
      ...CONNECTED,
      connected: false,
    });
    await waitFor(() => expect(effectiveAccessFind).toHaveBeenCalled());
    for (const button of screen.getAllByText('Edit').map((el) => el.closest('button'))) {
      expect(button).toBeDisabled();
    }
    expect(screen.getByText('Archive').closest('button')).toBeDisabled();
    expect(screen.getByText('Delete').closest('button')).toBeDisabled();
  });

  it.each([
    ['Archive', 'unload'],
    ['Archive', 'unload-reload'],
    ['Archive', 'disconnect'],
    ['Delete', 'unload'],
    ['Delete', 'unload-reload'],
    ['Delete', 'disconnect'],
  ])(
    'a %s confirmation opened while editable dispatches nothing after %s',
    async (action, change) => {
      loadBoard();
      const { client, patch, remove, effectiveAccessFind } = makeClient([
        'board.view',
        'board.edit',
      ]);
      const ui = (connection = CONNECTED) =>
        withApp(
          <CardModal
            open
            card={card}
            board={board}
            client={client}
            onClose={vi.fn()}
            requireLoadedBoard
          />,
          connection
        );
      const view = render(ui());
      await waitFor(() => expect(effectiveAccessFind).toHaveBeenCalled());
      await waitFor(() => expect(screen.getByText(action).closest('button')).not.toBeDisabled());
      fireEvent.click(screen.getByText(action).closest('button') as HTMLButtonElement);
      expect((await screen.findAllByText(`${action} card?`)).length).toBeGreaterThan(0);
      if (change === 'disconnect') {
        view.rerender(ui({ ...CONNECTED, connected: false }));
      } else {
        act(() => {
          agorStore.getState().resetBoardPartitions();
          if (change === 'unload-reload') loadBoard();
        });
      }
      // The confirmation's own OK button (role queries compute styles that
      // jsdom can't parse for antd's disabled buttons).
      const okButtons = document.querySelectorAll<HTMLButtonElement>(
        '.ant-modal-confirm-btns button'
      );
      await act(async () => {
        fireEvent.click(okButtons[okButtons.length - 1]);
      });
      expect(patch).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
      expect(showWarning).toHaveBeenCalledWith(expect.stringMatching(/was not (archived|deleted)/));
    }
  );

  it.each(['Archive', 'Delete'])(
    'a Settings card %s confirmation outliving its modal dispatches nothing',
    async (action) => {
      // Settings → Cards: the ticket needs no partition, only the auth generation.
      const { client, patch, remove, effectiveAccessFind } = makeClient([
        'board.view',
        'board.edit',
      ]);
      const view = renderWithApp(
        <CardModal open card={card} board={board} client={client} onClose={vi.fn()} />
      );
      await waitFor(() => expect(effectiveAccessFind).toHaveBeenCalled());
      await waitFor(() => expect(screen.getByText(action).closest('button')).not.toBeDisabled());
      fireEvent.click(screen.getByText(action).closest('button') as HTMLButtonElement);
      expect((await screen.findAllByText(`${action} card?`)).length).toBeGreaterThan(0);
      const okButtons = Array.from(
        document.querySelectorAll<HTMLButtonElement>('.ant-modal-confirm-btns button')
      );
      // The owner unmounts; partitions reset and the app re-authenticates.
      view.unmount();
      // Its confirmation goes with it.
      await waitFor(() => expect(screen.queryAllByText(`${action} card?`)).toHaveLength(0));
      act(() => agorStore.getState().resetBoardPartitions());
      render(
        <ConnectionProvider value={{ ...CONNECTED, authGeneration: 2 }}>
          <div />
        </ConnectionProvider>
      );
      await act(async () => {
        fireEvent.click(okButtons[okButtons.length - 1]);
      });
      expect(patch).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
    }
  );

  it('a re-authentication while open makes the card read-only at once', async () => {
    const { client, effectiveAccessFind } = makeClient(['board.view', 'board.edit']);
    const ui = (connection = CONNECTED) =>
      withApp(
        <CardModal open card={card} board={board} client={client} onClose={vi.fn()} />,
        connection
      );
    const view = render(ui());
    await waitFor(() => expect(effectiveAccessFind).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText('Archive').closest('button')).not.toBeDisabled());
    view.rerender(ui({ ...CONNECTED, authGeneration: 2 }));
    expect(screen.getByText('Archive').closest('button')).toBeDisabled();
    expect(screen.getByText('Delete').closest('button')).toBeDisabled();
  });

  it('a card opened before a board reload stays read-only until reopened', async () => {
    loadBoard();
    const { client, effectiveAccessFind } = makeClient(['board.view', 'board.edit']);
    renderWithApp(
      <CardModal
        open
        card={card}
        board={board}
        client={client}
        onClose={vi.fn()}
        requireLoadedBoard
      />
    );
    await waitFor(() => expect(effectiveAccessFind).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText('Archive').closest('button')).not.toBeDisabled());
    act(() => {
      agorStore.getState().resetBoardPartitions();
      loadBoard();
    });
    expect(screen.getByText('Archive').closest('button')).toBeDisabled();
    expect(screen.getByText('Save').closest('button')).toBeDisabled();
  });

  const openConfirmations = () => document.querySelectorAll('.ant-modal-confirm').length;

  it.each([
    ['Archive', 'Archive', false],
    ['Delete', 'Delete', false],
    ['Archive', 'Delete', false],
    ['Archive', 'Archive', true],
    ['Delete', 'Archive', true],
  ])(
    'a second click (%s, then %s; canvas: %s) opens no second confirmation, and closing ends it',
    async (first, second, requireLoadedBoard) => {
      if (requireLoadedBoard) loadBoard();
      const { client, patch, remove, effectiveAccessFind } = makeClient([
        'board.view',
        'board.edit',
      ]);
      const ui = (open: boolean) =>
        withApp(
          <CardModal
            open={open}
            card={card}
            board={board}
            client={client}
            onClose={vi.fn()}
            requireLoadedBoard={requireLoadedBoard}
          />
        );
      const view = render(ui(true));
      await waitFor(() => expect(effectiveAccessFind).toHaveBeenCalled());
      await waitFor(() => expect(screen.getByText(first).closest('button')).not.toBeDisabled());
      fireEvent.click(screen.getByText(first).closest('button') as HTMLButtonElement);
      fireEvent.click(screen.getByText(second).closest('button') as HTMLButtonElement);
      await waitFor(() => expect(openConfirmations()).toBeGreaterThan(0));
      expect(openConfirmations()).toBe(1);
      const okButtons = Array.from(
        document.querySelectorAll<HTMLButtonElement>(
          '.ant-modal-confirm-btns .ant-btn-primary, .ant-modal-confirm-btns .ant-btn-dangerous'
        )
      );
      // CardModal stays mounted when closed (Settings → Cards, the canvas).
      view.rerender(ui(false));
      await waitFor(() => expect(openConfirmations()).toBe(0));
      for (const ok of okButtons) {
        await act(async () => {
          fireEvent.click(ok);
        });
      }
      expect(patch).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
    }
  );

  it('a confirmation closed without confirming lets the next click open one', async () => {
    const { client, patch, effectiveAccessFind } = makeClient(['board.view', 'board.edit']);
    renderWithApp(<CardModal open card={card} board={board} client={client} onClose={vi.fn()} />);
    await waitFor(() => expect(effectiveAccessFind).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText('Archive').closest('button')).not.toBeDisabled());
    fireEvent.click(screen.getByText('Archive').closest('button') as HTMLButtonElement);
    await waitFor(() => expect(openConfirmations()).toBe(1));
    const cancel = document.querySelector<HTMLButtonElement>(
      '.ant-modal-confirm-btns button:not(.ant-btn-primary)'
    );
    await act(async () => {
      fireEvent.click(cancel as HTMLButtonElement);
    });
    await waitFor(() => expect(openConfirmations()).toBe(0));
    fireEvent.click(screen.getByText('Archive').closest('button') as HTMLButtonElement);
    await waitFor(() => expect(openConfirmations()).toBe(1));
    const ok = document.querySelector<HTMLButtonElement>(
      '.ant-modal-confirm-btns .ant-btn-primary'
    );
    await act(async () => {
      fireEvent.click(ok as HTMLButtonElement);
    });
    expect(patch).toHaveBeenCalledTimes(1);
  });
});
