import type { AgorClient, Branch, EffectiveBranchAccess, Repo, User } from '@agor-live/client';
import { getBranchCleanupBlockReason, resolveRepoCleanupPolicy } from '@agor-live/client';
import { useEffect, useState } from 'react';
import {
  useAuthenticatedAuthorityScope,
  useAuthorityOperationGuard,
} from '@/hooks/useAuthorityOperationGuard';

/** Fresh authenticated reads; neither a stale prop nor a failed load enables Clean. */
export function useCleanupPolicy(
  client: AgorClient | null,
  user: User | null | undefined,
  branch: Branch,
  open: boolean
) {
  const authority = useAuthenticatedAuthorityScope(
    client,
    user ? `${user.user_id}:${user.role}` : null
  );
  const guard = useAuthorityOperationGuard(authority.operationScope);
  const [loaded, setLoaded] = useState<{
    branch: Branch;
    repo: Repo;
    access: EffectiveBranchAccess;
    scope: readonly unknown[] | null;
  } | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [revision, setRevision] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision explicitly refreshes the authenticated snapshot
  useEffect(() => {
    setLoaded(null);
    setLoadError(false);
    const operation = guard.begin();
    if (!open || !client || !operation.isCurrent()) return;
    void Promise.all([
      client.service('branches').get(branch.branch_id),
      client.service('repos').get(branch.repo_id),
      client.service('branches/:id/effective-access').find({ route: { id: branch.branch_id } }),
    ])
      .then(([currentBranch, repo, access]) => {
        if (operation.isCurrent())
          setLoaded({
            branch: currentBranch,
            repo,
            access: access as unknown as EffectiveBranchAccess,
            scope: authority.operationScope,
          });
      })
      .catch(() => {
        if (operation.isCurrent()) setLoadError(true);
      });
    const refresh = () => setRevision((value) => value + 1);
    const repoChanged = (repo: Repo) => {
      if (repo.repo_id === branch.repo_id) refresh();
    };
    const branchChanged = (current: Branch) => {
      if (current.branch_id === branch.branch_id) refresh();
    };
    client.service('repos').on('patched', repoChanged);
    client.service('branches').on('patched', branchChanged);
    return () => {
      operation.cancel();
      client.service('repos').removeListener('patched', repoChanged);
      client.service('branches').removeListener('patched', branchChanged);
    };
  }, [client, guard, authority.operationScope, open, branch.branch_id, branch.repo_id, revision]);
  const current =
    guard.isCurrent() &&
    loaded?.scope === authority.operationScope &&
    loaded?.branch.branch_id === branch.branch_id &&
    loaded?.repo.repo_id === branch.repo_id
      ? loaded
      : null;
  const policy = current ? resolveRepoCleanupPolicy(current.repo.cleanup_policy) : null;
  const reason = !current
    ? loadError
      ? 'Cleanup policy or permissions could not be loaded.'
      : 'Loading cleanup policy and permissions…'
    : (getBranchCleanupBlockReason(policy, current.branch.cleanup_protected ?? false) ??
      (!(current.access.is_owner || current.access.can === 'all') ||
      current.access.fs_access !== 'write'
        ? 'Cleanup requires Branch Manager authority and writable workspace access.'
        : undefined));
  return { policy, reason, repo: current?.repo, refresh: () => setRevision((value) => value + 1) };
}
