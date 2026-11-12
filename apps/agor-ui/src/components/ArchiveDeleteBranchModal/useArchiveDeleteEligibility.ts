import type {
  AgorClient,
  Board,
  Branch,
  BranchArchiveEligibility,
  Repo,
  User,
} from '@agor-live/client';
import {
  getBranchCleanupBlockReason,
  getBranchMaintenanceBlockReason,
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
    repo: Repo;
    eligibility: BranchArchiveEligibility;
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
      client
        .service('branches/:id/archive-eligibility')
        .find({ route: { id: branch.branch_id } }) as unknown as Promise<BranchArchiveEligibility>,
      client.service('repos').get(branch.repo_id),
    ])
      .then(([eligibility, repo]) => {
        if (operation.isCurrent()) {
          setLoaded({
            repo,
            eligibility,
            scope: authority.operationScope,
          });
        }
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
    const boardChanged = (patchedBoard: Board) => {
      if (branch.board_id && patchedBoard.board_id === branch.board_id) refresh();
    };
    client.service('repos')?.on?.('patched', repoChanged);
    client.service('branches')?.on?.('patched', branchChanged);
    client.service('boards')?.on?.('patched', boardChanged);
    return () => {
      operation.cancel();
      client.service('repos')?.removeListener?.('patched', repoChanged);
      client.service('branches')?.removeListener?.('patched', branchChanged);
      client.service('boards')?.removeListener?.('patched', boardChanged);
    };
  }, [
    client,
    guard,
    authority.operationScope,
    open,
    branch.branch_id,
    branch.repo_id,
    branch.board_id,
    revision,
    user?.user_id,
    user?.role,
  ]);
  const current =
    guard.isCurrent() &&
    loaded?.scope === authority.operationScope &&
    loaded?.eligibility.branch_id === branch.branch_id &&
    loaded?.repo.repo_id === branch.repo_id
      ? loaded
      : null;
  const policy = current
    ? resolveRepoCleanupPolicy(current.repo.cleanup_policy ?? current.eligibility.cleanup_policy)
    : null;

  const canArchive = Boolean(current?.eligibility.can_archive);
  const canDelete = Boolean(current?.eligibility.can_delete);
  const canRetireTeammate = Boolean(current?.eligibility.can_retire_teammate);
  const maintenanceCapabilities =
    current?.eligibility.maintenance_capabilities ?? branch.maintenance_capabilities;
  const cleanupProtected =
    current?.eligibility.cleanup_protected ?? branch.cleanup_protected ?? false;

  const archiveManagementReason = !current
    ? loadError
      ? 'Branch permissions could not be loaded.'
      : 'Loading branch permissions…'
    : !canArchive
      ? 'Branch Manager authority is required to archive or delete.'
      : undefined;

  const retireManagementReason = !current
    ? loadError
      ? 'Branch permissions could not be loaded.'
      : 'Loading branch permissions…'
    : !canRetireTeammate
      ? current.eligibility.can_manage_board
        ? 'Branch Manager authority is required to retire.'
        : 'Branch Manager authority is required to archive or delete.'
      : undefined;

  const deleteManagementReason = !current
    ? loadError
      ? 'Branch permissions could not be loaded.'
      : 'Loading branch permissions…'
    : !canDelete
      ? current.eligibility.can_manage_board
        ? 'Branch Manager authority is required to delete.'
        : 'Branch Manager authority is required to archive or delete.'
      : undefined;

  const writableReason =
    archiveManagementReason ??
    (!current?.eligibility.can_cleanup_on_archive
      ? 'Writable workspace access is required to clean or delete files.'
      : undefined);
  const workspaceReason =
    writableReason ?? getBranchMaintenanceBlockReason(maintenanceCapabilities, 'archive_remove');

  const deleteWritableReason =
    deleteManagementReason ??
    (!current?.eligibility.can_delete_files
      ? 'Writable workspace access is required to clean or delete files.'
      : undefined);
  const deletionReason =
    deleteWritableReason ??
    getBranchMaintenanceBlockReason(maintenanceCapabilities, 'permanent_delete');

  const cleanupReason = !current
    ? loadError
      ? 'Cleanup policy or permissions could not be loaded.'
      : 'Loading cleanup policy and permissions…'
    : (writableReason ??
      getBranchMaintenanceBlockReason(maintenanceCapabilities, 'archive_clean') ??
      getBranchCleanupBlockReason(policy, cleanupProtected));
  return {
    policy,
    board: current?.eligibility.board,
    boardUnavailable: current?.eligibility.board_unavailable ?? false,
    canEditBoard: current?.eligibility.can_clear_board_primary ?? false,
    canManageBoard: current?.eligibility.can_manage_board ?? false,
    canArchive,
    canDelete,
    canRetireTeammate,
    archiveManagementReason,
    retireManagementReason,
    deleteManagementReason,
    managementReason: archiveManagementReason,
    cleanupReason,
    workspaceReason,
    deletionReason,
    repo: current?.repo,
    refresh: () => setRevision((value) => value + 1),
  };
}
