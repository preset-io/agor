/**
 * The one operational line that names a redirect-URI binding problem.
 *
 * A provider rejects a mismatched redirect URI front-channel, on its own
 * authorize page, so the rejection never reaches Agor: the flow simply stops
 * with a pending attempt that expires. The only thing Agor can do is state,
 * once per attempt, which callback origin it registered under, which one it
 * is authorizing with, and under what name it registered.
 *
 * Origins only. Never a path, a full URL, a client secret, an authorization
 * code, or anything the provider sent back. `client_name` is Agor's own
 * constant (`MCP_OAUTH_DCR_CLIENT_NAME`), so it is safe by construction.
 */

import type { OAuthFlowContext } from '@agor/core/tools/mcp/oauth-mcp-transport';

/** Origin, or a stable placeholder. Never the offending value itself. */
function originOf(url: string | undefined): string {
  if (!url) return 'none';
  try {
    return new URL(url).origin;
  } catch {
    return 'invalid';
  }
}

export function describeOAuthAuthorizeBuilt(input: {
  mcpServerId?: string;
  attemptId: string;
  context: Pick<
    OAuthFlowContext,
    | 'clientSource'
    | 'clientName'
    | 'redirectUri'
    | 'registeredRedirectUri'
    | 'registrationEndpoint'
    | 'authorizationEndpoint'
  >;
}): string {
  const { context } = input;
  // A configured client has no Agor-observed registration to compare against,
  // so it reports the comparison as unknown rather than as a pass.
  const matches =
    context.registeredRedirectUri === undefined
      ? 'unknown'
      : String(context.registeredRedirectUri === context.redirectUri);
  return [
    '[MCP OAuth] event=oauth_authorize_built',
    `server=${input.mcpServerId ?? 'none'}`,
    `attempt=${input.attemptId}`,
    `client_source=${context.clientSource ?? 'unknown'}`,
    `client_name=${context.clientName ?? 'none'}`,
    `redirect_origin=${originOf(context.redirectUri)}`,
    `authorize_origin=${originOf(context.authorizationEndpoint)}`,
    `redirect_matches_registered=${matches}`,
    `registration_endpoint_origin=${originOf(context.registrationEndpoint)}`,
  ].join(' ');
}

export function logOAuthAuthorizeBuilt(input: Parameters<typeof describeOAuthAuthorizeBuilt>[0]) {
  console.log(describeOAuthAuthorizeBuilt(input));
}
