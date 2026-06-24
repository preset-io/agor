import { hasMinimumRole, ROLES } from '@agor/core/types';

export interface McpTokenAuthorizationParams {
  callerUserId: string | undefined;
  callerRole: string | undefined;
}

export interface CliSessionControlParams extends McpTokenAuthorizationParams {
  sessionCreatedBy: string | null | undefined;
}

function hasExplicitMinimumRole(
  userRole: string | undefined,
  minimumRole: typeof ROLES.MEMBER
): boolean;
function hasExplicitMinimumRole(
  userRole: string | undefined,
  minimumRole: typeof ROLES.SUPERADMIN
): boolean;
function hasExplicitMinimumRole(
  userRole: string | undefined,
  minimumRole: typeof ROLES.MEMBER | typeof ROLES.SUPERADMIN
): boolean {
  return !!userRole && hasMinimumRole(userRole, minimumRole);
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
export function canReceiveMcpTokenForSession(params: McpTokenAuthorizationParams): boolean {
  const { callerUserId, callerRole } = params;
  const isServiceExecutor = callerRole === 'service';
  const isAuthenticatedMember = !!callerUserId && hasExplicitMinimumRole(callerRole, ROLES.MEMBER);
  return isAuthenticatedMember || isServiceExecutor;
}

/**
 * Authorization predicate for controlling a Claude CLI process bound to a
 * session (ensure/focus cold-start tab, restart/kill/re-spawn).
 *
 * CLI control is intentionally stricter than caller-scoped Agor MCP token
 * delivery. In simple Unix mode the process may run from the creator's shared
 * home/session state, and even in stricter modes resuming someone else's CLI
 * session can execute with that session's credentials/context. Only the creator,
 * a superadmin, or the service identity may control that process boundary.
 */
export function canControlCliSession(params: CliSessionControlParams): boolean {
  const { callerUserId, callerRole, sessionCreatedBy } = params;
  const isSuperadmin = hasExplicitMinimumRole(callerRole, ROLES.SUPERADMIN);
  const isServiceExecutor = callerRole === 'service';
  const isCreatorMember =
    !!callerUserId &&
    callerUserId === sessionCreatedBy &&
    hasExplicitMinimumRole(callerRole, ROLES.MEMBER);
  return isCreatorMember || isSuperadmin || isServiceExecutor;
}
