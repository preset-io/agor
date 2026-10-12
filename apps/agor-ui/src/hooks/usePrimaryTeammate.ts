import type { AgorClient, Branch } from '@agor-live/client';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

interface PrimaryTeammate {
  branch: Branch | null;
  /** Whether `branch` was resolved or picked for this client and caller; a `refreshKey` re-resolve keeps it true. */
  ownedByCaller: boolean;
  setBranch: (branch: Branch | null) => void;
  resolving: boolean;
  failed: boolean;
  /** Re-resolves now; `undefined` means a newer resolve or an identity change superseded this one. */
  refresh: () => Promise<Branch | null | undefined>;
}

/** The caller's primary teammate branch, re-resolved when the client, caller identity or `refreshKey` changes. */
export function usePrimaryTeammate(
  client: AgorClient | null,
  userId: string | undefined,
  authenticationGeneration: number,
  refreshKey?: unknown
): PrimaryTeammate {
  const [branch, setResolvedBranch] = useState<Branch | null>(null);
  const [branchCaller, setBranchCaller] = useState<readonly unknown[] | null>(null);
  const [resolving, setResolving] = useState(false);
  const [failed, setFailed] = useState(false);
  const requestRef = useRef(0);
  // Invalidate during render, as useIdentityGuardedAsync does: a response landing right after an identity change commits must not be accepted.
  const identity = [client, userId, authenticationGeneration, refreshKey];
  const renderedIdentityRef = useRef(identity);
  const caller = [client, userId, authenticationGeneration] as const;
  const callerRef = useRef(caller);
  callerRef.current = caller;
  if (renderedIdentityRef.current.some((value, index) => !Object.is(value, identity[index]))) {
    requestRef.current += 1;
    renderedIdentityRef.current = identity;
  }

  // Unmount supersedes any in-flight resolve, so a late answer neither commits nor is handed back to a caller's `refresh`.
  useLayoutEffect(
    () => () => {
      requestRef.current += 1;
    },
    []
  );

  // An explicit choice supersedes whatever the last resolve reported, including one still in flight.
  const setBranch = useCallback((next: Branch | null) => {
    requestRef.current += 1;
    setResolvedBranch(next);
    setBranchCaller(callerRef.current);
    setResolving(false);
    setFailed(false);
  }, []);

  const refresh = useCallback(async () => {
    // A refresh captured before a client swap is superseded; it must not tag the old client's answer as the new caller's.
    if (callerRef.current[0] !== client) return undefined;
    if (!client) {
      // A resolve abandoned when the client went away never reaches its `finally`.
      setResolving(false);
      return null;
    }
    requestRef.current += 1;
    const request = requestRef.current;
    const requestCaller = callerRef.current;
    setResolving(true);
    setFailed(false);
    try {
      const next = await client.service('users').getPrimaryTeammate();
      if (requestRef.current !== request) return undefined;
      setResolvedBranch(next);
      setBranchCaller(requestCaller);
      return next;
    } catch {
      if (requestRef.current !== request) return undefined;
      setFailed(true);
      return null;
    } finally {
      if (requestRef.current === request) setResolving(false);
    }
  }, [client]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: caller identity and refreshKey deliberately invalidate the caller-scoped preference
  useEffect(() => {
    void refresh();
  }, [refresh, userId, authenticationGeneration, refreshKey]);

  const ownedByCaller =
    !!branchCaller && branchCaller.every((value, index) => Object.is(value, caller[index]));
  return { branch, ownedByCaller, setBranch, resolving, failed, refresh };
}
