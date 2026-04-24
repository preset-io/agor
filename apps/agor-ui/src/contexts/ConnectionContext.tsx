import { createContext, useContext } from 'react';

/**
 * ConnectionContext - Global connection state for disabling UI during disconnections
 *
 * Prevents queued actions from flooding the daemon when reconnecting.
 *
 * `outOfSync`, `capturedSha`, and `currentSha` are populated by
 * useServerVersion in App.tsx and shared with any consumer that needs the
 * version-drift signal — the ConnectionStatus tag (banner) and the AboutTab
 * (debug rows). Provider-side ownership ensures every consumer sees the same
 * captured baseline; mounting useServerVersion in two places would give each
 * its own independent (and usually empty) capture.
 */
interface ConnectionContextValue {
  connected: boolean;
  connecting: boolean;
  outOfSync: boolean;
  capturedSha: string | null;
  currentSha: string | null;
}

const ConnectionContext = createContext<ConnectionContextValue>({
  connected: false,
  connecting: false,
  outOfSync: false,
  capturedSha: null,
  currentSha: null,
});

export const ConnectionProvider = ConnectionContext.Provider;

/**
 * Hook to check if UI should be disabled due to disconnection
 *
 * Usage:
 * ```tsx
 * const disabled = useConnectionDisabled();
 * <Button disabled={disabled} onClick={...}>Submit</Button>
 * ```
 */
export function useConnectionDisabled(): boolean {
  const { connected } = useContext(ConnectionContext);
  return !connected;
}

/**
 * Hook to get full connection state
 */
export function useConnectionState(): ConnectionContextValue {
  return useContext(ConnectionContext);
}
