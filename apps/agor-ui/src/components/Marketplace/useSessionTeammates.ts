/**
 * Caller-scoped teammates eligible for a new Catalog session.
 *
 * This intentionally uses the same API as the primary teammate picker. The
 * daemon applies active-teammate, tenant, and session-permission rules; Catalog
 * must not approximate that set from a general branch listing.
 */

import type { Branch, BranchID } from '@agor/core/types';
import { type AgorClient, isTeammate } from '@agor-live/client';
import { useEffect, useState } from 'react';

export interface SessionTeammates {
  teammates: Branch[];
  preferredTeammateId: BranchID | null;
  loading: boolean;
  error: string | null;
}

export function useSessionTeammates(
  client: AgorClient | null,
  enabled: boolean,
  identityKey: string | undefined
): SessionTeammates {
  const [teammates, setTeammates] = useState<Branch[]>([]);
  const [preferredTeammateId, setPreferredTeammateId] = useState<BranchID | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setTeammates([]);
    setPreferredTeammateId(null);
    setError(null);
    if (!client || !enabled || !identityKey) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    Promise.all([
      client.service('users').getPrimaryTeammate(),
      client.service('users').getPrimaryTeammateCandidates(),
    ])
      .then(([preferred, candidates]) => {
        if (cancelled) return;
        const eligible = candidates.filter(
          (candidate) => isTeammate(candidate) && !candidate.archived
        );
        setTeammates(eligible);
        setPreferredTeammateId(
          preferred && eligible.some((candidate) => candidate.branch_id === preferred.branch_id)
            ? preferred.branch_id
            : (eligible[0]?.branch_id ?? null)
        );
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : 'Could not load eligible teammates');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [client, enabled, identityKey]);

  return { teammates, preferredTeammateId, loading, error };
}
