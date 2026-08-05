/**
 * Branches a connect can land in.
 *
 * The marketplace is its own surface and never starts the workspace store, so
 * it reads the branch list directly rather than through the store's normalized
 * maps. It is also lazy: browsing the catalog costs nothing until a drawer
 * opens and a destination is actually needed.
 */

import type { Branch } from '@agor/core/types';
import type { AgorClient, FindResult } from '@agor-live/client';
import { useEffect, useState } from 'react';

const BRANCH_LIMIT = 200;
const LAST_BRANCH_KEY = 'agor-marketplace-branch';

export interface ConnectTargets {
  branches: Branch[];
  loading: boolean;
  error: string | null;
}

function toArray(result: FindResult<Branch>): Branch[] {
  return Array.isArray(result) ? result : result.data;
}

export function useConnectTargets(client: AgorClient, enabled: boolean): ConnectTargets {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!enabled || loaded) return;
    let cancelled = false;
    setLoading(true);

    client
      .service('branches')
      .find({ query: { archived: false, $limit: BRANCH_LIMIT } })
      .then((result) => {
        if (cancelled) return;
        setBranches(toArray(result));
        setError(null);
        setLoaded(true);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Could not load your branches');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [client, enabled, loaded]);

  return { branches, loading, error };
}

/** The branch the user last connected into, so the picker is usually pre-answered. */
export function getLastConnectBranchId(): string | null {
  try {
    return localStorage.getItem(LAST_BRANCH_KEY);
  } catch {
    return null;
  }
}

export function rememberConnectBranchId(branchId: string): void {
  try {
    localStorage.setItem(LAST_BRANCH_KEY, branchId);
  } catch {
    // localStorage full or unavailable
  }
}
