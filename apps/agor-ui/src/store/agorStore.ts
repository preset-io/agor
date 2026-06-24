/**
 * Zustand store scaffold for the Agor frontend state layer (Phase 4, PR1).
 *
 * This file is intentionally INERT: it creates and types the store, but nothing
 * consumes it yet. `useAgorData` remains the single source of truth for the
 * running app. PR2 moves ownership into this store while keeping the
 * `useAgorData` return signature identical; later PRs peel consumers onto
 * narrow selector subscriptions. See `~/.claude/plans/zustand-migration.md`.
 *
 * Design notes:
 * - State shape reuses the canonical `DataMaps` type (17 maps + 1 set) imported
 *   from `useAgorData` — never redefined here — plus load/meta fields.
 * - A VANILLA `createStore` (not React `create`) so the hook keeps owning
 *   lifecycle; React binds via `useStore`.
 * - The `immer` middleware is installed (and `enableMapSet()` called) so PR2's
 *   cascade/multi-map actions can mutate `draft` imperatively. The foundational
 *   actions below deliberately use object-form `set` / early-return, mirroring
 *   today's `setMapSlice` `Object.is` short-circuit so idempotent writes don't
 *   allocate a fresh state object (and don't notify subscribers).
 */
import { enableMapSet } from 'immer';
import { useStore } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createStore } from 'zustand/vanilla';
import {
  type DataMaps,
  EMPTY_MAPS,
  type InitialLoadItemKey,
  type InitialLoadingStage,
} from '../hooks/useAgorData';

// Immer needs this to draft Map/Set state. Called once at module load; the
// store's state is entirely Maps and one Set.
enableMapSet();

/** Per-item counts captured at fetch-resolution time. Mirrors `useAgorData`. */
export type ItemCounts = Partial<Record<InitialLoadItemKey, number>>;

/** Load/meta fields that ride alongside the data maps. */
interface AgorMeta {
  loading: boolean;
  loadingStage: InitialLoadingStage;
  error: string | null;
  itemCounts: ItemCounts;
}

/** Foundational actions. PR2 adds entity/realtime/hydration actions. */
interface AgorActions {
  /** Reset every data map to empty and meta to its initial (loading) values. */
  reset: () => void;
  setLoading: (loading: boolean) => void;
  setLoadingStage: (loadingStage: InitialLoadingStage) => void;
  setError: (error: string | null) => void;
  setItemCounts: (itemCounts: ItemCounts) => void;
  /**
   * Replace a single data map. Mirrors `useAgorData`'s `setMapSlice`: accepts a
   * value or a functional updater, and short-circuits on `Object.is` equality so
   * a no-op write preserves the outer state reference (no subscriber notify).
   */
  setMap: <K extends keyof DataMaps>(
    key: K,
    value: DataMaps[K] | ((prev: DataMaps[K]) => DataMaps[K])
  ) => void;
  /** Replace several data maps at once; each key honours the `Object.is` guard. */
  replaceMaps: (partial: Partial<DataMaps>) => void;
}

export type AgorState = DataMaps & AgorMeta & AgorActions;

/** Initial meta values — identical to `useAgorData`'s `useState` defaults. */
const INITIAL_META: AgorMeta = {
  loading: true,
  loadingStage: 'idle',
  error: null,
  itemCounts: {},
};

export const agorStore = createStore<AgorState>()(
  immer((set, get) => ({
    ...EMPTY_MAPS,
    ...INITIAL_META,

    reset: () => set({ ...EMPTY_MAPS, ...INITIAL_META }),

    setLoading: (loading) => set({ loading }),
    setLoadingStage: (loadingStage) => set({ loadingStage }),
    setError: (error) => set({ error }),
    setItemCounts: (itemCounts) => set({ itemCounts }),

    setMap: (key, value) => {
      const prev = get()[key];
      const next =
        typeof value === 'function'
          ? (value as (p: DataMaps[typeof key]) => DataMaps[typeof key])(prev)
          : value;
      // No-op short-circuit: skip the set entirely so the outer state object
      // (and every other slice's reference) is preserved.
      if (Object.is(next, prev)) return;
      set({ [key]: next } as Partial<AgorState>);
    },

    replaceMaps: (partial) => {
      const state = get();
      const changed: Partial<DataMaps> = {};
      for (const k of Object.keys(partial) as (keyof DataMaps)[]) {
        const next = partial[k];
        if (next !== undefined && !Object.is(next, state[k])) {
          // biome-ignore lint/suspicious/noExplicitAny: heterogeneous map union; per-key types are sound at the call site.
          changed[k] = next as any;
        }
      }
      if (Object.keys(changed).length === 0) return;
      set(changed as Partial<AgorState>);
    },
  }))
);

/**
 * React binding for the vanilla store. The store's lifecycle stays owned by the
 * hook layer (PR2); this just subscribes a component to a selected slice.
 */
export function useAgorStore<T>(selector: (state: AgorState) => T): T {
  return useStore(agorStore, selector);
}

// Re-exported for future multi-field selectors (BY-ID / derived reads) that
// need a custom equality function — see plan §4 "Selectors/equality".
export { shallow } from 'zustand/shallow';
export { useStoreWithEqualityFn } from 'zustand/traditional';
