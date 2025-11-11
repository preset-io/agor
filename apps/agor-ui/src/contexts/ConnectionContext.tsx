import { createContext, useContext } from 'react';

/**
 * ConnectionContext - Global connection state for disabling UI during disconnections
 *
 * Prevents queued actions from flooding the daemon when reconnecting
 */
interface ConnectionContextValue {
  connected: boolean;
  connecting: boolean;
}

const ConnectionContext = createContext<ConnectionContextValue>({
  connected: false,
  connecting: false,
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
