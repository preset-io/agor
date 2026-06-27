import type { Session } from '@agor-live/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { EMPTY_MAPS } from '../hooks/useAgorData';
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
});
