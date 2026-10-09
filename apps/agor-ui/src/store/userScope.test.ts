import type { Branch, Session } from '@agor-live/client';
import { hasFullSessionDetails, toLeanSessionListRow } from '@agor-live/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AUTHORITY,
  makeBranch as branch,
  makeComment as comment,
  deferred,
  fakeFeathersClient,
  gate,
  ME,
  makeSession,
  withTestAuthority,
} from '../test/harness';
import { boardCoverage, userScopeCoverage } from '../test/userScopeCoverage';
import { bumpFirstPaintMergeRevisions, cancelAllHydrations } from './agorHydration';
import { applyEntityFill } from './agorMaps';
import {
  branchPatched,
  sessionCreated,
  sessionPatched,
  sessionRemoved,
} from './agorRealtimeActions';
import { agorStore } from './agorStore';
import { captureLoadLifetime } from './loadLifetime';
import { setRealtimeAuthorityScope } from './realtimeBatch';
import {
  boardPartitionScope,
  boardScopeKey,
  replaceScope,
  type ScopeRows,
  USER_SCOPE_KEYS,
  type UserScopeKey,
} from './scopeMerge';
import {
  MY_SESSIONS_FULL_LIMIT,
  otherCommittedMembers,
  referencedBranchIds,
  referenceMembers,
  selectHomeBranchesLoaded,
  selectMySessionsLoaded,
  selectMySessionsTruncated,
  selectTeammatesLoaded,
  selectTeammatesTruncated,
  startUserScope,
  stopUserScope,
} from './userScope';

/** The current load lifetime (what `useAgorData` passes for its load). */
const lifetime = () => {
  const current = captureLoadLifetime();
  if (!current) throw new Error('no authority');
  return current;
};

const session = (id: string, branchId: string, overrides: Partial<Session> = {}) =>
  makeSession(id, branchId, {
    created_by: ME,
    last_updated: '2026-01-01T00:00:00.000Z',
    ...overrides,
  });

/** Mock client answering by service + query shape; records every call. */
function makeClient(handlers: {
  mine?: (limit: number) => Session[] | Promise<Session[]>;
  myBranches?: () => Branch[] | Promise<Branch[]>;
  teammates?: () => Branch[] | Promise<Branch[]>;
  /** The teammate total the daemon reports (default: the rows returned). */
  teammateTotal?: number;
  byIds?: (ids: string[]) => Branch[] | Promise<Branch[]>;
}) {
  const { client, calls } = fakeFeathersClient(
    {},
    {
      fallback: async ({ service, query }) => {
        if (service === 'sessions') return (await handlers.mine?.(query.$limit as number)) ?? [];
        if (query.teammate) {
          const data = (await handlers.teammates?.()) ?? [];
          return { data, total: handlers.teammateTotal ?? data.length };
        }
        if (query.created_by) return (await handlers.myBranches?.()) ?? [];
        const ids = (query.branch_id as { $in: string[] }).$in;
        return { data: (await handlers.byIds?.(ids)) ?? [] };
      },
    }
  );
  return { client, calls };
}

/** A complete replace of `boardId`'s partition with `rows`, respecting every other scope. */
const replaceBoard = (boardId: string, rows: ScopeRows) => {
  const others = otherCommittedMembers(agorStore.getState(), boardScopeKey(boardId));
  agorStore
    .getState()
    .applyMaps((prev) =>
      replaceScope(
        prev,
        boardPartitionScope(boardId),
        { ...rows, complete: true },
        () => false,
        others
      )
    );
};

const flags = () => {
  const s = agorStore.getState();
  return {
    mySessionsLoaded: selectMySessionsLoaded(s),
    mySessionsTruncated: selectMySessionsTruncated(s),
    teammatesLoaded: selectTeammatesLoaded(s),
    homeBranchesLoaded: selectHomeBranchesLoaded(s),
  };
};

withTestAuthority();
afterEach(() => stopUserScope());

describe('user scope', () => {
  it('skips the full read when the gated page already held all of my sessions', async () => {
    const { client, calls } = makeClient({});
    await startUserScope(client, { userId: ME, lifetime: lifetime(), gatedMineComplete: true });
    expect(calls.filter((c) => c.service === 'sessions')).toEqual([]);
    expect(flags()).toEqual({
      mySessionsLoaded: true,
      mySessionsTruncated: false,
      teammatesLoaded: true,
      homeBranchesLoaded: true,
    });
  });

  it('commits each piece with the ids its read returned, under the run lifetime', async () => {
    // br-present is already in the store, so the id read never asks for it.
    agorStore.getState().applyMaps((maps) => ({
      ...maps,
      branchById: new Map([['br-present', branch('br-present')]]),
    }));
    const { client } = makeClient({
      mine: () => [session('s-1', 'br-present'), session('s-2', 'br-ref')],
      myBranches: () => [branch('br-mine', { created_by: ME } as Partial<Branch>)],
      teammates: () => [branch('br-mate', { custom_context: { teammate: { kind: 'teammate' } } })],
      byIds: (ids) => ids.filter((id) => id === 'br-ref').map((id) => branch(id)),
    });
    const current = lifetime();
    await startUserScope(client, { userId: ME, lifetime: current, gatedMineComplete: false });
    const piece = (key: UserScopeKey) => agorStore.getState().coverage.get(key);
    const ids = (key: UserScopeKey, collection: 'sessions' | 'branches') => [
      ...(piece(key)?.members?.[collection] ?? []),
    ];
    expect(ids(USER_SCOPE_KEYS.sessions, 'sessions')).toEqual(['s-1', 's-2']);
    expect(ids(USER_SCOPE_KEYS.branches, 'branches')).toEqual(['br-mine']);
    expect(ids(USER_SCOPE_KEYS.teammates, 'branches')).toEqual(['br-mate']);
    // The referenced branches' membership is derived, however they loaded.
    expect(piece(USER_SCOPE_KEYS.references)?.members).toBeUndefined();
    expect([...referenceMembers(agorStore.getState(), ME)].sort()).toEqual([
      'br-present',
      'br-ref',
    ]);
    for (const key of Object.values(USER_SCOPE_KEYS)) {
      expect(piece(key)).toMatchObject({
        status: 'loaded',
        authorityScope: current.authorityScope,
        loadEpoch: current.loadEpoch,
      });
    }
  });

  it("a session created live after U1's read survives a later complete board replace that omits it", async () => {
    const { client } = makeClient({});
    await startUserScope(client, { userId: ME, lifetime: lifetime(), gatedMineComplete: false });
    expect(flags().mySessionsLoaded).toBe(true);
    sessionCreated(session('s-live', 'br-1', { branch_board_id: 'board-1' }));
    expect(
      agorStore.getState().coverage.get(USER_SCOPE_KEYS.sessions)?.members?.sessions?.has('s-live')
    ).toBe(true);
    // board-1's complete read predates the session.
    replaceBoard('board-1', { sessions: [] });
    expect(agorStore.getState().sessionById.has('s-live')).toBe(true);
    // Archived, it leaves my sessions' membership.
    sessionPatched(session('s-live', 'br-1', { branch_board_id: 'board-1', archived: true }));
    expect(
      agorStore.getState().coverage.get(USER_SCOPE_KEYS.sessions)?.members?.sessions?.has('s-live')
    ).toBe(false);
  });

  it('a session created live during the U1 read joins its membership at settlement', async () => {
    const held = deferred();
    const { client } = makeClient({
      mine: async () => {
        await held.promise;
        return [session('s-read', 'br-1')];
      },
    });
    const run = startUserScope(client, {
      userId: ME,
      lifetime: lifetime(),
      gatedMineComplete: false,
    });
    // While the read is in flight: one of mine created, one of mine removed.
    sessionCreated(session('s-raced', 'br-1'));
    sessionCreated(session('s-gone', 'br-1'));
    sessionRemoved(session('s-gone', 'br-1'));
    held.resolve();
    await run;
    const members = agorStore.getState().coverage.get(USER_SCOPE_KEYS.sessions)?.members?.sessions;
    expect([...(members ?? [])].sort()).toEqual(['s-raced', 's-read']);
  });

  it("a referenced branch preloaded by a partition is in reference membership and survives another scope's replace", async () => {
    // A board partition loaded br-ref (someone else's branch, on board-2).
    agorStore
      .getState()
      .applyMaps((prev) =>
        applyEntityFill(
          prev,
          { branches: [branch('br-ref', { board_id: 'board-2' })] },
          () => false
        )
      );
    const { client } = makeClient({ mine: () => [session('s-1', 'br-ref')] });
    await startUserScope(client, { userId: ME, lifetime: lifetime(), gatedMineComplete: false });
    expect(flags().homeBranchesLoaded).toBe(true);
    expect(referenceMembers(agorStore.getState(), ME).has('br-ref')).toBe(true);
    // board-2's complete read omits it (moved off while disconnected): my
    // session still references it, so it stays.
    replaceBoard('board-2', { branches: [] });
    expect(agorStore.getState().branchById.has('br-ref')).toBe(true);
    // No longer referenced: it leaves the membership, and the replace removes it.
    sessionPatched(session('s-1', 'br-ref', { archived: true }));
    expect(referenceMembers(agorStore.getState(), ME).has('br-ref')).toBe(false);
    replaceBoard('board-2', { branches: [] });
    expect(agorStore.getState().branchById.has('br-ref')).toBe(false);
  });

  it('reads all of my sessions in one capped read and flags truncation', async () => {
    const rows = Array.from({ length: MY_SESSIONS_FULL_LIMIT }, (_, i) =>
      session(`s-${i}`, 'br-1')
    );
    const { client, calls } = makeClient({
      mine: () => rows,
      byIds: () => [branch('br-1')],
    });
    await startUserScope(client, { userId: ME, lifetime: lifetime(), gatedMineComplete: false });
    const reads = calls.filter((c) => c.service === 'sessions');
    expect(reads).toHaveLength(1);
    expect(reads[0].query).toEqual({
      created_by: ME,
      archived: false,
      $sort: { updated_at: -1 },
      $limit: MY_SESSIONS_FULL_LIMIT,
      $count: false,
      lean: true,
    });
    expect(agorStore.getState().sessionById.size).toBe(MY_SESSIONS_FULL_LIMIT);
    expect(flags().mySessionsTruncated).toBe(true);
  });

  it('keeps live rows through a large (batched) fill of my sessions', async () => {
    const live = session('s-0', 'br-0', { title: 'live' });
    agorStore.getState().applyMaps((prev) => ({
      ...prev,
      sessionById: new Map([[live.session_id, live]]),
      sessionsByBranch: new Map([['br-0', [live]]]),
    }));
    const rows = Array.from({ length: 500 }, (_, i) =>
      session(`s-${i}`, `br-${i % 3}`, { title: 'snapshot' })
    );
    const { client } = makeClient({
      mine: () => rows,
      byIds: (ids) => ids.map((id) => branch(id)),
    });
    await startUserScope(client, { userId: ME, lifetime: lifetime(), gatedMineComplete: false });
    const state = agorStore.getState();
    expect(state.sessionById.get('s-0')).toBe(live);
    expect(state.sessionById.size).toBe(500);
    expect(state.sessionsByBranch.get('br-0')?.[0]).toBe(live);
    expect([...state.sessionsByBranch.values()].reduce((n, bucket) => n + bucket.length, 0)).toBe(
      500
    );
  });

  it('loads teammates, never overwriting a live (full) row', async () => {
    const live = branch('mate', { name: 'live', notes: 'full' } as Partial<Branch>);
    agorStore.getState().setMap('branchById', new Map([[live.branch_id, live]]));
    const { client } = makeClient({
      teammates: () => [branch('mate', { name: 'stale' }), branch('mate-2')],
    });
    await startUserScope(client, { userId: ME, lifetime: lifetime(), gatedMineComplete: true });
    expect(agorStore.getState().branchById.get('mate')).toBe(live);
    expect(agorStore.getState().branchById.has('mate-2')).toBe(true);
    expect(flags().teammatesLoaded).toBe(true);
  });

  it("publishes teammate rows before my branches settle, deferring only U3's coverage", async () => {
    const held = deferred();
    const { client } = makeClient({
      myBranches: async () => {
        await held.promise;
        return [];
      },
      teammates: () => [branch('mate', { custom_context: { teammate: { kind: 'teammate' } } })],
    });
    const run = startUserScope(client, {
      userId: ME,
      lifetime: lifetime(),
      gatedMineComplete: true,
    });
    await vi.waitFor(() => expect(agorStore.getState().branchById.has('mate')).toBe(true));
    expect(flags().teammatesLoaded).toBe(false);
    held.resolve();
    await run;
    expect(flags().teammatesLoaded).toBe(true);
    expect([
      ...(agorStore.getState().coverage.get(USER_SCOPE_KEYS.teammates)?.members?.branches ?? []),
    ]).toEqual(['mate']);
  });

  it('keeps a teammate branch U3 returned, through a later complete board replace', async () => {
    const mate = branch('mate', { custom_context: { teammate: { kind: 'teammate' } } });
    const { client } = makeClient({ teammates: () => [mate] });
    await startUserScope(client, { userId: ME, lifetime: lifetime(), gatedMineComplete: true });
    expect([
      ...(agorStore.getState().coverage.get(USER_SCOPE_KEYS.teammates)?.members?.branches ?? []),
    ]).toEqual(['mate']);
    replaceBoard('board-1', { branches: [] });
    expect(agorStore.getState().branchById.has('mate')).toBe(true);
  });

  it('a live patch that drops the marker leaves membership, so a complete board replace removes it', async () => {
    const teammateMembers = () =>
      agorStore.getState().coverage.get(USER_SCOPE_KEYS.teammates)?.members?.branches;
    const mate = branch('mate', { custom_context: { teammate: { kind: 'teammate' } } });
    const { client } = makeClient({ teammates: () => [mate] });
    await startUserScope(client, { userId: ME, lifetime: lifetime(), gatedMineComplete: true });
    branchPatched({ ...mate, custom_context: {} });
    expect(teammateMembers()?.has('mate')).toBe(false);
    replaceBoard('board-1', { branches: [] });
    expect(agorStore.getState().branchById.has('mate')).toBe(false);
  });

  it('a live patch adds a newly marked teammate to membership', async () => {
    agorStore.getState().applyMaps((maps) => ({
      ...maps,
      branchById: new Map([['br-plain', branch('br-plain')]]),
    }));
    const { client } = makeClient({});
    await startUserScope(client, { userId: ME, lifetime: lifetime(), gatedMineComplete: true });
    branchPatched(branch('br-plain', { custom_context: { teammate: { kind: 'teammate' } } }));
    expect(
      agorStore
        .getState()
        .coverage.get(USER_SCOPE_KEYS.teammates)
        ?.members?.branches?.has('br-plain')
    ).toBe(true);
  });

  it('marks teammates truncated when the server reports more than the capped read', async () => {
    const { client } = makeClient({ teammates: () => [branch('mate-1')], teammateTotal: 1001 });
    await startUserScope(client, { userId: ME, lifetime: lifetime(), gatedMineComplete: true });
    expect(flags().teammatesLoaded).toBe(true);
    expect(selectTeammatesTruncated(agorStore.getState())).toBe(true);
  });

  it('ensures referenced branches in chunks of 200 and records the absent ones', async () => {
    const mine = Array.from({ length: 250 }, (_, i) => session(`s-${i}`, `br-${i}`));
    const { client, calls } = makeClient({
      mine: () => mine,
      // The server returns all but br-7 (archived, deleted or invisible).
      byIds: (ids) => ids.filter((id) => id !== 'br-7').map((id) => branch(id)),
    });
    await startUserScope(client, { userId: ME, lifetime: lifetime(), gatedMineComplete: false });
    await vi.waitFor(() => expect(flags().homeBranchesLoaded).toBe(true));
    const idReads = calls.filter((c) => c.query.branch_id);
    expect(idReads.map((c) => (c.query.branch_id as { $in: string[] }).$in.length)).toEqual([
      200, 50,
    ]);
    expect(idReads[0].query).toMatchObject({ archived: false });
    expect([...agorStore.getState().absentBranchIds]).toEqual(['br-7']);
    expect(flags().homeBranchesLoaded).toBe(true);
  });

  it('resolves references from a complete gated page without waiting for my branches', async () => {
    agorStore.getState().applyMaps((prev) => ({
      ...prev,
      sessionById: new Map([['s-1', session('s-1', 'br-ref')]]),
    }));
    const mineGate = deferred();
    const { client, calls } = makeClient({
      myBranches: async () => {
        await mineGate.promise;
        return [];
      },
      byIds: (ids) => ids.map((id) => branch(id)),
    });
    const run = startUserScope(client, {
      userId: ME,
      lifetime: lifetime(),
      gatedMineComplete: true,
    });
    await vi.waitFor(() => expect(agorStore.getState().branchById.has('br-ref')).toBe(true));
    expect(calls.some((c) => c.query.branch_id)).toBe(true);
    expect(flags().homeBranchesLoaded).toBe(false);
    mineGate.resolve();
    await run;
    expect(flags().homeBranchesLoaded).toBe(true);
  });

  it('references the branches of candidate comment threads only', () => {
    agorStore.setState({
      commentById: new Map(
        [
          // Someone else spoke last → candidate.
          comment('root-a', { branch_id: 'br-a', created_by: 'bob' }),
          // I spoke last → not a candidate.
          comment('root-b', { branch_id: 'br-b', created_by: 'bob' }),
          comment('reply-b', {
            branch_id: 'br-b',
            parent_comment_id: 'root-b',
            created_by: ME,
            created_at: '2026-01-02T00:00:00.000Z',
          }),
          // Resolved → not a candidate.
          comment('root-c', { branch_id: 'br-c', created_by: 'bob', resolved: true }),
        ].map((c) => [c.comment_id, c])
      ),
    });
    expect([...referencedBranchIds(agorStore.getState(), ME)]).toEqual(['br-a']);
  });

  it('ensures new references once, batched, and clears an absent mark when the branch arrives', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { client, calls } = makeClient({ byIds: (ids) => ids.map((id) => branch(id)) });
    await startUserScope(client, { userId: ME, lifetime: lifetime(), gatedMineComplete: true });
    expect(flags().homeBranchesLoaded).toBe(true);

    sessionCreated(session('new-1', 'br-new'));
    sessionCreated(session('new-2', 'br-new'));
    sessionCreated(session('new-3', 'br-other'));
    await vi.advanceTimersByTimeAsync(150);
    const idReads = calls.filter((c) => c.query.branch_id);
    expect(idReads).toHaveLength(1);
    expect((idReads[0].query.branch_id as { $in: string[] }).$in.sort()).toEqual([
      'br-new',
      'br-other',
    ]);

    agorStore.getState().setUserScope({ absentBranchIds: new Set(['br-late']) });
    agorStore
      .getState()
      .setMap('branchById', (prev) => new Map(prev).set('br-late', branch('br-late')));
    await vi.advanceTimersByTimeAsync(150);
    expect(agorStore.getState().absentBranchIds.size).toBe(0);
  });

  it('leaves my-sessions and Home-branch flags unset when my sessions cannot be read', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { client } = makeClient({
      mine: () => Promise.reject(new Error('socket timeout')),
    });
    await startUserScope(client, { userId: ME, lifetime: lifetime(), gatedMineComplete: false });
    expect(flags()).toEqual({
      mySessionsLoaded: false,
      mySessionsTruncated: false,
      teammatesLoaded: true,
      homeBranchesLoaded: false,
    });
  });

  it('sends the id reads U1 triggered before resolving even when my branches fail', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { client, calls } = makeClient({
      mine: () => [session('s-old', 'br-old')],
      myBranches: () => Promise.reject(new Error('socket timeout')),
      byIds: (ids) => ids.map((id) => branch(id)),
    });
    await startUserScope(client, { userId: ME, lifetime: lifetime(), gatedMineComplete: false });
    // Sent (and drained) before the start resolves, not by the debounced scan.
    expect(
      calls.some((c) =>
        (c.query.branch_id as { $in?: string[] } | undefined)?.$in?.includes('br-old')
      )
    ).toBe(true);
    expect(agorStore.getState().branchById.has('br-old')).toBe(true);
    // Without my branches the references aren't all known: no completeness.
    expect(flags()).toEqual({
      mySessionsLoaded: true,
      mySessionsTruncated: false,
      teammatesLoaded: false,
      homeBranchesLoaded: false,
    });
  });

  it('drops a run whose authority changed, and resets with the maps', async () => {
    const held = deferred();
    const { client } = makeClient({
      mine: async () => {
        await held.promise;
        return [session('s-1', 'br-1')];
      },
    });
    const run = startUserScope(client, {
      userId: ME,
      lifetime: lifetime(),
      gatedMineComplete: false,
    });
    setRealtimeAuthorityScope('someone-else:member:1');
    held.resolve();
    await run;
    expect(agorStore.getState().sessionById.size).toBe(0);
    expect(flags().mySessionsLoaded).toBe(false);

    setRealtimeAuthorityScope(AUTHORITY);
    agorStore.setState({ coverage: userScopeCoverage({ sessions: true, teammates: true }) });
    agorStore.getState().resetMaps();
    expect(flags()).toEqual({
      mySessionsLoaded: false,
      mySessionsTruncated: false,
      teammatesLoaded: false,
      homeBranchesLoaded: false,
    });
  });

  it('rejects a lifetime that was cancelled before the run started', async () => {
    const { client, calls } = makeClient({});
    const stale = lifetime();
    cancelAllHydrations(); // an unmount/remount, same authority
    await startUserScope(client, { userId: ME, lifetime: stale, gatedMineComplete: true });
    expect(calls).toEqual([]);
    expect(flags().mySessionsLoaded).toBe(false);
  });

  it('drops a run cancelled mid-read even when the authority is the same again', async () => {
    const held = deferred();
    const { client } = makeClient({
      mine: async () => {
        await held.promise;
        return [session('s-1', 'br-1')];
      },
      teammates: async () => {
        await held.promise;
        return [branch('mate')];
      },
    });
    const run = startUserScope(client, {
      userId: ME,
      lifetime: lifetime(),
      gatedMineComplete: false,
    });
    cancelAllHydrations();
    held.resolve();
    await run;
    expect(agorStore.getState().sessionById.size).toBe(0);
    expect(agorStore.getState().branchById.size).toBe(0);
    expect(flags()).toEqual({
      mySessionsLoaded: false,
      mySessionsTruncated: false,
      teammatesLoaded: false,
      homeBranchesLoaded: false,
    });
  });

  it('never applies a read whose every attempt spanned a wholesale replacement', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let reads = 0;
    const { client } = makeClient({
      mine: () => {
        reads += 1;
        bumpFirstPaintMergeRevisions(); // a reconnect resync lands mid-read, every time
        return [session(`s-stale-${reads}`, 'br-1')];
      },
    });
    await startUserScope(client, { userId: ME, lifetime: lifetime(), gatedMineComplete: false });
    expect(reads).toBe(4);
    expect(agorStore.getState().sessionById.size).toBe(0);
    expect(flags().mySessionsLoaded).toBe(false);
  });

  it('sees a reference that appears while the referenced-branch reads are in flight', async () => {
    const idGate = deferred();
    const { client, calls } = makeClient({
      mine: () => [session('s-1', 'br-1')],
      byIds: async (ids) => {
        if (ids.includes('br-1')) await idGate.promise;
        return ids.map((id) => branch(id));
      },
    });
    // Resolves only after the id reads drain, so don't await it while br-1 is held.
    const run = startUserScope(client, {
      userId: ME,
      lifetime: lifetime(),
      gatedMineComplete: false,
    });
    await vi.waitFor(() =>
      expect(
        calls.some((c) =>
          (c.query.branch_id as { $in?: string[] } | undefined)?.$in?.includes('br-1')
        )
      ).toBe(true)
    );
    // A comment thread on an unloaded branch lands while br-1's read is in flight.
    agorStore
      .getState()
      .setMap(
        'commentById',
        new Map([['c-1', comment('c-1', { branch_id: 'br-late', created_by: 'bob' })]])
      );
    await vi.waitFor(() => expect(agorStore.getState().branchById.has('br-late')).toBe(true));
    expect(flags().homeBranchesLoaded).toBe(false);
    idGate.resolve();
    await run;
    await vi.waitFor(() => expect(flags().homeBranchesLoaded).toBe(true));
    expect(agorStore.getState().branchById.has('br-1')).toBe(true);
  });

  it('retries a failed referenced-branch read with backoff, and stops when the run stops', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let attempts = 0;
    const { client } = makeClient({
      mine: () => [session('s-1', 'br-1')],
      byIds: (ids) => {
        attempts += 1;
        if (attempts === 1) throw new Error('503');
        return ids.map((id) => branch(id));
      },
    });
    await startUserScope(client, { userId: ME, lifetime: lifetime(), gatedMineComplete: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toBe(1);
    expect(flags().homeBranchesLoaded).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(attempts).toBe(2);
    expect(flags().homeBranchesLoaded).toBe(true);

    // A stopped run never retries.
    let later = 0;
    const failing = makeClient({
      mine: () => [session('s-2', 'br-2')],
      byIds: () => {
        later += 1;
        throw new Error('503');
      },
    });
    await startUserScope(failing.client, {
      userId: ME,
      lifetime: lifetime(),
      gatedMineComplete: false,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(later).toBe(1);
    stopUserScope();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(later).toBe(1);
  });

  it('keeps at most three referenced-branch reads in flight', async () => {
    const held = gate();
    let inflight = 0;
    let peak = 0;
    const mine = Array.from({ length: 1000 }, (_, i) => session(`s-${i}`, `br-${i}`));
    const { client, calls } = makeClient({
      mine: () => mine,
      byIds: async (ids) => {
        inflight += 1;
        peak = Math.max(peak, inflight);
        await held.wait();
        inflight -= 1;
        return ids.map((id) => branch(id));
      },
    });
    const run = startUserScope(client, {
      userId: ME,
      lifetime: lifetime(),
      gatedMineComplete: false,
    });
    for (let i = 0; i < 20 && !flags().homeBranchesLoaded; i++) {
      await vi.waitFor(() => expect(held.waiting).toBeGreaterThan(0));
      held.release();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    await run;
    expect(flags().homeBranchesLoaded).toBe(true);
    expect(peak).toBe(3);
    expect(calls.filter((c) => c.query.branch_id)).toHaveLength(5);
  });

  it('drops an absent mark once nothing references the branch', async () => {
    agorStore.getState().applyMaps((prev) => ({
      ...prev,
      sessionById: new Map([
        ['s-1', session('s-1', 'br-gone')],
        ['s-2', session('s-2', 'br-other')],
      ]),
    }));
    const { client } = makeClient({ byIds: () => [] });
    await startUserScope(client, { userId: ME, lifetime: lifetime(), gatedMineComplete: true });
    await vi.waitFor(() =>
      expect([...agorStore.getState().absentBranchIds].sort()).toEqual(['br-gone', 'br-other'])
    );
    sessionRemoved(session('s-1', 'br-gone'));
    await vi.waitFor(() => expect([...agorStore.getState().absentBranchIds]).toEqual(['br-other']));
  });

  it('revalidates absent marks under the new run', async () => {
    agorStore.getState().applyMaps((prev) => ({
      ...prev,
      sessionById: new Map([
        ['s-1', session('s-1', 'br-gone')],
        ['s-2', session('s-2', 'br-back')],
      ]),
    }));
    agorStore.getState().setUserScope({ absentBranchIds: new Set(['br-gone', 'br-back']) });
    const { client } = makeClient({
      byIds: (ids) => ids.filter((id) => id === 'br-back').map((id) => branch(id)),
    });
    await startUserScope(client, { userId: ME, lifetime: lifetime(), gatedMineComplete: true });
    await vi.waitFor(() => expect([...agorStore.getState().absentBranchIds]).toEqual(['br-gone']));
    expect(agorStore.getState().branchById.has('br-back')).toBe(true);
  });

  it('resolves the references of a full gated page before the full read is sent', async () => {
    agorStore.getState().applyMaps((prev) => ({
      ...prev,
      sessionById: new Map([['s-1', session('s-1', 'br-early')]]),
    }));
    const mineGate = deferred();
    const { client, calls } = makeClient({
      mine: async () => {
        await mineGate.promise;
        return [];
      },
      byIds: (ids) => ids.map((id) => branch(id)),
    });
    const run = startUserScope(client, {
      userId: ME,
      lifetime: lifetime(),
      gatedMineComplete: false,
    });
    // Both are sent synchronously, before anything the caller starts next
    // (the global snapshots).
    const order = () => calls.map((c) => (c.query.branch_id ? 'ids' : c.service));
    expect(order()).toContain('sessions');
    expect(order().indexOf('ids')).toBeGreaterThanOrEqual(0);
    expect(order().indexOf('ids')).toBeLessThan(order().indexOf('sessions'));
    await vi.waitFor(() => expect(agorStore.getState().branchById.has('br-early')).toBe(true));
    mineGate.resolve();
    await run;
    await vi.waitFor(() => expect(flags().homeBranchesLoaded).toBe(true));
  });

  it('fills lean rows as summaries and never downgrades a live full row (#2948 read_shape)', async () => {
    const full = session('s-full', 'br-1', { title: 'live full' });
    agorStore.getState().applyMaps((prev) => ({
      ...prev,
      sessionById: new Map([[full.session_id, full]]),
      sessionsByBranch: new Map([['br-1', [full]]]),
    }));
    const { client } = makeClient({
      mine: () =>
        [session('s-full', 'br-1'), session('s-new', 'br-1')].map((row) =>
          toLeanSessionListRow(row)
        ) as unknown as Session[],
      byIds: (ids) => ids.map((id) => branch(id)),
    });
    await startUserScope(client, { userId: ME, lifetime: lifetime(), gatedMineComplete: false });
    const state = agorStore.getState();
    expect(state.sessionById.get('s-full')).toBe(full);
    expect(hasFullSessionDetails(state.sessionById.get('s-full') as Session)).toBe(true);
    expect(hasFullSessionDetails(state.sessionById.get('s-new') as Session)).toBe(false);
  });

  it('never marks a store loaded when its run is cancelled between the fill and its completion', async () => {
    const { client } = makeClient({ mine: () => [session('s-alice', 'br-1')] });
    // Cancel exactly when Alice's U1 rows are applied (still current), so only
    // the completion continuation runs after the teardown.
    let tornDown = false;
    const off = agorStore.subscribe((state) => {
      if (tornDown || !state.sessionById.has('s-alice')) return;
      tornDown = true;
      cancelAllHydrations(); // unmount
      setRealtimeAuthorityScope('bob:member:1');
      agorStore.getState().resetMaps(); // Bob's empty store
    });
    try {
      await startUserScope(client, { userId: ME, lifetime: lifetime(), gatedMineComplete: false });
    } finally {
      off();
    }
    expect(tornDown).toBe(true);
    expect(flags().mySessionsLoaded).toBe(false);
    expect(flags().homeBranchesLoaded).toBe(false);
  });

  it("never lets a superseded run's id-read completion mark branches absent for the next user", async () => {
    // Alice can't see br-x; her read returns only br-other.
    agorStore.getState().applyMaps((prev) => ({
      ...prev,
      sessionById: new Map([
        ['s-1', session('s-1', 'br-x')],
        ['s-2', session('s-2', 'br-other')],
      ]),
    }));
    const alice = makeClient({
      byIds: (ids) => ids.filter((id) => id === 'br-other').map((id) => branch(id)),
    });
    const BOB = 'user-bob';
    const bob = makeClient({
      mine: () => [session('s-bob', 'br-x', { created_by: BOB })],
      byIds: (ids) => ids.map((id) => branch(id)),
    });
    // When Alice's id read applies br-other, Bob's identity takes over and his
    // scope starts (his U1 still pending) before her completion runs.
    let switched = false;
    let bobRun: Promise<void> | undefined;
    const off = agorStore.subscribe((state) => {
      if (switched || !state.branchById.has('br-other')) return;
      switched = true;
      cancelAllHydrations();
      setRealtimeAuthorityScope('bob:member:1');
      agorStore.getState().resetMaps();
      bobRun = startUserScope(bob.client, {
        userId: BOB,
        lifetime: lifetime(),
        gatedMineComplete: false,
      });
    });
    try {
      await startUserScope(alice.client, {
        userId: ME,
        lifetime: lifetime(),
        gatedMineComplete: true,
      });
      await vi.waitFor(() => expect(switched).toBe(true));
      await bobRun;
      await vi.waitFor(() => expect(flags().homeBranchesLoaded).toBe(true));
    } finally {
      off();
    }
    const state = agorStore.getState();
    expect(state.absentBranchIds.has('br-x')).toBe(false);
    // Bob's U1 references br-x, so his scope reads it by id instead of trusting
    // a negative Alice recorded.
    expect(
      bob.calls.some((c) => (c.query.branch_id as { $in?: string[] })?.$in?.includes('br-x'))
    ).toBe(true);
    expect(state.branchById.has('br-x')).toBe(true);
  });

  it('keeps flags true while a silent-resync re-run is in flight', async () => {
    const { client } = makeClient({});
    await startUserScope(client, { userId: ME, lifetime: lifetime(), gatedMineComplete: true });
    expect(flags().homeBranchesLoaded).toBe(true);
    const held = deferred();
    const slow = makeClient({
      mine: async () => {
        await held.promise;
        return [];
      },
    });
    const rerun = startUserScope(slow.client, {
      userId: ME,
      lifetime: lifetime(),
      gatedMineComplete: false,
    });
    expect(flags()).toMatchObject({ mySessionsLoaded: true, homeBranchesLoaded: true });
    held.resolve();
    await rerun;
    expect(flags()).toMatchObject({ mySessionsLoaded: true, homeBranchesLoaded: true });
  });
});

describe('user scope — reconnect replace', () => {
  const mate = (id: string) =>
    branch(id, { custom_context: { teammate: { kind: 'teammate' } } } as Partial<Branch>);
  const mine = (id: string) => branch(id, { created_by: ME } as Partial<Branch>);
  const has = (map: 'sessionById' | 'branchById', id: string) => agorStore.getState()[map].has(id);

  /** A first (fill) run that loads every piece, then board-2 loaded holding `s-board`. */
  async function loadScope() {
    const first = makeClient({
      mine: () => [
        session('s-keep', 'br-mine'),
        session('s-gone', 'br-mine'),
        session('s-board', 'br-other', { branch_board_id: 'board-2' }),
      ],
      myBranches: () => [mine('br-mine'), mine('br-gone')],
      teammates: () => [mate('mate-1'), mate('mate-gone')],
      byIds: (ids) => ids.map((id) => branch(id, { board_id: 'board-2' })),
    });
    await startUserScope(first.client, {
      userId: ME,
      lifetime: lifetime(),
      gatedMineComplete: false,
    });
    await vi.waitFor(() => expect(flags().homeBranchesLoaded).toBe(true));
    agorStore.getState().setCoverage(boardScopeKey('board-2'), {
      ...boardCoverage('loaded', lifetime()),
      members: { sessions: new Set(['s-board']), branches: new Set(['br-other']) },
    });
  }

  it('reconciles my sessions, my branches and teammates, keeping rows another scope holds', async () => {
    await loadScope();
    // While disconnected: s-gone and s-board archived, br-gone deleted,
    // mate-gone lost its marker, s-keep renamed.
    const resync = makeClient({
      mine: () => [session('s-keep', 'br-mine', { title: 'renamed' } as Partial<Session>)],
      myBranches: () => [mine('br-mine')],
      teammates: () => [mate('mate-1')],
      byIds: (ids) => ids.map((id) => branch(id, { board_id: 'board-2' })),
    });
    await startUserScope(resync.client, {
      userId: ME,
      lifetime: lifetime(),
      gatedMineComplete: false,
      replace: true,
    });
    expect(has('sessionById', 's-gone')).toBe(false);
    expect(has('branchById', 'br-gone')).toBe(false);
    expect(has('branchById', 'mate-gone')).toBe(false);
    expect(agorStore.getState().sessionById.get('s-keep')?.title).toBe('renamed');
    // board-2's committed membership still holds it.
    expect(has('sessionById', 's-board')).toBe(true);
    expect(has('branchById', 'mate-1')).toBe(true);
    expect(flags()).toMatchObject({ mySessionsLoaded: true, teammatesLoaded: true });
  });

  it('my own teammate branch deleted while disconnected leaves even when U3 replies before U2', async () => {
    // br-own-mate is mine AND a teammate: both U2 and U3 hold it.
    const ownMate = branch('br-own-mate', {
      created_by: ME,
      custom_context: { teammate: { kind: 'teammate' } },
    } as Partial<Branch>);
    const first = makeClient({ myBranches: () => [ownMate], teammates: () => [ownMate] });
    await startUserScope(first.client, {
      userId: ME,
      lifetime: lifetime(),
      gatedMineComplete: true,
    });
    expect(has('branchById', 'br-own-mate')).toBe(true);
    // Deleted while disconnected; on reconnect U3 answers first, U2 later.
    const u2 = deferred();
    const resync = makeClient({
      myBranches: async () => {
        await u2.promise;
        return [];
      },
      teammates: () => [],
    });
    const run = startUserScope(resync.client, {
      userId: ME,
      lifetime: lifetime(),
      gatedMineComplete: true,
      replace: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    u2.resolve();
    await run;
    expect(has('branchById', 'br-own-mate')).toBe(false);
    expect(flags().teammatesLoaded).toBe(true);
  });

  it('a capped read removes nothing', async () => {
    await loadScope();
    const capped = Array.from({ length: MY_SESSIONS_FULL_LIMIT }, (_, i) =>
      session(`s-new-${i}`, 'br-mine')
    );
    const resync = makeClient({
      mine: () => capped,
      myBranches: () => [mine('br-mine'), mine('br-gone')],
      teammates: () => [mate('mate-1')],
      teammateTotal: 5,
      byIds: (ids) => ids.map((id) => branch(id, { board_id: 'board-2' })),
    });
    await startUserScope(resync.client, {
      userId: ME,
      lifetime: lifetime(),
      gatedMineComplete: false,
      replace: true,
    });
    expect(flags()).toMatchObject({ mySessionsTruncated: true });
    expect(selectTeammatesTruncated(agorStore.getState())).toBe(true);
    expect(has('sessionById', 's-gone')).toBe(true);
    expect(has('sessionById', 's-keep')).toBe(true);
    expect(has('branchById', 'mate-gone')).toBe(true);
  });

  it('a fill run (no replace) removes nothing', async () => {
    await loadScope();
    const resync = makeClient({ mine: () => [], myBranches: () => [], teammates: () => [] });
    await startUserScope(resync.client, {
      userId: ME,
      lifetime: lifetime(),
      gatedMineComplete: false,
    });
    expect(has('sessionById', 's-gone')).toBe(true);
    expect(has('branchById', 'br-gone')).toBe(true);
    expect(has('branchById', 'mate-gone')).toBe(true);
  });

  it('re-reads every referenced branch, present ones too, and removes the ones a chunk omits', async () => {
    const first = makeClient({
      mine: () => [
        session('s-1', 'br-ref'),
        session('s-2', 'br-gone'),
        session('s-3', 'br-held'),
        session('s-del', 'br-mine-del'),
      ],
      myBranches: () => [mine('br-mine-del')],
      byIds: (ids) => ids.map((id) => branch(id, { board_id: 'board-2' })),
    });
    await startUserScope(first.client, {
      userId: ME,
      lifetime: lifetime(),
      gatedMineComplete: false,
    });
    await vi.waitFor(() => expect(flags().homeBranchesLoaded).toBe(true));
    // board-3's committed membership holds br-held.
    agorStore.getState().setCoverage(boardScopeKey('board-3'), {
      ...boardCoverage('loaded', lifetime()),
      members: { branches: new Set(['br-held']) },
    });

    // While disconnected: br-ref renamed, br-gone deleted, br-held hidden
    // from the id read, and s-del deleted with its branch br-mine-del.
    const resync = makeClient({
      mine: () => [session('s-1', 'br-ref'), session('s-2', 'br-gone'), session('s-3', 'br-held')],
      myBranches: () => [],
      byIds: (ids) =>
        ids
          .filter((id) => id === 'br-ref')
          .map((id) => branch(id, { board_id: 'board-2', name: 'renamed' })),
    });
    await startUserScope(resync.client, {
      userId: ME,
      lifetime: lifetime(),
      gatedMineComplete: false,
      replace: true,
    });
    await vi.waitFor(() => expect(has('branchById', 'br-gone')).toBe(false));
    const state = agorStore.getState();
    expect(state.branchById.get('br-ref')?.name).toBe('renamed');
    expect(state.absentBranchIds.has('br-gone')).toBe(true);
    expect(has('sessionById', 's-del')).toBe(false);
    // Referenced only by a session that is gone now: still reconciled.
    expect(has('branchById', 'br-mine-del')).toBe(false);
    expect(has('branchById', 'br-held')).toBe(true);
    expect(state.absentBranchIds.has('br-held')).toBe(false);
    const requested = resync.calls.flatMap(
      (c) => (c.query.branch_id as { $in?: string[] } | undefined)?.$in ?? []
    );
    expect(requested).toEqual(expect.arrayContaining(['br-ref', 'br-gone', 'br-held']));
    expect(flags().homeBranchesLoaded).toBe(true);
  });

  it('publishes a removed referenced branch and its absent mark in one update', async () => {
    const first = makeClient({
      mine: () => [session('s-1', 'br-gone')],
      byIds: (ids) => ids.map((id) => branch(id)),
    });
    await startUserScope(first.client, {
      userId: ME,
      lifetime: lifetime(),
      gatedMineComplete: false,
    });
    await vi.waitFor(() => expect(flags().homeBranchesLoaded).toBe(true));
    const split: string[] = [];
    const off = agorStore.subscribe((s) => {
      if (!s.branchById.has('br-gone') && !s.absentBranchIds.has('br-gone')) split.push('br-gone');
    });
    const resync = makeClient({ mine: () => [session('s-1', 'br-gone')], byIds: () => [] });
    await startUserScope(resync.client, {
      userId: ME,
      lifetime: lifetime(),
      gatedMineComplete: false,
      replace: true,
    });
    await vi.waitFor(() => expect(has('branchById', 'br-gone')).toBe(false));
    off();
    expect(agorStore.getState().absentBranchIds.has('br-gone')).toBe(true);
    expect(split).toEqual([]);
  });
});
