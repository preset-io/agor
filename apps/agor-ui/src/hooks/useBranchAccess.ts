import type { AgorClient, EffectiveBranchAccess, User } from '@agor-live/client';
import { useEffect, useState } from 'react';
import { useConnectionState } from '../contexts/ConnectionContext';
import { accessScope, peekAccess, readAccess } from '../utils/accessCache';
import { type BranchAccessLookup, readBranchAccess } from '../utils/branchAccess';

/** The caller's effective access to a branch through the shared access cache; reads only while `enabled`. */
export function useBranchAccess(
  client: AgorClient | null,
  branchId: string,
  user: Pick<User, 'user_id' | 'role'> | null | undefined,
  enabled: boolean
): BranchAccessLookup {
  const { authGeneration } = useConnectionState();
  const scope = accessScope(user, authGeneration);
  const userId = user?.user_id;
  const key = `branch-access:${branchId}`;
  const [result, setResult] = useState<{
    scope: string;
    key: string;
    access: EffectiveBranchAccess | 'failed';
  } | null>(null);

  useEffect(() => {
    if (!enabled || !client || !userId) return;
    const controller = new AbortController();
    readAccess<EffectiveBranchAccess>(
      client,
      scope,
      key,
      () => readBranchAccess(client, branchId),
      {
        signal: controller.signal,
      }
    ).then(
      (access) => setResult({ scope, key, access }),
      () => {
        if (!controller.signal.aborted) setResult({ scope, key, access: 'failed' });
      }
    );
    return () => controller.abort();
  }, [enabled, client, userId, scope, key, branchId]);

  if (!client || !userId) return 'failed';
  if (result?.scope === scope && result.key === key) return result.access;
  return peekAccess<EffectiveBranchAccess>(client, scope, key) ?? 'loading';
}
