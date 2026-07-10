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
 * thunk queue. Two properties fall out of the shape:
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
 *     (3). Memory is bounded to one entry per session, so a burst collapses.
 *
 *  2. Bounded flush work. At most one (the latest) payload per id is applied,
 *     composed into a SINGLE `applyMaps` pass — O(1) store notifies per frame
 *     regardless of how many patches arrived.
 *
 *  3. Hydration ordering. Each queued entry is stamped with the sessions
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
import { getLastAppliedRevision, getRevision } from './agorHydration';
import { applySessionPatchToMaps } from './agorMaps';
import { agorStore } from './agorStore';

interface PendingPatch {
  session: Session;
  // Sessions revision captured right after the synchronous bump at enqueue —
  // used by the flush to discard entries a fresher hydration already subsumed.
  revision: number;
}

// Latest queued payload per session id, and the ids removed since the last
// flush (tombstones). Both are module-global singletons: `useAgorData` mounts
// once, and tests reset via `discardRealtimeNow`.
let pending = new Map<string, PendingPatch>();
let tombstones = new Set<string>();
let handle: number | ReturnType<typeof setTimeout> | null = null;
let handleIsRaf = false;

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
  tombstones = new Set();

  if (batch.size === 0) return;

  const lastApplied = getLastAppliedRevision('sessions');
  const sessions: Session[] = [];
  for (const [id, entry] of batch) {
    if (graves.has(id)) continue; // removed synchronously this frame
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
export function enqueueSessionPatch(session: Session): void {
  pending.set(session.session_id, { session, revision: getRevision('sessions') });
  scheduleFlush();
}

/**
 * Tombstone a session id on synchronous `session:removed`: drop any queued patch
 * for it and mark it so a same-frame queued patch can't resurrect it at flush.
 * Schedules a flush so the tombstone is cleared even if no patch is queued.
 */
export function tombstoneSession(sessionId: string): void {
  pending.delete(sessionId);
  tombstones.add(sessionId);
  scheduleFlush();
}

/**
 * Clear a session id's tombstone on synchronous `session:created` so a genuine
 * remove-then-recreate within one frame lets subsequent patches apply.
 */
export function untombstoneSession(sessionId: string): void {
  tombstones.delete(sessionId);
}

/**
 * Apply any queued patches immediately. Call on teardown so the last streamed
 * update isn't dropped when the subscription effect re-runs or unmounts.
 */
export function flushRealtimeNow(): void {
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
  tombstones = new Set();
}
