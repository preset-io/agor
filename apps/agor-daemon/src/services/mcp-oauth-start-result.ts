import type { OAuthFlowContext } from '@agor/core/tools/mcp/oauth-mcp-transport';
import type { MCPOAuthAttemptID } from '@agor/core/types';

export interface StartedMCPOAuthFlowResult {
  attemptId: MCPOAuthAttemptID;
  state: string;
  authorizationUrl: string;
  redirectUri: string;
}

/**
 * Preserve the exact redirect contract selected by core discovery/DCR.
 *
 * The input redirect URI can be replaced with an issuer-bound path while the
 * flow is created. Daemon callers must therefore serialize the resolved
 * context rather than the public callback base they supplied initially.
 */
export function createStartedMCPOAuthFlowResult(
  context: Pick<OAuthFlowContext, 'state' | 'authorizationUrl' | 'redirectUri'>,
  attemptId: MCPOAuthAttemptID
): StartedMCPOAuthFlowResult {
  return {
    attemptId,
    state: context.state,
    authorizationUrl: context.authorizationUrl,
    redirectUri: context.redirectUri,
  };
}
