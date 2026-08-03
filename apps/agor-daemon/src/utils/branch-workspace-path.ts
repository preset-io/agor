import type { BranchRepository } from '@agor/core/db';
import type { Branch, BranchPermissionLevel, UserID, UserRole } from '@agor/core/types';
import { hasBranchPermission } from './branch-authorization.js';

export async function ensureBranchWorkspaceAccess(
  branchRepo: BranchRepository,
  branch: Branch,
  userId?: string,
  userRole?: UserRole,
  requiredPermission: BranchPermissionLevel = 'session'
): Promise<void> {
  if (!userId) {
    throw new Error('Authentication required to access branch workspace files');
  }
  const userIdBranded = userId as UserID;
  const isOwner = await branchRepo.isOwner(branch.branch_id, userIdBranded);
  const effective = await branchRepo.resolveUserPermission(branch, userIdBranded);
  if (
    !hasBranchPermission(
      branch,
      userIdBranded,
      isOwner,
      requiredPermission,
      userRole,
      true,
      effective
    )
  ) {
    throw new Error(
      `Forbidden: branch ${requiredPermission} permission required to access branch workspace files`
    );
  }
}
