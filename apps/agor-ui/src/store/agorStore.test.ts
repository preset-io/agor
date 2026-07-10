import type { Branch, Link, Session } from '@agor-live/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { EMPTY_MAPS, mergeLinksIntoMaps, reconcilePinnedBranchLinksIntoMaps } from './agorMaps';
import { agorStore } from './agorStore';

// Reset the singleton before each test so cases don't bleed into each other.
beforeEach(() => {
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
