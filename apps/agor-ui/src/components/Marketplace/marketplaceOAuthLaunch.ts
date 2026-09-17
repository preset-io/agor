import { MCP_HEADER_REDACTED_SENTINEL } from '@agor/core/tools/mcp/http-headers';
import type {
  MCPCatalogConnectResult,
  MCPManagedOAuthStartResult,
  MCPOAuthStartFailure,
} from '@agor/core/types';
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
  options: { isCurrent: () => boolean; userId?: string }
): Promise<{ attemptId: string } | null> {
  if (!options.isCurrent()) {
    popup.close();
    return null;
  }
  const started = (await client.service('mcp-servers/oauth-start').create({
    mcp_server_id: result.mcp_server.mcp_server_id,
    ...(result.mcp_server.auth?.oauth_client_mode === 'cloud_managed_v1'
      ? { client_nonce: popup.operationId }
      : {}),
  })) as
    | (Pick<MCPManagedOAuthStartResult, 'success' | 'authorizationUrl' | 'attempt_id'> &
        Partial<Pick<MCPManagedOAuthStartResult, 'transaction_id' | 'oauth_client_mode'>>)
    | MCPOAuthStartFailure;
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
  if (result.mcp_server.auth?.oauth_client_mode === 'cloud_managed_v1') {
    if (
      !options.userId ||
      !started.transaction_id ||
      !popup.bindManagedFlow?.({
        nonce: popup.operationId,
        userId: options.userId,
        serverId: result.mcp_server.mcp_server_id,
        attemptId: started.attempt_id,
        transactionId: started.transaction_id,
        createdAt: Date.now(),
      })
    ) {
      popup.close();
      throw new MarketplaceOAuthStartError(
        'The sign-in window could not be securely bound. Start sign-in again.'
      );
    }
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
