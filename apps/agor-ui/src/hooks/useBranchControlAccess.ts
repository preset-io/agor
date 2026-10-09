import type { AgorClient, Branch, User } from '@agor-live/client';
import { hasMinimumRole, ROLES } from '@agor-live/client';
import { useEffect, useState } from 'react';
import { useConnectionState } from '../contexts/ConnectionContext';
import { readBranchAccess } from '../utils/branchAccess';

/** `unknown` means the lookup failed, so callers must not claim the viewer lacks access. */
export type BranchControlAccess = 'allowed' | 'denied' | 'loading' | 'unknown';

/**
 * Mirrors the server's branch-control rule (`ensureCanControlBranchEnvironment`):
 * administrators, the branch owner, or effective `all` on the branch. Reads only while `enabled`.
 */
export function useBranchControlAccess(
  client: AgorClient | null,
  branch: Pick<Branch, 'branch_id'>,
  user: Pick<User, 'user_id' | 'role'> | null | undefined,
  enabled: boolean
): BranchControlAccess {
  const { authGeneration } = useConnectionState();
  const isAdmin = hasMinimumRole(user?.role, ROLES.ADMIN);
  const branchId = branch.branch_id;
  const userId = user?.user_id;
  const scopeKey = `${branchId}:${userId ?? ''}:${authGeneration}`;
  const [result, setResult] = useState<{ scopeKey: string; access: BranchControlAccess } | null>(
    null
  );

  useEffect(() => {
    if (!enabled || isAdmin || !client || !userId) return;
    let cancelled = false;
    void readBranchAccess(client, branchId)
      .then((access) => {
        if (!cancelled)
          setResult({
            scopeKey,
            access: access.is_owner || access.can === 'all' ? 'allowed' : 'denied',
          });
      })
      .catch(() => {
        if (!cancelled) setResult({ scopeKey, access: 'unknown' });
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, isAdmin, client, userId, branchId, scopeKey]);

  if (isAdmin) return 'allowed';
  if (!client || !userId) return 'unknown';
  return result?.scopeKey === scopeKey ? result.access : 'loading';
}
