import fs from 'node:fs';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type { BranchRepository } from '@agor/core/db';
import type { Branch, BranchPermissionLevel, UserID, UserRole } from '@agor/core/types';
import { hasBranchPermission } from './branch-authorization.js';

export async function canonicalizeExistingPrefix(target: string): Promise<string> {
  const resolved = path.resolve(target);
  const segments = resolved.split(path.sep);
  for (let i = segments.length; i >= 1; i -= 1) {
    const prefix = segments.slice(0, i).join(path.sep) || path.sep;
    if (!fs.existsSync(prefix)) continue;
    const real = await realpath(prefix);
    const tail = segments.slice(i).join(path.sep);
    return tail ? path.join(real, tail) : real;
  }
  return resolved;
}

export function isPathInsideRoot(
  root: string,
  candidate: string,
  options?: { allowRoot?: boolean }
) {
  const rel = path.relative(root, candidate);
  if (rel === '') return options?.allowRoot === true;
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

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
