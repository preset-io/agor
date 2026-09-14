import type { AgorClient } from '@agor-live/client';
import { useLayoutEffect, useMemo, useRef } from 'react';
import { useOptionalConnectionState } from '@/contexts/ConnectionContext';

interface AuthorityEpoch {
  parts: readonly unknown[] | null;
  valid: boolean;
  invalidationListeners: Set<() => void>;
}

export interface AuthorityOperation {
  /** False as soon as the caller/client/authority scope changes or unmounts. */
  isCurrent: () => boolean;
  /** Subscribe to synchronous scope invalidation without coupling to mount cleanup. */
  onInvalidate: (listener: () => void) => () => void;
  /** Explicitly end a one-shot operation before its authority epoch ends. */
  cancel: () => void;
}

export interface AuthorityOperationGuard {
  /** Capture the authority epoch that exists at the start of an async action. */
  begin: () => AuthorityOperation;
  /** Whether this rendered authority epoch may start an action at all. */
  isCurrent: () => boolean;
}

export interface AuthenticatedAuthorityScope {
  /** Identity-stable key for erasing caller-private drafts only on identity/role change. */
  identityKey: string | null;
  /** Ready, generation-bound scope for async operations. Null fails closed. */
  operationScope: readonly unknown[] | null;
  connectionReady: boolean;
  authGeneration: number;
}

/**
 * Split caller identity lifecycle from socket authority lifecycle.
 *
 * Components erase drafts on `identityKey`, while guards consume
 * `operationScope`; a same-user reconnect therefore preserves input but
 * synchronously invalidates every older continuation. Independently mounted
 * leaf surfaces have no ConnectionProvider, so their supplied identity is the
 * explicit readiness contract and generation zero is used.
 */
export function useAuthenticatedAuthorityScope(
  client: AgorClient | null,
  identityKey: string | null
): AuthenticatedAuthorityScope {
  const connection = useOptionalConnectionState();
  const connectionReady = connection
    ? connection.connected && !connection.connecting
    : identityKey !== null;
  const authGeneration = connection?.authGeneration ?? 0;
  const operationScope = useMemo(
    () =>
      identityKey && connectionReady ? ([identityKey, client, authGeneration] as const) : null,
    [authGeneration, client, connectionReady, identityKey]
  );
  return { identityKey, operationScope, connectionReady, authGeneration };
}

function sameScope(left: readonly unknown[] | null, right: readonly unknown[] | null): boolean {
  if (left === null || right === null) return left === right;
  return left.length === right.length && left.every((part, index) => Object.is(part, right[index]));
}

function invalidateEpoch(epoch: AuthorityEpoch): void {
  if (!epoch.valid && epoch.invalidationListeners.size === 0) return;
  epoch.valid = false;
  const listeners = [...epoch.invalidationListeners];
  epoch.invalidationListeners.clear();
  for (const listener of listeners) listener();
}

/**
 * Synchronous authority fence for caller-private async UI work.
 *
 * Passive-effect cleanup is too late for a keyed A -> B replacement: an old
 * promise continuation can run after B commits but before `useEffect` cleanup.
 * This hook invalidates during render when any scope part changes, and again in
 * layout cleanup when a keyed owner is replaced or unmounted. State may remain
 * mounted across a same-user reconnect, while operations tied to the old auth
 * generation/client are still cancelled.
 */
export function useAuthorityOperationGuard(
  scopeParts: readonly unknown[] | null
): AuthorityOperationGuard {
  const epochRef = useRef<AuthorityEpoch | null>(null);
  let epoch = epochRef.current;
  if (!epoch || !sameScope(epoch.parts, scopeParts)) {
    if (epoch) invalidateEpoch(epoch);
    epoch = {
      parts: scopeParts === null ? null : [...scopeParts],
      valid: scopeParts !== null,
      invalidationListeners: new Set(),
    };
    epochRef.current = epoch;
  }

  useLayoutEffect(() => {
    // React StrictMode deliberately replays layout-effect setup/cleanup on
    // mount. Re-establish only this still-current epoch during setup so that
    // replay does not leave every action disabled; a replaced epoch can never
    // be revived because it no longer equals epochRef.current.
    if (epochRef.current === epoch && epoch.parts !== null) epoch.valid = true;
    return () => {
      invalidateEpoch(epoch);
    };
  }, [epoch]);

  return useMemo(
    () => ({
      begin: () => {
        const captured = epochRef.current;
        let active = true;
        const operationListeners = new Set<() => void>();
        const notifyOperationInvalidated = () => {
          const listeners = [...operationListeners];
          operationListeners.clear();
          // Scope replacement can happen during render. Promise resolution is
          // safe there, but arbitrary subscribers must not synchronously set
          // React state, so deliver on the immediately following microtask.
          for (const listener of listeners) queueMicrotask(listener);
        };
        const epochListener = () => {
          active = false;
          notifyOperationInvalidated();
        };
        return {
          isCurrent: () =>
            active && !!captured?.valid && captured.parts !== null && epochRef.current === captured,
          onInvalidate: (listener: () => void) => {
            let subscribed = true;
            const guardedListener = () => {
              if (subscribed) listener();
            };
            operationListeners.add(guardedListener);
            if (captured && active && captured.valid && epochRef.current === captured) {
              captured.invalidationListeners.add(epochListener);
            } else {
              active = false;
              notifyOperationInvalidated();
            }
            return () => {
              subscribed = false;
              operationListeners.delete(guardedListener);
              if (operationListeners.size === 0) {
                captured?.invalidationListeners.delete(epochListener);
              }
            };
          },
          cancel: () => {
            if (!active) return;
            active = false;
            captured?.invalidationListeners.delete(epochListener);
            notifyOperationInvalidated();
          },
        };
      },
      isCurrent: () => epoch.valid && epoch.parts !== null && epochRef.current === epoch,
    }),
    [epoch]
  );
}
