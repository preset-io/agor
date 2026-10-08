/**
 * Session-time handling for OAuth MCP servers that have no usable grant.
 */

import type { MCPAuth, MCPServer } from '../types';

/**
 * True for an OAuth setup whose client is already known: an explicit client ID,
 * or Dynamic Client Registration disabled (a customer-owned `configured_client`
 * catalog app is both). With no grant, the only recovery is signing in through
 * Agor. Handing such a server to a provider runtime without credentials lets the
 * runtime run its own OAuth discovery, which falls back to Dynamic Client
 * Registration and fails with a misleading "does not support dynamic client
 * registration".
 */
export function hasPreregisteredMCPOAuthClient(auth: MCPAuth | undefined): boolean {
  return (
    auth?.type === 'oauth' && (auth.oauth_dcr_mode === 'disabled' || Boolean(auth.oauth_client_id))
  );
}

const MAX_NOTICE_LABEL_LENGTH = 80;

function noticeLabel(server: Pick<MCPServer, 'name' | 'display_name'>): string {
  const label = (server.display_name || server.name)
    .replace(/[\p{Cc}\p{Cf}`]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return label.length > MAX_NOTICE_LABEL_LENGTH
    ? `${label.slice(0, MAX_NOTICE_LABEL_LENGTH - 1)}…`
    : label;
}

type NoticeServer = Pick<MCPServer, 'mcp_server_id' | 'name' | 'display_name'>;

const CONNECT_INSTRUCTION =
  "call agor_widgets_request_oauth({ mcpServerId: '<id>' }) to render an inline Connect button; the user signs in in their browser and Agor attaches the server and resumes you. The user can also reconnect it with Refresh auth in Agor.";

function noticeLines(servers: readonly NoticeServer[]): string[] {
  return servers.map((server) => `- ${noticeLabel(server)} (mcpServerId: ${server.mcp_server_id})`);
}

/**
 * Agent-facing note for OAuth servers the current user has no grant for.
 *
 * `withheld` servers have a pre-registered client and were not loaded: the OAuth
 * app already exists, so creating apps or tokens is never the fix. `pending`
 * servers rely on Dynamic Client Registration and were still loaded; if they
 * fail, Agor's Connect flow reports what is missing (for example a Client ID an
 * admin must save) instead of the runtime's raw OAuth error.
 */
export function renderMCPSignInRequiredNotice(servers: {
  withheld: readonly NoticeServer[];
  pending?: readonly NoticeServer[];
}): string | undefined {
  const pending = servers.pending ?? [];
  if (servers.withheld.length === 0 && pending.length === 0) return undefined;
  const sections = ['## MCP servers that need sign-in'];
  if (servers.withheld.length > 0) {
    sections.push(
      [
        'These MCP servers are attached to this session but have no usable OAuth sign-in for the current user (never connected, or reset by a configuration change), so their tools are not loaded:',
        ...noticeLines(servers.withheld),
        `If the task needs one, ${CONNECT_INSTRUCTION} The OAuth app is already configured: do not suggest creating an OAuth app or personal access token, and do not ask the user to paste a token.`,
      ].join('\n')
    );
  }
  if (pending.length > 0) {
    sections.push(
      [
        'These OAuth MCP servers have no usable sign-in for the current user yet:',
        ...noticeLines(pending),
        `If one fails to connect or reports an authentication or client-registration error, ${CONNECT_INSTRUCTION} If Agor reports that the server needs a pre-registered Client ID, tell the user an administrator must save one in the server's OAuth settings. Do not ask the user to paste a token.`,
      ].join('\n')
    );
  }
  return sections.join('\n\n');
}
