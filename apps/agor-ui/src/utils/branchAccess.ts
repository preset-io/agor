import {
  type AgorClient,
  BRANCH_PERMISSION_LEVELS,
  type EffectiveBranchAccess,
  hasMinimumRole,
  ROLES,
} from '@agor-live/client';

/** Creating sessions starts at `session`; `prompt` and `all` include it. */
export const canStartSessions = (access: Pick<EffectiveBranchAccess, 'can'>) =>
  BRANCH_PERMISSION_LEVELS.indexOf(access.can) >= BRANCH_PERMISSION_LEVELS.indexOf('session');

/** The caller's legacy `{ can }` access to a branch, from `branches/:id/effective-access`. */
export const readBranchAccess = (client: AgorClient, branchId: string) =>
  client
    .service('branches/:id/effective-access')
    .find({ route: { id: branchId } }) as unknown as Promise<EffectiveBranchAccess>;

/** A cached `effective-access` answer; `failed` means the lookup failed, not that access is missing. */
export type BranchAccessLookup = EffectiveBranchAccess | 'loading' | 'failed';

/** `unknown` means the client can't tell, so callers keep the action and the server decides. */
export type BranchControlAccess = 'allowed' | 'denied' | 'loading' | 'unknown';

/**
 * Retry-provisioning and permanent deletion: a member or above who is the owner, or has `all`
 * with filesystem `write`. A superadmin may still be allowed by `execution.allow_superadmin`,
 * which the client can't see.
 */
export function provisioningAccess(
  lookup: BranchAccessLookup,
  role: string | undefined
): BranchControlAccess {
  if (!role) return 'unknown';
  if (!hasMinimumRole(role, ROLES.MEMBER)) return 'denied';
  if (lookup === 'loading') return 'loading';
  if (lookup === 'failed') return 'unknown';
  if (lookup.is_owner || (lookup.can === 'all' && lookup.fs_access === 'write')) return 'allowed';
  return hasMinimumRole(role, ROLES.SUPERADMIN) ? 'unknown' : 'denied';
}

/** Branch Manager: the owner or effective `all`, as the workspace notification dismiss route checks. */
export const canManageBranch = (lookup: BranchAccessLookup) =>
  typeof lookup === 'object' && (lookup.is_owner || lookup.can === 'all');
