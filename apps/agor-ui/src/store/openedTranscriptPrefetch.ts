/**
 * Start loading the opened session's transcript at boot, ahead of the global
 * workspace hydration.
 *
 * Every service call shares one WebSocket, so a multi-megabyte global snapshot
 * in flight delays the small transcript responses behind it (head-of-line). On
 * a `/s/<id>` open, `useAgorData` retains the SAME shared reactive-session
 * handle the session panel and ConversationView retain (identical cache key),
 * which begins subscribing and hydrating immediately, and holds the global
 * full-set hydration until that first page lands or `timeoutMs` passes.
 *
 * The prefetch keeps its reference for `adoptionGraceMs` after the page lands
 * so the panel, which mounts once the first-paint gate opens, adopts the warm
 * handle instead of bootstrapping a second one. Independently, it never holds
 * the reference longer than `maxRetentionMs` from the start, so a load that
 * never settles cannot pin the handle. `release()` drops it early (logout,
 * authority change, unmount); it is idempotent.
 *
 * Transitional: this is a localized `/s/` deferral of the global hydration
 * gate, expected to go away with that gate.
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
export const OPENED_TRANSCRIPT_MAX_RETENTION_MS =
  OPENED_TRANSCRIPT_PRIORITY_TIMEOUT_MS + OPENED_TRANSCRIPT_ADOPTION_GRACE_MS;

export interface OpenedTranscriptPrefetch {
  /**
   * Priority barrier released: the global hydration may start. Settles when
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
    maxRetentionMs = OPENED_TRANSCRIPT_MAX_RETENTION_MS,
  }: { timeoutMs?: number; adoptionGraceMs?: number; maxRetentionMs?: number } = {}
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
  let retentionTimer: ReturnType<typeof setTimeout> | undefined;
  const release = () => {
    if (released) return;
    released = true;
    clearTimeout(graceTimer);
    clearTimeout(timeoutTimer);
    clearTimeout(retentionTimer);
    releaseReactiveSession(client, sessionId, OPENED_TRANSCRIPT_REACTIVE_OPTIONS);
  };
  // Upper bound on the speculative reference, even if loading never settles.
  retentionTimer = setTimeout(release, maxRetentionMs);

  const loaded = handle.ready().catch(() => undefined);
  void loaded.then(() => {
    if (!released) graceTimer = setTimeout(release, adoptionGraceMs);
  });
  const timedOut = new Promise<void>((resolve) => {
    timeoutTimer = setTimeout(resolve, timeoutMs);
  });
  const ready = Promise.race([loaded, timedOut]).then(() => clearTimeout(timeoutTimer));
  return { ready, release };
}
