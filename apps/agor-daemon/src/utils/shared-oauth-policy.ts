import { Forbidden, NotAuthenticated } from '@agor/core/feathers';
import type { AuthenticatedParams } from '@agor/core/types';
import { hasMinimumRole, ROLES } from '@agor/core/types';

export type OAuthLifecycleAction = 'start' | 'complete' | 'refresh' | 'disconnect';

/** Shared grants are tenant-wide credentials and may only be mutated by administrators. */
export function requireSharedOAuthAdministrator(
  params: AuthenticatedParams | undefined,
  action: OAuthLifecycleAction
): void {
  if (
    !params?.provider ||
    (params.user as { _isServiceAccount?: boolean } | undefined)?._isServiceAccount
  )
    return;
  if (!params.user) throw new NotAuthenticated('Authentication required');
  if (!hasMinimumRole(params.user.role, ROLES.ADMIN)) {
    throw new Forbidden(`Administrator access is required to ${action} a shared OAuth identity`);
  }
}

export function auditSharedOAuthLifecycle(input: {
  action: OAuthLifecycleAction;
  outcome: 'started' | 'succeeded' | 'failed';
  serverId?: string;
  actorUserId?: string;
  tenantId?: string;
}): void {
  // Deliberately structured and secret-free for operator log ingestion.
  console.info('[SECURITY] shared_oauth_lifecycle', input);
}
