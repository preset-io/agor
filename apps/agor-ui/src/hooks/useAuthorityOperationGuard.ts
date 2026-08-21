import { useLayoutEffect, useMemo, useRef } from 'react';

interface AuthorityEpoch {
  parts: readonly unknown[] | null;
  valid: boolean;
}

export interface AuthorityOperation {
  /** False as soon as the caller/client/authority scope changes or unmounts. */
  isCurrent: () => boolean;
  /** Explicitly end a one-shot operation before its authority epoch ends. */
  cancel: () => void;
}

export interface AuthorityOperationGuard {
  /** Capture the authority epoch that exists at the start of an async action. */
  begin: () => AuthorityOperation;
  /** Whether this rendered authority epoch may start an action at all. */
  isCurrent: () => boolean;
}

function sameScope(left: readonly unknown[] | null, right: readonly unknown[] | null): boolean {
  if (left === null || right === null) return left === right;
  return left.length === right.length && left.every((part, index) => Object.is(part, right[index]));
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
    if (epoch) epoch.valid = false;
    epoch = {
      parts: scopeParts === null ? null : [...scopeParts],
      valid: scopeParts !== null,
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
      epoch.valid = false;
    };
  }, [epoch]);

  return useMemo(
    () => ({
      begin: () => {
        const captured = epochRef.current;
        let active = true;
        return {
          isCurrent: () =>
            active && !!captured?.valid && captured.parts !== null && epochRef.current === captured,
          cancel: () => {
            active = false;
          },
        };
      },
      isCurrent: () => epoch.valid && epoch.parts !== null && epochRef.current === epoch,
    }),
    [epoch]
  );
}
