import type { AgorClient, Branch, EffectiveBranchAccess, User } from '@agor-live/client';
import { useEffect, useState } from 'react';
import { useConnectionState } from '../contexts/ConnectionContext';
import { accessScope, peekAccess, readAccess } from '../utils/accessCache';
import { type BranchAccessLookup, readBranchAccess } from '../utils/branchAccess';

/** The caller's effective access to a branch through the shared access cache; reads only while `enabled`. */
export function useBranchAccess(
  client: AgorClient | null,
  branch: Pick<
    Branch,
    'branch_id' | 'filesystem_status' | 'deletion_status' | 'error_message' | 'workspace_operation'
  >,
  user: Pick<User, 'user_id' | 'role'> | null | undefined,
  enabled: boolean
): BranchAccessLookup {
  const { authGeneration } = useConnectionState();
  const scope = accessScope(user, authGeneration);
  const userId = user?.user_id;
  const branchId = branch.branch_id;
  const key = `branch-access:${branchId}`;
  // A new failure or operation re-reads (through the cache TTL) instead of keeping the mount-time answer.
  const revision = [
    branch.filesystem_status,
    branch.deletion_status,
    branch.error_message,
    branch.workspace_operation?.operation_id,
    branch.workspace_operation?.status,
  ].join('|');
  const [result, setResult] = useState<{
    scope: string;
    key: string;
    access: EffectiveBranchAccess | 'failed';
  } | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision only triggers a re-read
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
  }, [enabled, client, userId, scope, key, branchId, revision]);

  if (!client || !userId) return 'failed';
  if (result?.scope === scope && result.key === key) return result.access;
  return peekAccess<EffectiveBranchAccess>(client, scope, key) ?? 'loading';
}
