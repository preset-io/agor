import {
  type BoardID,
  MAX_PRESENCE_BOARD_SUBSCRIPTIONS,
  PRESENCE_SOCKET_EVENTS,
  type PresenceSubscriptionAcknowledgement,
} from '@agor-live/client';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRESENCE_CONFIG } from '../config/presence';
import { useGlobalPresenceHeartbeat } from './useGlobalPresenceHeartbeat';

type Listener = () => void;

function makeMockClient() {
  const ioListeners = new Map<string, Set<Listener>>();
  const clientListeners = new Map<string, Set<Listener>>();
  const add = (registry: Map<string, Set<Listener>>, event: string, listener: Listener) => {
    const listeners = registry.get(event) ?? new Set();
    listeners.add(listener);
    registry.set(event, listeners);
  };
  const remove = (registry: Map<string, Set<Listener>>, event: string, listener: Listener) => {
    registry.get(event)?.delete(listener);
  };
  const emit = vi.fn(
    (
      event: string,
      _payload?: unknown,
      acknowledge?: (error: Error | null, value?: unknown) => void
    ) => {
      if (event === PRESENCE_SOCKET_EVENTS.subscribeBoardAssociations) {
        acknowledge?.(null, { ok: true });
      }
    }
  );
  return {
    client: {
      io: {
        emit,
        timeout: vi.fn(() => ({ emit })),
        on: vi.fn((event: string, listener: Listener) => add(ioListeners, event, listener)),
        off: vi.fn((event: string, listener: Listener) => remove(ioListeners, event, listener)),
      },
      on: vi.fn((event: string, listener: Listener) => add(clientListeners, event, listener)),
      off: vi.fn((event: string, listener: Listener) => remove(clientListeners, event, listener)),
    } as never,
    emit,
    emitIo: (event: string) => {
      for (const listener of ioListeners.get(event) ?? []) listener();
    },
    emitClient: (event: string) => {
      for (const listener of clientListeners.get(event) ?? []) listener();
    },
  };
}

function boardId(value: string): BoardID {
  return value as BoardID;
}

describe('useGlobalPresenceHeartbeat', () => {
  beforeEach(() => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reauthorizes on route/reconnect and removes board identity when blurred or hidden', () => {
    const { client, emit, emitClient, emitIo } = makeMockClient();
    const { rerender, unmount } = renderHook(
      ({ currentBoardId }: { currentBoardId: BoardID | null }) =>
        useGlobalPresenceHeartbeat({
          client,
          currentBoardId,
          visibleBoardIds: [boardId('board-a'), boardId('board-b')],
        }),
      { initialProps: { currentBoardId: boardId('board-a') } }
    );

    expect(emit).toHaveBeenCalledWith(
      PRESENCE_SOCKET_EVENTS.subscribeBoardAssociations,
      { boardIds: [boardId('board-a'), boardId('board-b')] },
      expect.any(Function)
    );
    expect(emit).toHaveBeenCalledWith(PRESENCE_SOCKET_EVENTS.heartbeat, {
      boardId: boardId('board-a'),
    });

    rerender({ currentBoardId: boardId('board-b') });
    expect(emit).toHaveBeenCalledWith(PRESENCE_SOCKET_EVENTS.heartbeat, {
      boardId: boardId('board-b'),
    });

    vi.mocked(document.hasFocus).mockReturnValue(false);
    act(() => window.dispatchEvent(new Event('blur')));
    expect(emit).toHaveBeenLastCalledWith(PRESENCE_SOCKET_EVENTS.heartbeat, { boardId: null });

    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(emit).toHaveBeenLastCalledWith(PRESENCE_SOCKET_EVENTS.heartbeat, { boardId: null });

    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    vi.mocked(document.hasFocus).mockReturnValue(true);
    act(() => {
      emitIo('connect');
      emitClient('authenticated');
    });
    expect(emit).toHaveBeenCalledWith(
      PRESENCE_SOCKET_EVENTS.subscribeBoardAssociations,
      { boardIds: [boardId('board-b'), boardId('board-a')] },
      expect.any(Function)
    );

    unmount();
    expect(emit).toHaveBeenCalledWith(PRESENCE_SOCKET_EVENTS.leave);
    expect(emit).toHaveBeenLastCalledWith(PRESENCE_SOCKET_EVENTS.subscribeBoardAssociations, {
      boardIds: [],
    });
  });

  it('prioritizes the current board and enforces the shared subscription bound', () => {
    const { client, emit } = makeMockClient();
    const visibleBoardIds = Array.from(
      { length: MAX_PRESENCE_BOARD_SUBSCRIPTIONS + 5 },
      (_, index) => boardId(`board-${index}`)
    );
    const currentBoardId = boardId('current-board');

    renderHook(() => useGlobalPresenceHeartbeat({ client, currentBoardId, visibleBoardIds }));

    const subscription = emit.mock.calls.find(
      ([event]) => event === PRESENCE_SOCKET_EVENTS.subscribeBoardAssociations
    )?.[1] as { boardIds: BoardID[] };
    expect(subscription.boardIds).toHaveLength(MAX_PRESENCE_BOARD_SUBSCRIPTIONS);
    expect(subscription.boardIds[0]).toBe(currentBoardId);
  });

  it('does not reactivate presence from a subscription acknowledgement after unmount', () => {
    const { client, emit } = makeMockClient();
    let acknowledge: ((error: Error | null, result: { ok: boolean }) => void) | undefined;
    emit.mockImplementation((event, payload, callback) => {
      if (
        event === PRESENCE_SOCKET_EVENTS.subscribeBoardAssociations &&
        (payload as { boardIds?: BoardID[] })?.boardIds?.length
      ) {
        acknowledge = callback as (error: Error | null, result: { ok: boolean }) => void;
      }
    });
    const { unmount } = renderHook(() =>
      useGlobalPresenceHeartbeat({
        client,
        currentBoardId: boardId('board-a'),
        visibleBoardIds: [boardId('board-a')],
      })
    );
    unmount();

    act(() => acknowledge?.(null, { ok: true }));

    expect(
      emit.mock.calls.filter(
        ([event, payload]) =>
          event === PRESENCE_SOCKET_EVENTS.heartbeat &&
          (payload as { boardId?: BoardID | null }).boardId !== null
      )
    ).toEqual([]);
  });

  it('keeps one acknowledgement in flight and retries only the latest mixed-version state', () => {
    const { client, emit } = makeMockClient();
    const acknowledgements: Array<
      (error: Error | null, result?: PresenceSubscriptionAcknowledgement) => void
    > = [];
    emit.mockImplementation((event, _payload, callback) => {
      if (event === PRESENCE_SOCKET_EVENTS.subscribeBoardAssociations && callback) {
        acknowledgements.push(
          callback as (error: Error | null, result?: PresenceSubscriptionAcknowledgement) => void
        );
      }
    });
    const { rerender } = renderHook(
      ({ currentBoardId }: { currentBoardId: BoardID }) =>
        useGlobalPresenceHeartbeat({
          client,
          currentBoardId,
          visibleBoardIds: [boardId('board-a'), boardId('board-b')],
        }),
      { initialProps: { currentBoardId: boardId('board-a') } }
    );

    rerender({ currentBoardId: boardId('board-b') });
    act(() => {
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('focus'));
    });
    expect(acknowledgements).toHaveLength(1);

    act(() => acknowledgements[0]?.(new Error('old daemon did not acknowledge')));
    expect(acknowledgements).toHaveLength(2);
    expect(
      emit.mock.calls
        .filter(([event]) => event === PRESENCE_SOCKET_EVENTS.heartbeat)
        .every(([, payload]) => (payload as { boardId?: BoardID | null }).boardId === null)
    ).toBe(true);

    act(() => acknowledgements[1]?.(null, { ok: true }));
    expect(emit).toHaveBeenCalledWith(PRESENCE_SOCKET_EVENTS.heartbeat, {
      boardId: boardId('board-b'),
    });
  });

  it('keeps periodic heartbeats boardless after a failed latest route generation', () => {
    vi.useFakeTimers();
    const { client, emit } = makeMockClient();
    const acknowledgements: Array<
      (error: Error | null, result?: PresenceSubscriptionAcknowledgement) => void
    > = [];
    emit.mockImplementation((event, _payload, callback) => {
      if (event === PRESENCE_SOCKET_EVENTS.subscribeBoardAssociations && callback) {
        acknowledgements.push(
          callback as (error: Error | null, result?: PresenceSubscriptionAcknowledgement) => void
        );
      }
    });
    const { rerender } = renderHook(
      ({ currentBoardId }: { currentBoardId: BoardID }) =>
        useGlobalPresenceHeartbeat({
          client,
          currentBoardId,
          visibleBoardIds: [boardId('board-a'), boardId('board-b')],
        }),
      { initialProps: { currentBoardId: boardId('board-a') } }
    );
    act(() => acknowledgements[0]?.(null, { ok: true }));
    expect(emit).toHaveBeenLastCalledWith(PRESENCE_SOCKET_EVENTS.heartbeat, {
      boardId: boardId('board-a'),
    });

    rerender({ currentBoardId: boardId('board-b') });
    expect(
      emit.mock.calls.filter(([event]) => event === PRESENCE_SOCKET_EVENTS.heartbeat).at(-1)?.[1]
    ).toEqual({ boardId: null });
    act(() => acknowledgements[1]?.(new Error('authorization timed out')));
    act(() => vi.advanceTimersByTime(PRESENCE_CONFIG.HEARTBEAT_INTERVAL_MS));
    expect(emit).toHaveBeenLastCalledWith(PRESENCE_SOCKET_EVENTS.heartbeat, { boardId: null });

    act(() => window.dispatchEvent(new Event('focus')));
    act(() => acknowledgements[2]?.(null, { ok: true }));
    expect(emit).toHaveBeenLastCalledWith(PRESENCE_SOCKET_EVENTS.heartbeat, {
      boardId: boardId('board-b'),
    });
  });
});
