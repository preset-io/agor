/**
 * Board partitions: one board's branches, sessions, board objects, cards and
 * full board record, loaded when the board is opened. Comments are
 * global and gated at first paint, so they are not part of a partition.
 *
 * Invariant I1 — presence is not completeness. Realtime keeps upserting rows
 * for every board the caller can see, so a row (or a non-empty bucket) in a map
 * says nothing about whether its board is complete. Surfaces that infer a fact
 * from ABSENCE ("teammate inaccessible", "no sessions", an empty canvas) gate on
 * `makeBoardReadySelector(boardId)` instead.
 *
 * Invariant I2 — a load never overwrites a live row. Every load is a complete
 * replace of the board (`replaceScope`): branches, sessions, board objects,
 * cards and the full board record. It is fenced per id by the touched stamps
 * that every realtime write records (`agorHydration.touchedSince`), so a row
 * written live during the load keeps its live value. Loading a board again
 * after it was unloaded (a reconnect or the LRU) drops rows deleted, moved or
 * hidden meanwhile, unless another scope's committed membership holds them.
 * The snapshot is never discarded because of churn, so a partition load cannot
 * starve the way a skip-apply-on-race hydration can.
 *
 * Loads are deduplicated per (authority, board), and a load whose authority
 * changed before it resolved applies nothing. A loaded partition marked
 * incomplete (a branch arrived from an unloaded board) is read again through
 * `requestBoardReload`, debounced so sustained arrivals cost a bounded number
 * of reads.
 */
import type { AgorClient, Board, Branch, CardWithType, Session } from '@agor-live/client';
import { PAGINATION } from '@agor-live/client';
import { debounceWithMaxWait } from '../utils/debounceWithMaxWait';
import { fencedRead, type HydratedCollection, touchedIdsSince } from './agorHydration';
import { type AgorState, agorStore } from './agorStore';
import { backgroundReadsClear, holdBackgroundReads } from './backgroundReads';
import { captureLoadLifetime, isLoadLifetimeCurrent, type LoadLifetime } from './loadLifetime';
import { anyOf, evictRows } from './retention';
import {
  BOARD_SCOPE_PREFIX,
  type BoardPartitionSnapshot,
  boardPartitionScope,
  boardScopeKey,
  type CoverageUpdate,
  replaceScope,
  type ScopeCoverage,
  type ScopeRows,
  settledMembers,
  withCoverage,
} from './scopeMerge';
import { sessionListQuery } from './sessionListQuery';
import { otherCommittedMembers } from './userScope';

/** `boardId`'s partition coverage entry, if any. */
export function selectBoardPartition(
  s: Pick<AgorState, 'coverage'>,
  boardId: string
): ScopeCoverage | undefined {
  return s.coverage.get(boardScopeKey(boardId));
}

const setBoardPartition = (boardId: string, entry: ScopeCoverage | null) =>
  agorStore.getState().setCoverage(boardScopeKey(boardId), entry);

/**
 * Whether `boardId` is complete: its partition is loaded from a complete
 * read. Nothing else makes a board complete; board objects, cards and full
 * board records load only with it. Curried for per-board memoization.
 */
export function makeBoardReadySelector(
  boardId: string | null | undefined
): (s: AgorState) => boolean {
  return (s) => {
    const entry = boardId ? selectBoardPartition(s, boardId) : undefined;
    return entry?.status === 'loaded' && entry.complete === true;
  };
}

export function makeBoardPartitionSelector(
  boardId: string | null | undefined
): (s: AgorState) => ScopeCoverage | undefined {
  return (s) => (boardId ? selectBoardPartition(s, boardId) : undefined);
}

/**
 * The coverage update that settles `boardId`'s partition from a read, in the
 * update that applies it: loaded under the read's lifetime and generation,
 * complete as the read says, with its membership (`settledMembers`: rows
 * realtime wrote since `startRevisions` are judged by their current value).
 * A branch that arrived from an unloaded board marks the entry incomplete
 * (`markArrivalIncomplete`): the load's own `loading` entry, whose read may
 * predate the arrival, or the `loaded` one an in-place load settles. Either
 * settles incomplete, so the board is read again; a new partition load starts
 * from a fresh entry.
 */
export function settleBoardPartition(
  boardId: string,
  lifetime: LoadLifetime,
  generation: number,
  rows: ScopeRows & { complete: boolean },
  startRevisions: Record<HydratedCollection, number>
): CoverageUpdate {
  const scope = boardPartitionScope(boardId);
  return (maps, coverage) => {
    const own = coverage.get(scope.key);
    const raced =
      own?.complete === false && (own.status === 'loaded' || own.generation === generation);
    return withCoverage(coverage, scope.key, {
      status: 'loaded',
      authorityScope: lifetime.authorityScope,
      loadEpoch: lifetime.loadEpoch,
      generation,
      members: settledMembers(scope, rows, maps, (collection) =>
        touchedIdsSince(collection, startRevisions[collection])
      ),
      complete: rows.complete && !raced,
    });
  };
}

let loadSequence = 0;

/** A new partition generation; generations only increase. */
export function nextPartitionGeneration(): number {
  return ++loadSequence;
}

/**
 * Background partitions the LRU keeps besides the displayed board: the most
 * recently used ones (a mounted background consumer counts as in use now).
 */
export const RETAINED_BACKGROUND_PARTITIONS = 3;

// The mounted consumers of a board's partition (`useBoardPartition`), in
// registration order: the board shells' displayed board, and background
// consumers (mobile navigation, the teammate panel). The UI resolves its
// board from far more than the URL (artifact routes, the mobile shell's
// fallbacks), so a reconnect resync reconciles the displayed board rather
// than re-deriving one from the URL.
const boardUses = new Map<number, { boardId: string; background: boolean }>();
let useSequence = 0;
// When each board was last used (a use registered or released), for the LRU.
const lastUsed = new Map<string, number>();

/**
 * Record that a mounted consumer uses `boardId`'s partition (displayed unless
 * `background`); returns the release function. Both ends run the LRU.
 */
export function registerBoardUse(boardId: string, background = false): () => void {
  const key = ++useSequence;
  boardUses.set(key, { boardId, background });
  lastUsed.set(boardId, key);
  evictInactivePartitions();
  return () => {
    boardUses.delete(key);
    lastUsed.set(boardId, ++useSequence);
    evictInactivePartitions();
  };
}

/** The board the UI displays (the most recently registered displayed use), if any. */
export function getDisplayedBoardId(): string | undefined {
  let latest: string | undefined;
  for (const use of boardUses.values()) if (!use.background) latest = use.boardId;
  return latest;
}

/**
 * The LRU: keep every displayed board, and of the other partitions the
 * `RETAINED_BACKGROUND_PARTITIONS` most recently used (mounted ones first);
 * evict the rest that are not mounted or loading. Runs when a use is
 * registered or released, and when a load settles or is cleaned up. Evicting a partition drops
 * its coverage and the rows it claims that no other scope holds (`evictRows`).
 */
export function evictInactivePartitions(): void {
  const displayed = new Set<string>();
  const mounted = new Set<string>();
  for (const use of boardUses.values()) (use.background ? mounted : displayed).add(use.boardId);
  const { coverage } = agorStore.getState();
  const background: string[] = [];
  for (const key of coverage.keys()) {
    if (!key.startsWith(BOARD_SCOPE_PREFIX)) continue;
    const boardId = key.slice(BOARD_SCOPE_PREFIX.length);
    if (!displayed.has(boardId)) background.push(boardId);
  }
  for (const boardId of lastUsed.keys()) {
    if (!coverage.has(boardScopeKey(boardId)) && !mounted.has(boardId) && !displayed.has(boardId))
      lastUsed.delete(boardId);
  }
  if (background.length <= RETAINED_BACKGROUND_PARTITIONS) return;
  const recency = (boardId: string) =>
    mounted.has(boardId) ? Number.POSITIVE_INFINITY : (lastUsed.get(boardId) ?? 0);
  background.sort((a, b) => recency(b) - recency(a));
  const evicted = background
    .slice(RETAINED_BACKGROUND_PARTITIONS)
    .filter(
      (boardId) =>
        !mounted.has(boardId) && coverage.get(boardScopeKey(boardId))?.status !== 'loading'
    );
  if (evicted.length === 0) return;
  evictRows(anyOf(evicted.map(boardPartitionScope)), evicted.map(boardScopeKey));
}

/**
 * The rows of `boardIds` whose partitions are unloaded (a reconnect resync
 * dropped them), unless another scope holds them. A board loaded or loading
 * again since keeps its rows.
 */
export function evictUnloadedBoards(boardIds: readonly string[]): void {
  const { coverage } = agorStore.getState();
  const unloaded = boardIds.filter((boardId) => !coverage.has(boardScopeKey(boardId)));
  if (unloaded.length > 0) evictRows(anyOf(unloaded.map(boardPartitionScope)));
}

/**
 * A reconnect resync begins: every board but `displayed`, when it is loaded,
 * is unloaded at once (loads in flight are orphaned), so a board loaded from
 * here on postdates the resync and is kept. Returns the kept board, which the
 * resync reads again in place, and the boards it unloaded.
 */
export function unloadBoardsForResync(displayed: string | null | undefined): {
  kept: string | undefined;
  unloaded: string[];
} {
  const { coverage } = agorStore.getState();
  const entry = displayed ? coverage.get(boardScopeKey(displayed)) : undefined;
  const kept =
    displayed && entry?.status === 'loaded' && isLoadLifetimeCurrent(entry) ? displayed : undefined;
  const unloaded = [...coverage.keys()]
    .filter((key) => key.startsWith(BOARD_SCOPE_PREFIX))
    .map((key) => key.slice(BOARD_SCOPE_PREFIX.length))
    .filter((boardId) => boardId !== kept);
  agorStore.getState().resetBoardPartitions(kept ? [kept] : []);
  return { kept, unloaded };
}

/** Whether `boardId`'s entry is still loading and owned by `generation`. */
function ownsLoading(boardId: string, generation: number): boolean {
  const entry = selectBoardPartition(agorStore.getState(), boardId);
  return entry?.status === 'loading' && entry.generation === generation;
}

const inflight = new Map<string, Promise<boolean>>();

// Loads dedupe per (authority, lifetime, scope epoch, board).
function inflightKey(lifetime: LoadLifetime, scopeEpoch: number, boardId: string): string {
  return `${lifetime.authorityScope}\u0000${lifetime.loadEpoch}\u0000${scopeEpoch}\u0000${boardId}`;
}

/** Forget a failed partition so `useBoardPartition` loads it again. */
export function retryBoardPartition(boardId: string): void {
  if (selectBoardPartition(agorStore.getState(), boardId)?.status === 'error') {
    setBoardPartition(boardId, null);
  }
}

type LoadOptions = {
  canUseMemberWorkspaceServices: boolean;
  background?: boolean;
  /**
   * Read a loaded board again without unloading it (a reconnect resync): it
   * stays ready and writable until the read settles it under a new generation,
   * and a failed read leaves it as it was.
   */
  inPlace?: boolean;
};

// The pending dirty reload of each board, with the latest load arguments.
const dirtyReloads = new Map<
  string,
  { request: () => void; client: AgorClient; options: LoadOptions }
>();

/**
 * Read `boardId` again because its loaded partition is incomplete: a branch
 * arrived from an unloaded board (`useBoardPartition`), or during the read
 * that settled it (`loadBoardPartition`). Debounced with a bounded wait, so a
 * burst of arrivals coalesces into one read, and fires only if the entry is
 * still loaded, incomplete and current, and a mounted consumer uses the board.
 */
export function requestBoardReload(
  client: AgorClient,
  boardId: string,
  options: LoadOptions
): void {
  const pending = dirtyReloads.get(boardId);
  if (pending) {
    Object.assign(pending, { client, options });
    pending.request();
    return;
  }
  const reload = {
    client,
    options,
    request: debounceWithMaxWait(() => {
      dirtyReloads.delete(boardId);
      const entry = selectBoardPartition(agorStore.getState(), boardId);
      const dirty =
        entry?.status === 'loaded' && entry.complete === false && isLoadLifetimeCurrent(entry);
      const used = [...boardUses.values()].some((use) => use.boardId === boardId);
      if (dirty && used) void loadBoardPartition(reload.client, boardId, reload.options);
    }).request,
  };
  dirtyReloads.set(boardId, reload);
  reload.request();
}

async function fetchBoardPartition(
  client: AgorClient,
  boardId: string,
  canUseMemberWorkspaceServices: boolean
): Promise<BoardPartitionSnapshot> {
  // The board-scoped first-paint queries of `useAgorData` (comments are
  // global and gated, so not part of a partition); each is pushed down to SQL
  // and RBAC-scoped by the daemon.
  const [branches, sessions, boardObjects, cards, board] = await Promise.all([
    client.service('branches').findAll({
      query: { archived: false, board_id: boardId, $limit: PAGINATION.DEFAULT_LIMIT },
    }) as Promise<Branch[]>,
    client.service('sessions').findAll({
      query: sessionListQuery({
        archived: false,
        board_id: boardId,
        $limit: PAGINATION.DEFAULT_LIMIT,
        $sort: { updated_at: -1 },
      }),
    }) as Promise<Session[]>,
    canUseMemberWorkspaceServices
      ? client
          .service('board-objects')
          .findAll({ query: { board_id: boardId, $limit: PAGINATION.DEFAULT_LIMIT } })
      : Promise.resolve(null),
    client
      .service('cards')
      .findAll({ query: { board_id: boardId, $limit: PAGINATION.DEFAULT_LIMIT } }) as Promise<
      CardWithType[]
    >,
    client.service('boards').get(boardId) as Promise<Board>,
  ]);
  return {
    boardId,
    branches,
    sessions,
    boardObjects: boardObjects as BoardPartitionSnapshot['boardObjects'],
    cards,
    board,
    // Every read is an unbounded `findAll`.
    complete: true,
  };
}

/**
 * Load one board's partition and replace it in the store (`replaceScope`,
 * respecting the other scopes' committed members). Deduplicated per
 * (authority, lifetime, board); resolves once applied (`true`), dropped or
 * failed (`false`).
 *
 * The `loading` entry is owned by this load (its `generation`). A load that
 * is cancelled (lifetime ended) or superseded releases its entry instead of
 * leaving the board stuck in `loading`. A load whose every attempt spans a
 * wholesale replacement never applies: it records a retryable error. The
 * snapshot and the `loaded` entry publish in one store update. A displayed
 * board's load holds background ones (`background`), which send no read
 * until the foreground reads settle (`backgroundReads.ts`). A load that
 * settles incomplete (a branch arrived during its read) owns the follow-up:
 * once its in-flight entry is gone it requests the reload
 * (`requestBoardReload`), which a deduplicated retry could not start.
 */
export function loadBoardPartition(
  client: AgorClient,
  boardId: string,
  options: LoadOptions
): Promise<boolean> {
  // Captured before the first await, like every load (see `loadLifetime`).
  const lifetime = captureLoadLifetime();
  if (!lifetime) return Promise.resolve(false);
  const { authorityScope, loadEpoch } = lifetime;
  // Per scope epoch too: a load orphaned by a reset (its entry is gone,
  // so it can never settle the board) must not absorb the board's next request.
  const key = inflightKey(lifetime, agorStore.getState().scopeEpoch, boardId);
  const existing = inflight.get(key);
  if (existing) return existing;

  const store = () => agorStore.getState();
  const loaded = selectBoardPartition(store(), boardId);
  const inPlaceFrom =
    options.inPlace && loaded?.status === 'loaded' && isLoadLifetimeCurrent(loaded)
      ? loaded.generation
      : null;
  const generation = nextPartitionGeneration();
  const owns = () => {
    if (inPlaceFrom === null) return ownsLoading(boardId, generation);
    const entry = selectBoardPartition(store(), boardId);
    return entry?.status === 'loaded' && entry.generation === inPlaceFrom;
  };
  const isCurrent = () => isLoadLifetimeCurrent(lifetime) && owns();
  const run = async (): Promise<boolean> => {
    if (inPlaceFrom === null) {
      setBoardPartition(boardId, { status: 'loading', authorityScope, loadEpoch, generation });
    }
    // A background board's reads queue behind the foreground ones on the one
    // socket: send none until the open transcript and displayed board settle.
    if (options.background) {
      await backgroundReadsClear();
      if (!isCurrent()) return false;
    }
    try {
      const applied = await fencedRead(
        () => fetchBoardPartition(client, boardId, options.canUseMemberWorkspaceServices),
        (snapshot, fence) => {
          store().applyMaps(
            (prev) =>
              replaceScope(
                prev,
                boardPartitionScope(boardId),
                snapshot,
                fence.touched,
                otherCommittedMembers(store(), boardScopeKey(boardId))
              ),
            settleBoardPartition(boardId, lifetime, generation, snapshot, fence.startRevisions)
          );
          return true;
        },
        isCurrent
      );
      return applied ?? false;
    } catch (err) {
      if (!isCurrent()) return false;
      console.warn(`[boardPartitions] load failed for board ${boardId}:`, err);
      if (inPlaceFrom !== null) return false;
      setBoardPartition(boardId, {
        status: 'error',
        authorityScope,
        loadEpoch,
        generation,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  };
  const promise = run().finally(() => {
    inflight.delete(key);
    // Cancelled or dropped while still loading: release the entry so the
    // board counts as unloaded and the next mount/authority loads it again.
    if (ownsLoading(boardId, generation)) setBoardPartition(boardId, null);
    const settled = selectBoardPartition(store(), boardId);
    if (settled?.status === 'loaded' && settled.generation === generation && !settled.complete) {
      requestBoardReload(client, boardId, options);
    }
    // The LRU skipped this board while it loaded: judge it now.
    evictInactivePartitions();
  });
  inflight.set(key, promise);
  if (!options.background) holdBackgroundReads(promise);
  return promise;
}
