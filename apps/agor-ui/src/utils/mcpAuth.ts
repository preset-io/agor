import type { MCPServer } from '@agor-live/client';

/**
 * Determine if an MCP server needs authentication from the current user.
 *
 * A server is considered authenticated if EITHER:
 * - It has a token (oauth_access_token) that hasn't passed its expiry —
 *   covers both shared-mode tokens and per-user tokens hydrated by the
 *   daemon's `injectPerUserOAuthTokens` find-hook.
 * - The current user has a per-user token (and the daemon-provided
 *   `userAuthenticatedMcpServerIds` set already filters expired ones).
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

  // Per-user fallback. The set is populated once at boot (and adds on
  // `oauth:completed` events) but is never pruned when tokens expire on a
  // long-lived tab — so we re-check expiry here too.
  if (userAuthenticatedMcpServerIds.has(server.mcp_server_id) && !isExpired) return false;

  return true;
}
