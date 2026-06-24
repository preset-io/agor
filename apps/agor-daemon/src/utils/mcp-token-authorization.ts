import { hasMinimumRole, ROLES } from '@agor/core/types';

export interface SessionActorAuthorizationParams {
  callerUserId: string | undefined;
  callerRole: string | undefined;
  sessionCreatedBy: string | null | undefined;
}

/**
 * Authorization predicate for handing an Agor MCP token to a caller.
 *
 * The token is minted for the *current authenticated caller* (not necessarily
 * `session.created_by`) and is bound to the requested session context. Normal
 * session/branch RBAC has already run before the after-hook calls this helper;
 * this gate only prevents anonymous/viewer contexts from receiving a bearer
 * credential. Returning caller-scoped tokens is important for gateway/aligned
 * user prompts: a collaborator prompting someone else's session must execute
 * MCP tools as themselves, not as the original session creator.
 */
export function canReceiveMcpTokenForSession(params: SessionActorAuthorizationParams): boolean {
  const { callerUserId, callerRole } = params;
  const isServiceExecutor = callerRole === 'service';
  const isAuthenticatedMember = !!callerUserId && hasMinimumRole(callerRole, ROLES.MEMBER);
  return isAuthenticatedMember || isServiceExecutor;
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
  const { callerUserId, callerRole, sessionCreatedBy } = params;
  const isSuperadmin = hasMinimumRole(callerRole, ROLES.SUPERADMIN);
  const isServiceExecutor = callerRole === 'service';
  const isCreatorMember =
    !!callerUserId && callerUserId === sessionCreatedBy && hasMinimumRole(callerRole, ROLES.MEMBER);
  return isCreatorMember || isSuperadmin || isServiceExecutor;
}
