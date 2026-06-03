import { hasMinimumRole, ROLES } from '@agor/core/types';

export interface SessionActorAuthorizationParams {
  callerUserId: string | undefined;
  callerRole: string | undefined;
  sessionCreatedBy: string | null | undefined;
}

/**
 * Authorization predicate for handing a session-scoped MCP token to a caller.
 *
 * The token binds `uid = session.created_by` and lets the bearer act as the
 * session creator on the MCP channel. It must therefore only be returned to
 * callers who are already allowed to act as that creator: the creator (member+),
 * a superadmin, or the executor/service identity.
 */
export function canReceiveMcpTokenForSession(params: SessionActorAuthorizationParams): boolean {
  const { callerUserId, callerRole, sessionCreatedBy } = params;
  const isSuperadmin = hasMinimumRole(callerRole, ROLES.SUPERADMIN);
  const isServiceExecutor = callerRole === 'service';
  const isCreatorMember =
    !!callerUserId && callerUserId === sessionCreatedBy && hasMinimumRole(callerRole, ROLES.MEMBER);
  return isCreatorMember || isSuperadmin || isServiceExecutor;
}

/**
 * Authorization predicate for controlling a Claude CLI process bound to a
 * session (ensure/focus cold-start tab, restart/kill/re-spawn).
 *
 * CLI control is as sensitive as receiving the MCP token: in simple Unix mode
 * the process may run from the creator's shared home/session state, and even in
 * stricter modes resuming someone else's CLI session can execute with that
 * session's credentials/context. Keep this boundary aligned with MCP token
 * delivery unless the CLI ownership model is redesigned explicitly.
 */
export function canControlCliSession(params: SessionActorAuthorizationParams): boolean {
  return canReceiveMcpTokenForSession(params);
}
