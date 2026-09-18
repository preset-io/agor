/**
 * Coalesce high-frequency streaming session patches into ONE store write per
 * animation frame.
 *
 * Streaming agents emit a `session:patched` on every token batch. Applied
 * synchronously — one zustand `set()` → one React notification each — they fire
 * dozens of times per second. That is harmless once a board is mounted (each
 * notification only re-renders the one BranchCard whose bucket changed), but it
 * is catastrophic *while a board is mounting*: home→board mounts the whole
 * canvas into a live, fully-hydrated store, and every mid-mount store mutation
 * makes React re-run the in-flight render before it can settle. On a busy
 * workspace (many agents streaming across all boards) the mount never converges.
 * A raw/direct board load doesn't hit it because its first paint is board-scoped
 * and goes through the quiet first-paint gate.
 *
 * Design — a KEYED latest-payload-per-session queue with tombstones, NOT a FIFO
 * thunk queue. Four properties fall out of the shape:
 *
 *  1. Ordering safety. `session:created`/`removed` apply SYNCHRONOUSLY (see the
 *     wiring in `useAgorData`), while `patched`/`updated` defer to the next
 *     flush. The patch reducer (`applySessionPatchToMaps`) INSERTS on a missing
 *     id in both `sessionById` and `sessionsByBranch`, so a naive deferred patch
 *     flushing after a synchronous `removed` would resurrect the deleted
 *     session. Here `removed` drops that id's queued payload AND tombstones the
 *     id; the flush skips tombstoned ids; `created` clears the tombstone so a
 *     genuine remove-then-recreate within one frame still applies. Tombstones
 *     live only until the flush that clears them — a later-frame patch can't be
 *     stale against a same-frame remove, and cross-fetch staleness is handled by
 *     (4). Memory is bounded to one entry per session, so a burst collapses.
 *
 *  2. Bounded flush work. At most one (the latest) payload per id is applied,
 *     composed into a SINGLE `applyMaps` pass — O(1) store notifies per frame
 *     regardless of how many patches arrived.
 *
 *  3. Authority ordering. Each queued entry is stamped with the authenticated
 *     identity/role/auth generation that received it. Moving to another
 *     authority discards the old queue before map reset, and an old listener
 *     or passive cleanup cannot enqueue/flush after that move.
 *
 *  4. Hydration ordering. Each queued entry is stamped with the sessions
 *     revision at enqueue time. A background hydration records the revision its
 *     last quiet-window apply was proven against (`getLastAppliedRevision`); the
 *     flush DROPS any queued entry stamped at-or-below it, because the applied
 *     server snapshot already contains that patch's effect and is strictly
 *     fresher. A patch enqueued after the hydration snapshotted would have
 *     bumped the revision mid-fetch and forced that hydration to discard — so a
 *     queued patch can only be stale relative to, never ahead of, an apply.
 *
 * Scheduling. `requestAnimationFrame` pauses in background tabs. A backgrounded
 * tab would otherwise accumulate patches for minutes and burst on refocus, so
 * when the document is hidden (or rAF is unavailable — SSR/tests) the flush is
 * scheduled via `setTimeout` instead, and a `visibilitychange` re-arms a pending
 * flush onto the scheduler that matches the new visibility state.
 */
import type { Session } from '@agor-live/client';
import { bumpRevision, getLastAppliedRevision, getRevision } from './agorHydration';
import { applySessionPatchToMaps } from './agorMaps';
import { agorStore } from './agorStore';

interface PendingPatch {
  session: Session;
  // The authenticated UI authority that received this socket event. The
  // socket client is intentionally long-lived across launch-auth replacement,
  // role changes, and reconnects, so a sessions revision alone cannot prove
  // that a deferred patch still belongs to the current caller.
  authorityScope: string;
  // Sessions revision captured right after the synchronous bump at enqueue —
  // used by the flush to discard entries a fresher hydration already subsumed.
  revision: number;
}

// Latest queued payload per session id, and the ids removed since the last
// flush (tombstones). Both are module-global singletons: `useAgorData` mounts
// once, and tests reset via `discardRealtimeNow`.
let pending = new Map<string, PendingPatch>();
let tombstones = new Map<string, string>();
let handle: number | ReturnType<typeof setTimeout> | null = null;
let handleIsRaf = false;
// Set from useAgorData's layout phase before any authority-transition map
// reset. Old passive subscription cleanups therefore cannot flush caller A's
// queue after caller B has become current.
let activeAuthorityScope: string | null = null;
let authorityCancellation = new AbortController();

const CONFIRMATION_ATTEMPTS = 6;
const CONFIRMATION_BUDGET_MS = 10_000;
const CONFIRMATION_CONCURRENCY = 4;
// Shared across confirmations so overlapping archive actions cannot multiply
// GET fanout. Retain slots until transport settlement, even after cancellation:
// Feathers GETs are not abortable, and releasing early would exceed the cap.
let confirmationReads = 0;
// Set insertion order is FIFO, with O(1) removal of cancelled waiters. A release
// launches the oldest waiter synchronously, before incumbent workers can requeue.
const confirmationWaiters = new Set<() => void>();

function drainConfirmationWaiters(): void {
  while (confirmationReads < CONFIRMATION_CONCURRENCY && confirmationWaiters.size > 0) {
    const start = confirmationWaiters.values().next().value!;
    confirmationWaiters.delete(start);
    start();
  }
}

async function untilCancelled<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let cancel!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    cancel = () => reject(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
  });
  try {
    return await Promise.race([work, cancelled]);
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}

async function confirmationRead(
  id: Session['session_id'],
  refetch: (id: Session['session_id']) => Promise<Session>,
  signal: AbortSignal
): Promise<Session> {
  signal.throwIfAborted();
  return new Promise<Session>((resolve, reject) => {
    const cancel = () => {
      confirmationWaiters.delete(start);
      reject(signal.reason);
    };
    const start = () => {
      if (signal.aborted) {
        cancel();
        return;
      }
      // Reserve before calling transport, including synchronous throws/reentry.
      confirmationReads++;
      let read: Promise<Session>;
      try {
        read = refetch(id);
      } catch (error) {
        read = Promise.reject(error);
      }
      const release = () => {
        signal.removeEventListener('abort', cancel);
        confirmationReads--;
        drainConfirmationWaiters();
      };
      void read.then(
        (session) => {
          release();
          resolve(session);
        },
        (error) => {
          release();
          reject(error);
        }
      );
    };
    signal.addEventListener('abort', cancel, { once: true });
    confirmationWaiters.add(start);
    drainConfirmationWaiters();
  });
}

// Cadence for the hidden-tab / no-rAF fallback. Browsers throttle background
// timers to ~1s regardless; a short nominal interval keeps a foreground no-rAF
// environment (tests) responsive.
const HIDDEN_FLUSH_INTERVAL_MS = 250;

const raf: ((cb: () => void) => number) | null =
  typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null;
const caf: ((h: number) => void) | null =
  typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : null;

function documentHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

function cancelHandle(): void {
  if (handle == null) return;
  if (handleIsRaf && caf) caf(handle as number);
  else clearTimeout(handle as ReturnType<typeof setTimeout>);
  handle = null;
  handleIsRaf = false;
}

function scheduleFlush(): void {
  if (handle != null) return;
  if (raf && !documentHidden()) {
    handleIsRaf = true;
    handle = raf(flush);
  } else {
    handleIsRaf = false;
    handle = setTimeout(flush, HIDDEN_FLUSH_INTERVAL_MS);
  }
}

function flush(): void {
  handle = null;
  handleIsRaf = false;

  const batch = pending;
  const graves = tombstones;
  // Tombstones are cleared every flush: once the frame's queue is drained, no
  // stale patch can outlive them (a later-frame patch is not stale against a
  // same-frame remove; cross-fetch staleness is caught by the revision guard).
  pending = new Map();
  tombstones = new Map();

  const flushAuthorityScope = activeAuthorityScope;
  if (!flushAuthorityScope || batch.size === 0) return;

  const lastApplied = getLastAppliedRevision('sessions');
  const sessions: Session[] = [];
  for (const [id, entry] of batch) {
    if (entry.authorityScope !== flushAuthorityScope) continue;
    if (graves.get(id) === flushAuthorityScope) continue; // removed synchronously this frame
    if (entry.revision <= lastApplied) continue; // subsumed by a fresher hydration apply
    sessions.push(entry.session);
  }
  if (sessions.length === 0) return;

  // One store write for the whole frame: compose every surviving payload into a
  // single `applyMaps` pass (one subscriber notify) instead of N `sessionPatched`
  // calls each doing two `set()`s.
  agorStore
    .getState()
    .applyMaps((prev) => sessions.reduce((maps, s) => applySessionPatchToMaps(maps, s), prev));
}

function handleVisibilityChange(): void {
  if (handle == null) return;
  // A rAF armed while visible pauses when the tab backgrounds; a timeout armed
  // while hidden should re-align to frames when the tab foregrounds. Re-arm on
  // the scheduler that matches the new state.
  cancelHandle();
  scheduleFlush();
}

if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('visibilitychange', handleVisibilityChange);
}

/**
 * Queue a streaming `session:patched`/`updated`. Keeps only the latest payload
 * per session id and stamps it with the current sessions revision (the caller
 * bumps synchronously first, so the stamp reflects this event). Applied on the
 * next coalesced flush.
 */
export function enqueueSessionPatch(authorityScope: string, session: Session): void {
  // A listener from the previous subscription can remain attached until its
  // passive cleanup runs. Reject it synchronously once the layout phase has
  // moved the queue to a replacement authority.
  if (authorityScope !== activeAuthorityScope) return;
  pending.set(session.session_id, {
    session,
    authorityScope,
    revision: getRevision('sessions'),
  });
  scheduleFlush();
}

/**
 * Capture authority before a mutation, then reread its root + affected IDs.
 * Mutation payloads and last_updated do NOT establish write order (timestamps
 * may be captured before database locks). Only a post-response, quiet read can
 * decide between an archive and a competing restore.
 *
 * Use hydration's skip-on-race discipline, but not runHydration itself: this is
 * a partial read and must neither cancel a full backfill nor advance its global
 * high-water mark/drop unrelated queued patches. Failures propagate to the
 * caller without applying any response rows; races have a finite retry budget.
 */
export function captureSessionPatchCommit(): (
  sessions: Session[],
  refetch: (id: Session['session_id']) => Promise<Session>
) => Promise<void> {
  const authorityScope = activeAuthorityScope;
  const authoritySignal = authorityCancellation.signal;
  const isCurrent = () => authorityScope !== null && !authoritySignal.aborted;
  return async (sessions, refetch) => {
    if (!authorityScope || !isCurrent()) return;
    const cancellation = new AbortController();
    const cancelAuthority = () => cancellation.abort(authoritySignal.reason);
    authoritySignal.addEventListener('abort', cancelAuthority, { once: true });
    const timeout = setTimeout(
      () => cancellation.abort(new Error('Session confirmation budget exhausted')),
      CONFIRMATION_BUDGET_MS
    );
    const signal = cancellation.signal;
    try {
      const ids = [...new Set(sessions.map((session) => session.session_id))];
      for (let attempt = 0; attempt < CONFIRMATION_ATTEMPTS && ids.length > 0; attempt++) {
        signal.throwIfAborted();
        if (attempt >= 4) {
          let delay!: ReturnType<typeof setTimeout>;
          try {
            await untilCancelled(
              new Promise<void>((resolve) => {
                delay = setTimeout(resolve, 200 * 2 ** (attempt - 4));
              }),
              signal
            );
          } finally {
            clearTimeout(delay);
          }
        }
        const before = getRevision('sessions');
        const current = agorStore.getState().sessionById;
        const lastApplied = getLastAppliedRevision('sessions');
        const present = ids.filter((id) => {
          if (tombstones.get(id) === authorityScope) return false;
          const entry = pending.get(id);
          // Reconcile patches, not creates: removal/branch eviction stays
          // authoritative even after frame tombstones drain. Hydration-subsumed
          // queue entries cannot resurrect an absent row either.
          return (
            current.has(id) ||
            (entry?.authorityScope === authorityScope && entry.revision > lastApplied)
          );
        });
        if (present.length === 0) return;
        const fresh: Session[] = [];
        let next = 0;
        // Only a bounded number of workers/queued slot waiters per invocation.
        await Promise.all(
          Array.from({ length: Math.min(present.length, CONFIRMATION_CONCURRENCY) }, async () => {
            while (next < present.length) {
              signal.throwIfAborted();
              const id = present[next++];
              fresh.push(await confirmationRead(id, refetch, signal));
            }
          })
        );
        signal.throwIfAborted();
        // Events bump revisions before enqueue; map identity also catches a
        // wholesale hydration apply (which need not bump the live revision). Its
        // watermark can subsume a queued-only row even if the maps stay empty.
        if (
          getRevision('sessions') !== before ||
          getLastAppliedRevision('sessions') !== lastApplied ||
          agorStore.getState().sessionById !== current
        )
          continue;
        const requested = new Set(present);
        bumpRevision('sessions');
        for (const session of fresh) {
          if (requested.has(session.session_id)) enqueueSessionPatch(authorityScope, session);
        }
        flushRealtimeNow(authorityScope);
        return;
      }
      if (ids.length > 0) throw new Error('Session confirmation attempts exhausted');
    } catch (error) {
      if (isCurrent()) throw error;
    } finally {
      // Stop sibling workers on errors as well as deadline/authority changes.
      cancellation.abort();
      clearTimeout(timeout);
      authoritySignal.removeEventListener('abort', cancelAuthority);
    }
  };
}

/**
 * Tombstone a session id on synchronous `session:removed`: drop any queued patch
 * for it and mark it so a same-frame queued patch can't resurrect it at flush.
 * Schedules a flush so the tombstone is cleared even if no patch is queued.
 */
export function tombstoneSession(authorityScope: string, sessionId: string): void {
  if (authorityScope !== activeAuthorityScope) return;
  pending.delete(sessionId);
  tombstones.set(sessionId, authorityScope);
  scheduleFlush();
}

/**
 * Clear a session id's tombstone on synchronous `session:created` so a genuine
 * remove-then-recreate within one frame lets subsequent patches apply.
 */
export function untombstoneSession(authorityScope: string, sessionId: string): void {
  if (authorityScope !== activeAuthorityScope) return;
  if (tombstones.get(sessionId) === authorityScope) tombstones.delete(sessionId);
}

/**
 * Move the singleton queue to the currently authenticated authority.
 *
 * Changing authority always discards queued work. It is not safe to preserve a
 * deferred entity payload across identity, role, token-auth generation, or
 * connection transitions: caller-shaped rows and redactions may differ even
 * when the entity ID is the same. This runs in useAgorData's layout phase,
 * before its map reset and before the previous subscription's passive cleanup.
 */
export function setRealtimeAuthorityScope(authorityScope: string | null): void {
  if (activeAuthorityScope === authorityScope) return;
  authorityCancellation.abort();
  authorityCancellation = new AbortController();
  activeAuthorityScope = authorityScope;
  discardRealtimeNow();
}

/**
 * Apply any queued patches immediately for a same-authority subscription
 * teardown. A true owner unmount first activates a null scope in layout cleanup,
 * making its later passive cleanup a no-op instead of retaining private rows.
 */
export function flushRealtimeNow(authorityScope: string): void {
  // A previous effect's cleanup must not cancel or flush the replacement
  // authority's queue. Same-authority resubscriptions still preserve the last
  // streamed update, which is why this is scoped rather than always discarded.
  if (authorityScope !== activeAuthorityScope) return;
  cancelHandle();
  flush();
}

/**
 * Discard the pending queue and tombstones WITHOUT applying — the explicit
 * logout/reset path, so a queued patch can't repopulate freshly-cleared maps.
 */
export function discardRealtimeNow(): void {
  cancelHandle();
  pending = new Map();
  tombstones = new Map();
}
