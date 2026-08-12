/**
 * Ownership rules for MCP server use.
 *
 * A configured MCP server can carry credentials, so attachment is a property
 * of the session/server pair rather than of the caller who happens to request
 * the attachment. Shared rows are usable by every session; private rows are
 * usable only by sessions created by their owner.
 */

import type { UserID } from '../types';

export interface MCPServerOwnership {
  owner_user_id?: UserID | string | null;
}

export interface MCPServerSessionIdentity {
  created_by: UserID | string;
}

export function isMCPServerUsableBy(
  server: MCPServerOwnership,
  userId: UserID | string | undefined | null
): boolean {
  if (!server.owner_user_id) return true;
  return Boolean(userId) && server.owner_user_id === userId;
}

export function isMCPServerUsableInSession(
  server: MCPServerOwnership,
  session: MCPServerSessionIdentity
): boolean {
  return isMCPServerUsableBy(server, session.created_by);
}

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

export function filterMCPServersForSession<T extends MCPServerOwnership>(
  servers: T[],
  session: MCPServerSessionIdentity
): T[] {
  return servers.filter((server) => isMCPServerUsableInSession(server, session));
}
