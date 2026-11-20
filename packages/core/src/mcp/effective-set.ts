/**
 * The session's effective MCP set: one pure rule shared by the runtime (what
 * the agent SDK receives), the session MCP pill, and the session MCP tools.
 * Browser-safe: no repository or Node imports.
 *
 * - A session link with `enabled: true` turns its server on.
 * - A link with `enabled: false` on a global server is a per-session opt-out.
 * - Without a link, an enabled global server is on by default unless the
 *   session made an explicit MCP selection. A per-user OAuth global server is
 *   on only once the acting user has connected it; until then it is a connect
 *   row (`needs_connect`), or `hidden` if the user chose to hide it. One that
 *   can never be signed into ({@link mcpServerConfigWarning}) is left out.
 */

import type { MCPServer } from '../types';
import { isMCPServerUsableBy } from './ownership';

export type SessionMcpEntryState = 'active' | 'needs_connect' | 'hidden' | 'off';

export interface SessionMcpEntry<S extends SessionMcpServerLike = MCPServer> {
  server: S;
  source: 'global' | 'session';
  state: SessionMcpEntryState;
}

export type SessionMcpServerLike = Pick<
  MCPServer,
  'mcp_server_id' | 'name' | 'scope' | 'enabled' | 'owner_user_id' | 'auth'
>;

export interface SessionMcpLinkState {
  mcp_server_id: string;
  enabled: boolean;
}

export interface ResolveSessionMcpEntriesInput<S extends SessionMcpServerLike> {
  /** `session.mcp_selection_explicit`: global servers are not on by default. */
  selectionExplicit?: boolean;
  /** Every junction row of the session, enabled or not. */
  links: readonly SessionMcpLinkState[];
  /** Servers referenced by `links` (missing ones are skipped). */
  linkedServers: readonly S[];
  /** Enabled global servers visible to the acting user. */
  globalServers: readonly S[];
  /** Servers the acting user holds a usable OAuth grant for (per-user or shared). */
  connectedServerIds: ReadonlySet<string>;
  /** `user.preferences.hidden_mcp_server_ids` of the acting user. */
  hiddenServerIds?: ReadonlySet<string>;
  /** Acting user; private servers of anybody else never enter the set. */
  forUserId: string | undefined;
  /**
   * Session membership only (credential/egress scope checks): skip the
   * connection, hide, and config-warning filters, so every linked or
   * inherited server that is not switched off reads `active`. Whether the
   * user can authenticate is the credential path's own decision.
   */
  membershipOnly?: boolean;
}

/** Per-user OAuth: each user signs in for themselves before it can work. */
export function mcpServerRequiresUserConnection(server: Pick<MCPServer, 'auth'>): boolean {
  return server.auth?.type === 'oauth' && (server.auth.oauth_mode ?? 'per_user') === 'per_user';
}

/**
 * Admin-facing configuration problem that makes a server unusable for every
 * user, or undefined. Per-user OAuth with the machine `client_credentials`
 * grant has no browser sign-in and no shared credential, so nobody can connect.
 */
export function mcpServerConfigWarning(server: Pick<MCPServer, 'auth'>): string | undefined {
  if (
    mcpServerRequiresUserConnection(server) &&
    server.auth?.oauth_grant_type === 'client_credentials'
  ) {
    return 'Per-user OAuth with the client_credentials grant type: users cannot sign in to this server. Use the authorization code grant, or switch to a shared OAuth credential.';
  }
  return undefined;
}

export function resolveSessionMcpEntries<S extends SessionMcpServerLike>(
  input: ResolveSessionMcpEntriesInput<S>
): SessionMcpEntry<S>[] {
  const linkById = new Map(input.links.map((link) => [link.mcp_server_id, link]));
  const entries = new Map<string, SessionMcpEntry<S>>();
  const usable = (server: S) => isMCPServerUsableBy(server, input.forUserId);
  const sourceOf = (server: S): SessionMcpEntry['source'] =>
    server.scope === 'global' ? 'global' : 'session';

  for (const server of input.linkedServers) {
    const link = linkById.get(server.mcp_server_id);
    if (!link || !usable(server) || entries.has(server.mcp_server_id)) continue;
    if (link.enabled) {
      entries.set(server.mcp_server_id, { server, source: sourceOf(server), state: 'active' });
    } else if (server.scope === 'global' && server.enabled) {
      entries.set(server.mcp_server_id, { server, source: 'global', state: 'off' });
    }
  }

  for (const server of input.globalServers) {
    const id = server.mcp_server_id;
    if (entries.has(id) || linkById.has(id) || !usable(server) || !server.enabled) continue;
    const connected =
      input.membershipOnly ||
      !mcpServerRequiresUserConnection(server) ||
      input.connectedServerIds.has(id);
    // Nobody can sign in to it; the admin sees a warning instead.
    if (!connected && mcpServerConfigWarning(server)) continue;
    let state: SessionMcpEntryState;
    if (input.selectionExplicit) state = 'off';
    else if (connected) state = 'active';
    else state = input.hiddenServerIds?.has(id) ? 'hidden' : 'needs_connect';
    entries.set(id, { server, source: 'global', state });
  }

  // Global servers first, then session links: the historical order.
  const globalIds = new Set(input.globalServers.map((server) => server.mcp_server_id));
  const values = [...entries.values()];
  return [
    ...input.globalServers.flatMap((server) => entries.get(server.mcp_server_id) ?? []),
    ...values.filter((entry) => !globalIds.has(entry.server.mcp_server_id)),
  ];
}

/** The servers the runtime loads: only `active` entries. */
export function activeSessionMcpServers<S extends SessionMcpServerLike>(
  entries: readonly SessionMcpEntry<S>[]
): S[] {
  return entries.filter((entry) => entry.state === 'active').map((entry) => entry.server);
}

/** User preference key for global servers a user hid from their connect rows. */
export const HIDDEN_MCP_SERVER_IDS_PREFERENCE = 'hidden_mcp_server_ids';

export function readHiddenMcpServerIds(
  preferences: Record<string, unknown> | undefined | null
): Set<string> {
  const value = preferences?.[HIDDEN_MCP_SERVER_IDS_PREFERENCE];
  return new Set(Array.isArray(value) ? value.filter((id) => typeof id === 'string') : []);
}
