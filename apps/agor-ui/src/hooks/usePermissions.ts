/**
 * Permission hook for role-based UI logic.
 *
 * Derives permission flags from the authenticated user's role using
 * the shared hasMinimumRole() from @agor/core. Eliminates scattered
 * role string comparisons and prop-drilling of currentUser.
 */

import type { UserRole } from '@agor-live/client';
import { hasMinimumRole, ROLES } from '@agor-live/client';
import { useMemo } from 'react';
import { useAuth } from './useAuth';

export interface Permissions {
  /** Current user's role (undefined if not authenticated) */
  role: UserRole | undefined;
  /** User has admin or superadmin role */
  isAdmin: boolean;
  /** User has superadmin role */
  isSuperAdmin: boolean;
  /** Check if user meets a minimum role requirement */
  hasRole: (minimumRole: UserRole) => boolean;
}

/**
 * Returns permission flags derived from the current user's role.
 *
 * Usage:
 *   const { isAdmin, hasRole } = usePermissions();
 *   <Button disabled={!isAdmin}>Edit</Button>
 *   <Button disabled={!hasRole(ROLES.MEMBER)}>Create</Button>
 */
export function usePermissions(): Permissions {
  const { user } = useAuth();
  const role = user?.role;

  return useMemo(
    () => ({
      role,
      isAdmin: hasMinimumRole(role, ROLES.ADMIN),
      isSuperAdmin: hasMinimumRole(role, ROLES.SUPERADMIN),
      hasRole: (minimumRole: UserRole) => hasMinimumRole(role, minimumRole),
    }),
    [role]
  );
}
