import { createContext, useContext } from 'react';

/**
 * ConnectionContext - Global connection state for disabling UI during disconnections
 *
 * Prevents queued actions from flooding the daemon when reconnecting.
 *
 * `outOfSync` is set by useServerVersion when the daemon's build SHA changes
 * mid-session (e.g. after a deploy). It supersedes connected/disconnected in
 * the ConnectionStatus tag — the user is asked to refresh, period.
 */
interface ConnectionContextValue {
  connected: boolean;
  connecting: boolean;
  outOfSync: boolean;
}

const ConnectionContext = createContext<ConnectionContextValue>({
  connected: false,
  connecting: false,
  outOfSync: false,
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
