import type { AgorClient, Board, CardType, CardWithType } from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, type Mock, vi } from 'vitest';
import {
  boardObjectCreated,
  boardObjectPatched,
  boardObjectRemoved,
} from '../../store/agorRealtimeActions';
import { setRealtimeAuthorityScope } from '../../store/realtimeBatch';
import { fakeFeathersClient, withTestAuthority } from '../../test/harness';
import { SERVER_READ_MAX_WAIT_MS } from '../../utils/debounceWithMaxWait';
import { CardsTable } from './CardsTable';

vi.mock('@/utils/message', () => ({
  useThemedMessage: () => ({ showSuccess: vi.fn(), showError: vi.fn() }),
}));

const cardType = { card_type_id: 'type-1', name: 'Ticket', emoji: '🎫' } as CardType;
const card = (id: string, title: string, boardId = 'board-unloaded') =>
  ({ card_id: id, card_type_id: 'type-1', board_id: boardId, title }) as CardWithType;
// The store's lean board row has no zones; only `boards.get` returns them.
const leanBoard = { board_id: 'board-unloaded', name: 'Unloaded' } as Board;
const fullBoard = (label = 'Review') =>
  ({
    ...leanBoard,
    objects: { 'zone-1': { type: 'zone', label, x: 0, y: 0, width: 1, height: 1 } },
  }) as unknown as Board;
const cardPlacement = {
  object_id: 'o-1',
  board_id: 'board-unloaded',
  card_id: 'k-1',
  zone_id: 'zone-1',
  entity_type: 'card',
};

/** A client whose services and socket emit events like Feathers'. */
function makeClient(cards: CardWithType[]) {
  const fake = fakeFeathersClient({
    cards: { findAll: () => [...cards] },
    'board-objects': { findAll: () => [cardPlacement] },
    boards: { get: () => fullBoard() },
  });
  // The settings dataset unsubscribes from the socket with `removeListener`.
  const fn = (service: string, method: 'findAll' | 'get') =>
    (fake.client.service(service) as unknown as Record<string, Mock>)[method];
  const emit = (name: string, event: string, payload?: unknown) =>
    act(() => (name === 'io' ? fake.emitIo(event, payload) : fake.emit(name, event, payload)));
  return {
    client: fake.client,
    emit,
    cardsFindAll: fn('cards', 'findAll'),
    placementsFindAll: fn('board-objects', 'findAll'),
    boardsGet: fn('boards', 'get'),
  };
}

function renderTable(client: AgorClient) {
  render(
    <CardsTable
      client={client}
      cardTypeById={new Map([['type-1', cardType]])}
      boardById={new Map([['board-unloaded', leanBoard]])}
      canReadPlacements
    />
  );
  fireEvent.click(screen.getByText('Ticket'));
}

describe('CardsTable', () => {
  withTestAuthority('user-a:admin:1', { dataAuthority: false });

  it('reads every card on open, not just the loaded boards in the store', async () => {
    const { client, cardsFindAll, placementsFindAll, boardsGet } = makeClient([
      card('k-1', 'Fix login'),
    ]);
    renderTable(client);
    expect(await screen.findByText('Fix login')).toBeVisible();
    // The zone name comes from the board's full record.
    expect(await screen.findByText('Review')).toBeVisible();
    expect(cardsFindAll).toHaveBeenCalledTimes(1);
    expect(placementsFindAll).toHaveBeenCalledWith({
      query: expect.objectContaining({ entity_type: 'card' }),
    });
    expect(boardsGet).toHaveBeenCalledWith('board-unloaded');
  });

  it('reads every card once on open', async () => {
    const { client, cardsFindAll, placementsFindAll } = makeClient([card('k-1', 'Fix login')]);
    renderTable(client);
    expect(await screen.findByText('Review')).toBeVisible();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(cardsFindAll).toHaveBeenCalledTimes(1);
    expect(placementsFindAll).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['pending', () => new Promise<CardWithType[]>(() => {})],
    ['failed', () => Promise.reject(new Error('offline'))],
  ])('stops showing placements on a capability loss while the read is %s', async (_, next) => {
    const { client, cardsFindAll } = makeClient([card('k-1', 'Fix login')]);
    const table = (canReadPlacements: boolean) => (
      <CardsTable
        client={client}
        cardTypeById={new Map([['type-1', cardType]])}
        boardById={new Map([['board-unloaded', leanBoard]])}
        canReadPlacements={canReadPlacements}
      />
    );
    const view = render(table(true));
    fireEvent.click(screen.getByText('Ticket'));
    expect(await screen.findByText('Review')).toBeVisible();

    cardsFindAll.mockImplementation(next);
    view.rerender(table(false));
    // Synchronously, before the replacement read settles (or after it fails).
    expect(screen.queryByText('Review')).not.toBeInTheDocument();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.queryByText('Review')).not.toBeInTheDocument();
    // Regaining the capability never resurrects the old placements before a read.
    cardsFindAll.mockImplementation(() => new Promise<CardWithType[]>(() => {}));
    view.rerender(table(true));
    expect(screen.queryByText('Review')).not.toBeInTheDocument();
  });

  it('patches the dataset from card events without reading again', async () => {
    const { client, emit, cardsFindAll } = makeClient([card('k-1', 'Fix login')]);
    renderTable(client);
    await screen.findByText('Fix login');

    emit('cards', 'created', card('k-2', 'New ticket'));
    emit('cards', 'patched', card('k-1', 'Fix login (renamed)'));
    expect(await screen.findByText('New ticket')).toBeVisible();
    expect(await screen.findByText('Fix login (renamed)')).toBeVisible();
    emit('cards', 'removed', card('k-2', 'New ticket'));
    await waitFor(() => expect(screen.queryByText('New ticket')).not.toBeInTheDocument());
    expect(cardsFindAll).toHaveBeenCalledTimes(1);
  });

  it('ignores branch placement events: three of them read nothing', async () => {
    const { client, emit, cardsFindAll, placementsFindAll } = makeClient([
      card('k-1', 'Fix login'),
    ]);
    renderTable(client);
    await screen.findByText('Fix login');
    // As in the app, each event reaches this table and the store (useAgorData).
    const branchPlacement = { object_id: 'o-b', board_id: 'b', branch_id: 'br-1' } as never;
    const store = {
      created: boardObjectCreated,
      patched: boardObjectPatched,
      removed: boardObjectRemoved,
    };
    for (const event of ['created', 'patched', 'removed'] as const) {
      emit('board-objects', event, branchPlacement);
      act(() => store[event](branchPlacement));
    }
    await act(async () => new Promise((resolve) => setTimeout(resolve, 600)));
    expect(cardsFindAll).toHaveBeenCalledTimes(1);
    expect(placementsFindAll).toHaveBeenCalledTimes(1);
  });

  it('reconciles once for a burst of reconnects', async () => {
    const cards = [card('k-1', 'Fix login')];
    const { client, emit, cardsFindAll } = makeClient(cards);
    renderTable(client);
    await screen.findByText('Fix login');

    // Missed while disconnected: a card was deleted and another created.
    cards.splice(0, 1, card('k-3', 'Created while offline'));
    emit('io', 'connect');
    emit('io', 'connect');
    emit('io', 'connect');
    expect(await screen.findByText('Created while offline')).toBeVisible();
    expect(screen.queryByText('Fix login')).not.toBeInTheDocument();
    await act(async () => new Promise((resolve) => setTimeout(resolve, 600)));
    expect(cardsFindAll).toHaveBeenCalledTimes(2);
  });

  it('a sustained burst still reconciles within the max wait', async () => {
    const { client, emit, cardsFindAll } = makeClient([card('k-1', 'Fix login')]);
    renderTable(client);
    await screen.findByText('Fix login');
    const started = Date.now();
    while (
      Date.now() - started < SERVER_READ_MAX_WAIT_MS + 400 &&
      cardsFindAll.mock.calls.length < 2
    ) {
      emit('io', 'connect');
      await act(async () => new Promise((resolve) => setTimeout(resolve, 100)));
    }
    expect(cardsFindAll).toHaveBeenCalledTimes(2);
    expect(Date.now() - started).toBeLessThan(SERVER_READ_MAX_WAIT_MS + 400);
  });

  it('updates a zone label when the board record changes', async () => {
    const { client, emit } = makeClient([card('k-1', 'Fix login')]);
    renderTable(client);
    expect(await screen.findByText('Review')).toBeVisible();

    emit('boards', 'patched', fullBoard('In review'));
    expect(await screen.findByText('In review')).toBeVisible();
  });

  it('keeps a board event that lands during the initial zone read', async () => {
    const { client, emit, boardsGet } = makeClient([card('k-1', 'Fix login')]);
    let releaseGet!: () => void;
    boardsGet.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseGet = () => resolve(fullBoard('Review (older read)'));
        })
    );
    renderTable(client);
    await screen.findByText('Fix login');
    await waitFor(() => expect(boardsGet).toHaveBeenCalledTimes(1));
    // The zone was renamed while the read was in flight.
    emit('boards', 'patched', fullBoard('Renamed'));
    await act(async () => releaseGet());
    expect(await screen.findByText('Renamed')).toBeVisible();
    expect(screen.queryByText('Review (older read)')).not.toBeInTheDocument();
  });

  it('never lets a refresh read overwrite a newer board event', async () => {
    const { client, emit, boardsGet } = makeClient([card('k-1', 'Fix login')]);
    renderTable(client);
    expect(await screen.findByText('Review')).toBeVisible();
    let releaseGet!: () => void;
    boardsGet.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseGet = () => resolve(fullBoard('Stale refresh'));
        })
    );
    // A lean event triggers a refresh read; a full event lands before it returns.
    emit('boards', 'patched', leanBoard);
    await waitFor(() => expect(boardsGet).toHaveBeenCalledTimes(2));
    emit('boards', 'patched', fullBoard('Newest'));
    await act(async () => releaseGet());
    expect(await screen.findByText('Newest')).toBeVisible();
    expect(screen.queryByText('Stale refresh')).not.toBeInTheDocument();
  });

  function trackConcurrency(cardsFindAll: ReturnType<typeof vi.fn>, rows: () => CardWithType[]) {
    const stats = { inflight: 0, max: 0, gates: [] as Array<() => void> };
    cardsFindAll.mockImplementation(async () => {
      stats.inflight += 1;
      stats.max = Math.max(stats.max, stats.inflight);
      await new Promise<void>((resolve) => stats.gates.push(resolve));
      stats.inflight -= 1;
      return rows();
    });
    return stats;
  }

  it('coalesces five rapid re-authentications into one trailing reconcile', async () => {
    const { client, cardsFindAll } = makeClient([]);
    const stats = trackConcurrency(cardsFindAll, () => [card('k-1', 'Fix login')]);
    renderTable(client);
    await waitFor(() => expect(cardsFindAll).toHaveBeenCalledTimes(1));
    await act(async () => stats.gates.shift()?.());
    await screen.findByText('Fix login');

    for (let generation = 2; generation <= 6; generation++) {
      act(() => setRealtimeAuthorityScope(null));
      act(() => setRealtimeAuthorityScope(`user-a:admin:${generation}`));
    }
    await waitFor(() => expect(cardsFindAll).toHaveBeenCalledTimes(2), { timeout: 2000 });
    await act(async () => stats.gates.shift()?.());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 600)));
    expect(cardsFindAll).toHaveBeenCalledTimes(2);
    expect(stats.max).toBe(1);
  });

  it('keeps one read in flight when re-authentications land during the first read', async () => {
    const { client, cardsFindAll } = makeClient([]);
    const stats = trackConcurrency(cardsFindAll, () => [card('k-1', 'Fix login')]);
    renderTable(client);
    await waitFor(() => expect(cardsFindAll).toHaveBeenCalledTimes(1));
    for (let generation = 2; generation <= 6; generation++) {
      act(() => setRealtimeAuthorityScope(null));
      act(() => setRealtimeAuthorityScope(`user-a:admin:${generation}`));
    }
    expect(cardsFindAll).toHaveBeenCalledTimes(1);
    // The superseded read is discarded and read once more.
    await act(async () => stats.gates.shift()?.());
    await waitFor(() => expect(cardsFindAll).toHaveBeenCalledTimes(2));
    await act(async () => stats.gates.shift()?.());
    expect(await screen.findByText('Fix login')).toBeVisible();
    await act(async () => new Promise((resolve) => setTimeout(resolve, 600)));
    expect(cardsFindAll).toHaveBeenCalledTimes(2);
    expect(stats.max).toBe(1);
  });

  it("never shows the previous user's cards after an identity change", async () => {
    const { client, cardsFindAll } = makeClient([]);
    const stats = trackConcurrency(cardsFindAll, () =>
      cardsFindAll.mock.calls.length === 1 ? [card('k-a', 'Alice card')] : [card('k-b', 'Bob card')]
    );
    renderTable(client);
    await act(async () => stats.gates.shift()?.());
    await screen.findByText('Alice card');

    act(() => setRealtimeAuthorityScope('user-b:admin:1'));
    // Cleared at once, before Bob's read returns.
    await waitFor(() => expect(screen.queryByText('Alice card')).not.toBeInTheDocument());
    await waitFor(() => expect(cardsFindAll).toHaveBeenCalledTimes(2));
    await act(async () => stats.gates.shift()?.());
    expect(await screen.findByText('Bob card')).toBeVisible();
  });

  it.each(['reauthentication', 'reconnect'])(
    're-reads cached zone boards on a %s reconcile',
    async (trigger) => {
      const { client, emit, cardsFindAll, boardsGet } = makeClient([card('k-1', 'Fix login')]);
      renderTable(client);
      expect(await screen.findByText('Review')).toBeVisible();
      expect(boardsGet).toHaveBeenCalledTimes(1);
      // Renamed while disconnected (or visible under the new authority only).
      boardsGet.mockImplementation(async () => fullBoard('Renamed while away'));
      if (trigger === 'reauthentication') {
        act(() => setRealtimeAuthorityScope(null));
        act(() => setRealtimeAuthorityScope('user-a:admin:2'));
      } else {
        emit('io', 'connect');
      }
      await waitFor(() => expect(cardsFindAll).toHaveBeenCalledTimes(2), { timeout: 2000 });
      expect(await screen.findByText('Renamed while away')).toBeVisible();
      expect(boardsGet).toHaveBeenCalledTimes(2);
    }
  );

  it('a trailing read consumes a reconcile still waiting in its debounce', async () => {
    const { client, emit, cardsFindAll } = makeClient([]);
    const stats = trackConcurrency(cardsFindAll, () => [card('k-1', 'Fix login')]);
    renderTable(client);
    await waitFor(() => expect(cardsFindAll).toHaveBeenCalledTimes(1));
    await act(async () => stats.gates.shift()?.());
    await screen.findByText('Fix login');

    // A reconnect reconcile starts and stays in flight.
    emit('io', 'connect');
    await waitFor(() => expect(cardsFindAll).toHaveBeenCalledTimes(2));
    // A second reconnect's debounce fires during it: the read is superseded.
    emit('io', 'connect');
    await act(async () => new Promise((resolve) => setTimeout(resolve, 400)));
    // A third is still in its debounce when the superseded read returns and
    // the trailing read starts at once.
    emit('io', 'connect');
    await act(async () => stats.gates.shift()?.());
    await waitFor(() => expect(cardsFindAll).toHaveBeenCalledTimes(3));
    await act(async () => stats.gates.shift()?.());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 600)));
    // The trailing read covered the pending request: one active, one trailing.
    expect(cardsFindAll).toHaveBeenCalledTimes(3);
    expect(stats.max).toBe(1);
  });
});
