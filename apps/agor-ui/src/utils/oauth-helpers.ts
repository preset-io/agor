/**
 * OAuth helper functions extracted from App.tsx for testability.
 *
 * These pure functions handle OAuth auto-continue logic and
 * cooldown/dedup decisions for the OAuth flow.
 */

export interface PendingOAuthServer {
  serverId: string;
  name: string;
  url: string;
  sessionId?: string;
}

/**
 * Build the auto-continue prompt payload for a session that was waiting on OAuth.
 * Returns null if there's no pending server or no session to continue.
 */
export function buildOAuthAutoContinuePrompt(
  pendingServer: PendingOAuthServer | null
): { sessionId: string; prompt: string; messageSource: string } | null {
  if (!pendingServer) return null;
  if (!pendingServer.sessionId) return null;

  return {
    sessionId: pendingServer.sessionId,
    prompt: `OAuth authentication for "${pendingServer.name}" MCP server completed successfully. The MCP tools are now available. Please continue with what you were doing.`,
    messageSource: 'agor',
  };
}

/**
 * Determine whether an incoming oauth:auth_required event should be processed.
 * Returns false (with a reason) if a flow is already in progress or we're in cooldown.
 */
export function shouldProcessOAuthRequired(
  pendingOAuthServer: PendingOAuthServer | null,
  oauthCooldownUntil: number,
  now?: number
): { shouldProcess: boolean; reason?: string } {
  const currentTime = now ?? Date.now();

  if (pendingOAuthServer) {
    return { shouldProcess: false, reason: 'OAuth flow already in progress' };
  }

  if (currentTime < oauthCooldownUntil) {
    return { shouldProcess: false, reason: 'In cooldown period' };
  }

  return { shouldProcess: true };
}
