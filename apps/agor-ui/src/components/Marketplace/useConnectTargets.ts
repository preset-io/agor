/**
 * Branches a connect can land in.
 *
 * The marketplace is its own surface and never starts the workspace store, so
 * it reads the branch list directly rather than through the store's normalized
 * maps. It is also lazy: browsing the catalog costs nothing until a drawer
 * opens and a destination is actually needed.
 */

import type { Branch } from '@agor/core/types';
import type { AgorClient } from '@agor-live/client';
import { useEffect, useState } from 'react';

const LAST_BRANCH_KEY = 'agor-marketplace-branch';

function branchPreferenceKey(userId: string | undefined): string | null {
  return userId ? `${LAST_BRANCH_KEY}:${userId}` : null;
}

export interface ConnectTargets {
  branches: Branch[];
  loading: boolean;
  error: string | null;
}

export function useConnectTargets(client: AgorClient | null, enabled: boolean): ConnectTargets {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!client || !enabled || loaded) return;
    let cancelled = false;
    setLoading(true);

    // Every accessible branch, not a first page. A branch missing from this
    // list is a destination the user simply cannot pick, with nothing on screen
    // to say why — so a silent cap here reads as "you have no such branch".
    client
      .service('branches')
      .findAll({ query: { archived: false } })
      .then((result) => {
        if (cancelled) return;
        setBranches(result);
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

/** The branch this user last connected into, so the picker is usually pre-answered. */
export function getLastConnectBranchId(userId: string | undefined): string | null {
  const key = branchPreferenceKey(userId);
  if (!key) return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function rememberConnectBranchId(userId: string | undefined, branchId: string): void {
  const key = branchPreferenceKey(userId);
  if (!key) return;
  try {
    localStorage.setItem(key, branchId);
  } catch {
    // localStorage full or unavailable
  }
}
