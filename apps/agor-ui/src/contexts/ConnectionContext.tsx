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
  return !useMutationGate().canMutate;
}

/**
 * Hook to get full connection state
 */
export function useConnectionState(): ConnectionContextValue {
  return useContext(ConnectionContext);
}

/**
 * Why a mutation is currently blocked. Extend this union as we add new
 * gates (e.g. RBAC, env-not-running, read-only viewer).
 */
export type MutationBlockReason = 'disconnected' | 'reconnecting' | 'out-of-sync';

export interface MutationGate {
  canMutate: boolean;
  reason: MutationBlockReason | null;
  message: string | null;
}

/**
 * Single source of truth for "should this mutation site be disabled?"
 *
 * Returns a structured reason so UI can show a meaningful tooltip / toast
 * instead of just `disabled=true`. The boolean shortcut is
 * `useConnectionDisabled()`, which now delegates here.
 */
export function useMutationGate(): MutationGate {
  const { connected, connecting, outOfSync } = useContext(ConnectionContext);

  if (outOfSync) {
    return {
      canMutate: false,
      reason: 'out-of-sync',
      message: 'Daemon was upgraded — refresh the page to continue.',
    };
  }
  // `connecting` is set immediately on socket drop, while `connected` stays
  // true for a ~1.5s grace window in useAgorClient before flipping. We must
  // close the gate as soon as `connecting` is true, otherwise mutations slip
  // through during the grace window.
  if (connecting) {
    return {
      canMutate: false,
      reason: 'reconnecting',
      message: 'Reconnecting to daemon…',
    };
  }
  if (!connected) {
    return {
      canMutate: false,
      reason: 'disconnected',
      message: 'Disconnected from daemon. Action unavailable.',
    };
  }
  return { canMutate: true, reason: null, message: null };
}
