import {
  type AgorClient,
  type ReactiveSessionHandle,
  type ReactiveSessionOptions,
  type ReactiveSessionState,
  releaseReactiveSession,
  retainReactiveSession,
} from '@agor-live/client';
import { useEffect, useState } from 'react';

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

  return { handle, state };
}
