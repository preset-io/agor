import type { MCPCatalogConnectResult, MCPOAuthStartFailure } from '@agor/core/types';
import type { AgorClient } from '@agor-live/client';
import { savePendingMarketplaceOAuthPrompt } from '../../utils/marketplaceOAuthPrompt';

/** Start OAuth only for the authoritative saved server returned by Connect. */
export async function launchMarketplaceOAuth(
  client: AgorClient,
  result: MCPCatalogConnectResult,
  popup: Window
): Promise<boolean> {
  const started = (await client.service('mcp-servers/oauth-start').create({
    mcp_server_id: result.mcp_server.mcp_server_id,
  })) as { success: true; authorizationUrl: string; attempt_id: string } | MCPOAuthStartFailure;
  if (!started.success || !started.authorizationUrl || !started.attempt_id) {
    popup.close();
    return false;
  }
  if (result.starter_prompt) {
    savePendingMarketplaceOAuthPrompt({
      sessionId: result.session.session_id,
      serverId: result.mcp_server.mcp_server_id,
      attemptId: started.attempt_id,
      prompt: result.starter_prompt,
      createdAt: Date.now(),
    });
  }
  popup.location.replace(started.authorizationUrl);
  return true;
}
