import type { DependencyList } from 'react';
import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';

export interface IdentityGuardedAsync {
  /**
   * Tag async work with the identity live at call time. The returned promise
   * resolves/rejects exactly as `work` does WHILE the identity is unchanged; if
   * the identity swaps (or the component unmounts) before `work` settles, the
   * returned promise stays pending forever so the awaiting continuation never
   * runs — the new identity's own work owns the resulting state instead. Each
   * call captures its own generation, so an older in-flight call is dropped even
   * after a newer call has started (no shared-generation false positives).
   */
  run: <T>(work: () => Promise<T>) => Promise<T>;
  /**
   * Whether the identity is still the one live at the most recent `run` call.
   * Intended for inline guards inside a loop where at most one operation is in
   * flight (e.g. a self-scheduling poll); for concurrent one-shot calls, rely on
   * `run`'s per-call guard instead.
   */
  isCurrent: () => boolean;
}

/**
 * Invalidate in-flight async work when the identity it was issued against
 * changes (or the component unmounts). Several Codex-auth panes talk to a
 * per-identity service — the connected client, or a device-auth service bound to
 * it — and must not let a request issued against one identity land its state
 * updates over its replacement, nor call setState after teardown.
 *
 * The generation bump is a LAYOUT effect: it runs synchronously during the
 * commit, before a settled request's continuation (a passive cleanup can be
 * deferred past unmount, letting a stale success commit after teardown). Pass
 * the identity as a dependency list; `onIdentityChange` fires on every change
 * (and on mount) for any synchronous per-site reset the guard doesn't own.
 */
export function useIdentityGuardedAsync(
  identity: DependencyList,
  onIdentityChange?: () => void
): IdentityGuardedAsync {
  const genRef = useRef(0);
  const runGenRef = useRef(0);
  const onIdentityChangeRef = useRef(onIdentityChange);
  onIdentityChangeRef.current = onIdentityChange;

  useLayoutEffect(
    () => {
      genRef.current += 1;
      onIdentityChangeRef.current?.();
      return () => {
        genRef.current += 1;
      };
    },
    // biome-ignore lint/correctness/useExhaustiveDependencies: caller-owned identity dependency list; the body invalidates rather than reading it.
    identity
  );

  const run = useCallback(<T>(work: () => Promise<T>): Promise<T> => {
    const gen = genRef.current;
    runGenRef.current = gen;
    return new Promise<T>((resolve, reject) => {
      work().then(
        (value) => {
          if (genRef.current === gen) resolve(value);
        },
        (error) => {
          if (genRef.current === gen) reject(error);
        }
      );
    });
  }, []);

  const isCurrent = useCallback(() => genRef.current === runGenRef.current, []);

  return useMemo(() => ({ run, isCurrent }), [run, isCurrent]);
}
