/**
 * Vanilla zustand store that is the single source of truth for Agor's
 * normalized entity state. `useAgorData` drives it (its fetch effect + socket
 * subscriptions dispatch the actions here) and reads full state back via
 * `useStore`; React consumers can also bind to narrow selector subscriptions.
 *
 * Design notes:
 * - State shape reuses the canonical `DataMaps` type from
 *   `agorMaps` — held as top-level fields alongside load/meta fields.
 * - A VANILLA `createStore` (not React `create`) so the hook keeps owning
 *   lifecycle; React binds via `useStore`.
 * - IMMER breadth/depth rule: `immer` is installed (and `enableMapSet()`
 *   called) so genuine CASCADE / multi-map mutations can be expressed as
 *   imperative draft edits (see `evictBranchAndSessions`). The HOT single-entity
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

import {
  type AgorClient,
  type Link,
  PAGINATION,
  type TenantAgenticToolName,
  type TenantAgenticToolSettings,
} from '@agor-live/client';
import { enableMapSet } from 'immer';
import { useStore } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createStore } from 'zustand/vanilla';
import type { InitialLoadItemKey, InitialLoadingStage } from '../hooks/useAgorData';
import { bumpRevision, getHydrationRetryDelay } from './agorHydration';
import {
  type DataMaps,
  EMPTY_MAPS,
  MAP_KEYS,
  pickMaps,
  removeLinkFromMaps,
  replaceFullBranchLinksInMaps,
  replaceFullSessionLinksInMaps,
  upsertLinkInMaps,
} from './agorMaps';

// Immer needs this to draft Map/Set state. Called once at module load; the
// store's state is entirely Maps and one Set.
enableMapSet();

/** Per-item counts captured at fetch-resolution time. Mirrors `useAgorData`. */
type ItemCounts = Partial<Record<InitialLoadItemKey, number>>;

/** Background-hydrated collections that gate UI reads on their first apply. */
type GatedHydrationFlag = 'mcpServersHydrated' | 'gatewayChannelsHydrated';

/** Load/meta fields that ride alongside the data maps. */
interface AgorMeta {
  loading: boolean;
  loadingStage: InitialLoadingStage;
  error: string | null;
  itemCounts: ItemCounts;
  /** Branch owners whose `linksByBranch` bucket has been hydrated as a full owner snapshot. */
  fullBranchLinkOwnerIds: Set<string>;
  /** Full branch owners intentionally hydrated while outside the active branch map. */
  directFullBranchLinkOwnerIds: Set<string>;
  /** Session owners whose `linksBySession` bucket has been hydrated as a full owner snapshot. */
  fullSessionLinkOwnerIds: Set<string>;
  /** Set once the background mcp-servers hydration first applies (empty result included). */
  mcpServersHydrated: boolean;
  /** Set once the background gateway-channels hydration first applies (empty result included). */
  gatewayChannelsHydrated: boolean;
  agenticToolSettingsByName: Map<TenantAgenticToolName, TenantAgenticToolSettings>;
}

/** Store actions: foundational primitives + the one immer cascade. */
interface AgorActions {
  /** Reset every data map to empty and meta to its initial (loading) values. */
  reset: () => void;
  /**
   * Reset ONLY the data maps to empty, leaving meta untouched. Mirrors the
   * hook's logout effect (`setMaps(EMPTY_MAPS)`), which clears board state
   * without flipping `loading` / `error` / `itemCounts`. Full-link owner
   * hydration markers are data-scope bookkeeping, so they are cleared too.
   */
  resetMaps: () => void;
  setLoading: (loading: boolean) => void;
  setLoadingStage: (loadingStage: InitialLoadingStage) => void;
  setError: (error: string | null) => void;
  /** Accepts a value or a functional updater (mirrors `useState`). */
  setItemCounts: (value: ItemCounts | ((prev: ItemCounts) => ItemCounts)) => void;
  /** Mark a gated background collection as first-hydrated (idempotent). */
  markHydrated: (flag: GatedHydrationFlag) => void;
  setAgenticToolSettings: (settings: TenantAgenticToolSettings[]) => void;
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
  /**
   * CASCADE (immer): drop a branch from `branchById`, prune every session that
   * lived on it from `sessionById` / `sessionsByBranch`, and evict branch-owned
   * plus child-session-owned links. Shared between the `archived: true` patch
   * path and the hard-delete `removed` path.
   */
  evictBranchAndSessions: (branchId: string) => void;
  /** Evict a removed/archived session owner's link bucket and owner metadata. */
  evictSessionLinks: (sessionId: string) => void;
  /** Replace one session owner's complete link bucket, preserving every other owner bucket. */
  replaceFullSessionLinks: (sessionId: string, links: readonly Link[]) => void;
  /** Replace one branch owner's complete link bucket, preserving every other owner bucket. */
  replaceFullBranchLinks: (branchId: string, links: readonly Link[]) => void;
  /** Fetch and race-safely replace one session owner's complete link bucket. */
  fetchAndReplaceFullSessionLinks: (client: AgorClient, sessionId: string) => Promise<Link[]>;
  /** Fetch and race-safely replace one branch owner's complete link bucket. */
  fetchAndReplaceFullBranchLinks: (client: AgorClient, branchId: string) => Promise<Link[]>;
  /** Apply a link returned from a component-initiated create/upsert where this caller knows it is current. */
  applyKnownLinkCreatedResult: (link: Link) => void;
  /** Apply a link returned from a component-initiated remove where this caller knows it is current. */
  applyKnownLinkRemovedResult: (link: Link) => void;
  /** Apply a link returned from a component-initiated service mutation. */
  applyLinkMutationResult: (link: Link) => void;
}

export type AgorState = DataMaps & AgorMeta & AgorActions;

/** Initial meta values — identical to `useAgorData`'s `useState` defaults. */
const makeInitialMeta = (): AgorMeta => ({
  loading: true,
  loadingStage: 'idle',
  error: null,
  itemCounts: {},
  fullBranchLinkOwnerIds: new Set(),
  directFullBranchLinkOwnerIds: new Set(),
  fullSessionLinkOwnerIds: new Set(),
  mcpServersHydrated: false,
  gatewayChannelsHydrated: false,
  agenticToolSettingsByName: new Map(),
});

let fullLinkRequestSequence = 0;
const fullLinkRequestGeneration = new Map<string, number>();
const fullLinkMutationGeneration = new Map<string, number>();
type FullLinkOwnerScope = 'branch' | 'session';

function fullLinkOwnerKey(scope: FullLinkOwnerScope, ownerId: string): string {
  return `${scope}:${ownerId}`;
}

function resetFullLinkRequestGenerations(): void {
  fullLinkRequestGeneration.clear();
  fullLinkMutationGeneration.clear();
}

function startFullLinkRequest(scope: FullLinkOwnerScope, ownerId: string): number {
  const generation = ++fullLinkRequestSequence;
  fullLinkRequestGeneration.set(fullLinkOwnerKey(scope, ownerId), generation);
  return generation;
}

function cancelFullLinkRequest(scope: FullLinkOwnerScope, ownerId: string): void {
  startFullLinkRequest(scope, ownerId);
}

function invalidateFullLinkOwnerSnapshot(scope: FullLinkOwnerScope, ownerId: string): void {
  const key = fullLinkOwnerKey(scope, ownerId);
  fullLinkMutationGeneration.set(key, (fullLinkMutationGeneration.get(key) ?? 0) + 1);
}

/** Mark owner-scoped snapshots stale when a link mutation may race their fetch. */
export function invalidateFullLinkRequestsForLink(link: Link | null | undefined): void {
  if (!link) return;
  if (link.branch_id && !link.session_id) invalidateFullLinkOwnerSnapshot('branch', link.branch_id);
  if (link.session_id && !link.branch_id)
    invalidateFullLinkOwnerSnapshot('session', link.session_id);
}

function isLatestFullLinkRequest(
  scope: FullLinkOwnerScope,
  ownerId: string,
  generation: number
): boolean {
  return fullLinkRequestGeneration.get(fullLinkOwnerKey(scope, ownerId)) === generation;
}

function fullLinkOwnerBucket(
  state: AgorState,
  scope: FullLinkOwnerScope,
  ownerId: string
): readonly Link[] | undefined {
  return scope === 'branch' ? state.linksByBranch.get(ownerId) : state.linksBySession.get(ownerId);
}

async function fetchAndReplaceFullOwnerLinks(
  get: () => AgorState,
  client: AgorClient,
  scope: FullLinkOwnerScope,
  ownerId: string
): Promise<Link[]> {
  const requestGeneration = startFullLinkRequest(scope, ownerId);
  const ownerKey = fullLinkOwnerKey(scope, ownerId);
  const query =
    scope === 'branch'
      ? {
          owner_scope: 'branch' as const,
          branch_id: ownerId,
          $limit: PAGINATION.DEFAULT_LIMIT,
        }
      : {
          owner_scope: 'session' as const,
          session_id: ownerId,
          $limit: PAGINATION.DEFAULT_LIMIT,
        };
  for (let attempt = 0; isLatestFullLinkRequest(scope, ownerId, requestGeneration); attempt++) {
    const delayMs = getHydrationRetryDelay(attempt);
    if (delayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      if (!isLatestFullLinkRequest(scope, ownerId, requestGeneration)) return [];
    }
    const mutationGeneration = fullLinkMutationGeneration.get(ownerKey) ?? 0;
    const beforeBucket = fullLinkOwnerBucket(get(), scope, ownerId);
    const links = await client.service('links').findAll({ query });

    if (!isLatestFullLinkRequest(scope, ownerId, requestGeneration)) return [];
    if (
      (fullLinkMutationGeneration.get(ownerKey) ?? 0) !== mutationGeneration ||
      fullLinkOwnerBucket(get(), scope, ownerId) !== beforeBucket
    ) {
      continue;
    }

    if (scope === 'branch') get().replaceFullBranchLinks(ownerId, links);
    else get().replaceFullSessionLinks(ownerId, links);
    return links;
  }
  return [];
}

function linkUpdatedAtMillis(link: Link): number | null {
  const timestamp = Date.parse(link.updated_at);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function isStaleLinkMutationResult(existing: Link, incoming: Link): boolean {
  if (existing.revision !== undefined && incoming.revision !== undefined) {
    return incoming.revision <= existing.revision;
  }
  const existingUpdatedAt = linkUpdatedAtMillis(existing);
  const incomingUpdatedAt = linkUpdatedAtMillis(incoming);
  if (existingUpdatedAt === null || incomingUpdatedAt === null) return false;
  return incomingUpdatedAt < existingUpdatedAt;
}

export const agorStore = createStore<AgorState>()(
  immer((set, get) => ({
    ...EMPTY_MAPS,
    ...makeInitialMeta(),

    reset: () => {
      resetFullLinkRequestGenerations();
      set({ ...EMPTY_MAPS, ...makeInitialMeta() });
    },

    resetMaps: () => {
      resetFullLinkRequestGenerations();
      set({
        ...EMPTY_MAPS,
        fullBranchLinkOwnerIds: new Set(),
        directFullBranchLinkOwnerIds: new Set(),
        fullSessionLinkOwnerIds: new Set(),
      });
    },

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
      set({ agenticToolSettingsByName: new Map(settings.map((item) => [item.tool, item])) });
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

    evictBranchAndSessions: (branchId) => {
      const orphanIds: string[] = [];
      for (const [sessionId, session] of get().sessionById) {
        if (session.branch_id === branchId) orphanIds.push(sessionId);
      }

      cancelFullLinkRequest('branch', branchId);
      for (const sessionId of orphanIds) cancelFullLinkRequest('session', sessionId);

      set((draft) => {
        if (draft.branchById.has(branchId)) draft.branchById.delete(branchId);
        if (draft.sessionsByBranch.has(branchId)) draft.sessionsByBranch.delete(branchId);
        for (const sessionId of orphanIds) draft.sessionById.delete(sessionId);
        draft.fullBranchLinkOwnerIds.delete(branchId);
        draft.directFullBranchLinkOwnerIds.delete(branchId);
        if (draft.linksByBranch.has(branchId)) {
          for (const link of draft.linksByBranch.get(branchId) ?? []) {
            draft.linkById.delete(link.link_id);
          }
          draft.linksByBranch.delete(branchId);
        }
        for (const sessionId of orphanIds) {
          for (const link of draft.linksBySession.get(sessionId) ?? []) {
            draft.linkById.delete(link.link_id);
          }
          draft.linksBySession.delete(sessionId);
          draft.fullSessionLinkOwnerIds.delete(sessionId);
        }
      });
    },

    evictSessionLinks: (sessionId) => {
      cancelFullLinkRequest('session', sessionId);
      const state = get();
      if (!state.linksBySession.has(sessionId) && !state.fullSessionLinkOwnerIds.has(sessionId)) {
        return;
      }

      set((draft) => {
        for (const link of draft.linksBySession.get(sessionId) ?? []) {
          draft.linkById.delete(link.link_id);
        }
        draft.linksBySession.delete(sessionId);
        draft.fullSessionLinkOwnerIds.delete(sessionId);
      });
    },

    replaceFullSessionLinks: (sessionId, links) => {
      invalidateFullLinkOwnerSnapshot('session', sessionId);
      let mapsChanged = false;
      get().applyMaps((prev) => {
        const next = replaceFullSessionLinksInMaps(prev, sessionId, links);
        mapsChanged = next !== prev;
        return next;
      });
      if (mapsChanged) bumpRevision('links');
      set((draft) => {
        draft.fullSessionLinkOwnerIds.add(sessionId);
      });
    },

    replaceFullBranchLinks: (branchId, links) => {
      invalidateFullLinkOwnerSnapshot('branch', branchId);
      const isDirectOutsideActiveBranchMap = !get().branchById.has(branchId);
      let mapsChanged = false;
      get().applyMaps((prev) => {
        const next = replaceFullBranchLinksInMaps(prev, branchId, links);
        mapsChanged = next !== prev;
        return next;
      });
      if (mapsChanged) bumpRevision('links');
      set((draft) => {
        draft.fullBranchLinkOwnerIds.add(branchId);
        if (isDirectOutsideActiveBranchMap) draft.directFullBranchLinkOwnerIds.add(branchId);
        else draft.directFullBranchLinkOwnerIds.delete(branchId);
      });
    },

    fetchAndReplaceFullSessionLinks: (client, sessionId) =>
      fetchAndReplaceFullOwnerLinks(get, client, 'session', sessionId),

    fetchAndReplaceFullBranchLinks: (client, branchId) =>
      fetchAndReplaceFullOwnerLinks(get, client, 'branch', branchId),

    applyKnownLinkCreatedResult: (link) => {
      const existing = get().linkById.get(link.link_id);
      if (existing && isStaleLinkMutationResult(existing, link)) return;

      invalidateFullLinkRequestsForLink(existing);
      invalidateFullLinkRequestsForLink(link);

      let mapsChanged = false;
      get().applyMaps((prev) => {
        const next = upsertLinkInMaps(prev, link);
        mapsChanged = next !== prev;
        return next;
      });
      if (mapsChanged) bumpRevision('links');
    },

    applyKnownLinkRemovedResult: (link) => {
      invalidateFullLinkRequestsForLink(get().linkById.get(link.link_id));
      invalidateFullLinkRequestsForLink(link);
      let mapsChanged = false;
      get().applyMaps((prev) => {
        const next = removeLinkFromMaps(prev, link);
        mapsChanged = next !== prev;
        return next;
      });
      if (mapsChanged) bumpRevision('links');
    },

    applyLinkMutationResult: (link) => {
      const existing = get().linkById.get(link.link_id);
      if (!existing || isStaleLinkMutationResult(existing, link)) return;

      invalidateFullLinkRequestsForLink(existing);
      invalidateFullLinkRequestsForLink(link);

      let mapsChanged = false;
      get().applyMaps((prev) => {
        const next = upsertLinkInMaps(prev, link);
        mapsChanged = next !== prev;
        return next;
      });
      if (mapsChanged) bumpRevision('links');
    },
  }))
);

/**
 * Pinned-only branch snapshots are authoritative for active branch owners, but
 * not for direct full-owner buckets whose branch is outside the active branch
 * map (for example, an archived branch opened directly). Preserve those buckets
 * during pinned reconciliation while still allowing global pinned hydration to
 * clean up stale active-branch pins after missed realtime events.
 */
export function getPinnedBranchLinkPreserveBranchIds(
  state: AgorState
): ReadonlySet<string> | undefined {
  const preserve = new Set<string>();
  for (const branchId of state.directFullBranchLinkOwnerIds) {
    if (!state.branchById.has(branchId)) preserve.add(branchId);
  }
  return preserve.size > 0 ? preserve : undefined;
}

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
