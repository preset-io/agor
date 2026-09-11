import { MCP_HEADER_REDACTED_SENTINEL } from '@agor/core/tools/mcp/http-headers';
import type { MCPCatalogConnectResult, MCPOAuthStartFailure } from '@agor/core/types';
import type { AgorClient } from '@agor-live/client';
import { mcpServerNeedsAuth } from '../../utils/mcpAuth';
import type { MarketplaceOAuthPopup } from './marketplaceOAuthPopup';

/**
 * Connect projects a sentinel only for a currently live, authorized caller grant.
 * The workspace OAuth badge Set is a last-observed saved-status snapshot, not
 * completion authority. Keep this contract separate from generic server reads.
 */
export function catalogConnectNeedsAuthentication(
  result: MCPCatalogConnectResult,
  now = Date.now()
): boolean {
  const { auth } = result.mcp_server;
  if (auth?.type !== 'oauth') return mcpServerNeedsAuth(result.mcp_server, new Set());
  return (
    auth.oauth_access_token !== MCP_HEADER_REDACTED_SENTINEL ||
    (auth.oauth_token_expires_at !== undefined &&
      !(Number.isFinite(auth.oauth_token_expires_at) && auth.oauth_token_expires_at > now))
  );
}

export class MarketplaceOAuthPopupNavigationError extends Error {
  constructor() {
    super('The sign-in window closed before it could open the provider. Try connecting again.');
    this.name = 'MarketplaceOAuthPopupNavigationError';
  }
}

export class MarketplaceOAuthStartError extends Error {
  constructor(message?: string) {
    super(message || 'Sign-in could not start automatically. Retry from My Servers when ready.');
    this.name = 'MarketplaceOAuthStartError';
  }
}

/** Start OAuth only for the authoritative saved server returned by Connect. */
export async function launchMarketplaceOAuth(
  client: AgorClient,
  result: MCPCatalogConnectResult,
  popup: MarketplaceOAuthPopup,
  options: { isCurrent: () => boolean }
): Promise<{ attemptId: string } | null> {
  if (!options.isCurrent()) {
    popup.close();
    return null;
  }
  const started = (await client.service('mcp-servers/oauth-start').create({
    mcp_server_id: result.mcp_server.mcp_server_id,
  })) as { success: true; authorizationUrl: string; attempt_id: string } | MCPOAuthStartFailure;
  if (!options.isCurrent()) {
    popup.close();
    return null;
  }
  if (!started.success) {
    popup.close();
    throw new MarketplaceOAuthStartError(started.error || started.recovery?.message);
  }
  if (!started.authorizationUrl || !started.attempt_id) {
    popup.close();
    throw new MarketplaceOAuthStartError();
  }
  try {
    if (popup.navigate(started.authorizationUrl, options.isCurrent)) {
      return { attemptId: started.attempt_id };
    }
  } catch {
    // The durable server and OAuth attempt remain recoverable from MCP settings.
  }
  popup.close();
  throw new MarketplaceOAuthPopupNavigationError();
}
