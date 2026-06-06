import fs from 'node:fs';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type { BranchRepository } from '@agor/core/db';
import type { Branch, BranchID, BranchPermissionLevel, UserID, UserRole } from '@agor/core/types';
import { hasBranchPermission } from './branch-authorization.js';

export function normalizeBranchWorkspaceSubpath(subpath: string | undefined | null): string {
  if (!subpath || subpath.trim().length === 0) {
    throw new Error('subpath is required');
  }
  const normalized = subpath
    .trim()
    .replace(/\\+/g, '/')
    .replace(/^\/+|\/+$/g, '');
  if (!normalized) throw new Error('subpath must identify a path inside the branch root');
  for (const segment of normalized.split('/')) {
    if (!segment || segment === '.' || segment === '..') {
      throw new Error('subpath must not contain empty, "." or ".." segments');
    }
  }
  return normalized;
}

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

export function assertPathInsideRoot(
  root: string,
  candidate: string,
  reason: string,
  options?: { allowRoot?: boolean }
): void {
  if (!isPathInsideRoot(root, candidate, options)) {
    throw new Error(`${reason}: escapes branch root`);
  }
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

export async function resolveBranchWorkspacePath(input: {
  branchRepo: BranchRepository;
  branchId: string;
  subpath: string | undefined | null;
  userId?: string;
  userRole?: UserRole;
  requiredPermission?: BranchPermissionLevel;
}): Promise<{
  branch: Branch;
  branchId: BranchID;
  branchRoot: string;
  relative: string;
  absolute: string;
  canonical: string;
}> {
  const branch = await input.branchRepo.findById(input.branchId);
  if (!branch) throw new Error(`Branch not found: ${input.branchId}`);
  await ensureBranchWorkspaceAccess(
    input.branchRepo,
    branch,
    input.userId,
    input.userRole,
    input.requiredPermission ?? 'session'
  );

  const branchRoot = await realpath(branch.path);
  const relative = normalizeBranchWorkspaceSubpath(input.subpath);
  const absolute = path.resolve(branchRoot, relative);
  const canonical = await canonicalizeExistingPrefix(absolute);
  assertPathInsideRoot(branchRoot, absolute, `subpath ${relative}`);
  assertPathInsideRoot(branchRoot, canonical, `subpath ${relative} (canonical)`);

  return {
    branch,
    branchId: branch.branch_id,
    branchRoot,
    relative,
    absolute,
    canonical,
  };
}

export async function matchRegisteredBranchPath(input: {
  branchRepo: BranchRepository;
  folderPath: string;
}): Promise<{
  branch: Branch;
  branchId: BranchID;
  branchRoot: string;
  canonicalFolderPath: string;
} | null> {
  const resolved = path.resolve(input.folderPath);
  const canonical = await canonicalizeExistingPrefix(resolved);
  const branches = await input.branchRepo.findAll();
  for (const branch of branches) {
    let branchRoot: string;
    try {
      branchRoot = await realpath(branch.path);
    } catch {
      continue;
    }
    const lexicalBranchRoot = path.resolve(branch.path);
    const lexicallyInside = isPathInsideRoot(lexicalBranchRoot, resolved, { allowRoot: true });
    const canonicallyInside = isPathInsideRoot(branchRoot, canonical, { allowRoot: true });
    if (lexicallyInside && !canonicallyInside) {
      throw new Error('Resolved path escapes registered branch root');
    }
    if (canonicallyInside) {
      return {
        branch,
        branchId: branch.branch_id,
        branchRoot,
        canonicalFolderPath: canonical,
      };
    }
  }
  return null;
}
