import type { AgorClient, Branch } from '@agor-live/client';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cancelAllHydrations, resetHydrationRevisions } from '../store/agorHydration';
import { branchPatched } from '../store/agorRealtimeActions';
import { agorStore } from '../store/agorStore';
import {
  getDisplayedBoardId,
  loadBoardPartition,
  makeBoardReadySelector,
  registerBoardUse,
  selectBoardPartition,
} from '../store/boardPartitions';
import { discardRealtimeNow, setRealtimeAuthorityScope } from '../store/realtimeBatch';
import { useBoardPartition } from './useBoardPartition';

const AUTHORITY = 'user-a:member:1';
const BOARD = 'board-1';

/** A client whose partition reads wait for `release`; counts session reads. */
function makeClient() {
  const gates: Array<() => void> = [];
  let sessionReads = 0;
  const wait = () => new Promise<void>((resolve) => gates.push(resolve));
  const client = {
    io: { on: vi.fn(), off: vi.fn() },
    service: (name: string) => ({
      findAll: vi.fn(async () => {
        if (name === 'sessions') sessionReads += 1;
        await wait();
        return [];
      }),
      get: vi.fn(async () => {
        await wait();
        return { board_id: BOARD, name: 'Board', objects: {} };
      }),
    }),
  } as unknown as AgorClient;
  return {
    client,
    sessionReads: () => sessionReads,
    releaseAll: () => {
      for (const release of gates.splice(0)) release();
    },
  };
}

beforeEach(() => {
  agorStore.getState().reset();
  resetHydrationRevisions();
  discardRealtimeNow();
  setRealtimeAuthorityScope(AUTHORITY);
  agorStore.getState().setLoading(false);
  agorStore
    .getState()
    .setMap('boardById', new Map([[BOARD, { board_id: BOARD, name: 'Board' } as never]]));
});
afterEach(() => {
  setRealtimeAuthorityScope(null);
  agorStore.getState().reset();
  resetHydrationRevisions();
});

describe('useBoardPartition', () => {
  it('reloads a board whose loading entry belongs to a cancelled lifetime', async () => {
    const stale = makeClient();
    // A load from the previous lifetime that never settles in this one.
    void loadBoardPartition(stale.client, BOARD, { canUseMemberWorkspaceServices: true });
    cancelAllHydrations();
    expect(selectBoardPartition(agorStore.getState(), BOARD)?.status).toBe('loading');

    const fresh = makeClient();
    const { result } = renderHook(() =>
      useBoardPartition(fresh.client, BOARD, { canUseMemberWorkspaceServices: true })
    );
    await waitFor(() => expect(fresh.sessionReads()).toBe(1));
    await act(async () => fresh.releaseAll());
    await waitFor(() => expect(result.current.boardReady).toBe(true));
    stale.releaseAll();
  });

  it('a background consumer loads its board without becoming the displayed board', async () => {
    agorStore.getState().setMap(
      'boardById',
      new Map([
        [BOARD, { board_id: BOARD, name: 'Board' } as never],
        ['board-2', { board_id: 'board-2', name: 'Other' } as never],
      ])
    );
    const unregister = registerBoardUse(BOARD);
    const { client, sessionReads, releaseAll } = makeClient();
    const background = renderHook(() =>
      useBoardPartition(client, 'board-2', {
        canUseMemberWorkspaceServices: true,
        background: true,
      })
    );
    await waitFor(() => expect(sessionReads()).toBe(1));
    expect(getDisplayedBoardId()).toBe(BOARD);
    // A displayed consumer takes priority, as before.
    const shell = renderHook(() =>
      useBoardPartition(client, 'board-2', { canUseMemberWorkspaceServices: true })
    );
    expect(getDisplayedBoardId()).toBe('board-2');
    shell.unmount();
    await act(async () => releaseAll());
    background.unmount();
    unregister();
  });

  it('is ready without a board, and for a board that does not exist', () => {
    const { client } = makeClient();
    const none = renderHook(() =>
      useBoardPartition(client, null, { canUseMemberWorkspaceServices: true })
    );
    expect(none.result.current.boardReady).toBe(true);
    const unknown = renderHook(() =>
      useBoardPartition(client, 'does-not-exist', { canUseMemberWorkspaceServices: true })
    );
    expect(unknown.result.current.boardReady).toBe(true);
  });

  it('loads once the authority becomes valid again (an authenticated reconnect)', async () => {
    // The disconnect: no authority, and the transition unloaded every board.
    setRealtimeAuthorityScope(null);
    const { client, sessionReads, releaseAll } = makeClient();
    const { result } = renderHook(() =>
      useBoardPartition(client, BOARD, { canUseMemberWorkspaceServices: true })
    );
    await act(async () => {});
    expect(sessionReads()).toBe(0);
    expect(result.current.boardReady).toBe(false);

    // Reauthenticated under a new generation: nothing else re-renders the hook.
    act(() => setRealtimeAuthorityScope('user-a:member:2'));
    await waitFor(() => expect(sessionReads()).toBe(1));
    await act(async () => releaseAll());
    await waitFor(() => expect(result.current.boardReady).toBe(true));
  });

  it('re-requests a board whose in-flight load a reset orphaned (navigation during a resync)', async () => {
    // B's partition read is in flight when a resync of another board resets
    // every partition entry.
    const { client, sessionReads, releaseAll } = makeClient();
    const { result } = renderHook(() =>
      useBoardPartition(client, BOARD, { canUseMemberWorkspaceServices: true })
    );
    await waitFor(() => expect(sessionReads()).toBe(1));
    act(() => agorStore.getState().resetBoardPartitions());

    // The orphaned load can't settle the board; the hook must read again.
    await waitFor(() => expect(sessionReads()).toBe(2));
    await act(async () => releaseAll());
    await waitFor(() => expect(result.current.boardReady).toBe(true));
  });

  // A branch arriving from a board that isn't loaded (nothing held it).
  const arrive = (id: string) =>
    branchPatched({ branch_id: id, board_id: BOARD, name: id, archived: false } as Branch);

  it('reads the board again when a branch arrives while its reload is in flight', async () => {
    const { client, sessionReads, releaseAll } = makeClient();
    const { result } = renderHook(() =>
      useBoardPartition(client, BOARD, { canUseMemberWorkspaceServices: true })
    );
    await waitFor(() => expect(sessionReads()).toBe(1));
    await act(async () => releaseAll());
    await waitFor(() => expect(result.current.boardReady).toBe(true));

    // The first arrival reloads the board; a second lands during that read.
    act(() => arrive('br-1'));
    await waitFor(() => expect(sessionReads()).toBe(2));
    act(() => arrive('br-2'));
    await act(async () => releaseAll());
    expect(selectBoardPartition(agorStore.getState(), BOARD)).toMatchObject({
      status: 'loaded',
      complete: false,
    });

    // The read may predate the second arrival: the board is read once more.
    await waitFor(() => expect(sessionReads()).toBe(3));
    await act(async () => releaseAll());
    await waitFor(() => expect(result.current.boardReady).toBe(true));
  });

  it('sustained arrivals end in a bounded number of reads and a ready board', async () => {
    vi.useFakeTimers();
    try {
      const { client, sessionReads, releaseAll } = makeClient();
      renderHook(() => useBoardPartition(client, BOARD, { canUseMemberWorkspaceServices: true }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
        releaseAll();
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(makeBoardReadySelector(BOARD)(agorStore.getState())).toBe(true);
      const before = sessionReads();

      // A branch arrives every 50ms for 2.5s; every read answers at once.
      for (let i = 0; i < 50; i++) {
        await act(async () => {
          arrive(`br-${i}`);
          releaseAll();
          await vi.advanceTimersByTimeAsync(50);
          releaseAll();
        });
      }
      await act(async () => {
        for (let i = 0; i < 10; i++) {
          releaseAll();
          await vi.advanceTimersByTimeAsync(500);
        }
      });
      expect(makeBoardReadySelector(BOARD)(agorStore.getState())).toBe(true);
      expect(sessionReads() - before).toBeLessThanOrEqual(12);
    } finally {
      vi.useRealTimers();
    }
  });

  it('navigating to a retained board never evicts it first', async () => {
    const visits = ['05', '01', '02', '03', '04', '06', '07', '06', '05', '01', '07'];
    const ids = [...new Set(visits)].map((n) => `board-${n}`);
    agorStore
      .getState()
      .setMap('boardById', new Map(ids.map((id) => [id, { board_id: id, name: id } as never])));
    const reads = new Map<string, number>();
    const client = {
      io: { on: vi.fn(), off: vi.fn() },
      service: (name: string) => ({
        findAll: vi.fn(async ({ query }: { query: { board_id: string } }) => {
          if (name === 'sessions') reads.set(query.board_id, (reads.get(query.board_id) ?? 0) + 1);
          return [];
        }),
        get: vi.fn(async (id: string) => ({ board_id: id, name: id, objects: {} })),
      }),
    } as unknown as AgorClient;
    const { result, rerender } = renderHook(
      ({ boardId }) => useBoardPartition(client, boardId, { canUseMemberWorkspaceServices: true }),
      { initialProps: { boardId: `board-${visits[0]}` } }
    );
    for (const visit of visits) {
      rerender({ boardId: `board-${visit}` });
      await waitFor(() => expect(result.current.boardReady).toBe(true));
    }
    // 07 was among the three most recently used background boards (06, 05, 07).
    expect(reads.get('board-07')).toBe(1);
  });
});
