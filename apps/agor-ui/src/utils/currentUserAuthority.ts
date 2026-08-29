import type { User } from '@agor-live/client';

/**
 * Enrich the freshly authenticated user with directory display data without
 * allowing an older directory snapshot to become authorization authority.
 *
 * Launch auth can update the database directly and return the new role without
 * a `users` event. Likewise, a token replacement can establish a different
 * role while `userById` still contains the prior row. Display fields may lag;
 * identity, role, and login gates may not.
 */
export function enrichAuthenticatedUser(
  authenticated: User | null | undefined,
  directory: User | null | undefined
): User | null {
  if (!authenticated) return null;
  if (!directory || directory.user_id !== authenticated.user_id) return authenticated;

  return {
    ...authenticated,
    ...directory,
    // Authentication response is the caller authority. Keep these after the
    // directory spread so stale admin/member rows and launch-auth direct DB
    // updates cannot be reversed by cached enrichment.
    user_id: authenticated.user_id,
    email: authenticated.email,
    role: authenticated.role,
    must_change_password: authenticated.must_change_password,
    onboarding_completed: authenticated.onboarding_completed,
    unix_username: authenticated.unix_username,
    filesystem_home: authenticated.filesystem_home,
  };
}

/**
 * Close-only onboarding signal. Authentication remains authoritative for
 * opening/login gates, while a same-user directory `true` may only make the
 * state more terminal (for example when another tab completes onboarding).
 */
export function hasObservedOnboardingCompletion(
  authenticated: User | null | undefined,
  directory: User | null | undefined
): boolean {
  if (!authenticated) return false;
  if (authenticated.onboarding_completed === true) return true;
  return directory?.user_id === authenticated.user_id && directory.onboarding_completed === true;
}
