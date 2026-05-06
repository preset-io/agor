import {
  type AgorClient,
  type ReactiveSessionHandle,
  type ReactiveSessionOptions,
  type ReactiveSessionState,
  releaseReactiveSession,
  retainReactiveSession,
} from '@agor-live/client';
import { useEffect, useState } from 'react';
import { TOKENS_REFRESHED_EVENT } from '../utils/singleFlightRefresh';

interface UseSharedReactiveSessionOptions {
  enabled?: boolean;
  reactiveOptions?: ReactiveSessionOptions;
}

interface UseSharedReactiveSessionResult {
  handle: ReactiveSessionHandle | null;
  state: ReactiveSessionState | null;
}

export function useSharedReactiveSession(
  client: AgorClient | null,
  sessionId: string | null | undefined,
  options: UseSharedReactiveSessionOptions = {}
): UseSharedReactiveSessionResult {
  const { enabled = true, reactiveOptions } = options;
  const taskHydration = reactiveOptions?.taskHydration ?? 'lazy';
  const [handle, setHandle] = useState<ReactiveSessionHandle | null>(null);
  const [state, setState] = useState<ReactiveSessionState | null>(null);

  useEffect(() => {
    if (!client || !sessionId || !enabled) {
      setHandle(null);
      setState(null);
      return;
    }

    const sharedHandle = retainReactiveSession(client, sessionId, { taskHydration });
    setHandle(sharedHandle);
    let disposed = false;

    const sync = () => {
      if (!disposed) {
        setState(sharedHandle.state);
      }
    };

    sync();
    const unsubscribe = sharedHandle.subscribe(sync);
    sharedHandle.ready().then(sync).catch(sync);

    return () => {
      disposed = true;
      unsubscribe();
      releaseReactiveSession(client, sessionId, { taskHydration });
    };
  }, [client, sessionId, enabled, taskHydration]);

  // Re-trigger resync() when an external signal suggests our error state may
  // be stale. The reactive session itself only resyncs on socket `connect`
  // events — but auth-recovery happens on other channels too:
  //
  // - The proactive token-refresh timer in useAuth fires `TOKENS_REFRESHED_EVENT`
  //   after a successful refresh that the panel didn't trigger.
  // - When a tab regains focus after a long background, useAuth's
  //   visibilitychange handler may have refreshed tokens silently.
  //
  // Without these listeners, a transient 401 surfaced during a previous
  // `resync()` (e.g. socket reconnected before the access-token refresh
  // landed) leaves the panel stuck on a "jwt expired" banner indefinitely.
  //
  // We retry while `state.error` is set but skip `state.terminal` errors —
  // session-removed and similar non-recoverable conditions. Otherwise a tab
  // returning from background after a session was deleted would refetch on
  // every focus change forever.
  //
  // No local inflight guard is needed — `ReactiveSessionHandle.resync()` is
  // single-flighted, so duplicate calls collapse onto the same promise.
  useEffect(() => {
    if (!handle) return;

    const tryResync = () => {
      const s = handle.state;
      if (!s.error || s.terminal) return;
      void handle.resync();
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') tryResync();
    };
    const onTokensRefreshed = () => {
      tryResync();
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener(TOKENS_REFRESHED_EVENT, onTokensRefreshed);

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener(TOKENS_REFRESHED_EVENT, onTokensRefreshed);
    };
  }, [handle]);

  return { handle, state };
}
