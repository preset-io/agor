import type { Session, TenantAgenticToolSettings } from '@agor-live/client';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  bumpRevision,
  cancelAndFailAllHydrations,
  resetHydrationRevisions,
  runHydration,
} from './agorHydration';
import { EMPTY_MAPS } from './agorMaps';
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

describe('agorStore agentic tool-settings hydration gate', () => {
  const setting = (tool: string, enabled: boolean) =>
    ({ tool, enabled }) as unknown as TenantAgenticToolSettings;

  it('does not mark hydrated when a single-row upsert lands before the full fetch', () => {
    // A realtime patch/created event arrives first: the row is merged, but the
    // collection is NOT yet authoritative, so the gate must stay closed.
    agorStore.getState().upsertAgenticToolSetting(setting('codex', false));

    expect(agorStore.getState().agenticToolSettingsHydrated).toBe(false);
    expect(agorStore.getState().agenticToolSettingsByName.get('codex')).toEqual(
      setting('codex', false)
    );

    // The complete snapshot lands: now the collection is authoritative.
    agorStore.getState().setAgenticToolSettings([setting('codex', false), setting('gemini', true)]);

    expect(agorStore.getState().agenticToolSettingsHydrated).toBe(true);
    expect(agorStore.getState().agenticToolSettingsByName.size).toBe(2);
  });

  it('upsert merges one row without disturbing the hydrated flag', () => {
    agorStore.getState().setAgenticToolSettings([setting('codex', true)]);
    expect(agorStore.getState().agenticToolSettingsHydrated).toBe(true);

    agorStore.getState().upsertAgenticToolSetting(setting('gemini', false));

    expect(agorStore.getState().agenticToolSettingsHydrated).toBe(true);
    expect(agorStore.getState().agenticToolSettingsByName.get('codex')).toEqual(
      setting('codex', true)
    );
    expect(agorStore.getState().agenticToolSettingsByName.get('gemini')).toEqual(
      setting('gemini', false)
    );
  });

  it('resetMaps clears the tool-settings map AND the hydration flag (tenant switch)', () => {
    agorStore.getState().setAgenticToolSettings([setting('codex', false)]);
    expect(agorStore.getState().agenticToolSettingsHydrated).toBe(true);
    expect(agorStore.getState().agenticToolSettingsByName.size).toBe(1);

    agorStore.getState().resetMaps();

    // The next tenant must start un-hydrated with an empty map — no cross-tenant
    // fail-open or stale rows.
    expect(agorStore.getState().agenticToolSettingsHydrated).toBe(false);
    expect(agorStore.getState().agenticToolSettingsByName.size).toBe(0);
  });
});

// The full agentic-tool-settings fetch rides the shared skip-apply-on-race /
// generation lifecycle (runHydration + liveRevisions/hydrationGeneration), so
// these mirror the exact wiring: apply = setAgenticToolSettings (full snapshot),
// realtime = bumpRevision + upsertAgenticToolSetting, logout = cancelAndFail +
// resetMaps.
describe('agorStore agentic tool-settings fetch lifecycle races', () => {
  const setting = (tool: string, enabled: boolean) =>
    ({ tool, enabled }) as unknown as TenantAgenticToolSettings;
  const apply = (settings: TenantAgenticToolSettings[]) =>
    agorStore.getState().setAgenticToolSettings(settings);

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  beforeEach(() => {
    resetHydrationRevisions();
  });

  it('drops a stale full snapshot that resolves after a realtime upsert raced it', async () => {
    const first = deferred<TenantAgenticToolSettings[]>();
    let call = 0;
    const fetchFn = () => {
      call += 1;
      // The first (stale) response is controlled; any retry re-fetches the fresh
      // server state that already reflects the upsert.
      return call === 1 ? first.promise : Promise.resolve([setting('codex', false)]);
    };

    const done = runHydration('agentic-tool-settings', ['agenticToolSettings'], fetchFn, apply);
    await Promise.resolve(); // let runHydration reach its first await

    // A realtime upsert lands mid-fetch (Codex disabled), bumping the revision.
    bumpRevision('agenticToolSettings');
    agorStore.getState().upsertAgenticToolSetting(setting('codex', false));

    // The older snapshot (Codex ENABLED) now resolves — it must be discarded.
    first.resolve([setting('codex', true)]);
    await done;

    // The stale enabled snapshot never won; the disabled value survives.
    expect(agorStore.getState().agenticToolSettingsByName.get('codex')).toEqual(
      setting('codex', false)
    );
  });

  it('ignores a full snapshot that resolves after logout (no repopulation)', async () => {
    const first = deferred<TenantAgenticToolSettings[]>();
    const done = runHydration(
      'agentic-tool-settings',
      ['agenticToolSettings'],
      () => first.promise,
      apply
    );
    await Promise.resolve(); // in-flight

    // Logout teardown: cancel in-flight hydrations, then clear the maps.
    cancelAndFailAllHydrations();
    agorStore.getState().resetMaps();

    // The request from the previous tenant resolves AFTER logout.
    first.resolve([setting('codex', true)]);
    await done;

    // It must not repopulate; the next tenant starts un-hydrated.
    expect(agorStore.getState().agenticToolSettingsByName.size).toBe(0);
    expect(agorStore.getState().agenticToolSettingsHydrated).toBe(false);
  });
});
