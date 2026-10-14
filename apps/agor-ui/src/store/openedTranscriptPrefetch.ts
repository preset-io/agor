/**
 * Start loading the opened session's transcript at boot, ahead of the user
 * scope's bulk read.
 *
 * Every service call shares one WebSocket, so a large snapshot in flight
 * delays the small transcript responses behind it (head-of-line). On a
 * `/s/<id>` open, `useAgorData` retains the SAME shared reactive-session
 * handle the session panel and ConversationView retain (identical cache key),
 * which begins subscribing and hydrating immediately, and holds the user
 * scope's U1 read until that first page lands or `timeoutMs` passes.
 *
 * The prefetch keeps its reference for `adoptionGraceMs` after the priority
 * barrier settles — the page landed, its load failed, or `timeoutMs` passed —
 * so the panel, which mounts once the first-paint gate opens, adopts the warm
 * handle instead of bootstrapping a second one. Because the grace starts from
 * that settlement, a load that never settles still releases the handle (its
 * listeners, stream subscription and transcript state) after
 * `timeoutMs + adoptionGraceMs`. `release()` drops it early (logout,
 * authority change, unmount); it is idempotent.
 */

import {
  type AgorClient,
  type ReactiveSessionOptions,
  releaseReactiveSession,
  retainReactiveSession,
} from '@agor-live/client';

// Must match the cache key SessionPanel and ConversationView retain.
export const OPENED_TRANSCRIPT_REACTIVE_OPTIONS: ReactiveSessionOptions = {
  taskHydration: 'lean',
};

export const OPENED_TRANSCRIPT_PRIORITY_TIMEOUT_MS = 10_000;
export const OPENED_TRANSCRIPT_ADOPTION_GRACE_MS = 30_000;

export interface OpenedTranscriptPrefetch {
  /**
   * Priority barrier released: the bulk U1 read may start. Settles when
   * the first transcript page lands, when its load fails, or at the timeout —
   * so it does NOT mean the transcript loaded. Never rejects.
   */
  ready: Promise<void>;
  release: () => void;
}

export function prefetchOpenedTranscript(
  client: AgorClient,
  sessionId: string,
  {
    timeoutMs = OPENED_TRANSCRIPT_PRIORITY_TIMEOUT_MS,
    adoptionGraceMs = OPENED_TRANSCRIPT_ADOPTION_GRACE_MS,
  }: { timeoutMs?: number; adoptionGraceMs?: number } = {}
): OpenedTranscriptPrefetch {
  let handle: ReturnType<typeof retainReactiveSession>;
  try {
    handle = retainReactiveSession(client, sessionId, OPENED_TRANSCRIPT_REACTIVE_OPTIONS);
  } catch (error) {
    // A prefetch is an optimization; never let it block the workspace load.
    console.warn('[useAgorData] opened-transcript prefetch failed:', error);
    return { ready: Promise.resolve(), release: () => {} };
  }

  let released = false;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  const release = () => {
    if (released) return;
    released = true;
    clearTimeout(graceTimer);
    clearTimeout(timeoutTimer);
    releaseReactiveSession(client, sessionId, OPENED_TRANSCRIPT_REACTIVE_OPTIONS);
  };

  const loaded = handle.ready().catch(() => undefined);
  const timedOut = new Promise<void>((resolve) => {
    timeoutTimer = setTimeout(resolve, timeoutMs);
  });
  // Bounded release from the race's settlement, timeout included.
  const ready = Promise.race([loaded, timedOut]).then(() => {
    clearTimeout(timeoutTimer);
    if (!released) graceTimer = setTimeout(release, adoptionGraceMs);
  });
  return { ready, release };
}
