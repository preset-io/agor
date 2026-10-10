import type { Board, BoardEntityObject, Branch, CardWithType, Session } from '@agor-live/client';
import { PAGINATION_CHURN_MESSAGE } from '@agor-live/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BOARD,
  makeBranch as branch,
  makeCard as card,
  deferred,
  fakeFeathersClient,
  makeBoard,
  makeBoardObject,
  makeSession,
  withTestAuthority,
} from '../test/harness';
import { boardCoverage, markBoardLoaded } from '../test/userScopeCoverage';
import {
  beginPartitionLoad,
  bumpFirstPaintMergeRevisions,
  bumpRevision,
  cancelAllHydrations,
  endPartitionLoad,
  resetHydrationRevisions,
  touchedSince,
} from './agorHydration';
import type { EMPTY_MAPS } from './agorMaps';
import {
  branchPatched,
  branchRemoved,
  cardCreated,
  cardRemoved,
  sessionPatched,
} from './agorRealtimeActions';
import { agorStore } from './agorStore';
import { holdBackgroundReads } from './backgroundReads';
import {
  BOARD_OBJECT_PAGE_LIMIT,
  evictUnloadedBoards,
  loadBoardPartition,
  makeBoardReadySelector,
  nextPartitionGeneration,
  RETAINED_BACKGROUND_PARTITIONS,
  registerBoardUse,
  retryBoardPartition,
  selectBoardPartition,
  settleBoardPartition,
} from './boardPartitions';
import { captureLoadLifetime, isLoadLifetimeCurrent } from './loadLifetime';
import { enqueueSessionPatch, flushRealtimeNow, setRealtimeAuthorityScope } from './realtimeBatch';
import {
  type BoardPartitionSnapshot,
  boardPartitionScope,
  boardScopeKey,
  replaceScope,
  USER_SCOPE_KEYS,
} from './scopeMerge';
import { otherCommittedMembers } from './userScope';

const AUTHORITY = 'user-a:member:1';
withTestAuthority(AUTHORITY);

const at = '2026-01-01T00:00:00.000Z';
const session = (id: string, branchId: string, overrides: Partial<Session> = {}) =>
  makeSession(id, branchId, {
    branch_board_id: BOARD,
    created_at: at,
    last_updated: at,
    ...overrides,
  });
const boardObject = (id: string, branchId: string) => makeBoardObject(id, { branch_id: branchId });
const fullBoard = (overrides: Partial<Board> = {}) =>
  makeBoard(BOARD, {
    name: 'Board',
    objects: { 'zone-1': { type: 'zone' } },
    ...overrides,
  } as Partial<Board>);

const snapshotOf = (overrides: Partial<BoardPartitionSnapshot> = {}): BoardPartitionSnapshot => ({
  boardId: BOARD,
  branches: [],
  sessions: [],
  boardObjects: [],
  cards: [],
  board: null,
  complete: true,
  ...overrides,
});

const never = () => false;

/** A partition load's apply: a complete replace of the board. */
const replacePartition = (
  prev: typeof EMPTY_MAPS,
  snapshot: BoardPartitionSnapshot,
  touched: (collection: string, id: string) => boolean
) => replaceScope(prev, boardPartitionScope(snapshot.boardId), snapshot, touched, []);

describe('touched fence', () => {
  beforeEach(() => resetHydrationRevisions());

  it('only stamps ids while a partition load is in flight', () => {
    bumpRevision('sessions', 'before');
    const fence = beginPartitionLoad();
    bumpRevision('sessions', 'during');
    expect(touchedSince('sessions', 'during', fence.startRevisions.sessions)).toBe(true);
    expect(touchedSince('sessions', 'before', fence.startRevisions.sessions)).toBe(false);
    endPartitionLoad();
    expect(touchedSince('sessions', 'during', fence.startRevisions.sessions)).toBe(false);
  });
});

/** Controllable mock client: each service call resolves when released. */
function makePartitionClient(data: {
  branches?: Branch[];
  sessions?: Session[];
  boardObjects?: BoardEntityObject[];
  cards?: CardWithType[];
  board?: Board;
}) {
  const held = deferred();
  const byService: Record<string, unknown> = {
    branches: data.branches ?? [],
    sessions: data.sessions ?? [],
    'board-objects': data.boardObjects ?? [],
    cards: data.cards ?? [],
  };
  const fake = fakeFeathersClient(
    {},
    {
      fallback: async ({ service, method }) => {
        await held.promise;
        return method === 'get' ? (data.board ?? fullBoard()) : byService[service];
      },
    }
  );
  return { ...fake, release: () => held.resolve() };
}

describe('loadBoardPartition', () => {
  const ready = () => makeBoardReadySelector(BOARD)(agorStore.getState());

  it('marks the board loading, fills the snapshot, then marks it loaded', async () => {
    const { client, release } = makePartitionClient({
      branches: [branch('br-1')],
      sessions: [session('s-1', 'br-1')],
    });
    const load = loadBoardPartition(client, BOARD, { canUseMemberWorkspaceServices: true });
    expect(selectBoardPartition(agorStore.getState(), BOARD)?.status).toBe('loading');
    expect(ready()).toBe(false);
    release();
    await load;
    expect(ready()).toBe(true);
    expect(agorStore.getState().sessionById.has('s-1')).toBe(true);
  });

  it('a load that settles incomplete reads the board again for a mounted consumer', async () => {
    const unregister = registerBoardUse(BOARD);
    const { client, release, callsTo } = makePartitionClient({});
    const load = loadBoardPartition(client, BOARD, { canUseMemberWorkspaceServices: true });
    // A branch arrives during the read: the load settles incomplete.
    branchPatched(branch('br-late', { created_by: 'user-b' }));
    release();
    await load;
    expect(ready()).toBe(false);
    // The loader requests the follow-up itself; no retry has to race it.
    await vi.waitFor(() => expect(callsTo('sessions', 'findAll')).toHaveLength(2));
    await vi.waitFor(() => expect(ready()).toBe(true));
    unregister();
  });

  it('is not complete once a branch arrives from an unloaded board, even while loading', async () => {
    // Loaded: a branch arriving from a board that isn't loaded brings no sessions.
    markBoardLoaded(BOARD);
    expect(ready()).toBe(true);
    branchPatched(branch('br-in', { created_by: 'user-b' }));
    expect(agorStore.getState().branchById.has('br-in')).toBe(true);
    expect(ready()).toBe(false);
    // A resync settling the loaded entry in place keeps it incomplete.
    const fence = beginPartitionLoad();
    endPartitionLoad();
    agorStore
      .getState()
      .applyMaps(
        (maps) => maps,
        settleBoardPartition(
          BOARD,
          captureLoadLifetime()!,
          nextPartitionGeneration(),
          { ...snapshotOf(), complete: true },
          fence.startRevisions
        )
      );
    expect(ready()).toBe(false);

    // In flight: the read may predate the arrival, so it settles incomplete.
    const { client, release } = makePartitionClient({});
    const load = loadBoardPartition(client, BOARD, { canUseMemberWorkspaceServices: true });
    branchPatched(branch('br-late', { created_by: 'user-b' }));
    release();
    await load;
    expect(selectBoardPartition(agorStore.getState(), BOARD)?.status).toBe('loaded');
    expect(ready()).toBe(false);

    // From a loaded board, its sessions came along: still complete.
    const again = makePartitionClient({});
    const reload = loadBoardPartition(again.client, BOARD, { canUseMemberWorkspaceServices: true });
    again.release();
    await reload;
    expect(ready()).toBe(true);
    markBoardLoaded('board-2');
    agorStore
      .getState()
      .setMap('branchById', (prev) =>
        new Map(prev).set('br-moved', branch('br-moved', { board_id: 'board-2' }))
      );
    branchPatched(branch('br-moved'));
    expect(ready()).toBe(true);
  });

  it.each([
    ['loading', () => boardCoverage('loading', captureLoadLifetime()!)],
    [
      'loaded-but-incomplete',
      () => ({ ...boardCoverage('loaded', captureLoadLifetime()!), complete: false }),
    ],
  ])('is not complete once a branch arrives from a %s board', (_label, source) => {
    // The source's read may not hold the branch's sessions, so they can't come along.
    markBoardLoaded(BOARD);
    agorStore.getState().setCoverage(boardScopeKey('board-2'), source());
    agorStore
      .getState()
      .setMap('branchById', (prev) =>
        new Map(prev).set('br-moved', branch('br-moved', { board_id: 'board-2' }))
      );
    branchPatched(branch('br-moved'));
    expect(ready()).toBe(false);
  });

  it('reads a loaded board again in place: ready throughout, a new generation, kept on failure', async () => {
    const { client, release } = makePartitionClient({});
    const first = loadBoardPartition(client, BOARD, { canUseMemberWorkspaceServices: true });
    release();
    await first;
    const loaded = selectBoardPartition(agorStore.getState(), BOARD)!;
    const statuses: Array<string | undefined> = [];
    const off = agorStore.subscribe((s) => statuses.push(selectBoardPartition(s, BOARD)?.status));
    const again = makePartitionClient({});
    const inPlace = loadBoardPartition(again.client, BOARD, {
      canUseMemberWorkspaceServices: true,
      inPlace: true,
    });
    expect(ready()).toBe(true);
    again.release();
    await expect(inPlace).resolves.toBe(true);
    expect(statuses.every((status) => status === 'loaded')).toBe(true);
    expect(selectBoardPartition(agorStore.getState(), BOARD)?.generation).toBeGreaterThan(
      loaded.generation
    );
    // A failed in-place read leaves the board as it was.
    const settled = selectBoardPartition(agorStore.getState(), BOARD);
    const failing = fakeFeathersClient({}, { fallback: () => Promise.reject(new Error('down')) });
    await expect(
      loadBoardPartition(failing.client, BOARD, {
        canUseMemberWorkspaceServices: true,
        inPlace: true,
      })
    ).resolves.toBe(false);
    off();
    expect(selectBoardPartition(agorStore.getState(), BOARD)).toBe(settled);
  });

  it('dedupes in-flight loads of the same board', async () => {
    const { client, release, callsTo } = makePartitionClient({});
    const a = loadBoardPartition(client, BOARD, { canUseMemberWorkspaceServices: true });
    const b = loadBoardPartition(client, BOARD, { canUseMemberWorkspaceServices: true });
    expect(b).toBe(a);
    release();
    await a;
    expect(callsTo('sessions', 'findAll')).toHaveLength(1);
  });

  it("reads the board's sessions as lean rows", async () => {
    const { client, release, queries } = makePartitionClient({});
    const load = loadBoardPartition(client, BOARD, { canUseMemberWorkspaceServices: true });
    release();
    await load;
    expect(queries('sessions', 'findAll').at(-1)).toMatchObject({
      board_id: BOARD,
      archived: false,
      lean: true,
    });
  });

  it('never reads comments: they are global and gated at first paint', async () => {
    const { client, release, callsTo } = makePartitionClient({});
    const load = loadBoardPartition(client, BOARD, { canUseMemberWorkspaceServices: true });
    release();
    await load;
    expect(callsTo('board-comments')).toEqual([]);
  });

  it('skips board objects for callers without member workspace services', async () => {
    const { client, release, callsTo } = makePartitionClient({});
    const load = loadBoardPartition(client, BOARD, { canUseMemberWorkspaceServices: false });
    release();
    await load;
    expect(callsTo('board-objects')).toEqual([]);
    expect(ready()).toBe(true);
  });

  it('reads only the placements of active branches, in bounded pages', async () => {
    const { client, release, queries } = makePartitionClient({});
    const load = loadBoardPartition(client, BOARD, { canUseMemberWorkspaceServices: true });
    release();
    await load;
    expect(queries('board-objects', 'findAll')).toEqual([
      { board_id: BOARD, exclude_archived_branches: true, $limit: BOARD_OBJECT_PAGE_LIMIT },
    ]);
  });

  it('restarts only the placement read when its pages churn, a bounded number of times', async () => {
    const churn = () => Promise.reject(new Error(PAGINATION_CHURN_MESSAGE));
    let failures = 1;
    const { client, callsTo } = fakeFeathersClient(
      {
        'board-objects': {
          findAll: () => (failures-- > 0 ? churn() : Promise.resolve([boardObject('o-1', 'br-1')])),
        },
        boards: { get: () => fullBoard() },
      },
      { fallback: async () => [] }
    );
    await expect(
      loadBoardPartition(client, BOARD, { canUseMemberWorkspaceServices: true })
    ).resolves.toBe(true);
    expect(callsTo('board-objects', 'findAll')).toHaveLength(2);
    expect(callsTo('sessions', 'findAll')).toHaveLength(1);
    expect(agorStore.getState().boardObjectById.has('o-1')).toBe(true);
    expect(ready()).toBe(true);

    // Sustained churn fails the board with its retryable partition error.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    failures = Number.POSITIVE_INFINITY;
    agorStore.getState().setCoverage(boardScopeKey(BOARD), null);
    await expect(
      loadBoardPartition(client, BOARD, { canUseMemberWorkspaceServices: true })
    ).resolves.toBe(false);
    expect(callsTo('board-objects', 'findAll')).toHaveLength(5);
    expect(selectBoardPartition(agorStore.getState(), BOARD)?.status).toBe('error');
  });

  it('never retries a placement read that failed for any other reason', async () => {
    const { client, callsTo } = fakeFeathersClient(
      {
        'board-objects': { findAll: () => Promise.reject(new Error('Forbidden')) },
        boards: { get: () => fullBoard() },
      },
      { fallback: async () => [] }
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await loadBoardPartition(client, BOARD, { canUseMemberWorkspaceServices: true });
    expect(callsTo('board-objects', 'findAll')).toHaveLength(1);
    expect(selectBoardPartition(agorStore.getState(), BOARD)?.status).toBe('error');
  });

  it('drops the apply when the authority changes mid-load', async () => {
    const { client, release } = makePartitionClient({ sessions: [session('s-1', 'br-1')] });
    const load = loadBoardPartition(client, BOARD, { canUseMemberWorkspaceServices: true });
    setRealtimeAuthorityScope('user-b:member:1');
    release();
    await load;
    expect(agorStore.getState().sessionById.size).toBe(0);
    // The stale load never settles its entry under the new authority; it
    // releases it, so the board loads again instead of staying 'loading'.
    expect(agorStore.getState().coverage.has(boardScopeKey(BOARD))).toBe(false);
  });

  it('drops the apply when the load is cancelled, even under the same authority', async () => {
    const { client, release } = makePartitionClient({ sessions: [session('s-1', 'br-1')] });
    const load = loadBoardPartition(client, BOARD, { canUseMemberWorkspaceServices: true });
    cancelAllHydrations(); // unmount + remount of the data owner
    release();
    await load;
    expect(agorStore.getState().sessionById.size).toBe(0);
  });

  it('lets a patch queued during the load beat the snapshot, and never resurrects a removal', async () => {
    const { client, release } = makePartitionClient({
      branches: [branch('br-1')],
      sessions: [session('s-1', 'br-1', { title: 'stale' }), session('s-2', 'br-1')],
      cards: [card('k-1')],
    });
    const load = loadBoardPartition(client, BOARD, { canUseMemberWorkspaceServices: true });
    // A streaming patch arrives mid-load and sits in the frame queue.
    bumpRevision('sessions');
    enqueueSessionPatch(AUTHORITY, session('s-1', 'br-1', { title: 'live' }));
    // A card removal for a row the snapshot still contains.
    cardRemoved(card('k-1'));
    release();
    await load;
    expect(agorStore.getState().sessionById.has('s-1')).toBe(false);
    expect(agorStore.getState().sessionById.has('s-2')).toBe(true);
    expect(agorStore.getState().cardById.has('k-1')).toBe(false);
    flushRealtimeNow(AUTHORITY);
    expect(agorStore.getState().sessionById.get('s-1')?.title).toBe('live');
  });

  it('skips rows on a branch deleted mid-load', async () => {
    const { client, release } = makePartitionClient({
      branches: [branch('br-1')],
      sessions: [session('s-1', 'br-1')],
      boardObjects: [boardObject('o-1', 'br-1')],
    });
    const load = loadBoardPartition(client, BOARD, { canUseMemberWorkspaceServices: true });
    branchRemoved(branch('br-1'));
    release();
    await load;
    const state = agorStore.getState();
    expect(state.branchById.size).toBe(0);
    expect(state.sessionById.size).toBe(0);
    expect(state.boardObjectById.size).toBe(0);
    expect(ready()).toBe(true);
    // The cascade wrote no session or board-object ids: they leave the membership anyway.
    const members = selectBoardPartition(state, BOARD)?.members;
    expect([...(members?.sessions ?? [])]).toEqual([]);
    expect([...(members?.boardObjects ?? [])]).toEqual([]);
  });

  it("a branch moved off the board during its read takes its sessions out of the board's membership", async () => {
    const { client, release } = makePartitionClient({
      branches: [branch('br-1')],
      sessions: [session('s-1', 'br-1')],
    });
    const load = loadBoardPartition(client, BOARD, { canUseMemberWorkspaceServices: true });
    branchPatched(branch('br-1', { board_id: 'board-2' }));
    release();
    await load;
    expect([
      ...(selectBoardPartition(agorStore.getState(), BOARD)?.members?.sessions ?? []),
    ]).toEqual([]);
    // So a complete replace of the board it moved to, which omits s-1, removes it.
    const others = otherCommittedMembers(agorStore.getState(), boardScopeKey('board-2'));
    agorStore
      .getState()
      .applyMaps((prev) =>
        replaceScope(prev, boardPartitionScope('board-2'), { sessions: [] }, never, others)
      );
    expect(agorStore.getState().sessionById.has('s-1')).toBe(false);
  });

  it("a branch moved onto the board during its read brings its present sessions into the board's membership", async () => {
    agorStore.getState().applyMaps((prev) =>
      replacePartition(
        prev,
        snapshotOf({
          boardId: 'board-2',
          branches: [branch('br-2', { board_id: 'board-2' })],
          sessions: [session('s-2', 'br-2', { branch_board_id: 'board-2' })],
        }),
        never
      )
    );
    const { client, release } = makePartitionClient({});
    const load = loadBoardPartition(client, BOARD, { canUseMemberWorkspaceServices: true });
    branchPatched(branch('br-2'));
    release();
    await load;
    const members = selectBoardPartition(agorStore.getState(), BOARD)?.members;
    expect([...(members?.branches ?? [])]).toEqual(['br-2']);
    expect([...(members?.sessions ?? [])]).toEqual(['s-2']);
  });

  it('keeps a session patched live during the load', async () => {
    const { client, release } = makePartitionClient({
      sessions: [session('s-1', 'br-1', { title: 'stale' })],
    });
    const load = loadBoardPartition(client, BOARD, { canUseMemberWorkspaceServices: true });
    sessionPatched(session('s-1', 'br-1', { title: 'live' }));
    release();
    await load;
    expect(agorStore.getState().sessionById.get('s-1')?.title).toBe('live');
  });

  it('restarts instead of applying across a wholesale reconnect replacement', async () => {
    let calls = 0;
    const firstGate = deferred();
    const { client } = fakeFeathersClient(
      { boards: { get: () => fullBoard() } },
      {
        fallback: async ({ service }) => {
          if (service === 'sessions') calls += 1;
          if (calls === 1) await firstGate.promise;
          return service === 'sessions'
            ? calls === 1
              ? [session('s-deleted-while-offline', 'br-1')]
              : [session('s-1', 'br-1')]
            : [];
        },
      }
    );
    const load = loadBoardPartition(client, BOARD, { canUseMemberWorkspaceServices: true });
    bumpFirstPaintMergeRevisions();
    firstGate.resolve();
    await load;
    expect(calls).toBe(2);
    expect([...agorStore.getState().sessionById.keys()]).toEqual(['s-1']);
  });

  it('releases its loading entry when cancelled, so the board counts as unloaded', async () => {
    const { client, release } = makePartitionClient({ sessions: [session('s-1', 'br-1')] });
    const load = loadBoardPartition(client, BOARD, { canUseMemberWorkspaceServices: true });
    const entry = selectBoardPartition(agorStore.getState(), BOARD);
    expect(entry?.status).toBe('loading');
    cancelAllHydrations();
    // Another lifetime's entry is not current even before the load settles.
    expect(isLoadLifetimeCurrent(entry!)).toBe(false);
    release();
    await load;
    expect(agorStore.getState().coverage.has(boardScopeKey(BOARD))).toBe(false);
    // A new load under the new lifetime starts instead of deduping into the old one.
    const again = makePartitionClient({ sessions: [session('s-2', 'br-1')] });
    const reload = loadBoardPartition(again.client, BOARD, { canUseMemberWorkspaceServices: true });
    again.release();
    await reload;
    expect(ready()).toBe(true);
    expect(agorStore.getState().sessionById.has('s-2')).toBe(true);
  });

  it("never records loaded into the next user's store when its apply's subscriber logs out", async () => {
    const { client, release } = makePartitionClient({ sessions: [session('s-1', 'br-1')] });
    const load = loadBoardPartition(client, BOARD, { canUseMemberWorkspaceServices: true });
    // `applyMaps` notifies synchronously: switch identity from inside it.
    const unsubscribe = agorStore.subscribe((state) => {
      if (!state.sessionById.has('s-1')) return;
      unsubscribe();
      cancelAllHydrations();
      agorStore.getState().reset();
      setRealtimeAuthorityScope('user-b:member:1');
    });
    release();
    await load;
    expect(agorStore.getState().coverage.has(boardScopeKey(BOARD))).toBe(false);
    expect(ready()).toBe(false);
  });

  it('never overwrites the entry of a load that superseded it during its apply', async () => {
    const first = makePartitionClient({ sessions: [session('s-1', 'br-1')] });
    const second = makePartitionClient({ sessions: [session('s-2', 'br-1')] });
    const load = loadBoardPartition(first.client, BOARD, { canUseMemberWorkspaceServices: true });
    let reload: Promise<void> | undefined;
    const unsubscribe = agorStore.subscribe((state) => {
      if (!state.sessionById.has('s-1')) return;
      unsubscribe();
      cancelAllHydrations(); // remount: a new lifetime loads the board again
      reload = loadBoardPartition(second.client, BOARD, { canUseMemberWorkspaceServices: true });
    });
    first.release();
    await load;
    const entry = selectBoardPartition(agorStore.getState(), BOARD);
    expect(entry?.status).toBe('loading');
    expect(isLoadLifetimeCurrent(entry!)).toBe(true);
    second.release();
    await reload;
    expect(agorStore.getState().sessionById.has('s-2')).toBe(true);
    expect(ready()).toBe(true);
    expect(isLoadLifetimeCurrent(selectBoardPartition(agorStore.getState(), BOARD)!)).toBe(true);
  });

  it('never applies after the restart budget: records a retryable error instead', async () => {
    let calls = 0;
    const { client } = fakeFeathersClient({
      sessions: {
        findAll: () => {
          calls += 1;
          // Every attempt spans a wholesale replacement.
          bumpFirstPaintMergeRevisions();
          return [session(`s-stale-${calls}`, 'br-1')];
        },
      },
      boards: { get: () => fullBoard() },
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await loadBoardPartition(client, BOARD, { canUseMemberWorkspaceServices: true });
    expect(calls).toBe(4);
    expect(agorStore.getState().sessionById.size).toBe(0);
    expect(selectBoardPartition(agorStore.getState(), BOARD)?.status).toBe('error');
    retryBoardPartition(BOARD);
    expect(agorStore.getState().coverage.has(boardScopeKey(BOARD))).toBe(false);
  });

  it('records a failure and lets retry clear it', async () => {
    const { client } = fakeFeathersClient(
      { boards: { get: () => fullBoard() } },
      {
        fallback: () => {
          throw new Error('boom');
        },
      }
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await loadBoardPartition(client, BOARD, { canUseMemberWorkspaceServices: true });
    expect(selectBoardPartition(agorStore.getState(), BOARD)?.status).toBe('error');
    retryBoardPartition(BOARD);
    expect(agorStore.getState().coverage.has(boardScopeKey(BOARD))).toBe(false);
  });

  it('reloading a board reconciles its annotations: deleted, moved and hidden rows leave', async () => {
    // Rows left from before a reconnect unloaded the board.
    agorStore.getState().applyMaps((prev) =>
      replacePartition(
        prev,
        snapshotOf({
          boardObjects: [boardObject('o-kept', 'br-1'), boardObject('o-hidden', 'br-private')],
          cards: [card('k-deleted'), card('k-moved'), card('k-kept')],
        }),
        never
      )
    );
    const { client, release } = makePartitionClient({
      boardObjects: [boardObject('o-kept', 'br-1')],
      cards: [card('k-kept')],
    });
    const load = loadBoardPartition(client, BOARD, { canUseMemberWorkspaceServices: true });
    // A card created live during the load stays although the snapshot lacks it.
    cardCreated(card('k-live'));
    release();
    await load;
    const state = agorStore.getState();
    expect([...state.boardObjectById.keys()]).toEqual(['o-kept']);
    expect([...state.cardById.keys()].sort()).toEqual(['k-kept', 'k-live']);
    expect(ready()).toBe(true);
    // Its membership: the ids the read returned, and the row realtime wrote
    // during the read that the board claims now; not the rows deleted meanwhile.
    const members = selectBoardPartition(state, BOARD)?.members;
    expect([...(members?.cards ?? [])].sort()).toEqual(['k-kept', 'k-live']);
    expect([...(members?.boardObjects ?? [])]).toEqual(['o-kept']);
  });

  it("reloading a board replaces its branches and sessions, keeping rows other scopes' members hold", async () => {
    const lifetime = captureLoadLifetime()!;
    // Rows left from before the board was unloaded.
    agorStore.getState().applyMaps((prev) =>
      replaceScope(
        prev,
        boardPartitionScope(BOARD),
        {
          branches: [branch('br-1', { name: 'stale' }), branch('br-deleted'), branch('br-mine')],
          sessions: [
            session('s-1', 'br-1', { title: 'stale' }),
            session('s-deleted', 'br-1'),
            session('s-mine', 'br-1'),
          ],
        },
        never,
        []
      )
    );
    // My session and my branch belong to the user scope too.
    agorStore.getState().setCoverage(USER_SCOPE_KEYS.sessions, {
      status: 'loaded',
      ...lifetime,
      generation: 0,
      members: { sessions: new Set(['s-mine']) },
    });
    agorStore.getState().setCoverage(USER_SCOPE_KEYS.branches, {
      status: 'loaded',
      ...lifetime,
      generation: 0,
      members: { branches: new Set(['br-mine']) },
    });
    const { client, release } = makePartitionClient({
      branches: [branch('br-1', { name: 'fresh' })],
      sessions: [session('s-1', 'br-1', { title: 'fresh' })],
    });
    const load = loadBoardPartition(client, BOARD, { canUseMemberWorkspaceServices: true });
    release();
    await load;
    const state = agorStore.getState();
    expect([...state.branchById.keys()].sort()).toEqual(['br-1', 'br-mine']);
    expect([...state.sessionById.keys()].sort()).toEqual(['s-1', 's-mine']);
    expect(state.branchById.get('br-1')?.name).toBe('fresh');
    expect(state.sessionById.get('s-1')?.title).toBe('fresh');
  });

  it('only committed members of other current, loaded scopes keep rows', () => {
    const lifetime = captureLoadLifetime()!;
    const entry = (status: 'loading' | 'loaded' | 'error', id: string) => ({
      status,
      ...lifetime,
      generation: 0,
      members: { sessions: new Set([id]) },
    });
    const { setCoverage } = agorStore.getState();
    setCoverage(boardScopeKey('board-2'), entry('loaded', 's-2'));
    setCoverage(boardScopeKey(BOARD), entry('loaded', 's-1'));
    setCoverage(boardScopeKey('board-3'), entry('loading', 's-3'));
    setCoverage(boardScopeKey('board-4'), entry('error', 's-4'));
    setCoverage(USER_SCOPE_KEYS.sessions, entry('loaded', 's-mine'));
    // Committed under an earlier authority: stale.
    setCoverage(USER_SCOPE_KEYS.teammates, {
      ...entry('loaded', 's-stale'),
      authorityScope: 'user-a:member:0',
    });
    const holds = (id: string) =>
      otherCommittedMembers(agorStore.getState(), boardScopeKey(BOARD)).some((members) =>
        members.sessions?.has(id)
      );
    expect(['s-1', 's-2', 's-3', 's-4', 's-mine', 's-stale'].filter((id) => holds(id))).toEqual([
      's-2',
      's-mine',
    ]);
  });
});

describe('partition LRU', () => {
  const boardRows = (boardId: string) => ({
    branches: [branch(`br-${boardId}`, { board_id: boardId })],
    sessions: [session(`s-${boardId}`, `br-${boardId}`, { branch_board_id: boardId })],
    cards: [card(`k-${boardId}`, { board_id: boardId, title: boardId })],
  });
  /** Load `boardId`'s partition: one branch, session and card of its own. */
  async function loadBoard(boardId: string) {
    const { client, release } = makePartitionClient({
      ...boardRows(boardId),
      board: fullBoard({ board_id: boardId }),
    });
    const load = loadBoardPartition(client, boardId, { canUseMemberWorkspaceServices: true });
    release();
    await load;
  }
  /** Display `boardId` (a board shell's use): loaded while used. */
  async function visit(boardId: string, background = false) {
    const release = registerBoardUse(boardId, background);
    await loadBoard(boardId);
    return release;
  }
  const loadedBoards = () =>
    [...agorStore.getState().coverage.keys()]
      .filter((key) => key.startsWith('board:'))
      .map((key) => key.slice('board:'.length))
      .sort();
  const has = (map: 'branchById' | 'sessionById' | 'cardById', id: string) =>
    agorStore.getState()[map].has(id);

  it('keeps the displayed board and the most recently used background partitions', async () => {
    expect(RETAINED_BACKGROUND_PARTITIONS).toBe(3);
    let release = await visit('b1');
    for (const boardId of ['b2', 'b3', 'b4', 'b5', 'b6']) {
      release();
      release = await visit(boardId);
    }
    // b6 displayed; b5, b4, b3 recently used; b1 and b2 evicted with their rows.
    expect(loadedBoards()).toEqual(['b3', 'b4', 'b5', 'b6']);
    for (const boardId of ['b1', 'b2']) {
      expect(has('branchById', `br-${boardId}`)).toBe(false);
      expect(has('sessionById', `s-${boardId}`)).toBe(false);
      expect(has('cardById', `k-${boardId}`)).toBe(false);
      expect(agorStore.getState().sessionsByBranch.has(`br-${boardId}`)).toBe(false);
    }
    for (const boardId of ['b3', 'b4', 'b5', 'b6'])
      expect(has('sessionById', `s-${boardId}`)).toBe(true);
    // Re-opening an evicted board reads it again.
    release();
    release = await visit('b1');
    expect(loadedBoards()).toEqual(['b1', 'b4', 'b5', 'b6']);
    expect(has('sessionById', 's-b1')).toBe(true);
    release();
  });

  it("an evicted partition's rows stay while another scope holds them", async () => {
    const lifetime = captureLoadLifetime()!;
    agorStore.getState().setCoverage(USER_SCOPE_KEYS.sessions, {
      status: 'loaded',
      ...lifetime,
      generation: 0,
      members: { sessions: new Set(['s-b1']) },
    });
    let release = await visit('b1');
    for (const boardId of ['b2', 'b3', 'b4', 'b5']) {
      release();
      release = await visit(boardId);
    }
    expect(loadedBoards()).not.toContain('b1');
    // My session stays (the user scope holds it); its branch and the card leave.
    expect(has('sessionById', 's-b1')).toBe(true);
    expect(has('branchById', 'br-b1')).toBe(false);
    expect(has('cardById', 'k-b1')).toBe(false);
    release();
  });

  it('mounted background partitions are never evicted and are kept first', async () => {
    const releases = [];
    // Five mounted background consumers (an expanded mobile navigation).
    for (const boardId of ['m1', 'm2', 'm3', 'm4', 'm5']) releases.push(await visit(boardId, true));
    expect(loadedBoards()).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
    // Collapsing them releases them into the LRU: the three most recent stay.
    for (const release of releases) release();
    expect(loadedBoards()).toEqual(['m3', 'm4', 'm5']);
    // A mounted one outranks a more recently released one.
    const mounted = await visit('m6', true);
    const shown = await visit('m7');
    expect(loadedBoards()).toEqual(['m4', 'm5', 'm6', 'm7']);
    mounted();
    shown();
  });

  it('never evicts a partition still loading', async () => {
    const pending = makePartitionClient(boardRows('slow'));
    const releaseSlow = registerBoardUse('slow', true);
    const slow = loadBoardPartition(pending.client, 'slow', {
      canUseMemberWorkspaceServices: true,
    });
    releaseSlow();
    const releases = [];
    for (const boardId of ['b1', 'b2', 'b3', 'b4']) releases.push(await visit(boardId, true));
    for (const release of releases) release();
    expect(loadedBoards()).toEqual(['b2', 'b3', 'b4', 'slow']);
    pending.release();
    await slow;
    // Once it settles, the LRU runs again: it was the least recently used.
    expect(loadedBoards()).toEqual(['b2', 'b3', 'b4']);
    expect(has('sessionById', 's-slow')).toBe(false);
  });

  it('boards visited and left while loading are evicted once their loads settle', async () => {
    const pending = [];
    for (let i = 0; i < 8; i++) {
      const boardId = `d${i}`;
      const deferred = makePartitionClient({
        ...boardRows(boardId),
        board: fullBoard({ board_id: boardId }),
      });
      const release = registerBoardUse(boardId);
      const load = loadBoardPartition(deferred.client, boardId, {
        canUseMemberWorkspaceServices: true,
      });
      release();
      pending.push({ deferred, load });
    }
    for (const { deferred, load } of pending) {
      deferred.release();
      await load;
    }
    expect(loadedBoards()).toEqual(['d5', 'd6', 'd7']);
    expect(agorStore.getState().sessionById.size).toBe(RETAINED_BACKGROUND_PARTITIONS);
    expect(agorStore.getState().branchById.size).toBe(RETAINED_BACKGROUND_PARTITIONS);
  });

  it("drops an evicted session's MCP links and loaded mark", async () => {
    let release = await visit('b1');
    agorStore.getState().replaceMaps({ sessionMcpServerIds: new Map([['s-b1', ['mcp-1']]]) });
    agorStore.getState().markSessionMcpLoaded('s-b1');
    for (const boardId of ['b2', 'b3', 'b4', 'b5']) {
      release();
      release = await visit(boardId);
    }
    expect(has('sessionById', 's-b1')).toBe(false);
    expect(agorStore.getState().sessionMcpServerIds.has('s-b1')).toBe(false);
    expect(agorStore.getState().sessionMcpLoaded.has('s-b1')).toBe(false);
    release();
  });

  it('evictUnloadedBoards removes the rows of boards without coverage only', async () => {
    await loadBoard('b1');
    await loadBoard('b2');
    agorStore.getState().setCoverage(boardScopeKey('b1'), null);
    evictUnloadedBoards(['b1', 'b2']);
    expect(has('sessionById', 's-b1')).toBe(false);
    expect(has('sessionById', 's-b2')).toBe(true);
  });
});

describe('foreground priority', () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("a background partition sends no read until the open session's transcript settles", async () => {
    let transcriptLanded!: () => void;
    holdBackgroundReads(new Promise<void>((resolve) => (transcriptLanded = resolve)));
    const background = makePartitionClient({ sessions: [session('s-1', 'br-1')] });
    const load = loadBoardPartition(background.client, BOARD, {
      canUseMemberWorkspaceServices: true,
      background: true,
    });
    await settle();
    expect(background.calls).toEqual([]);
    transcriptLanded();
    await settle();
    expect(background.callsTo('sessions', 'findAll')).not.toEqual([]);
    background.release();
    await load;
    expect(agorStore.getState().sessionById.has('s-1')).toBe(true);
  });

  it('the displayed board reads at once, and background partitions wait for it', async () => {
    const displayed = makePartitionClient({});
    const shown = loadBoardPartition(displayed.client, BOARD, {
      canUseMemberWorkspaceServices: true,
    });
    expect(displayed.callsTo('sessions', 'findAll')).not.toEqual([]);
    const background = makePartitionClient({});
    const other = loadBoardPartition(background.client, 'board-2', {
      canUseMemberWorkspaceServices: true,
      background: true,
    });
    await settle();
    expect(background.calls).toEqual([]);
    displayed.release();
    await shown;
    await settle();
    expect(background.callsTo('sessions', 'findAll')).not.toEqual([]);
    background.release();
    await other;
  });
});
