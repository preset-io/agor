import type { MCPServer } from '@agor-live/client';

/**
 * Determine if an MCP server needs authentication from the current user.
 *
 * Two sources of truth, intentionally:
 *   1. `server.auth.oauth_access_token` / `oauth_token_expires_at` — populated
 *      by the daemon's `injectPerUserOAuthTokens` find-hook on every
 *      `mcp-servers` find/get. Authoritative, but only as fresh as the last
 *      fetch. Covers both shared-mode and per-user tokens.
 *   2. `userAuthenticatedMcpServerIds` — a Set populated at boot from
 *      `/mcp-servers/oauth-status` and then *additively* updated when an
 *      `oauth:completed` socket event arrives. Acts as an optimistic flip
 *      that lights the chip green the instant OAuth completes (before the
 *      `mcp-servers.get(id)` refetch resolves) and as a fallback if that
 *      refetch ever fails.
 *
 * Both branches are gated on `!isExpired` so the optimistic Set can never
 * outlive the actual token: stale "authenticated" state degrades back to
 * "needs auth" once expiry passes, even if nothing pruned the Set.
 *
 * The expiry check on the access-token branch matters because the daemon's
 * find-hook reflects the row verbatim: when JIT refresh has failed (no
 * refresh_token, invalid_grant, transient error), the cached row carries a
 * now-past `oauth_token_expires_at`. Without re-checking expiry here, the UI
 * surfaces a "happy" purple chip and suppresses the above-prompt-box auth
 * banner — leaving users to send doomed prompts.
 *
 * Non-OAuth servers always return false (no auth needed).
 */
export function mcpServerNeedsAuth(
  server: MCPServer | undefined,
  userAuthenticatedMcpServerIds: Set<string>
): boolean {
  if (!server || server.auth?.type !== 'oauth') return false;

  const expiresAt = server.auth.oauth_token_expires_at;
  // Use `<=` to match the daemon-side boundary: `oauth-status` treats
  // `> now` as still-valid (so `<= now` is expired) and the executor's
  // auth-headers path also flips at `<=`. Without this we'd silently
  // disagree with the daemon at the exact expiry millisecond.
  const isExpired = !!(expiresAt && expiresAt <= Date.now());

  // A token only counts as "authenticated" while it's still valid.
  if (server.auth.oauth_access_token && !isExpired) return false;

  // Optimistic flip / refetch fallback. See the docstring above for why this
  // Set exists alongside `server.auth`. Re-check expiry here too because the
  // Set is never pruned when tokens expire on a long-lived tab.
  if (userAuthenticatedMcpServerIds.has(server.mcp_server_id) && !isExpired) return false;

  return true;
}
