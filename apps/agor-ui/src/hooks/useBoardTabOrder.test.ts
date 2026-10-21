import type { AgorClient, Board, BoardView } from '@agor-live/client';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useBoardTabOrder } from './useBoardTabOrder';

vi.mock('../utils/message', () => ({ useThemedMessage: () => ({ showError: vi.fn() }) }));

const BOARD = { board_id: 'b1', tab_order: ['board', 'chat', 'files'] } as Board;

describe('useBoardTabOrder', () => {
  it('saves a quick reverse reorder after the first one, so the latest order wins', async () => {
    const saves: { order: BoardView[]; resolve: () => void }[] = [];
    const patch = vi.fn(
      (_id: string, data: { tab_order: BoardView[] }) =>
        new Promise<void>((resolve) => saves.push({ order: data.tab_order, resolve }))
    );
    const client = { service: () => ({ patch }) } as unknown as AgorClient;
    const { result } = renderHook(() => useBoardTabOrder(client, BOARD));

    act(() => void result.current.setOrder(['chat', 'board', 'files']));
    expect(result.current.order).toEqual(['chat', 'board', 'files']);
    // Moved back before the first save returns: equal to the stored order, not to what is on screen.
    act(() => void result.current.setOrder(['board', 'chat', 'files']));
    expect(result.current.order).toEqual(['board', 'chat', 'files']);
    expect(patch).toHaveBeenCalledTimes(1);

    await act(async () => saves[0].resolve());
    expect(patch).toHaveBeenCalledTimes(2);
    expect(saves[1].order).toEqual(['board', 'chat', 'files']);
    await act(async () => saves[1].resolve());
    expect(result.current.order).toEqual(['board', 'chat', 'files']);
  });

  it('sends only the latest of several orders requested during one save', async () => {
    const saves: { order: BoardView[]; resolve: () => void }[] = [];
    const patch = vi.fn(
      (_id: string, data: { tab_order: BoardView[] }) =>
        new Promise<void>((resolve) => saves.push({ order: data.tab_order, resolve }))
    );
    const client = { service: () => ({ patch }) } as unknown as AgorClient;
    const { result } = renderHook(() => useBoardTabOrder(client, BOARD));

    act(() => void result.current.setOrder(['chat', 'board', 'files']));
    act(() => void result.current.setOrder(['board', 'chat', 'files']));
    act(() => void result.current.setOrder(['chat', 'board', 'files']));
    await act(async () => saves[0].resolve());
    await act(async () => saves[1]?.resolve());
    expect(saves.map((save) => save.order)).toEqual([
      ['chat', 'board', 'files'],
      ['chat', 'board', 'files'],
    ]);
  });
});
