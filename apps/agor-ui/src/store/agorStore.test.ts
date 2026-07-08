import type { Branch, Link, Session } from '@agor-live/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_MAPS } from '../hooks/useAgorData';
import { cancelAllHydrations, resetHydrationRevisions, runHydration } from './agorHydration';
import { mergeLinksIntoMaps, reconcilePinnedBranchLinksIntoMaps } from './agorMaps';
import { branchPatched, linkCreated, linkRemoved, sessionRemoved } from './agorRealtimeActions';
import { agorStore, getPinnedBranchLinkPreserveBranchIds } from './agorStore';

// Reset the singleton before each test so cases don't bleed into each other.

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  cancelAllHydrations();
  resetHydrationRevisions();
  agorStore.getState().reset();
});

describe('agorStore scaffold', () => {
  it('initializes with empty maps and the loading defaults', () => {
    const state = agorStore.getState();

    // Every data map starts empty (matching EMPTY_MAPS), and the meta fields
    // match useAgorData's useState defaults.
    for (const key of Object.keys(EMPTY_MAPS) as (keyof typeof EMPTY_MAPS)[]) {
      expect(state[key]).toEqual(EMPTY_MAPS[key]);
    }
    expect(state.loading).toBe(true);
    expect(state.loadingStage).toBe('idle');
    expect(state.error).toBeNull();
    expect(state.itemCounts).toEqual({});
  });

  it('reset() restores empty maps and initial meta after mutation', () => {
    const populated = new Map<string, Session>([['s1', { session_id: 's1' } as Session]]);
    agorStore.getState().setMap('sessionById', populated);
    agorStore.getState().setLoading(false);
    agorStore.getState().setError('boom');

    agorStore.getState().reset();

    const state = agorStore.getState();
    expect(state.sessionById.size).toBe(0);
    expect(state.loading).toBe(true);
    expect(state.loadingStage).toBe('idle');
    expect(state.error).toBeNull();
    expect(state.itemCounts).toEqual({});
  });

  it('setLoading / setMap update their fields', () => {
    agorStore.getState().setLoading(false);
    expect(agorStore.getState().loading).toBe(false);

    const next = new Map<string, Session>([['s1', { session_id: 's1' } as Session]]);
    agorStore.getState().setMap('sessionById', next);
    expect(agorStore.getState().sessionById).toBe(next);

    // Functional-updater form mirrors setMapSlice's signature.
    agorStore.getState().setMap('sessionById', (prev) => {
      const copy = new Map(prev);
      copy.set('s2', { session_id: 's2' } as Session);
      return copy;
    });
    expect(agorStore.getState().sessionById.size).toBe(2);
  });

  it('no-op setMap (same reference) preserves the outer state reference', () => {
    const before = agorStore.getState();
    // Writing back the identical map reference must short-circuit (Object.is),
    // leaving the whole state object untouched so no subscriber is notified.
    agorStore.getState().setMap('sessionById', before.sessionById);
    expect(agorStore.getState()).toBe(before);

    // A genuine change DOES allocate a new state object.
    agorStore.getState().setMap('sessionById', new Map());
    expect(agorStore.getState()).not.toBe(before);
  });

  it('replaceMaps writes changed slices and skips unchanged ones', () => {
    const sessions = new Map<string, Session>([['s1', { session_id: 's1' } as Session]]);
    const before = agorStore.getState();

    // boardById is written back as its current (unchanged) reference, so only
    // sessionById should actually change.
    agorStore.getState().replaceMaps({
      sessionById: sessions,
      boardById: before.boardById,
    });

    expect(agorStore.getState().sessionById).toBe(sessions);
    expect(agorStore.getState().boardById).toBe(before.boardById);

    // An all-no-op replaceMaps preserves the outer state reference.
    const stable = agorStore.getState();
    agorStore.getState().replaceMaps({ sessionById: sessions });
    expect(agorStore.getState()).toBe(stable);
  });

  it('indexes links by id and owner bucket without wiping existing scopes', () => {
    const branchLink = {
      link_id: 'l-branch',
      branch_id: 'b1',
      session_id: null,
      is_pinned: true,
    } as Link;
    const sessionLink = {
      link_id: 'l-session',
      branch_id: null,
      session_id: 's1',
      is_pinned: false,
    } as Link;

    agorStore.getState().applyMaps((prev) => mergeLinksIntoMaps(prev, [branchLink]));
    agorStore.getState().applyMaps((prev) => mergeLinksIntoMaps(prev, [sessionLink]));

    const state = agorStore.getState();
    expect(state.linkById.get('l-branch')).toBe(branchLink);
    expect(state.linkById.get('l-session')).toBe(sessionLink);
    expect(state.linksByBranch.get('b1')).toEqual([branchLink]);
    expect(state.linksBySession.get('s1')).toEqual([sessionLink]);
  });

  it('applies link mutation results only when they still match current store state', () => {
    const newerLink = {
      link_id: 'l-branch',
      branch_id: 'b1',
      session_id: null,
      is_pinned: true,
      updated_at: '2026-07-01T12:00:00.000Z',
    } as Link;
    const stalePatchResponse = {
      ...newerLink,
      is_pinned: false,
      updated_at: '2026-07-01T11:59:00.000Z',
    } as Link;
    const freshPatchResponse = {
      ...newerLink,
      is_pinned: false,
      updated_at: '2026-07-01T12:01:00.000Z',
    } as Link;

    agorStore.getState().applyMaps((prev) => mergeLinksIntoMaps(prev, [newerLink]));

    agorStore.getState().applyLinkMutationResult(stalePatchResponse);
    expect(agorStore.getState().linkById.get('l-branch')).toBe(newerLink);
    expect(agorStore.getState().linksByBranch.get('b1')).toEqual([newerLink]);

    agorStore.getState().applyLinkMutationResult(freshPatchResponse);
    expect(agorStore.getState().linkById.get('l-branch')).toEqual(freshPatchResponse);
    expect(agorStore.getState().linksByBranch.get('b1')).toEqual([freshPatchResponse]);
  });

  it('does not resurrect a removed link from a delayed mutation result', () => {
    const removedLink = {
      link_id: 'l-removed',
      branch_id: 'b1',
      session_id: null,
      is_pinned: true,
      updated_at: '2026-07-01T12:00:00.000Z',
    } as Link;
    const delayedPatchResponse = {
      ...removedLink,
      is_pinned: false,
      updated_at: '2026-07-01T12:01:00.000Z',
    } as Link;

    agorStore.getState().applyMaps((prev) => mergeLinksIntoMaps(prev, [removedLink]));
    linkRemoved(removedLink);

    agorStore.getState().applyLinkMutationResult(delayedPatchResponse);
    expect(agorStore.getState().linkById.has('l-removed')).toBe(false);
    expect(agorStore.getState().linksByBranch.has('b1')).toBe(false);
  });

  it('reconciles only the fetched pinned branch link domain', () => {
    const stalePinnedInDomain = {
      link_id: 'l-stale-pinned-in-domain',
      branch_id: 'b1',
      session_id: null,
      is_pinned: true,
    } as Link;
    const currentPinnedInDomain = {
      link_id: 'l-current-pinned-in-domain',
      branch_id: 'b1',
      session_id: null,
      is_pinned: true,
    } as Link;
    const pinnedOutOfDomain = {
      link_id: 'l-pinned-out-of-domain',
      branch_id: 'b2',
      session_id: null,
      is_pinned: true,
    } as Link;
    const unpinnedInDomain = {
      link_id: 'l-unpinned-in-domain',
      branch_id: 'b1',
      session_id: null,
      is_pinned: false,
    } as Link;
    const sessionLink = {
      link_id: 'l-session',
      branch_id: null,
      session_id: 's1',
      is_pinned: true,
    } as Link;

    agorStore
      .getState()
      .applyMaps((prev) =>
        mergeLinksIntoMaps(prev, [
          stalePinnedInDomain,
          pinnedOutOfDomain,
          unpinnedInDomain,
          sessionLink,
        ])
      );

    agorStore.getState().applyMaps((prev) =>
      reconcilePinnedBranchLinksIntoMaps(prev, [currentPinnedInDomain], {
        branchIds: new Set(['b1']),
      })
    );

    const state = agorStore.getState();
    expect(state.linkById.has('l-stale-pinned-in-domain')).toBe(false);
    expect(state.linkById.get('l-current-pinned-in-domain')).toBe(currentPinnedInDomain);
    expect(state.linkById.get('l-pinned-out-of-domain')).toBe(pinnedOutOfDomain);
    expect(state.linkById.get('l-unpinned-in-domain')).toBe(unpinnedInDomain);
    expect(state.linkById.get('l-session')).toBe(sessionLink);
    expect(state.linksByBranch.get('b1')).toEqual([unpinnedInDomain, currentPinnedInDomain]);
    expect(state.linksByBranch.get('b2')).toEqual([pinnedOutOfDomain]);
    expect(state.linksBySession.get('s1')).toEqual([sessionLink]);
  });

  it('replaces a full session link bucket without touching other owners', () => {
    const staleSessionLink = {
      link_id: 'l-stale-session',
      branch_id: null,
      session_id: 's1',
      is_pinned: false,
    } as Link;
    const currentSessionLink = {
      link_id: 'l-current-session',
      branch_id: null,
      session_id: 's1',
      is_pinned: true,
    } as Link;
    const otherSessionLink = {
      link_id: 'l-other-session',
      branch_id: null,
      session_id: 's2',
      is_pinned: false,
    } as Link;
    const branchLink = {
      link_id: 'l-branch',
      branch_id: 'b1',
      session_id: null,
      is_pinned: true,
    } as Link;

    agorStore
      .getState()
      .applyMaps((prev) =>
        mergeLinksIntoMaps(prev, [staleSessionLink, otherSessionLink, branchLink])
      );

    agorStore.getState().replaceFullSessionLinks('s1', [currentSessionLink, branchLink]);

    const state = agorStore.getState();
    expect(state.linkById.has('l-stale-session')).toBe(false);
    expect(state.linkById.get('l-current-session')).toBe(currentSessionLink);
    expect(state.linkById.get('l-other-session')).toBe(otherSessionLink);
    expect(state.linkById.get('l-branch')).toBe(branchLink);
    expect(state.linksBySession.get('s1')).toEqual([currentSessionLink]);
    expect(state.linksBySession.get('s2')).toEqual([otherSessionLink]);
    expect(state.linksByBranch.get('b1')).toEqual([branchLink]);
    expect(state.fullSessionLinkOwnerIds.has('s1')).toBe(true);
  });

  it('replaces a full branch link bucket without touching session or other branch owners', () => {
    const staleBranchLink = {
      link_id: 'l-stale-branch',
      branch_id: 'b1',
      session_id: null,
      is_pinned: true,
    } as Link;
    const currentBranchLink = {
      link_id: 'l-current-branch',
      branch_id: 'b1',
      session_id: null,
      is_pinned: false,
    } as Link;
    const otherBranchLink = {
      link_id: 'l-other-branch',
      branch_id: 'b2',
      session_id: null,
      is_pinned: true,
    } as Link;
    const sessionLink = {
      link_id: 'l-session',
      branch_id: null,
      session_id: 's1',
      is_pinned: true,
    } as Link;

    agorStore
      .getState()
      .applyMaps((prev) =>
        mergeLinksIntoMaps(prev, [staleBranchLink, otherBranchLink, sessionLink])
      );

    agorStore.getState().replaceFullBranchLinks('b1', [currentBranchLink, sessionLink]);

    const state = agorStore.getState();
    expect(state.linkById.has('l-stale-branch')).toBe(false);
    expect(state.linkById.get('l-current-branch')).toBe(currentBranchLink);
    expect(state.linkById.get('l-other-branch')).toBe(otherBranchLink);
    expect(state.linkById.get('l-session')).toBe(sessionLink);
    expect(state.linksByBranch.get('b1')).toEqual([currentBranchLink]);
    expect(state.linksByBranch.get('b2')).toEqual([otherBranchLink]);
    expect(state.linksBySession.get('s1')).toEqual([sessionLink]);
    expect(state.fullBranchLinkOwnerIds.has('b1')).toBe(true);
  });

  it('lets pinned-only hydration prune active full buckets but preserves direct archived full buckets', () => {
    const activeBranch = { branch_id: 'b-active' } as Branch;
    const activePinned = {
      link_id: 'l-active-pinned',
      branch_id: 'b-active',
      session_id: null,
      is_pinned: true,
    } as Link;
    const archivedPinned = {
      link_id: 'l-archived-pinned',
      branch_id: 'b-archived',
      session_id: null,
      is_pinned: true,
    } as Link;

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
    const stalePinned = {
      link_id: 'l-formerly-active-pinned',
      branch_id: 'b-formerly-active',
      session_id: null,
      is_pinned: true,
    } as Link;

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
    const fetchedBranchLink = {
      link_id: 'l-fetched-branch',
      branch_id: 'b1',
      session_id: null,
      is_pinned: true,
    } as Link;
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
    const sessionLink = {
      link_id: 'l-session-full',
      branch_id: null,
      session_id: 's1',
      is_pinned: false,
    } as Link;
    const branchLink = {
      link_id: 'l-branch-full',
      branch_id: 'b1',
      session_id: null,
      is_pinned: true,
    } as Link;
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
    const staleActivePinned = {
      link_id: 'l-stale-active-pinned',
      branch_id: 'b-active',
      session_id: null,
      is_pinned: true,
    } as Link;
    const directArchivedLink = {
      link_id: 'l-direct-archived',
      branch_id: 'b-archived',
      session_id: null,
      is_pinned: true,
    } as Link;
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
    const directArchivedLink = {
      link_id: 'l-direct-after-global',
      branch_id: 'b-archived',
      session_id: null,
      is_pinned: true,
    } as Link;
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
    const staleSessionLink = {
      link_id: 'l-older-empty-race',
      branch_id: null,
      session_id: 's1',
      is_pinned: false,
    } as Link;
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

    const state = agorStore.getState();
    expect(state.linkById.has('l-older-empty-race')).toBe(false);
    expect(state.linksBySession.has('s1')).toBe(false);
  });

  it('suppresses stale full owner results when that owner changed during the fetch', async () => {
    const staleSessionLink = {
      link_id: 'l-stale-session-result',
      branch_id: null,
      session_id: 's1',
      is_pinned: false,
      title: 'stale',
    } as Link;
    const newerSessionLink = {
      link_id: 'l-newer-session-link',
      branch_id: null,
      session_id: 's1',
      is_pinned: true,
      title: 'newer',
    } as Link;
    const gate = deferred<Link[]>();
    const findAll = vi.fn().mockReturnValue(gate.promise);
    const client = { service: vi.fn(() => ({ findAll })) } as never;

    const hydration = agorStore.getState().fetchAndReplaceFullSessionLinks(client, 's1');
    agorStore.getState().replaceFullSessionLinks('s1', [newerSessionLink]);
    gate.resolve([staleSessionLink]);

    await expect(hydration).resolves.toEqual([]);
    const state = agorStore.getState();
    expect(state.linkById.has('l-stale-session-result')).toBe(false);
    expect(state.linkById.get('l-newer-session-link')).toBe(newerSessionLink);
    expect(state.linksBySession.get('s1')).toEqual([newerSessionLink]);
  });

  it('suppresses a stale empty-to-empty session full-owner result after realtime link churn', async () => {
    const staleSessionLink = {
      link_id: 'l-stale-session-churn',
      branch_id: null,
      session_id: 's-empty-churn',
      is_pinned: false,
    } as Link;
    const gate = deferred<Link[]>();
    const findAll = vi.fn().mockReturnValue(gate.promise);
    const client = { service: vi.fn(() => ({ findAll })) } as never;

    const hydration = agorStore
      .getState()
      .fetchAndReplaceFullSessionLinks(client, staleSessionLink.session_id!);
    linkCreated(staleSessionLink);
    linkRemoved(staleSessionLink);
    gate.resolve([staleSessionLink]);

    await expect(hydration).resolves.toEqual([]);
    const state = agorStore.getState();
    expect(state.linkById.has(staleSessionLink.link_id)).toBe(false);
    expect(state.linksBySession.has(staleSessionLink.session_id!)).toBe(false);
  });

  it('suppresses a stale empty-to-empty branch full-owner result after realtime link churn', async () => {
    const staleBranchLink = {
      link_id: 'l-stale-branch-churn',
      branch_id: 'b-empty-churn',
      session_id: null,
      is_pinned: false,
    } as Link;
    const gate = deferred<Link[]>();
    const findAll = vi.fn().mockReturnValue(gate.promise);
    const client = { service: vi.fn(() => ({ findAll })) } as never;

    const hydration = agorStore
      .getState()
      .fetchAndReplaceFullBranchLinks(client, staleBranchLink.branch_id!);
    linkCreated(staleBranchLink);
    linkRemoved(staleBranchLink);
    gate.resolve([staleBranchLink]);

    await expect(hydration).resolves.toEqual([]);
    const state = agorStore.getState();
    expect(state.linkById.has(staleBranchLink.link_id)).toBe(false);
    expect(state.linksByBranch.has(staleBranchLink.branch_id!)).toBe(false);
  });

  it('suppresses a stale empty-to-empty branch full-owner result after branch archive eviction', async () => {
    const branch = { branch_id: 'b-empty-evicted', archived: false } as Branch;
    const staleBranchLink = {
      link_id: 'l-stale-branch-after-evict',
      branch_id: 'b-empty-evicted',
      session_id: null,
      is_pinned: false,
    } as Link;
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
    const staleSessionLink = {
      link_id: 'l-stale-session-after-remove',
      branch_id: null,
      session_id: 's-empty-removed',
      is_pinned: false,
    } as Link;
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
    const branchLink = {
      link_id: 'l-branch',
      branch_id: 'b1',
      session_id: null,
      is_pinned: true,
    } as Link;
    const sessionLink = {
      link_id: 'l-session',
      branch_id: null,
      session_id: 's1',
      is_pinned: true,
    } as Link;

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
