import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cancelAllHydrations } from '../store/agorHydration';
import { branchPatched } from '../store/agorRealtimeActions';
import { agorStore } from '../store/agorStore';
import {
  getDisplayedBoardId,
  loadBoardPartition,
  makeBoardReadySelector,
  registerBoardUse,
  selectBoardPartition,
} from '../store/boardPartitions';
import { setRealtimeAuthorityScope } from '../store/realtimeBatch';
import {
  BOARD,
  fakeFeathersClient,
  gate,
  makeBoard,
  makeBoardObject,
  makeBranch,
  withTestAuthority,
} from '../test/harness';
import { useBoardPartition } from './useBoardPartition';

/** A client whose partition reads wait for `release`; counts session reads. */
function makeClient() {
  const reads = gate();
  const fake = fakeFeathersClient(
    {},
    {
      fallback: async ({ method }) => {
        await reads.wait();
        return method === 'get' ? { board_id: BOARD, name: 'Board', objects: {} } : [];
      },
    }
  );
  return {
    client: fake.client,
    sessionReads: () => fake.callsTo('sessions', 'findAll').length,
    releaseAll: reads.release,
  };
}

withTestAuthority('user-a:member:1', { dataAuthority: false });
beforeEach(() => {
  agorStore.getState().setMap('boardById', new Map([[BOARD, makeBoard(BOARD, { name: 'Board' })]]));
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
  const arrive = (id: string) => branchPatched(makeBranch(id));

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

  it('unarchiving a branch onto the displayed board reads its saved placement', async () => {
    // Placement reads skip archived branches, so the archived branch and its
    // stored position are both absent until it is unarchived.
    let archived = true;
    const fake = fakeFeathersClient(
      {
        branches: { findAll: async () => (archived ? [] : [makeBranch('br-back')]) },
        'board-objects': {
          findAll: async () =>
            archived ? [] : [makeBoardObject('o-back', { branch_id: 'br-back' })],
        },
        boards: { get: async () => ({ board_id: BOARD, name: 'Board', objects: {} }) },
      },
      { fallback: async () => [] }
    );
    const { result } = renderHook(() =>
      useBoardPartition(fake.client, BOARD, { canUseMemberWorkspaceServices: true })
    );
    await waitFor(() => expect(result.current.boardReady).toBe(true));
    expect(agorStore.getState().boardObjectById.has('o-back')).toBe(false);

    // Unarchive emits only the branch patch, never a board-object event.
    archived = false;
    act(() => arrive('br-back'));
    await waitFor(() => expect(fake.callsTo('board-objects', 'findAll')).toHaveLength(2));
    await waitFor(() => expect(result.current.boardReady).toBe(true));
    expect(agorStore.getState().boardObjectById.get('o-back')?.branch_id).toBe('br-back');
  });

  it('sustained arrivals end in a bounded number of reads and a ready board', async () => {
    vi.useFakeTimers();
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
  });

  it('navigating to a retained board never evicts it first', async () => {
    const visits = ['05', '01', '02', '03', '04', '06', '07', '06', '05', '01', '07'];
    const ids = [...new Set(visits)].map((n) => `board-${n}`);
    agorStore
      .getState()
      .setMap('boardById', new Map(ids.map((id) => [id, { board_id: id, name: id } as never])));
    const fake = fakeFeathersClient(
      {},
      {
        fallback: ({ method, id }) =>
          method === 'get' ? { board_id: id, name: id, objects: {} } : [],
      }
    );
    const client = fake.client;
    const { result, rerender } = renderHook(
      ({ boardId }) => useBoardPartition(client, boardId, { canUseMemberWorkspaceServices: true }),
      { initialProps: { boardId: `board-${visits[0]}` } }
    );
    for (const visit of visits) {
      rerender({ boardId: `board-${visit}` });
      await waitFor(() => expect(result.current.boardReady).toBe(true));
    }
    // 07 was among the three most recently used background boards (06, 05, 07).
    expect(
      fake.queries('sessions', 'findAll').filter((q) => q.board_id === 'board-07')
    ).toHaveLength(1);
  });
});
