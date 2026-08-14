/**
 * The MCP member policy, as the UI states it.
 *
 * The daemon decides every write — `authorizeMcpServerWrite` is the boundary,
 * and it is the only place that may refuse one. What lives here is the reading
 * of that decision a person needs: what each policy value means in words, and
 * which affordances are worth offering under it. The rules themselves come from
 * `@agor/core/mcp/member-policy`, which the daemon's authorizer also calls, so
 * an offered button and an accepted write cannot come to differ.
 */

import {
  isAtLeastMemberRole,
  mayMemberManageMCPServer,
  mayMemberUseMCPScope,
  mayMemberUseMCPTransport,
} from '@agor/core/mcp/member-policy';
import type { MCPMemberPolicy, MCPScope, MCPServer, MCPTransport } from '@agor-live/client';
import { MCP_SCOPES, MCP_TRANSPORTS } from '@agor-live/client';

export interface MCPMemberPolicyDescription {
  /** The value, named as a sentence about members rather than as its enum. */
  label: string;
  /** What members can and cannot do under it. */
  meaning: string;
}

export const MCP_MEMBER_POLICY_DESCRIPTIONS: Record<MCPMemberPolicy, MCPMemberPolicyDescription> = {
  use_existing_only: {
    label: 'Use existing servers only',
    meaning:
      'Members can use the MCP servers an admin has already configured. They cannot add, change, or remove any.',
  },
  allow_private_only: {
    label: 'Members can add private servers',
    meaning:
      'Members can add remote (HTTP/SSE) servers owned by themselves, reaching only the sessions they attach them to. Servers shared with the workspace stay admin-managed.',
  },
  allow_crud: {
    label: 'Members can add shared servers',
    meaning:
      "Members can add, change, and remove remote (HTTP/SSE) servers, including ones shared with the whole workspace. Another member's private server stays out of reach.",
  },
};

export interface MCPServerCapabilityContext {
  /**
   * The role as the daemon reads it — raw, because the roles beneath member are
   * the ones this has to tell apart, and a boolean cannot.
   */
  role: string | undefined;
  /** Admins administer every server, private ones included. */
  isAdmin: boolean;
  policy: MCPMemberPolicy;
  /** The signed-in user, whose private servers are theirs to manage. */
  userId?: string;
  /**
   * The daemon's answer to "may this caller configure servers at all", from
   * `GET /mcp-member-policy`. Read rather than recomputed: role floor and
   * policy are one question, and the client that answers it a second time is
   * the client that answers it differently.
   */
  canConfigure: boolean;
}

/**
 * Whether this user may add an MCP server at all.
 *
 * The daemon's answer, with the admin clause of that same answer as a floor
 * under it: {@link canConfigureMCPServers} returns true for every admin under
 * every policy, so the two cannot disagree — but an answer that arrives
 * without the field would otherwise leave an admin looking at a disabled
 * button and a reason that does not apply to them.
 *
 * This is about a capability that arrived. An answer that did not arrive at all
 * is a separate state its caller handles, and there the control is withheld
 * from everyone, admins included, rather than guessed at.
 */
export function canAddMcpServer({ isAdmin, canConfigure }: MCPServerCapabilityContext): boolean {
  return isAdmin || canConfigure;
}

/**
 * The transports this user may configure. Members are held to remote ones, so
 * a form offers what the write will accept rather than a 403. Role alone
 * decides it — no policy value widens it.
 */
export function allowedMcpTransports({
  isAdmin,
}: Pick<MCPServerCapabilityContext, 'isAdmin'>): MCPTransport[] {
  return MCP_TRANSPORTS.filter((transport) => isAdmin || mayMemberUseMCPTransport(transport));
}

/**
 * The scopes this user may give a server. A member under `allow_private_only`
 * attaches their server per session rather than to every session they start.
 */
export function allowedMcpScopes({
  isAdmin,
  policy,
}: Pick<MCPServerCapabilityContext, 'isAdmin' | 'policy'>): MCPScope[] {
  return MCP_SCOPES.filter((scope) => isAdmin || mayMemberUseMCPScope(policy, scope));
}

/** Whether this user may change this server's configuration. */
export function canEditMcpServer(
  server: Pick<MCPServer, 'owner_user_id' | 'transport'>,
  context: MCPServerCapabilityContext
): boolean {
  if (context.isAdmin) return true;
  // The endpoint answers "may I configure at all"; which server, and whether
  // its transport is one a member may hold, it cannot — so the floor is asked
  // here too rather than assumed from the policy.
  if (!isAtLeastMemberRole(context.role)) return false;
  return (
    mayMemberManageMCPServer(server, context.policy, context.userId) &&
    mayMemberUseMCPTransport(server.transport)
  );
}

/** Whether this user may delete this server. */
export function canDeleteMcpServer(
  server: Pick<MCPServer, 'owner_user_id'>,
  context: MCPServerCapabilityContext
): boolean {
  if (context.isAdmin) return true;
  if (!isAtLeastMemberRole(context.role)) return false;
  return mayMemberManageMCPServer(server, context.policy, context.userId);
}

const READ_ONLY_RESTRICTION =
  'Your account has read-only access, so it cannot configure MCP servers. An admin can change your role.';

/**
 * Why a refused action is refused, phrased so the reader can act on it — ask an
 * admin, rather than look for a bug in the button.
 *
 * A reader refused for their role is told that, not told about the workspace's
 * policy: the policy is not what is stopping them, and changing it would not
 * help.
 */
export function explainAddRestriction({ role, policy }: MCPServerCapabilityContext): string {
  if (!isAtLeastMemberRole(role)) return READ_ONLY_RESTRICTION;
  return `This workspace's MCP policy — "${MCP_MEMBER_POLICY_DESCRIPTIONS[policy].label}" — does not let you add MCP servers. An admin can add one, or change the policy.`;
}

/** Why changing or removing this particular server is refused. */
export function explainManageRestriction({ role, policy }: MCPServerCapabilityContext): string {
  if (!isAtLeastMemberRole(role)) return READ_ONLY_RESTRICTION;
  return `This workspace's MCP policy — "${MCP_MEMBER_POLICY_DESCRIPTIONS[policy].label}" — does not let you change this server. An admin can change it, or change the policy.`;
}
