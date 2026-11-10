import type {
  AgorClient,
  Board,
  Branch,
  EffectiveBranchAccess,
  EffectiveCapabilityPolicyAccess,
  Repo,
  User,
} from '@agor-live/client';
import {
  getBranchCleanupBlockReason,
  getBranchMaintenanceBlockReason,
  hasMinimumRole,
  ROLES,
  resolveRepoCleanupPolicy,
} from '@agor-live/client';
import { useEffect, useState } from 'react';
import {
  useAuthenticatedAuthorityScope,
  useAuthorityOperationGuard,
} from '@/hooks/useAuthorityOperationGuard';

/** Fresh authenticated eligibility for archive/delete actions; stale or failed reads fail closed. */
export function useArchiveDeleteEligibility(
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
    board?: Board;
    boardUnavailable: boolean;
    canEditBoard: boolean;
    canManageBoard: boolean;
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
      .then(async ([currentBranch, repo, access]) => {
        let board: Board | undefined;
        let boardAccess: EffectiveCapabilityPolicyAccess | undefined;
        let boardUnavailable = false;
        // Board visibility/control is independent of branch Manager authority.
        // Keep a successfully read primary designation even if its access read fails.
        if (currentBranch.board_id) {
          try {
            board = await client.service('boards').get(currentBranch.board_id);
            if (board) {
              try {
                boardAccess = (await client.service('boards/:id/effective-access').find({
                  route: { id: board.board_id },
                })) as unknown as EffectiveCapabilityPolicyAccess;
              } catch {
                // If effective access read fails, boardAccess remains undefined.
              }
            } else {
              boardUnavailable = true;
            }
          } catch {
            boardUnavailable = true;
          }
        }
        const canManageBoard = Boolean(
          board &&
            !boardUnavailable &&
            user?.user_id &&
            hasMinimumRole(user.role, ROLES.MEMBER) &&
            (hasMinimumRole(user.role, ROLES.ADMIN) ||
              board.primary_owner_user_id === user.user_id ||
              boardAccess?.capabilities.includes('board.policy.manage'))
        );
        const canEditBoard = Boolean(
          board &&
            !boardUnavailable &&
            user?.user_id &&
            hasMinimumRole(user.role, ROLES.MEMBER) &&
            (hasMinimumRole(user.role, ROLES.ADMIN) ||
              board.primary_owner_user_id === user.user_id ||
              boardAccess?.capabilities.includes('board.edit') ||
              boardAccess?.capabilities.includes('board.policy.manage'))
        );
        if (operation.isCurrent())
          setLoaded({
            branch: currentBranch,
            repo,
            board,
            boardUnavailable,
            canEditBoard,
            canManageBoard,
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
  }, [
    client,
    guard,
    authority.operationScope,
    open,
    branch.branch_id,
    branch.repo_id,
    revision,
    user?.user_id,
    user?.role,
  ]);
  const current =
    guard.isCurrent() &&
    loaded?.scope === authority.operationScope &&
    loaded?.branch.branch_id === branch.branch_id &&
    loaded?.repo.repo_id === branch.repo_id
      ? loaded
      : null;
  const policy = current ? resolveRepoCleanupPolicy(current.repo.cleanup_policy) : null;

  const hasBranchManager = Boolean(current?.access.is_owner || current?.access.can === 'all');
  const canArchive = hasBranchManager || Boolean(current?.canManageBoard);
  const canDelete = hasBranchManager;

  const archiveManagementReason = !current
    ? loadError
      ? 'Branch permissions could not be loaded.'
      : 'Loading branch permissions…'
    : !canArchive
      ? 'Branch Manager authority is required to archive or delete.'
      : undefined;

  const deleteManagementReason = !current
    ? loadError
      ? 'Branch permissions could not be loaded.'
      : 'Loading branch permissions…'
    : !canDelete
      ? current?.canManageBoard
        ? 'Branch Manager authority is required to delete.'
        : 'Branch Manager authority is required to archive or delete.'
      : undefined;

  // Board administrators are elevated to writable workspace access for authorized archive maintenance.
  const canWriteForArchive = Boolean(
    current?.access.fs_access === 'write' || current?.canManageBoard
  );

  const writableReason =
    archiveManagementReason ??
    (!canWriteForArchive
      ? 'Writable workspace access is required to clean or delete files.'
      : undefined);
  const workspaceReason =
    writableReason ??
    getBranchMaintenanceBlockReason(current?.branch.maintenance_capabilities, 'archive_remove');

  const deleteWritableReason =
    deleteManagementReason ??
    (current?.access.fs_access !== 'write'
      ? 'Writable workspace access is required to clean or delete files.'
      : undefined);
  const deletionReason =
    deleteWritableReason ??
    getBranchMaintenanceBlockReason(current?.branch.maintenance_capabilities, 'permanent_delete');

  const cleanupReason = !current
    ? loadError
      ? 'Cleanup policy or permissions could not be loaded.'
      : 'Loading cleanup policy and permissions…'
    : (writableReason ??
      getBranchMaintenanceBlockReason(current.branch.maintenance_capabilities, 'archive_clean') ??
      getBranchCleanupBlockReason(policy, current.branch.cleanup_protected ?? false));
  return {
    policy,
    board: current?.board,
    boardUnavailable: current?.boardUnavailable ?? false,
    canEditBoard: current?.canEditBoard ?? false,
    canManageBoard: current?.canManageBoard ?? false,
    canArchive,
    canDelete,
    archiveManagementReason,
    deleteManagementReason,
    managementReason: archiveManagementReason,
    cleanupReason,
    workspaceReason,
    deletionReason,
    repo: current?.repo,
    refresh: () => setRevision((value) => value + 1),
  };
}
