import { hasMinimumRole, ROLES } from '@agor/core/types';

export interface McpTokenAuthorizationParams {
  callerUserId: string | undefined;
  callerRole: string | undefined;
}

/**
 * Authorization predicate for handing an Agor MCP token to a task executor.
 *
 * The token is minted for the executor's delegated user (the prompter, not
 * necessarily `session.created_by`) and is bound to the requested session
 * context and the executor's task. Normal session/branch RBAC has already run
 * before the after-hook calls this helper; this gate only prevents
 * anonymous/viewer identities from receiving a bearer credential. Caller-scoped
 * tokens matter for gateway/aligned user prompts: a collaborator prompting
 * someone else's session must execute MCP tools as themselves.
 */
export function canReceiveMcpTokenForSession(params: McpTokenAuthorizationParams): boolean {
  const { callerUserId, callerRole } = params;
  return !!callerUserId && !!callerRole && hasMinimumRole(callerRole, ROLES.MEMBER);
}
