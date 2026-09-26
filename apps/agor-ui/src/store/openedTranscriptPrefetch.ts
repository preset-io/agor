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
 * handle instead of bootstrapping a second one. `release()` drops it early
 * (logout, authority change, unmount); it is idempotent.
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
  /** Settles when the first transcript page lands, fails, or times out. Never rejects. */
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
  void loaded.then(() => {
    if (!released) graceTimer = setTimeout(release, adoptionGraceMs);
  });
  const timedOut = new Promise<void>((resolve) => {
    timeoutTimer = setTimeout(resolve, timeoutMs);
  });
  const ready = Promise.race([loaded, timedOut]).then(() => clearTimeout(timeoutTimer));
  return { ready, release };
}
