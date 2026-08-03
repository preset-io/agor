/**
 * Ownership rule for MCP servers.
 *
 * An MCP server row carries the credential used to reach a third-party
 * service, and a session runs under its creator's OS identity. So the question
 * "may this server appear in this session?" is a property of the pair, not of
 * whoever happens to be making the request: a collaborator who can drive
 * someone else's session must not be able to widen what that session can
 * reach, and a member must not be able to pull another member's credential
 * into a session they control.
 *
 * Both enforcement points — attaching a server to a session, and resolving the
 * set a starting session receives — answer it with this one predicate.
 */

import type { UserID } from '../types';

/** Everything the rule needs from a server row. */
export interface MCPServerOwnership {
  owner_user_id?: UserID | string | null;
}

/** Everything the rule needs from a session row. */
export interface MCPServerSessionIdentity {
  created_by: UserID | string;
}

/**
 * Whether `userId` may use `server`.
 *
 * Shared servers (no owner) stay available to the whole tenant, which is what
 * every row created before ownership existed is.
 */
export function isMCPServerUsableBy(
  server: MCPServerOwnership,
  userId: UserID | string | undefined | null
): boolean {
  if (!server.owner_user_id) return true;
  return Boolean(userId) && server.owner_user_id === userId;
}

/**
 * Whether `server` may appear in `session`.
 *
 * Keyed on the session's creator — the identity the session's process runs as
 * — rather than on the caller, so the answer does not change with who asks.
 */
export function isMCPServerUsableInSession(
  server: MCPServerOwnership,
  session: MCPServerSessionIdentity
): boolean {
  return isMCPServerUsableBy(server, session.created_by);
}

/** Error thrown when an attach would place a private server in another user's session. */
export class MCPServerNotUsableError extends Error {
  constructor(
    public readonly serverId: string,
    public readonly sessionId: string
  ) {
    super(
      `MCP server ${serverId} is private to another user and cannot be used by session ${sessionId}`
    );
    this.name = 'MCPServerNotUsableError';
  }
}

/** Drop the private servers a session may not use. */
export function filterMCPServersForSession<T extends MCPServerOwnership>(
  servers: T[],
  session: MCPServerSessionIdentity
): T[] {
  return servers.filter((server) => isMCPServerUsableInSession(server, session));
}
