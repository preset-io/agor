/**
 * Vanilla zustand store that is the single source of truth for Agor's
 * normalized entity state. `useAgorData` drives it (its fetch effect + socket
 * subscriptions dispatch the actions here) and reads full state back via
 * `useStore`; React consumers can also bind to narrow selector subscriptions.
 *
 * Design notes:
 * - State shape reuses the canonical `DataMaps` type (17 maps + 1 set) from
 *   `agorMaps` — held as top-level fields alongside load/meta fields.
 * - A VANILLA `createStore` (not React `create`) so the hook keeps owning
 *   lifecycle; React binds via `useStore`.
 * - IMMER breadth/depth rule: `immer` is installed (and `enableMapSet()`
 *   called) so genuine CASCADE / multi-map mutations can be expressed as
 *   imperative draft edits (see the named branch lifecycle cascades). The HOT single-entity
 *   `*:patched` writes go through the object-form `setMap` / `applyMaps` (the
 *   immer middleware passes object-form `set` straight through — no draft proxy
 *   on the hot path). Object-form `set` + early-return mirror today's
 *   `setMapSlice` `Object.is` short-circuit so idempotent writes don't allocate
 *   a fresh state object (and don't notify subscribers).
 * - Per-collection realtime entity mutations live in `agorRealtimeActions.ts`;
 *   they write through the primitives here. The background-hydration bookkeeping
 *   (per-collection revision counters, generation tokens, `runHydration`) lives
 *   in `agorHydration.ts`.
 */

import type { Session, TenantAgenticToolName, TenantAgenticToolSettings } from '@agor-live/client';
import { type Draft, enableMapSet } from 'immer';
import { useStore } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createStore } from 'zustand/vanilla';
import type { InitialLoadItemKey, InitialLoadingStage } from '../hooks/useAgorData';
import { type DataMaps, EMPTY_MAPS, MAP_KEYS, pickMaps } from './agorMaps';

// Immer needs this to draft Map/Set state. Called once at module load; the
// store's state is entirely Maps and one Set.
enableMapSet();

/** Per-item counts captured at fetch-resolution time. Mirrors `useAgorData`. */
export type ItemCounts = Partial<Record<InitialLoadItemKey, number>>;

/** Background-hydrated collections that gate UI reads on their first apply. */
export type GatedHydrationFlag = 'mcpServersHydrated' | 'gatewayChannelsHydrated';

/** Load/meta fields that ride alongside the data maps. */
interface AgorMeta {
  loading: boolean;
  loadingStage: InitialLoadingStage;
  error: string | null;
  itemCounts: ItemCounts;
  /** Set once the background mcp-servers hydration first applies (empty result included). */
  mcpServersHydrated: boolean;
  /** Set once the background gateway-channels hydration first applies (empty result included). */
  gatewayChannelsHydrated: boolean;
  agenticToolSettingsByName: Map<TenantAgenticToolName, TenantAgenticToolSettings>;
  /** Set once the background agentic-tool-settings hydration first applies (empty result included). */
  agenticToolSettingsHydrated: boolean;
}

/** Store actions: foundational primitives + named branch lifecycle cascades. */
interface AgorActions {
  /** Reset every data map to empty and meta to its initial (loading) values. */
  reset: () => void;
  /**
   * Reset ONLY the data maps to empty, leaving meta untouched. Mirrors the
   * hook's logout effect (`setMaps(EMPTY_MAPS)`), which clears board state
   * without flipping `loading` / `error` / `itemCounts`.
   */
  resetMaps: () => void;
  setLoading: (loading: boolean) => void;
  setLoadingStage: (loadingStage: InitialLoadingStage) => void;
  setError: (error: string | null) => void;
  /** Accepts a value or a functional updater (mirrors `useState`). */
  setItemCounts: (value: ItemCounts | ((prev: ItemCounts) => ItemCounts)) => void;
  /** Mark a gated background collection as first-hydrated (idempotent). */
  markHydrated: (flag: GatedHydrationFlag) => void;
  /**
   * Replace the WHOLE tenant tool-settings map from a complete snapshot (the
   * background full fetch) and mark the collection hydrated. Only a full
   * snapshot may flip `agenticToolSettingsHydrated` — a partial map must never
   * be treated as authoritative (that would let disabled providers fail open).
   */
  setAgenticToolSettings: (settings: TenantAgenticToolSettings[]) => void;
  /**
   * Merge ONE row into the tenant tool-settings map (realtime `patched` /
   * `created`, or an admin edit). Does NOT touch `agenticToolSettingsHydrated`:
   * a single incremental row is not a complete snapshot, so it can't establish
   * "we now know the full set".
   */
  upsertAgenticToolSetting: (setting: TenantAgenticToolSettings) => void;
  /**
   * Replace a single data map: accepts a value or a functional updater, and
   * short-circuits on `Object.is` equality so
   * a no-op write preserves the outer state reference (no subscriber notify).
   */
  setMap: <K extends keyof DataMaps>(
    key: K,
    value: DataMaps[K] | ((prev: DataMaps[K]) => DataMaps[K])
  ) => void;
  /** Replace several data maps at once; each key honours the `Object.is` guard. */
  replaceMaps: (partial: Partial<DataMaps>) => void;
  /**
   * Apply a whole-`DataMaps` reducer (mirrors the hook's `setMaps((prev) =>
   * …)`). Runs the reducer against a fresh projection of the current slices,
   * then commits ONLY the slices whose reference actually changed — so the
   * reducer's existing per-slice reference preservation carries through, and an
   * all-no-op reducer leaves the outer state object untouched.
   */
  applyMaps: (updater: (prev: DataMaps) => DataMaps) => void;
  /** Mirror archive visibility while retaining the persisted board placement. */
  evictArchivedBranch: (branchId: string) => void;
  /** Atomically mirror every normalized FK cascade/SET NULL from a hard delete. */
  applyBranchHardDeleteCascade: (branchId: string) => void;
}

export type AgorState = DataMaps & AgorMeta & AgorActions;

function evictBranchAndSessions(draft: Draft<AgorState>, branchId: string): Set<string> {
  if (draft.branchById.has(branchId)) draft.branchById.delete(branchId);
  if (draft.sessionsByBranch.has(branchId)) draft.sessionsByBranch.delete(branchId);
  const removedSessionIds = new Set<string>();
  for (const [sessionId, session] of draft.sessionById) {
    if (session.branch_id === branchId) removedSessionIds.add(sessionId);
  }
  for (const sessionId of removedSessionIds) draft.sessionById.delete(sessionId);
  return removedSessionIds;
}

function removeRelationshipsToDeletedSessions(
  session: Draft<Session>,
  removedSessionIds: Set<string>
): void {
  const relationships = session.remote_relationships;
  if (!relationships) return;
  const survives = (relationship: { source_session_id: string; target_session_id: string }) =>
    !removedSessionIds.has(relationship.source_session_id) &&
    !removedSessionIds.has(relationship.target_session_id);
  const asSource = relationships.as_source?.filter(survives);
  const asTarget = relationships.as_target?.filter(survives);
  if (
    asSource?.length === relationships.as_source?.length &&
    asTarget?.length === relationships.as_target?.length
  ) {
    return;
  }
  session.remote_relationships =
    (asSource?.length ?? 0) > 0 || (asTarget?.length ?? 0) > 0
      ? {
          ...(asSource && asSource.length > 0 ? { as_source: asSource } : {}),
          ...(asTarget && asTarget.length > 0 ? { as_target: asTarget } : {}),
        }
      : undefined;
}

/** Initial meta values — identical to `useAgorData`'s `useState` defaults. */
const INITIAL_META: AgorMeta = {
  loading: true,
  loadingStage: 'idle',
  error: null,
  itemCounts: {},
  mcpServersHydrated: false,
  gatewayChannelsHydrated: false,
  agenticToolSettingsByName: new Map(),
  agenticToolSettingsHydrated: false,
};

export const agorStore = createStore<AgorState>()(
  immer((set, get) => ({
    ...EMPTY_MAPS,
    ...INITIAL_META,

    reset: () => set({ ...EMPTY_MAPS, ...INITIAL_META }),

    // Also clear the tenant-specific tool-settings map AND its hydration flag:
    // both are meta (not in EMPTY_MAPS), so without this they'd persist across a
    // logout / tenant switch and the next tenant would fail open + read stale
    // rows until its own fetch lands.
    resetMaps: () =>
      set({
        ...EMPTY_MAPS,
        agenticToolSettingsByName: new Map(),
        agenticToolSettingsHydrated: false,
      }),

    // Meta setters mirror `useState`'s bail-out: a write equal to the current
    // value is a no-op (no fresh state object, no subscriber notify).
    setLoading: (loading) => {
      if (loading !== get().loading) set({ loading });
    },
    setLoadingStage: (loadingStage) => {
      if (loadingStage !== get().loadingStage) set({ loadingStage });
    },
    setError: (error) => {
      if (error !== get().error) set({ error });
    },
    setItemCounts: (value) => {
      const next =
        typeof value === 'function'
          ? (value as (prev: ItemCounts) => ItemCounts)(get().itemCounts)
          : value;
      if (Object.is(next, get().itemCounts)) return;
      set({ itemCounts: next });
    },
    markHydrated: (flag) => {
      if (!get()[flag]) set({ [flag]: true } as Partial<AgorState>);
    },
    setAgenticToolSettings: (settings) => {
      set({
        agenticToolSettingsByName: new Map(settings.map((item) => [item.tool, item])),
        agenticToolSettingsHydrated: true,
      });
    },
    upsertAgenticToolSetting: (setting) => {
      const next = new Map(get().agenticToolSettingsByName);
      next.set(setting.tool, setting);
      // Intentionally leaves `agenticToolSettingsHydrated` untouched: a partial
      // update never establishes the complete set, so it can't flip the gate.
      set({ agenticToolSettingsByName: next });
    },

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

    applyMaps: (updater) => {
      const prev = pickMaps(get());
      const next = updater(prev);
      // Whole-object short-circuit: the ported reducers return their `prev`
      // argument unchanged on a no-op.
      if (next === prev) return;
      const changed: Partial<DataMaps> = {};
      for (const k of MAP_KEYS) {
        if (!Object.is(next[k], prev[k])) {
          // biome-ignore lint/suspicious/noExplicitAny: heterogeneous map union; per-key types are sound.
          changed[k] = next[k] as any;
        }
      }
      if (Object.keys(changed).length === 0) return;
      set(changed as Partial<AgorState>);
    },

    evictArchivedBranch: (branchId) =>
      set((draft) => {
        evictBranchAndSessions(draft, branchId);
      }),

    applyBranchHardDeleteCascade: (branchId) =>
      set((draft) => {
        const removedSessionIds = evictBranchAndSessions(draft, branchId);

        // The branch row owns its branch-type board_object via an FK cascade,
        // so the database cannot emit a separate board-objects.removed event.
        // Mirror that cascade in the normalized client indexes when the branch
        // tombstone arrives.
        const removedObjectIds = new Set<string>();
        for (const [objectId, boardObject] of draft.boardObjectById) {
          if (boardObject.branch_id === branchId) {
            removedObjectIds.add(objectId);
            draft.boardObjectById.delete(objectId);
          }
        }
        const indexedBoardObject = draft.boardObjectByBranchId.get(branchId);
        if (indexedBoardObject) removedObjectIds.add(indexedBoardObject.object_id);
        if (draft.boardObjectByBranchId.has(branchId)) {
          draft.boardObjectByBranchId.delete(branchId);
        }
        for (const [boardId, boardObjects] of draft.boardObjectsByBoardId) {
          const remaining = boardObjects.filter(
            (candidate) =>
              candidate.branch_id !== branchId && !removedObjectIds.has(candidate.object_id)
          );
          if (remaining.length !== boardObjects.length) {
            if (remaining.length > 0) {
              draft.boardObjectsByBoardId.set(boardId, remaining);
            } else {
              draft.boardObjectsByBoardId.delete(boardId);
            }
          }
        }

        // Cascaded session relationship rows do not emit child service events.
        for (const sessionId of removedSessionIds) {
          draft.sessionMcpServerIds.delete(sessionId);
        }

        // Cross-branch remote-create relationships are also cascaded by the
        // database without child service events. A target session can appear as
        // a surrogate in another branch bucket, so remove deleted IDs from every
        // bucket and strip the now-deleted relationship from surviving sessions.
        for (const session of draft.sessionById.values()) {
          removeRelationshipsToDeletedSessions(session, removedSessionIds);
        }
        for (const [bucketBranchId, sessions] of draft.sessionsByBranch) {
          const remaining = sessions.filter((session) => {
            if (removedSessionIds.has(session.session_id)) return false;
            const surrogate = session.remote_surrogate;
            return !(
              surrogate &&
              (removedSessionIds.has(surrogate.source_session_id) ||
                removedSessionIds.has(surrogate.relationship.target_session_id))
            );
          });
          for (const session of remaining) {
            removeRelationshipsToDeletedSessions(session, removedSessionIds);
          }
          if (remaining.length !== sessions.length) {
            if (remaining.length > 0) {
              draft.sessionsByBranch.set(bucketBranchId, remaining);
            } else {
              draft.sessionsByBranch.delete(bucketBranchId);
            }
          }
        }

        for (const [commentId, comment] of draft.commentById) {
          if (comment.branch_id === branchId) {
            draft.commentById.delete(commentId);
          } else if (comment.session_id && removedSessionIds.has(comment.session_id)) {
            // Session-attached comments survive with a SET NULL attachment.
            comment.session_id = undefined;
          }
        }

        for (const [channelId, channel] of draft.gatewayChannelById) {
          if (channel.target_branch_id === branchId) {
            draft.gatewayChannelById.delete(channelId);
          }
        }

        for (const board of draft.boardById.values()) {
          if (board.primary_teammate_id === branchId) {
            board.primary_teammate_id = undefined;
          }
        }

        for (const artifact of draft.artifactById.values()) {
          if (artifact.branch_id === branchId) artifact.branch_id = null;
          if (artifact.source_session_id && removedSessionIds.has(artifact.source_session_id)) {
            artifact.source_session_id = null;
          }
        }
      }),
  }))
);

/**
 * React binding for the vanilla store. The store's lifecycle stays owned by the
 * hook layer; this subscribes a component to a selected slice.
 */
export function useAgorStore<T>(selector: (state: AgorState) => T): T {
  return useStore(agorStore, selector);
}

// Re-exported for future multi-field selectors (BY-ID / derived reads) that
// need a custom equality function — see plan §4 "Selectors/equality".
export { shallow } from 'zustand/shallow';
export { useStoreWithEqualityFn } from 'zustand/traditional';
