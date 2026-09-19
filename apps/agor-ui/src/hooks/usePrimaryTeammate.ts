import type { AgorClient, Branch } from '@agor-live/client';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

interface PrimaryTeammate {
  branch: Branch | null;
  /** False from the render an identity change or a new resolve begins until its answer (or an explicit pick) lands, and after a failure. */
  current: boolean;
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
  const [branchRequest, setBranchRequest] = useState(0);
  const [resolving, setResolving] = useState(false);
  const [failed, setFailed] = useState(false);
  const requestRef = useRef(0);
  // Invalidate during render, as useIdentityGuardedAsync does: a response landing right after an identity change commits must not be accepted.
  const identity = [client, userId, authenticationGeneration, refreshKey];
  const renderedIdentityRef = useRef(identity);
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
    setBranchRequest(requestRef.current);
    setResolving(false);
    setFailed(false);
  }, []);

  const refresh = useCallback(async () => {
    if (!client) return null;
    requestRef.current += 1;
    const request = requestRef.current;
    setResolving(true);
    setFailed(false);
    try {
      const next = await client.service('users').getPrimaryTeammate();
      if (requestRef.current !== request) return undefined;
      setResolvedBranch(next);
      setBranchRequest(request);
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

  const current = branchRequest === requestRef.current;
  return { branch, current, setBranch, resolving, failed, refresh };
}
