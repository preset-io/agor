/**
 * User scope: everything Home and the teammates surfaces read, loaded in full
 * for the caller (design r3 §3), independent of the global hydration.
 *
 * - Gated (in `useAgorData`'s first paint): my newest `MY_SESSIONS_GATED_LIMIT`
 *   sessions. Fewer rows than the limit already means "all of mine".
 * - U1: all of my active sessions in ONE read (no offset pages: an archive
 *   during a paged read shifts rows and skips one), capped at
 *   `MY_SESSIONS_FULL_LIMIT`; hitting the cap sets `mySessionsTruncated`.
 * - U2: my branches (`branches{created_by}`).
 * - U3: every teammate branch I can view (`branches{teammate: true}`), capped
 *   at `PAGINATION.MAX_TEAMMATE_BRANCHES`; the daemon's real total sets
 *   `teammatesTruncated` when the cap was hit.
 * - U5: every branch my sessions or candidate comment threads reference that
 *   is still absent, read by id in chunks; ids the server does not return go
 *   into `absentBranchIds` (archived, deleted or invisible).
 *
 * Fork ancestors of other users are deliberately NOT fetched (decision Q4,
 * 2026-10-01); see `startedByUserLineage` in `homeSelectors.ts`.
 *
 * Every read applies with the fill-only merge and per-id touched fence
 * (`applyEntityFill`), under the lifetime of the load that started the run.
 * Flags only ever become true within one identity; `resetMaps` clears them.
 * A failed U1/U2/U3 read leaves its flag unset (Home keeps its loading state)
 * until the next run, which `useAgorData` starts again on every silent
 * reconnect resync.
 *
 * Realtime keeps the scope complete for rows; a store subscription, installed
 * before the first read, keeps it complete for new REFERENCES (a new session of
 * mine, a new comment thread on a branch that isn't loaded) by ensuring their
 * branches: debounced, in chunks, at most `MAX_CONCURRENT_ID_READS` at once,
 * with a run-owned retry queue (capped backoff) for failed reads. Absent marks
 * are revalidated at the start of every run.
 */
import type { AgorClient, BoardComment, Branch, Session } from '@agor-live/client';
import { PAGINATION } from '@agor-live/client';
import { getTimeMs } from '../utils/entityTime';
import {
  beginPartitionLoad,
  endPartitionLoad,
  type HydratedCollection,
  MAX_WHOLESALE_RESTARTS,
  touchedSince,
  WholesaleReplacementError,
  wholesaleReplacedSince,
} from './agorHydration';
import { applyEntityFill, type DataMaps } from './agorMaps';
import { type AgorState, agorStore } from './agorStore';
import { isLoadLifetimeCurrent, type LoadLifetime } from './loadLifetime';
import { sessionListQuery } from './sessionListQuery';

/** Gated first-paint page of my sessions (replaces the global recent slice). */
export const MY_SESSIONS_GATED_LIMIT = 200;
/** Cap of the single all-my-sessions read (U1). */
export const MY_SESSIONS_FULL_LIMIT = PAGINATION.MAX_LIMIT;
/** Debounce for ensuring branches of newly referenced ids. */
const REFERENCE_DEBOUNCE_MS = 100;
/** Referenced-branch id reads in flight at once, per run. */
export const MAX_CONCURRENT_ID_READS = 3;
/** Backoff of a failed referenced-branch read: base, cap and attempts. */
const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 30_000;
export const MAX_REFERENCE_READ_ATTEMPTS = 6;

/** The newest-first query for my active sessions. */
export function mySessionsQuery(userId: string, limit: number) {
  return sessionListQuery({
    created_by: userId,
    archived: false,
    $sort: { updated_at: -1 },
    $limit: limit,
    $count: false,
  });
}

/**
 * The daemon does not support a user-scope read: it rejected the query (400,
 * an older validator) or answered rows that violate the filter (an older
 * validator that strips unknown keys and returns an unfiltered result).
 */
export class UnsupportedScopeReadError extends Error {
  constructor(detail: string) {
    super(`user-scope read unsupported: ${detail}`);
    this.name = 'UnsupportedScopeReadError';
  }
}

/** Whether a read failed because the daemon rejected the query itself (HTTP 400). */
export function isUnsupportedQueryError(err: unknown): boolean {
  const error = err as { code?: unknown; name?: unknown } | null;
  return error?.code === 400 || error?.name === 'BadRequest';
}

/** Whether the global session and branch snapshots have applied (Steps 1–2 only). */
const globalSetsComplete = (s: AgorState) =>
  s.globallyHydrated.has('sessions') && s.globallyHydrated.has('branches');

const rowsOf = <T>(result: unknown): T[] =>
  Array.isArray(result) ? (result as T[]) : ((result as { data?: T[] })?.data ?? []);

/**
 * Branch ids the user scope must resolve: the branch of every active session I
 * created, and of every candidate comment thread — unresolved, on a board that
 * isn't archived, where someone else spoke and the caller did not speak last.
 * A superset of the threads `makeCommentsForYouSelector` can show.
 */
export function referencedBranchIds(
  s: Pick<DataMaps, 'sessionById' | 'commentById' | 'boardById'>,
  userId: string
): Set<string> {
  const ids = new Set<string>();
  for (const session of s.sessionById.values()) {
    if (!session.archived && session.created_by === userId && session.branch_id) {
      ids.add(session.branch_id);
    }
  }
  const threads = new Map<string, BoardComment[]>();
  for (const comment of s.commentById.values()) {
    const rootId = comment.parent_comment_id ?? comment.comment_id;
    const thread = threads.get(rootId);
    if (thread) thread.push(comment);
    else threads.set(rootId, [comment]);
  }
  for (const [rootId, comments] of threads) {
    const root = s.commentById.get(rootId);
    if (!root?.branch_id || root.resolved || s.boardById.get(root.board_id)?.archived) continue;
    let last = root;
    let someoneElse = false;
    for (const comment of comments) {
      if (comment.created_by !== userId) someoneElse = true;
      if (getTimeMs(comment, 'created_at') >= getTimeMs(last, 'created_at')) last = comment;
    }
    if (someoneElse && last.created_by !== userId) ids.add(root.branch_id);
  }
  return ids;
}

interface ScopeRun {
  client: AgorClient;
  userId: string;
  /** The lifetime of the load that started the run; never the current one. */
  lifetime: LoadLifetime;
  /** Ids waiting to be sent in an id-list read. */
  queue: string[];
  /** Ids queued, in flight or waiting for a retry; never requested twice meanwhile. */
  pending: Set<string>;
  /** Ids whose reads failed every attempt; retried by the next run. */
  failed: Set<string>;
  /** Failed attempts per id, for the retry backoff. */
  attempts: Map<string, number>;
  /** Id-list reads in flight (at most `MAX_CONCURRENT_ID_READS`). */
  inflight: number;
  /** Every reference is known: my sessions (U1 or a complete gated page) and my branches (U2) loaded. */
  referencesKnown: boolean;
  /** The daemon does not support the scope reads; no more of them are sent. */
  degraded: boolean;
  /**
   * A scope read was unsupported or failed: the global snapshots (Steps 1–2)
   * may complete the flags it left unset (`applyGlobalCompatibility`).
   */
  compat: boolean;
  referenceTimer: ReturnType<typeof setTimeout> | null;
  retryTimers: Set<ReturnType<typeof setTimeout>>;
  /** Resolved once no id read is queued or in flight (or the run stops). */
  drainWaiters: Array<() => void>;
  unsubscribe: (() => void) | null;
}

let currentRun: ScopeRun | null = null;

const isCurrent = (run: ScopeRun) => currentRun === run && isLoadLifetimeCurrent(run.lifetime);

/**
 * The user whose scope is loading or loaded under the current lifetime, or
 * null. Its rows are claimed against other scopes' replaces (`scopeMerge`).
 */
export function getUserScopeUserId(): string | null {
  return currentRun && isCurrent(currentRun) ? currentRun.userId : null;
}

/**
 * Read rows and fill-merge them; null when the run went stale. Read errors
 * propagate, and so does a read whose every attempt spanned a wholesale
 * replacement (`WholesaleReplacementError`): its snapshot is never applied.
 */
async function fillRead(
  run: ScopeRun,
  read: () => Promise<{ branches?: Branch[]; sessions?: Session[] }>,
  /** Rows the filter can't have produced mean the daemon ignored the filter. */
  violatesFilter?: (rows: { branches?: Branch[]; sessions?: Session[] }) => boolean
): Promise<{ branches?: Branch[]; sessions?: Session[] } | null> {
  for (let attempt = 0; ; attempt++) {
    const fence = beginPartitionLoad();
    try {
      let rows: { branches?: Branch[]; sessions?: Session[] };
      try {
        rows = await read();
      } catch (err) {
        if (isUnsupportedQueryError(err)) throw new UnsupportedScopeReadError(String(err));
        throw err;
      }
      if (!isCurrent(run)) return null;
      if (violatesFilter?.(rows)) throw new UnsupportedScopeReadError('filter ignored');
      if (wholesaleReplacedSince(fence)) {
        if (attempt < MAX_WHOLESALE_RESTARTS) continue;
        throw new WholesaleReplacementError();
      }
      const touched = (collection: HydratedCollection, id: string) =>
        touchedSince(collection, id, fence.startRevisions[collection]);
      agorStore.getState().applyMaps((prev) => applyEntityFill(prev, rows, touched));
      return rows;
    } finally {
      endPartitionLoad();
    }
  }
}

/**
 * Write user-scope metadata for `run` — only while it is current. Every flag
 * and absent-mark write goes through here (or `updateAbsent`), so a
 * continuation that resumes after its run was cancelled or superseded (an
 * awaited read's completion, a `.then`, a timer) can never write into the
 * next authority's store, even when its rows were applied while it was
 * still current.
 */
function setScope(run: ScopeRun, partial: Parameters<AgorState['setUserScope']>[0]): void {
  if (isCurrent(run)) agorStore.getState().setUserScope(partial);
}

/** Add absent marks and drop the marks of branches that are present now (current run only). */
function updateAbsent(run: ScopeRun, add: readonly string[]): void {
  if (!isCurrent(run)) return;
  const state = agorStore.getState();
  const next = new Set([...state.absentBranchIds, ...add]);
  for (const id of next) if (state.branchById.has(id)) next.delete(id);
  const same =
    next.size === state.absentBranchIds.size &&
    [...next].every((id) => state.absentBranchIds.has(id));
  if (!same) state.setUserScope({ absentBranchIds: next });
}

/** Ids referenced but neither present, absent, nor pending or failed in this run. */
function missingReferences(s: AgorState, run: ScopeRun): string[] {
  const missing: string[] = [];
  for (const id of referencedBranchIds(s, run.userId)) {
    if (
      !s.branchById.has(id) &&
      !s.absentBranchIds.has(id) &&
      !run.pending.has(id) &&
      !run.failed.has(id)
    ) {
      missing.push(id);
    }
  }
  return missing;
}

/**
 * Compatibility path while global hydration exists (Steps 1–2; removed with
 * the global loops in 3.3). Once the global session and branch snapshots have
 * applied, the store holds every active session and branch the caller can
 * see, so they complete any flag a degraded or failed scope left unset, and a
 * referenced branch that is still missing is absent.
 */
function applyGlobalCompatibility(run: ScopeRun): void {
  if (!isCurrent(run) || !run.compat) return;
  const state = agorStore.getState();
  if (!globalSetsComplete(state)) return;
  const unresolved = [...referencedBranchIds(state, run.userId)].filter(
    (id) => !state.branchById.has(id) && !run.pending.has(id)
  );
  updateAbsent(run, unresolved);
  for (const id of unresolved) run.failed.delete(id);
  setScope(run, {
    ...(state.mySessionsLoaded ? {} : { mySessionsLoaded: true, mySessionsTruncated: false }),
    teammatesLoaded: true,
    teammatesTruncated: false,
  });
  if (run.pending.size === 0) setScope(run, { homeBranchesLoaded: true });
}

/** Stop sending scope reads: the daemon doesn't support them (terminal for the run). */
function enterDegraded(run: ScopeRun, reason: unknown): void {
  if (!isCurrent(run)) return;
  if (!run.degraded) console.warn('[userScope] daemon does not support user-scope reads:', reason);
  run.degraded = true;
  run.compat = true;
  run.queue = [];
  run.pending.clear();
  for (const timer of run.retryTimers) clearTimeout(timer);
  run.retryTimers.clear();
  setScope(run, { userScopeDegraded: true });
  applyGlobalCompatibility(run);
}

/** `homeBranchesLoaded` once every reference is known and none is unresolved. */
function settleHomeBranches(run: ScopeRun): void {
  applyGlobalCompatibility(run);
  if (!isCurrent(run) || !run.referencesKnown) return;
  if (run.pending.size > 0 || run.failed.size > 0) return;
  if (missingReferences(agorStore.getState(), run).length > 0) return;
  setScope(run, { homeBranchesLoaded: true });
}

/** Queue branch ids for id-list reads (deduplicated by `pending`). */
function queueBranches(run: ScopeRun, ids: Iterable<string>): void {
  if (run.degraded) return;
  for (const id of ids) {
    if (run.pending.has(id)) continue;
    run.pending.add(id);
    run.failed.delete(id);
    run.queue.push(id);
  }
  pumpBranchReads(run);
}

/** Send queued ids in chunks of `PAGINATION.MAX_ID_LIST`, at most `MAX_CONCURRENT_ID_READS` at once. */
function pumpBranchReads(run: ScopeRun): void {
  while (isCurrent(run) && run.inflight < MAX_CONCURRENT_ID_READS && run.queue.length > 0) {
    const chunk = run.queue.splice(0, PAGINATION.MAX_ID_LIST);
    run.inflight += 1;
    void readBranchChunk(run, chunk).finally(() => {
      run.inflight -= 1;
      pumpBranchReads(run);
      settleHomeBranches(run);
      if (run.inflight === 0 && run.queue.length === 0) releaseDrainWaiters(run);
    });
  }
}

function releaseDrainWaiters(run: ScopeRun): void {
  for (const resolve of run.drainWaiters.splice(0)) resolve();
}

/**
 * Resolves once no id read is queued or in flight (a scheduled retry doesn't
 * count), or once the run is no longer current.
 */
function idReadsDrained(run: ScopeRun): Promise<void> {
  if (!isCurrent(run) || (run.inflight === 0 && run.queue.length === 0)) {
    return Promise.resolve();
  }
  return new Promise((resolve) => run.drainWaiters.push(resolve));
}

/**
 * Read one chunk of branch ids and record the ones the server doesn't return —
 * and that didn't arrive meanwhile — as absent. A failed read is retried with
 * backoff; the ids stay pending until it settles.
 */
async function readBranchChunk(run: ScopeRun, chunk: string[]): Promise<void> {
  try {
    const requested = new Set(chunk);
    const rows = await fillRead(
      run,
      async () => ({
        branches: rowsOf<Branch>(
          await run.client.service('branches').find({
            query: { branch_id: { $in: chunk }, archived: false, $limit: chunk.length },
          })
        ),
      }),
      ({ branches }) => (branches ?? []).some((branch) => !requested.has(branch.branch_id))
    );
    // Recheck after the await: `fillRead` applied while current, but this
    // continuation runs later, possibly after a cancellation or a new run.
    if (!rows || !isCurrent(run)) return;
    const returned = new Set((rows.branches ?? []).map((branch) => branch.branch_id as string));
    const state = agorStore.getState();
    updateAbsent(
      run,
      chunk.filter((id) => !returned.has(id) && !state.branchById.has(id))
    );
    for (const id of chunk) {
      run.pending.delete(id);
      run.attempts.delete(id);
    }
  } catch (err) {
    if (!isCurrent(run)) return;
    if (err instanceof UnsupportedScopeReadError) {
      enterDegraded(run, err);
      return;
    }
    console.warn('[userScope] referenced branches failed:', err);
    scheduleRetry(run, chunk);
  }
}

/** Retry failed ids with capped exponential backoff; give up after `MAX_REFERENCE_READ_ATTEMPTS`. */
function scheduleRetry(run: ScopeRun, ids: string[]): void {
  const attempt = Math.max(...ids.map((id) => (run.attempts.get(id) ?? 0) + 1));
  for (const id of ids) run.attempts.set(id, attempt);
  if (attempt >= MAX_REFERENCE_READ_ATTEMPTS) {
    for (const id of ids) {
      run.pending.delete(id);
      run.failed.add(id);
    }
    run.compat = true;
    return;
  }
  const timer = setTimeout(
    () => {
      run.retryTimers.delete(timer);
      if (!isCurrent(run)) return;
      for (const id of ids) run.pending.delete(id);
      queueBranches(
        run,
        ids.filter((id) => !agorStore.getState().branchById.has(id))
      );
      settleHomeBranches(run);
    },
    Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS)
  );
  run.retryTimers.add(timer);
}

/** Clear marks of branches that arrived, queue new references, and settle. */
function checkReferences(run: ScopeRun): void {
  if (!isCurrent(run)) return;
  // A branch arriving by any path (event, partition, ensure) clears its mark.
  updateAbsent(run, []);
  queueBranches(run, missingReferences(agorStore.getState(), run));
  settleHomeBranches(run);
}

function scheduleReferenceCheck(run: ScopeRun): void {
  if (run.referenceTimer) return;
  run.referenceTimer = setTimeout(() => {
    run.referenceTimer = null;
    checkReferences(run);
  }, REFERENCE_DEBOUNCE_MS);
}

function subscribeToReferences(run: ScopeRun): void {
  run.unsubscribe = agorStore.subscribe((state, prev) => {
    if (
      state.sessionById === prev.sessionById &&
      state.commentById === prev.commentById &&
      state.branchById === prev.branchById &&
      state.globallyHydrated === prev.globallyHydrated
    ) {
      return;
    }
    scheduleReferenceCheck(run);
  });
}

/** Stop the current run: unsubscribe, cancel its timers, and drop its pending applies. */
export function stopUserScope(): void {
  const run = currentRun;
  currentRun = null;
  if (!run) return;
  run.unsubscribe?.();
  run.unsubscribe = null;
  if (run.referenceTimer) clearTimeout(run.referenceTimer);
  run.referenceTimer = null;
  for (const timer of run.retryTimers) clearTimeout(timer);
  run.retryTimers.clear();
  run.queue = [];
  releaseDrainWaiters(run);
}

/**
 * Load the user scope under `lifetime`, the lifetime of the load that started
 * it (captured before that load's first await). A lifetime that is no longer
 * current — another authority, or a cancellation since — is rejected, so a
 * load that outlived a logout/remount can never adopt the next user's
 * authority. `gatedMineComplete` says the gated first-paint page already holds
 * all of my active sessions (it returned fewer than `MY_SESSIONS_GATED_LIMIT`
 * rows and raced none of mine), so U1 can be skipped. Resolves when the
 * initial reads and the id reads they triggered settled, failed, or were
 * superseded; the reference subscription and retries keep running until
 * `stopUserScope`.
 */
export async function startUserScope(
  client: AgorClient,
  options: {
    userId: string;
    lifetime: LoadLifetime;
    gatedMineComplete: boolean;
    /** The gated my-sessions page was rejected as unsupported: start degraded. */
    unsupported?: boolean;
    /**
     * Hold the bulk U1 read until this settles: on a session route, the opened
     * transcript (#2887's transcript-first barrier). The small reads (U2, U3,
     * referenced branches) never wait for it.
     */
    deferBulkRead?: Promise<void>;
  }
): Promise<void> {
  if (!isLoadLifetimeCurrent(options.lifetime)) return;
  stopUserScope();
  const run: ScopeRun = {
    client,
    userId: options.userId,
    lifetime: options.lifetime,
    queue: [],
    pending: new Set(),
    failed: new Set(),
    attempts: new Map(),
    inflight: 0,
    referencesKnown: false,
    degraded: false,
    compat: false,
    referenceTimer: null,
    retryTimers: new Set(),
    drainWaiters: [],
    unsubscribe: null,
  };
  currentRun = run;
  const store = () => agorStore.getState();
  if (options.gatedMineComplete) setScope(run, { mySessionsLoaded: true });

  // Subscribe before any read: a reference that appears while the reads below
  // are in flight is seen by the subscription, never lost between a scan and
  // a late subscribe.
  subscribeToReferences(run);
  // An older daemon rejected the gated page's keys; it rejects (or ignores)
  // every scope read the same way, so send none.
  if (options.unsupported) {
    enterDegraded(run, 'the gated my-sessions page was rejected');
    return;
  }
  // Absent marks are negatives of the authority that produced them (a grant,
  // reconnect or role change can make a branch visible): revalidate them.
  queueBranches(run, store().absentBranchIds);
  // Early pass: resolve what the gated page already references now — full
  // page or not — so these small reads go out before U1 and the global
  // snapshots instead of queuing behind them on a slow socket.
  checkReferences(run);

  // Small reads first (U2, U3), then the bulk U1: on a slow socket the
  // teammate and branch answers then don't queue behind thousands of rows.
  const u2 = fillRead(
    run,
    async () => ({
      branches: rowsOf<Branch>(
        await client.service('branches').findAll({
          query: { created_by: run.userId, archived: false, $limit: PAGINATION.DEFAULT_LIMIT },
        })
      ),
    }),
    ({ branches }) => (branches ?? []).some((row) => row.created_by !== run.userId)
  ).then(Boolean);
  // The daemon reports the real total, so a capped read is never "all teammates".
  let teammateTotal = 0;
  const u3 = fillRead(run, async () => {
    const result = await client.service('branches').find({
      query: { teammate: true, archived: false, $limit: PAGINATION.MAX_TEAMMATE_BRANCHES },
    });
    const branches = rowsOf<Branch>(result);
    const total = (result as { total?: unknown }).total;
    teammateTotal = typeof total === 'number' ? total : branches.length;
    return { branches };
  }).then(async (rows) => {
    if (!rows) return false;
    // U3's rows can't be checked against its filter (the server's teammate
    // set is a superset of the client's), but a daemon that ignores
    // `teammate` also ignores U2's `created_by`: trust U3 only once U2 proved
    // the keys are honoured.
    const keysHonoured = await u2.catch(() => false);
    if (!keysHonoured || run.degraded || !isCurrent(run)) return false;
    setScope(run, {
      teammatesLoaded: true,
      teammatesTruncated: teammateTotal > (rows.branches?.length ?? 0),
    });
    return true;
  });

  const u1 = options.gatedMineComplete
    ? Promise.resolve(true)
    : fillRead(
        run,
        async () => {
          // Await only a real barrier: even `await undefined` would send U1 a
          // microtask late, behind the global snapshots started right after.
          if (options.deferBulkRead) {
            await options.deferBulkRead;
            if (!isCurrent(run)) return {};
          }
          return {
            sessions: rowsOf<Session>(
              await client
                .service('sessions')
                .find({ query: mySessionsQuery(run.userId, MY_SESSIONS_FULL_LIMIT) })
            ),
          };
        },
        ({ sessions }) =>
          (sessions ?? []).some((row) => row.created_by !== run.userId || row.archived)
      ).then((rows) => {
        // Recheck after the await (see `readBranchChunk`).
        if (!rows || !isCurrent(run)) return false;
        setScope(run, {
          mySessionsLoaded: true,
          mySessionsTruncated: (rows.sessions?.length ?? 0) >= MY_SESSIONS_FULL_LIMIT,
        });
        return true;
      });

  const settled = await Promise.allSettled([u1, u2, u3]);
  if (!isCurrent(run)) return;
  for (const result of settled) {
    if (result.status === 'fulfilled') continue;
    if (result.reason instanceof UnsupportedScopeReadError) enterDegraded(run, result.reason);
    else console.warn('[userScope] read failed:', result.reason);
  }
  if (settled.some((result) => result.status === 'rejected' || !result.value)) {
    // A flag this run could not set may still be completed by the global
    // snapshots (Steps 1–2).
    run.compat = true;
    applyGlobalCompatibility(run);
  }
  if (run.degraded) return;
  // Every reference is known once all of my sessions and my branches are in;
  // teammates (U3) only shrink the id list, so they needn't succeed.
  const ok = (index: number) => settled[index].status === 'fulfilled' && settled[index].value;
  if (ok(0) && ok(1)) run.referencesKnown = true;
  // Immediate catch-up scan (not debounced), even when U1 or U2 failed: the
  // references a read that did land added are queued now. Resolve only once
  // those follow-up id reads settle, so a caller holding the global snapshots
  // for the scope doesn't release them before the U1-only references are on
  // the wire. Completeness (`homeBranchesLoaded`) still needs referencesKnown.
  checkReferences(run);
  await idReadsDrained(run);
}
