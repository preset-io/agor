import { hasMinimumRole, ROLES } from '@agor/core/types';

/**
 * Authorization predicate for handing a session-scoped MCP token to a caller.
 *
 * The token binds `uid = session.created_by` and lets the bearer act as the
 * session creator on the MCP channel. It must therefore only be returned to
 * callers who are already allowed to act as that creator: the creator (member+),
 * a superadmin, or the executor/service identity.
 */
export function canReceiveMcpTokenForSession(params: {
  callerUserId: string | undefined;
  callerRole: string | undefined;
  sessionCreatedBy: string | null | undefined;
}): boolean {
  const { callerUserId, callerRole, sessionCreatedBy } = params;
  const isSuperadmin = hasMinimumRole(callerRole, ROLES.SUPERADMIN);
  const isServiceExecutor = callerRole === 'service';
  const isCreatorMember =
    !!callerUserId && callerUserId === sessionCreatedBy && hasMinimumRole(callerRole, ROLES.MEMBER);
  return isCreatorMember || isSuperadmin || isServiceExecutor;
}
