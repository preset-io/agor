import type { Branch, Link, Session } from '@agor-live/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deferred } from '../testUtils';
import { cancelAllHydrations, resetHydrationRevisions, runHydration } from './agorHydration';
import { mergeLinksIntoMaps, reconcilePinnedBranchLinksIntoMaps } from './agorMaps';
import { branchPatched, linkCreated, linkRemoved, sessionRemoved } from './agorRealtimeActions';
import {
  agorStore,
  getPinnedBranchLinkPreserveBranchIds,
  invalidateFullLinkRequestsForLink,
} from './agorStore';

function link(linkId: string, owner: Partial<Link>): Link {
  return {
    link_id: linkId,
    branch_id: null,
    session_id: null,
    is_pinned: false,
    ...owner,
  } as Link;
}

beforeEach(() => {
  cancelAllHydrations();
  resetHydrationRevisions();
  agorStore.getState().reset();
});

describe('agorStore link hydration', () => {
  it('lets pinned-only hydration prune active full buckets but preserves direct archived full buckets', () => {
    const activeBranch = { branch_id: 'b-active' } as Branch;
    const activePinned = link('l-active-pinned', { branch_id: 'b-active', is_pinned: true });
    const archivedPinned = link('l-archived-pinned', {
      branch_id: 'b-archived',
      is_pinned: true,
    });

    agorStore.getState().setMap('branchById', new Map([['b-active', activeBranch]]));
    agorStore.getState().replaceFullBranchLinks('b-active', [activePinned]);
    agorStore.getState().replaceFullBranchLinks('b-archived', [archivedPinned]);

    agorStore.getState().applyMaps((prev) =>
      reconcilePinnedBranchLinksIntoMaps(prev, [], {
        preserveBranchIds: getPinnedBranchLinkPreserveBranchIds(agorStore.getState()),
      })
    );

    const state = agorStore.getState();
    expect(state.linkById.has('l-active-pinned')).toBe(false);
    expect(state.linksByBranch.has('b-active')).toBe(false);
    expect(state.linkById.get('l-archived-pinned')).toBe(archivedPinned);
    expect(state.linksByBranch.get('b-archived')).toEqual([archivedPinned]);
  });

  it('prunes a formerly-active full branch bucket after branch hydration drops the owner', () => {
    const activeBranch = { branch_id: 'b-formerly-active' } as Branch;
    const stalePinned = link('l-formerly-active-pinned', {
      branch_id: 'b-formerly-active',
      is_pinned: true,
    });

    agorStore.getState().setMap('branchById', new Map([['b-formerly-active', activeBranch]]));
    agorStore.getState().replaceFullBranchLinks('b-formerly-active', [stalePinned]);

    // Active branch hydration later discovers the branch disappeared (archived
    // or deleted) before global pinned-link hydration runs.
    agorStore.getState().setMap('branchById', new Map());
    agorStore.getState().applyMaps((prev) =>
      reconcilePinnedBranchLinksIntoMaps(prev, [], {
        preserveBranchIds: getPinnedBranchLinkPreserveBranchIds(agorStore.getState()),
      })
    );

    const state = agorStore.getState();
    expect(state.linkById.has('l-formerly-active-pinned')).toBe(false);
    expect(state.linksByBranch.has('b-formerly-active')).toBe(false);
  });

  it('fetches and replaces a full branch link bucket through the centralized action', async () => {
    const fetchedBranchLink = link('l-fetched-branch', { branch_id: 'b1', is_pinned: true });
    const findAll = vi.fn().mockResolvedValue([fetchedBranchLink]);
    const service = vi.fn(() => ({ findAll }));
    const client = { service } as never;

    const result = await agorStore.getState().fetchAndReplaceFullBranchLinks(client, 'b1');

    expect(result).toEqual([fetchedBranchLink]);
    expect(service).toHaveBeenCalledWith('links');
    expect(findAll).toHaveBeenCalledWith({
      query: {
        owner_scope: 'branch',
        branch_id: 'b1',
        $limit: 10000,
      },
    });
    expect(agorStore.getState().linksByBranch.get('b1')).toEqual([fetchedBranchLink]);
  });

  it('applies concurrent unrelated full session and branch hydrations independently', async () => {
    const sessionGate = deferred<Link[]>();
    const branchGate = deferred<Link[]>();
    const sessionLink = link('l-session-full', { session_id: 's1' });
    const branchLink = link('l-branch-full', { branch_id: 'b1', is_pinned: true });
    const findAll = vi.fn(({ query }) => {
      if (query.session_id === 's1') return sessionGate.promise;
      if (query.branch_id === 'b1') return branchGate.promise;
      return Promise.resolve([]);
    });
    const client = { service: vi.fn(() => ({ findAll })) } as never;

    const sessionHydration = agorStore.getState().fetchAndReplaceFullSessionLinks(client, 's1');
    const branchHydration = agorStore.getState().fetchAndReplaceFullBranchLinks(client, 'b1');

    branchGate.resolve([branchLink]);
    sessionGate.resolve([sessionLink]);
    await expect(Promise.all([sessionHydration, branchHydration])).resolves.toEqual([
      [sessionLink],
      [branchLink],
    ]);

    const state = agorStore.getState();
    expect(state.linksBySession.get('s1')).toEqual([sessionLink]);
    expect(state.linksByBranch.get('b1')).toEqual([branchLink]);
  });

  it('does not let direct full owner hydration cancel global pinned hydration', async () => {
    const activeBranch = { branch_id: 'b-active' } as Branch;
    const staleActivePinned = link('l-stale-active-pinned', {
      branch_id: 'b-active',
      is_pinned: true,
    });
    const directArchivedLink = link('l-direct-archived', {
      branch_id: 'b-archived',
      is_pinned: true,
    });
    const globalGate = deferred<Link[]>();
    let globalCalls = 0;

    agorStore.getState().setMap('branchById', new Map([['b-active', activeBranch]]));
    agorStore.getState().applyMaps((prev) => mergeLinksIntoMaps(prev, [staleActivePinned]));

    const globalPinnedHydration = runHydration(
      'links',
      ['links'],
      () => {
        globalCalls += 1;
        return globalCalls === 1 ? globalGate.promise : Promise.resolve([]);
      },
      (pinnedLinks) =>
        agorStore.getState().applyMaps((prev) =>
          reconcilePinnedBranchLinksIntoMaps(prev, pinnedLinks, {
            preserveBranchIds: getPinnedBranchLinkPreserveBranchIds(agorStore.getState()),
          })
        )
    );

    const findAll = vi.fn().mockResolvedValue([directArchivedLink]);
    const client = { service: vi.fn(() => ({ findAll })) } as never;
    await expect(
      agorStore.getState().fetchAndReplaceFullBranchLinks(client, 'b-archived')
    ).resolves.toEqual([directArchivedLink]);

    globalGate.resolve([]);
    await globalPinnedHydration;

    expect(globalCalls).toBe(2);
    const state = agorStore.getState();
    expect(state.linkById.has('l-stale-active-pinned')).toBe(false);
    expect(state.linksByBranch.has('b-active')).toBe(false);
    expect(state.linkById.get('l-direct-archived')).toBe(directArchivedLink);
    expect(state.linksByBranch.get('b-archived')).toEqual([directArchivedLink]);
  });

  it('does not let global pinned hydration cancel direct full owner hydration', async () => {
    const directGate = deferred<Link[]>();
    const directArchivedLink = link('l-direct-after-global', {
      branch_id: 'b-archived',
      is_pinned: true,
    });
    const findAll = vi.fn().mockReturnValue(directGate.promise);
    const client = { service: vi.fn(() => ({ findAll })) } as never;

    const directHydration = agorStore
      .getState()
      .fetchAndReplaceFullBranchLinks(client, 'b-archived');
    await runHydration(
      'links',
      ['links'],
      () => Promise.resolve([]),
      (pinnedLinks) =>
        agorStore
          .getState()
          .applyMaps((prev) => reconcilePinnedBranchLinksIntoMaps(prev, pinnedLinks))
    );

    directGate.resolve([directArchivedLink]);
    await expect(directHydration).resolves.toEqual([directArchivedLink]);
    expect(agorStore.getState().linksByBranch.get('b-archived')).toEqual([directArchivedLink]);
  });

  it('suppresses an older same-owner result after a newer empty request applies', async () => {
    const staleSessionLink = link('l-older-empty-race', { session_id: 's1' });
    const olderGate = deferred<Link[]>();
    let calls = 0;
    const findAll = vi.fn(() => {
      calls += 1;
      return calls === 1 ? olderGate.promise : Promise.resolve([]);
    });
    const client = { service: vi.fn(() => ({ findAll })) } as never;

    const olderHydration = agorStore.getState().fetchAndReplaceFullSessionLinks(client, 's1');
    await expect(
      agorStore.getState().fetchAndReplaceFullSessionLinks(client, 's1')
    ).resolves.toEqual([]);

    olderGate.resolve([staleSessionLink]);
    await expect(olderHydration).resolves.toEqual([]);
    expect(findAll).toHaveBeenCalledTimes(2);

    const state = agorStore.getState();
    expect(state.linkById.has('l-older-empty-race')).toBe(false);
    expect(state.linksBySession.has('s1')).toBe(false);
  });

  it('retries full owner hydration when that owner changed during the fetch', async () => {
    const staleSessionLink = link('l-stale-session-result', {
      session_id: 's1',
      title: 'stale',
    });
    const newerSessionLink = link('l-newer-session-link', {
      session_id: 's1',
      is_pinned: true,
      title: 'newer',
    });
    const gate = deferred<Link[]>();
    const findAll = vi
      .fn()
      .mockReturnValueOnce(gate.promise)
      .mockResolvedValueOnce([newerSessionLink]);
    const client = { service: vi.fn(() => ({ findAll })) } as never;

    const hydration = agorStore.getState().fetchAndReplaceFullSessionLinks(client, 's1');
    agorStore.getState().replaceFullSessionLinks('s1', [newerSessionLink]);
    gate.resolve([staleSessionLink]);

    await expect(hydration).resolves.toEqual([newerSessionLink]);
    expect(findAll).toHaveBeenCalledTimes(2);
    const state = agorStore.getState();
    expect(state.linkById.has('l-stale-session-result')).toBe(false);
    expect(state.linkById.get('l-newer-session-link')).toBe(newerSessionLink);
    expect(state.linksBySession.get('s1')).toEqual([newerSessionLink]);
  });

  it('retries a gated full owner fetch after a realtime create and applies the complete snapshot', async () => {
    const createdSessionLink = link('l-created-during-fetch', { session_id: 's-realtime' });
    const gate = deferred<Link[]>();
    const findAll = vi
      .fn()
      .mockReturnValueOnce(gate.promise)
      .mockResolvedValueOnce([createdSessionLink]);
    const client = { service: vi.fn(() => ({ findAll })) } as never;

    const hydration = agorStore
      .getState()
      .fetchAndReplaceFullSessionLinks(client, createdSessionLink.session_id!);
    linkCreated(createdSessionLink);
    gate.resolve([]);

    await expect(hydration).resolves.toEqual([createdSessionLink]);
    expect(findAll).toHaveBeenCalledTimes(2);
    expect(agorStore.getState().linksBySession.get(createdSessionLink.session_id!)).toEqual([
      createdSessionLink,
    ]);
  });

  it('retries an empty-to-empty session full-owner result after realtime link churn', async () => {
    const staleSessionLink = link('l-stale-session-churn', {
      session_id: 's-empty-churn',
    });
    const gate = deferred<Link[]>();
    const findAll = vi.fn().mockReturnValueOnce(gate.promise).mockResolvedValueOnce([]);
    const client = { service: vi.fn(() => ({ findAll })) } as never;

    const hydration = agorStore
      .getState()
      .fetchAndReplaceFullSessionLinks(client, staleSessionLink.session_id!);
    linkCreated(staleSessionLink);
    linkRemoved(staleSessionLink);
    gate.resolve([staleSessionLink]);

    await expect(hydration).resolves.toEqual([]);
    expect(findAll).toHaveBeenCalledTimes(2);
    const state = agorStore.getState();
    expect(state.linkById.has(staleSessionLink.link_id)).toBe(false);
    expect(state.linksBySession.has(staleSessionLink.session_id!)).toBe(false);
  });

  it('retries an empty-to-empty branch full-owner result after realtime link churn', async () => {
    const staleBranchLink = link('l-stale-branch-churn', { branch_id: 'b-empty-churn' });
    const gate = deferred<Link[]>();
    const findAll = vi.fn().mockReturnValueOnce(gate.promise).mockResolvedValueOnce([]);
    const client = { service: vi.fn(() => ({ findAll })) } as never;

    const hydration = agorStore
      .getState()
      .fetchAndReplaceFullBranchLinks(client, staleBranchLink.branch_id!);
    linkCreated(staleBranchLink);
    linkRemoved(staleBranchLink);
    gate.resolve([staleBranchLink]);

    await expect(hydration).resolves.toEqual([]);
    expect(findAll).toHaveBeenCalledTimes(2);
    const state = agorStore.getState();
    expect(state.linkById.has(staleBranchLink.link_id)).toBe(false);
    expect(state.linksByBranch.has(staleBranchLink.branch_id!)).toBe(false);
  });

  it('suppresses a stale empty-to-empty branch full-owner result after branch archive eviction', async () => {
    const branch = { branch_id: 'b-empty-evicted', archived: false } as Branch;
    const staleBranchLink = link('l-stale-branch-after-evict', {
      branch_id: 'b-empty-evicted',
    });
    const gate = deferred<Link[]>();
    const findAll = vi.fn().mockReturnValue(gate.promise);
    const client = { service: vi.fn(() => ({ findAll })) } as never;

    agorStore.getState().setMap('branchById', new Map([[branch.branch_id, branch]]));

    const hydration = agorStore.getState().fetchAndReplaceFullBranchLinks(client, branch.branch_id);
    branchPatched({ ...branch, archived: true });
    gate.resolve([staleBranchLink]);

    await expect(hydration).resolves.toEqual([]);
    const state = agorStore.getState();
    expect(state.linkById.has('l-stale-branch-after-evict')).toBe(false);
    expect(state.linksByBranch.has(branch.branch_id)).toBe(false);
    expect(state.fullBranchLinkOwnerIds.has(branch.branch_id)).toBe(false);
    expect(state.directFullBranchLinkOwnerIds.has(branch.branch_id)).toBe(false);
  });

  it('suppresses a stale empty-to-empty session full-owner result after session removal eviction', async () => {
    const session = { session_id: 's-empty-removed', branch_id: 'b1', archived: false } as Session;
    const staleSessionLink = link('l-stale-session-after-remove', {
      session_id: 's-empty-removed',
    });
    const gate = deferred<Link[]>();
    const findAll = vi.fn().mockReturnValue(gate.promise);
    const client = { service: vi.fn(() => ({ findAll })) } as never;

    agorStore.getState().setMap('sessionById', new Map([[session.session_id, session]]));
    agorStore.getState().setMap('sessionsByBranch', new Map([['b1', [session]]]));

    const hydration = agorStore
      .getState()
      .fetchAndReplaceFullSessionLinks(client, session.session_id);
    sessionRemoved(session);
    gate.resolve([staleSessionLink]);

    await expect(hydration).resolves.toEqual([]);
    const state = agorStore.getState();
    expect(state.linkById.has('l-stale-session-after-remove')).toBe(false);
    expect(state.linksBySession.has(session.session_id)).toBe(false);
    expect(state.fullSessionLinkOwnerIds.has(session.session_id)).toBe(false);
  });

  it('branch eviction removes branch links and child session links', () => {
    const branch = { branch_id: 'b1' } as Branch;
    const session = { session_id: 's1', branch_id: 'b1' } as Session;
    const branchLink = link('l-branch', { branch_id: 'b1', is_pinned: true });
    const sessionLink = link('l-session', { session_id: 's1', is_pinned: true });

    agorStore.getState().setMap('branchById', new Map([['b1', branch]]));
    agorStore.getState().setMap('sessionById', new Map([['s1', session]]));
    agorStore.getState().setMap('sessionsByBranch', new Map([['b1', [session]]]));
    agorStore.getState().applyMaps((prev) => mergeLinksIntoMaps(prev, [branchLink, sessionLink]));

    agorStore.getState().evictBranchAndSessions('b1');

    const state = agorStore.getState();
    expect(state.branchById.has('b1')).toBe(false);
    expect(state.sessionById.has('s1')).toBe(false);
    expect(state.linkById.size).toBe(0);
    expect(state.linksByBranch.has('b1')).toBe(false);
    expect(state.linksBySession.has('s1')).toBe(false);
  });
});

describe('agorStore full-link hydration retry policy', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('converges immediately after one transient owner mutation', async () => {
    const ownerLink = link('l-transient', { session_id: 's-transient' });
    let calls = 0;
    const findAll = vi.fn(async () => {
      calls += 1;
      if (calls === 1) invalidateFullLinkRequestsForLink(ownerLink);
      return [ownerLink];
    });
    const client = { service: vi.fn(() => ({ findAll })) } as never;

    await expect(
      agorStore.getState().fetchAndReplaceFullSessionLinks(client, ownerLink.session_id!)
    ).resolves.toEqual([ownerLink]);
    expect(findAll).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('backs off under sustained owner churn and applies after a quiet fetch', async () => {
    const ownerLink = link('l-sustained', { session_id: 's-sustained' });
    let calls = 0;
    const findAll = vi.fn(async () => {
      calls += 1;
      if (calls <= 5) invalidateFullLinkRequestsForLink(ownerLink);
      return [ownerLink];
    });
    const client = { service: vi.fn(() => ({ findAll })) } as never;
    const hydration = agorStore
      .getState()
      .fetchAndReplaceFullSessionLinks(client, ownerLink.session_id!);

    await vi.advanceTimersByTimeAsync(0);
    expect(findAll).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(199);
    expect(findAll).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(findAll).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(399);
    expect(findAll).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(1);

    await expect(hydration).resolves.toEqual([ownerLink]);
    expect(findAll).toHaveBeenCalledTimes(6);
  });

  it('does not fetch again when the owner is evicted during backoff', async () => {
    const ownerLink = link('l-cancelled', { session_id: 's-cancelled' });
    const findAll = vi.fn(async () => {
      invalidateFullLinkRequestsForLink(ownerLink);
      return [ownerLink];
    });
    const client = { service: vi.fn(() => ({ findAll })) } as never;
    const hydration = agorStore
      .getState()
      .fetchAndReplaceFullSessionLinks(client, ownerLink.session_id!);

    await vi.advanceTimersByTimeAsync(0);
    expect(findAll).toHaveBeenCalledTimes(4);
    agorStore.getState().evictSessionLinks(ownerLink.session_id!);
    await vi.advanceTimersByTimeAsync(5000);

    await expect(hydration).resolves.toEqual([]);
    expect(findAll).toHaveBeenCalledTimes(4);
  });

  it('does not fetch again when the store resets during backoff', async () => {
    const ownerLink = link('l-reset', { session_id: 's-reset' });
    const findAll = vi.fn(async () => {
      invalidateFullLinkRequestsForLink(ownerLink);
      return [ownerLink];
    });
    const client = { service: vi.fn(() => ({ findAll })) } as never;
    const hydration = agorStore
      .getState()
      .fetchAndReplaceFullSessionLinks(client, ownerLink.session_id!);

    await vi.advanceTimersByTimeAsync(0);
    expect(findAll).toHaveBeenCalledTimes(4);
    agorStore.getState().reset();
    await vi.advanceTimersByTimeAsync(5000);

    await expect(hydration).resolves.toEqual([]);
    expect(findAll).toHaveBeenCalledTimes(4);
  });

  it('does not let a superseded request fetch again after its backoff', async () => {
    const ownerLink = link('l-superseded', { session_id: 's-superseded' });
    let calls = 0;
    const findAll = vi.fn(async () => {
      calls += 1;
      if (calls <= 4) invalidateFullLinkRequestsForLink(ownerLink);
      return [ownerLink];
    });
    const client = { service: vi.fn(() => ({ findAll })) } as never;
    const older = agorStore
      .getState()
      .fetchAndReplaceFullSessionLinks(client, ownerLink.session_id!);

    await vi.advanceTimersByTimeAsync(0);
    expect(findAll).toHaveBeenCalledTimes(4);
    await expect(
      agorStore.getState().fetchAndReplaceFullSessionLinks(client, ownerLink.session_id!)
    ).resolves.toEqual([ownerLink]);
    expect(findAll).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(5000);

    await expect(older).resolves.toEqual([]);
    expect(findAll).toHaveBeenCalledTimes(5);
  });
});
