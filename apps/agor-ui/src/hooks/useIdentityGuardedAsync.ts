import type { DependencyList } from 'react';
import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';

export interface IdentityGuardedAsync {
  /**
   * Tag async work with the identity live at call time AND supersede any earlier
   * in-flight `run`. The returned promise resolves/rejects exactly as `work`
   * does only WHILE this call still owns the latest run and its identity is
   * unchanged; if the identity swaps, the component unmounts, or a newer `run`
   * starts before `work` settles, the returned promise stays pending forever so
   * the awaiting continuation never runs — the newest work owns the resulting
   * state instead. Each call captures its own generation and sequence, so an
   * older call is dropped even after a newer one starts, under a changed OR an
   * unchanged identity (newest-wins, no shared-state false positives).
   */
  run: <T>(work: () => Promise<T>) => Promise<T>;
  /**
   * Whether the identity is still the one live at the most recent `run` call.
   * Intended for inline guards inside a loop where at most one operation is in
   * flight (e.g. a self-scheduling poll); for concurrent one-shot calls, rely on
   * `run`'s per-call guard instead. Returns `false` until the first `run` — call
   * it only from work that a `run` has already gated (e.g. a poll armed by it),
   * never as a standalone readiness check.
   */
  isCurrent: () => boolean;
}

/**
 * Invalidate in-flight async work when the identity it was issued against
 * changes (or the component unmounts), and let a newer request supersede an
 * older one. Several Codex-auth panes talk to a per-identity service — the
 * connected client, or a device-auth service bound to it — and must not let a
 * request issued against one identity (or an older overlapping request) land its
 * state updates over the current one, nor call setState after teardown.
 *
 * The identity-generation bump is a LAYOUT effect: it runs synchronously during
 * the commit, before a settled request's continuation (a passive cleanup can be
 * deferred past unmount, letting a stale success commit after teardown). Pass
 * the identity as a dependency list; `onIdentityChange` fires on every change
 * (and on mount) for any synchronous per-site reset the guard doesn't own.
 */
export function useIdentityGuardedAsync(
  identity: DependencyList,
  onIdentityChange?: () => void
): IdentityGuardedAsync {
  // Bumped on identity change + unmount; a call is invalid once it differs.
  const identityGenRef = useRef(0);
  // Bumped on every run(); only the latest sequence still owns the result.
  const opSeqRef = useRef(0);
  // Identity generation live at the most recent run() (for isCurrent()).
  const lastRunIdentityRef = useRef(0);
  const onIdentityChangeRef = useRef(onIdentityChange);
  onIdentityChangeRef.current = onIdentityChange;

  useLayoutEffect(
    () => {
      identityGenRef.current += 1;
      onIdentityChangeRef.current?.();
      return () => {
        identityGenRef.current += 1;
      };
    },
    // biome-ignore lint/correctness/useExhaustiveDependencies: caller-owned identity dependency list; the body invalidates rather than reading it.
    identity
  );

  const run = useCallback(<T>(work: () => Promise<T>): Promise<T> => {
    const myIdentity = identityGenRef.current;
    opSeqRef.current += 1;
    const mySeq = opSeqRef.current;
    lastRunIdentityRef.current = myIdentity;
    const stillOwns = () => identityGenRef.current === myIdentity && opSeqRef.current === mySeq;
    return new Promise<T>((resolve, reject) => {
      work().then(
        (value) => {
          if (stillOwns()) resolve(value);
        },
        (error) => {
          if (stillOwns()) reject(error);
        }
      );
    });
  }, []);

  const isCurrent = useCallback(() => identityGenRef.current === lastRunIdentityRef.current, []);

  return useMemo(() => ({ run, isCurrent }), [run, isCurrent]);
}
