/**
 * What the `mcp_member_policy` lets a member do with an MCP server row.
 *
 * The daemon decides every write and is the only place that may refuse one
 * (`authorizeMcpServerWrite`), but the UI has to predict the same answer to
 * decide which buttons to offer, and a button that always fails is its own kind
 * of defect. Both sides call these predicates so there is one rule rather than a
 * rule and a copy of it; the daemon adds the refusal message, the UI adds the
 * explanation.
 *
 * Using a server is a separate question with its own predicate — see
 * {@link isMCPServerUsableBy} in `./ownership`.
 */

import type { MCPMemberPolicy, MCPTransport, UserID } from '../types';
import type { MCPServerOwnership } from './ownership';

/**
 * Whether a member may write MCP server configuration at all.
 *
 * The first question every write asks, and the one an offered "add" button
 * predicts.
 */
export function mayMemberWriteMCPServers(policy: MCPMemberPolicy): boolean {
  return policy !== 'use_existing_only';
}

/**
 * Whether policy and ownership place this server in a member's hands.
 *
 * Admins are not members: they administer every server, so callers answer that
 * by role before consulting this.
 */
export function mayMemberManageMCPServer(
  server: MCPServerOwnership,
  policy: MCPMemberPolicy,
  userId: UserID | string | undefined | null
): boolean {
  if (!mayMemberWriteMCPServers(policy)) return false;
  // An unowned server belongs to the whole tenant, so managing one is the step
  // up that separates the two permissive values.
  if (!server.owner_user_id) return policy === 'allow_crud';
  return Boolean(userId) && server.owner_user_id === userId;
}

/**
 * Whether a member may configure this transport.
 *
 * A `stdio` server is a command line the executor process runs on its host, so
 * letting members configure one turns "may register an MCP server" into "may
 * run any binary as the executor user" — a grant neither permissive policy
 * value hands out. An unstated transport is decided by whoever defaults it.
 */
export function mayMemberUseMCPTransport(transport: MCPTransport | undefined): boolean {
  return transport !== 'stdio';
}
