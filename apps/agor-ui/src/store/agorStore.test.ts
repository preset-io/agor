import type { Link, Session } from '@agor-live/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { cancelAllHydrations, resetHydrationRevisions } from './agorHydration';
import { EMPTY_MAPS, mergeLinksIntoMaps, reconcilePinnedBranchLinksIntoMaps } from './agorMaps';
import { linkRemoved } from './agorRealtimeActions';
import { agorStore } from './agorStore';

// Reset the singleton before each test so cases don't bleed into each other.

beforeEach(() => {
  cancelAllHydrations();
  resetHydrationRevisions();
  agorStore.getState().reset();
});

describe('agorStore state and link maps', () => {
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

  it('orders link mutation results by revision even when timestamps are equal', () => {
    const newerLink = {
      link_id: 'l-branch',
      branch_id: 'b1',
      session_id: null,
      is_pinned: true,
      updated_at: '2026-07-01T12:00:00.000Z',
      revision: 2,
    } as Link;
    const stalePatchResponse = {
      ...newerLink,
      is_pinned: false,
      updated_at: '2026-07-01T12:00:00.000Z',
      revision: 1,
    } as Link;
    const freshPatchResponse = {
      ...newerLink,
      is_pinned: false,
      updated_at: '2026-07-01T12:00:00.000Z',
      revision: 3,
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
      revision: 2,
    } as Link;

    agorStore.getState().applyMaps((prev) => mergeLinksIntoMaps(prev, [removedLink]));
    linkRemoved(removedLink);

    agorStore.getState().applyLinkMutationResult(delayedPatchResponse);
    expect(agorStore.getState().linkById.has('l-removed')).toBe(false);
    expect(agorStore.getState().linksByBranch.has('b1')).toBe(false);
  });

  it('applies known create/remove results without overwriting newer realtime state', () => {
    const existing = {
      link_id: 'l-known',
      branch_id: 'b1',
      session_id: null,
      is_pinned: false,
      updated_at: '2026-07-01T12:01:00.000Z',
    } as Link;
    const olderKnownCreate = {
      ...existing,
      is_pinned: true,
      updated_at: '2026-07-01T12:00:00.000Z',
      revision: 1,
    } as Link;

    agorStore.getState().applyMaps((prev) => mergeLinksIntoMaps(prev, [existing]));
    agorStore.getState().applyKnownLinkCreatedResult(olderKnownCreate);
    expect(agorStore.getState().linkById.get('l-known')).toEqual(existing);
    expect(agorStore.getState().linksByBranch.get('b1')).toEqual([existing]);

    agorStore.getState().applyKnownLinkRemovedResult(olderKnownCreate);
    expect(agorStore.getState().linkById.has('l-known')).toBe(false);
    expect(agorStore.getState().linksByBranch.has('b1')).toBe(false);

    agorStore.getState().applyKnownLinkCreatedResult(olderKnownCreate);
    expect(agorStore.getState().linkById.get('l-known')).toEqual(olderKnownCreate);
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
});
