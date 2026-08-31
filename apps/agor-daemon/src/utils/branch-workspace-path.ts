import type { BranchRepository } from '@agor/core/db';
import type {
  Branch,
  BranchFsAccessLevel,
  BranchPermissionLevel,
  UserID,
  UserRole,
} from '@agor/core/types';
import { hasBranchPermission, isSuperAdmin } from './branch-authorization.js';

const FS_ACCESS_RANK: Readonly<Record<BranchFsAccessLevel, number>> = {
  none: 0,
  read: 1,
  write: 2,
};

export async function ensureBranchWorkspaceAccess(
  branchRepo: BranchRepository,
  branch: Branch,
  userId?: string,
  userRole?: UserRole,
  requiredPermission: BranchPermissionLevel = 'session',
  requiredFsAccess: Exclude<BranchFsAccessLevel, 'none'> = 'read',
  allowSuperadmin = false
): Promise<Exclude<BranchFsAccessLevel, 'none'>> {
  if (!userId) {
    throw new Error('Authentication required to access branch workspace files');
  }
  const userIdBranded = userId as UserID;
  const effective = await branchRepo.resolveUserAccess(branch, userIdBranded);
  if (
    !hasBranchPermission(
      branch,
      userIdBranded,
      effective.is_owner,
      requiredPermission,
      userRole,
      allowSuperadmin,
      effective.can
    )
  ) {
    throw new Error(
      `Forbidden: branch ${requiredPermission} permission required to access branch workspace files`
    );
  }
  if (
    !effective.is_owner &&
    !isSuperAdmin(userRole, allowSuperadmin) &&
    FS_ACCESS_RANK[effective.fs_access ?? 'none'] < FS_ACCESS_RANK[requiredFsAccess]
  ) {
    throw new Error(
      `Forbidden: branch filesystem ${requiredFsAccess} access required to access branch workspace files`
    );
  }
  if (effective.is_owner || isSuperAdmin(userRole, allowSuperadmin)) return 'write';
  return effective.fs_access as Exclude<BranchFsAccessLevel, 'none'>;
}
