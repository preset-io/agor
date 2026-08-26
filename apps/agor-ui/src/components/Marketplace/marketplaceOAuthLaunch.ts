import type { MCPCatalogConnectResult, MCPOAuthStartFailure } from '@agor/core/types';
import type { AgorClient } from '@agor-live/client';
import {
  discardPendingMarketplaceOAuthPrompt,
  savePendingMarketplaceOAuthPrompt,
} from '../../utils/marketplaceOAuthPrompt';
import type { MarketplaceOAuthPopup } from './marketplaceOAuthPopup';

export class MarketplaceOAuthPopupNavigationError extends Error {
  constructor() {
    super(
      'The sign-in window closed before it could open the provider. Continue sign-in from the new session.'
    );
    this.name = 'MarketplaceOAuthPopupNavigationError';
  }
}

/** Start OAuth only for the authoritative saved server returned by Connect. */
export async function launchMarketplaceOAuth(
  client: AgorClient,
  result: MCPCatalogConnectResult,
  popup: MarketplaceOAuthPopup,
  options: {
    authority: { userId: string; role: string; authGeneration: number };
    isCurrent: () => boolean;
  }
): Promise<boolean> {
  if (!options.isCurrent()) {
    popup.close();
    return false;
  }
  const started = (await client.service('mcp-servers/oauth-start').create({
    mcp_server_id: result.mcp_server.mcp_server_id,
  })) as { success: true; authorizationUrl: string; attempt_id: string } | MCPOAuthStartFailure;
  if (!options.isCurrent()) {
    popup.close();
    return false;
  }
  if (!started.success || !started.authorizationUrl || !started.attempt_id) {
    popup.close();
    return false;
  }
  // Record every newer Marketplace attempt, even when this catalog entry has
  // no starter prompt. The attempt marker synchronously fences any suggestion
  // from an earlier flow for the same session/authority.
  savePendingMarketplaceOAuthPrompt({
    sessionId: result.session.session_id,
    serverId: result.mcp_server.mcp_server_id,
    attemptId: started.attempt_id,
    prompt: result.starter_prompt ?? '',
    createdAt: Date.now(),
    userId: options.authority.userId,
    role: options.authority.role,
    authGeneration: options.authority.authGeneration,
    popupOperationId: popup.operationId,
  });
  // Guard once more inside the launch helper immediately before handing the
  // third-party URL to the pre-opened window.
  try {
    if (popup.navigate(started.authorizationUrl, options.isCurrent)) return true;
  } catch {
    // Fall through to exact-attempt cleanup. The durable server, session, and
    // OAuth attempt remain recoverable from the session UI.
  }
  discardPendingMarketplaceOAuthPrompt(
    result.session.session_id,
    started.attempt_id,
    popup.operationId
  );
  popup.close();
  throw new MarketplaceOAuthPopupNavigationError();
}
