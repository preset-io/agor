import {
  type AgorClient,
  type ReactiveSessionHandle,
  type ReactiveSessionOptions,
  type ReactiveSessionState,
  releaseReactiveSession,
  retainReactiveSession,
} from '@agor-live/client';
import { useEffect, useRef, useState } from 'react';
import { holdBackgroundReads } from '../store/backgroundReads';
import { TOKENS_REFRESHED_EVENT } from '../utils/singleFlightRefresh';

interface UseSharedReactiveSessionOptions {
  enabled?: boolean;
  reactiveOptions?: ReactiveSessionOptions;
  /**
   * The open session's transcript: background partition reads wait for its
   * first page (`holdBackgroundReads`), so they never queue ahead of it.
   */
  foreground?: boolean;
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
  const { enabled = true, reactiveOptions, foreground = false } = options;
  const taskHydration = reactiveOptions?.taskHydration ?? 'lean';
  const cacheScope = reactiveOptions?.cacheScope ?? 'session';
  const binding = useRef<{
    client: AgorClient;
    sessionId: string;
    taskHydration: string;
    cacheScope: string;
  } | null>(null);
  const [handle, setHandle] = useState<ReactiveSessionHandle | null>(null);
  const [state, setState] = useState<ReactiveSessionState | null>(null);

  useEffect(() => {
    if (!client || !sessionId || !enabled) {
      binding.current = null;
      setHandle(null);
      setState(null);
      return;
    }

    binding.current = { client, sessionId, taskHydration, cacheScope };
    const sharedHandle = retainReactiveSession(client, sessionId, { taskHydration, cacheScope });
    if (foreground) holdBackgroundReads(sharedHandle.ready());
    setHandle(sharedHandle);
    let disposed = false;
    let frame = 0;
    let rendered: ReactiveSessionState | null = null;

    const sync = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      if (!disposed) {
        rendered = sharedHandle.state;
        setState(rendered);
      }
    };
    // Streaming chunks notify many times a frame; render them once per frame.
    // Anything else renders now. Hidden tabs get no frames, so they sync directly.
    const scheduleSync = () => {
      const next = sharedHandle.state;
      const chunksOnly =
        !!rendered &&
        (Object.keys(next) as (keyof ReactiveSessionState)[]).every(
          (key) => key === 'streamingMessages' || next[key] === rendered?.[key]
        );
      if (!chunksOnly || document.hidden) return sync();
      frame ||= requestAnimationFrame(sync);
    };

    sync();
    const unsubscribe = sharedHandle.subscribe(scheduleSync);
    sharedHandle.ready().then(sync).catch(sync);

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      unsubscribe();
      releaseReactiveSession(client, sessionId, { taskHydration, cacheScope });
    };
  }, [client, sessionId, enabled, taskHydration, cacheScope, foreground]);

  // Re-trigger resync() when an external signal suggests our error state may
  // be stale. The reactive session itself only resyncs on socket `connect`
  // events — but auth-recovery happens on other channels too:
  //
  // - Auth recovery in useAuth fires `TOKENS_REFRESHED_EVENT` after a
  //   successful token replacement that the panel didn't trigger.
  // - When a tab regains focus after a long background, useAuth's
  //   visibilitychange handler may have refreshed tokens silently.
  //
  // Without these listeners, a transient error surfaced during a previous
  // `resync()` can leave the panel stuck on a stale banner indefinitely.
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

  // Fence identity/session replacement during render, not just passive cleanup.
  const current =
    enabled &&
    binding.current?.client === client &&
    binding.current?.sessionId === sessionId &&
    binding.current?.taskHydration === taskHydration &&
    binding.current?.cacheScope === cacheScope;
  return { handle: current ? handle : null, state: current ? state : null };
}
