/**
 * The authority re-read shared by every Slack-delivered MCP OAuth lane.
 *
 * Both the reactive recovery lane and the intent-initiated connect lane hand a
 * sealed token to a browser and then have to answer the same question at
 * redemption: *is all of this still true?* The two lanes differ in what record
 * they are redeeming and therefore in their record-specific predicates, but
 * the surrounding authority — the two user rows, the Slack channel and its
 * configuration generation, the write target, the thread↔session mapping, and
 * the MCP server row — is identical, and must stay identical.
 *
 * That is why this is a shared function rather than two copies. A copy is a
 * place for one lane to quietly lose a check the other kept: the check that
 * matters most here (`provider_config_generation`) exists precisely because an
 * admin can reconfigure a channel between issue and redemption, and a lane
 * that forgot it would keep honouring links minted under the old config.
 *
 * Every read goes through the caller's already-entered tenant scope. This
 * function opens none of its own.
 */

import type {
  GatewayChannelRepository,
  MCPServerRepository,
  SessionRepository,
  ThreadSessionMapRepository,
  UsersRepository,
} from '@agor/core/db';
import { isSlackWriteTargetAllowed, parseSlackThreadId } from '@agor/core/gateway';
import type {
  GatewayChannel,
  MCPServer,
  MCPServerID,
  Session,
  SessionID,
  User,
  UserID,
} from '@agor/core/types';
import { hasMinimumRole, ROLES } from '@agor/core/types';

/**
 * A version this read must agree with, or `'current'`.
 *
 * `'current'` means "whatever is stored right now, by definition" — the shape
 * an ISSUE-time caller is in, because there is no earlier claim to compare
 * against and pinning today's value is exactly what makes a later change
 * invalidate the link. It is spelled out rather than expressed by reading the
 * row and passing its own value back in, because that call reads as a real
 * check at the call site while being `x !== x`: it can never fail, and a
 * reviewer has to reconstruct why before knowing whether that is intended.
 *
 * Every REDEMPTION-time caller passes a number sealed into its token. Passing
 * `'current'` there would silently retire the one check this module exists for
 * (see the header), which is why the vacuous case now has to be written down.
 */
export type SlackMCPOAuthExpectedVersion = number | 'current';

/** Everything a sealed Slack MCP OAuth token pins about the wider workspace. */
export interface SlackMCPOAuthAuthorityBinding {
  principalUserId: UserID;
  credentialUserId: UserID;
  sessionId: SessionID;
  gatewayChannelId: string;
  gatewayConfigGeneration: SlackMCPOAuthExpectedVersion;
  slackChannelId: string;
  slackThreadId: string;
  mcpServerId: MCPServerID;
  mcpServerConfigVersion: SlackMCPOAuthExpectedVersion;
}

/** `'current'` matches by definition; a number must match exactly. */
function versionMatches(stored: number, expected: SlackMCPOAuthExpectedVersion): boolean {
  return expected === 'current' || stored === expected;
}

/** The exact rows the authority was proven against, for lane-specific checks. */
export interface SlackMCPOAuthAuthoritySnapshot {
  session: Session;
  principal: User;
  credentialUser: User;
  channel: GatewayChannel;
  server: MCPServer;
}

/** Tenant-scoped repositories this read needs. Injected so tests can fake them. */
export interface SlackMCPOAuthAuthorityRepositories {
  sessions: Pick<SessionRepository, 'findById'>;
  users: Pick<UsersRepository, 'findById'>;
  channels: Pick<GatewayChannelRepository, 'findById'>;
  servers: Pick<MCPServerRepository, 'findById'>;
  threadMap: Pick<ThreadSessionMapRepository, 'findBySession'>;
}

/**
 * Is this Slack thread one Agor is still configured to write into, and does it
 * belong to the channel the token names?
 *
 * A thread id encodes its own channel, so a token whose `slack_channel_id`
 * disagrees with its `slack_thread_id` is internally inconsistent and refused
 * before the allow-list is even consulted. An unparseable thread id is a
 * refusal, not a pass.
 */
export function slackThreadWriteTargetAllowed(
  slackThreadId: string,
  slackChannelId: string,
  config: Record<string, unknown>
): boolean {
  try {
    const parsed = parseSlackThreadId(slackThreadId);
    return parsed.channel === slackChannelId && isSlackWriteTargetAllowed(config, parsed.channel);
  } catch {
    return false;
  }
}

/**
 * Re-read and re-prove the shared authority behind a Slack-delivered MCP OAuth
 * action. Returns `null` — never a partial snapshot — when anything fails, so
 * a caller cannot accidentally proceed on a half-checked binding.
 *
 * The role floor is derived from the *stored* server row rather than from
 * anything the token said, because a server that was switched to `shared`
 * after issue must demand an admin from that moment on, and one switched away
 * from `shared` must not keep demanding one.
 */
export async function readSlackMCPOAuthAuthority(
  repositories: SlackMCPOAuthAuthorityRepositories,
  binding: SlackMCPOAuthAuthorityBinding
): Promise<SlackMCPOAuthAuthoritySnapshot | null> {
  const [session, principal, credentialUser, channel, server, mapping] = await Promise.all([
    repositories.sessions.findById(binding.sessionId),
    repositories.users.findById(binding.principalUserId),
    repositories.users.findById(binding.credentialUserId),
    repositories.channels.findById(binding.gatewayChannelId),
    repositories.servers.findById(binding.mcpServerId),
    repositories.threadMap.findBySession(binding.sessionId),
  ]);

  const credentialFloor =
    server?.auth?.type === 'oauth' && (server.auth.oauth_mode ?? 'per_user') === 'shared'
      ? ROLES.ADMIN
      : ROLES.MEMBER;

  if (
    !session ||
    !principal ||
    !credentialUser ||
    !hasMinimumRole(principal.role, ROLES.MEMBER) ||
    !hasMinimumRole(credentialUser.role, credentialFloor) ||
    !channel?.enabled ||
    channel.channel_type !== 'slack' ||
    !versionMatches(channel.provider_config_generation, binding.gatewayConfigGeneration) ||
    !slackThreadWriteTargetAllowed(binding.slackThreadId, binding.slackChannelId, channel.config) ||
    mapping?.channel_id !== channel.id ||
    mapping.thread_id !== binding.slackThreadId ||
    !server?.enabled ||
    server.auth?.type !== 'oauth' ||
    !versionMatches(server.config_version ?? 1, binding.mcpServerConfigVersion)
  ) {
    return null;
  }

  return { session, principal, credentialUser, channel, server };
}

/**
 * Deep link back to the originating Slack thread.
 *
 * Both landing pages end the same way — "Return to Slack" — and both build the
 * URL from the same encoded thread id, so the parsing lives once. A thread id
 * that carries no timestamp still yields a valid channel link; only the
 * jump-to-message hint is lost.
 */
export function slackThreadReturnUrl(
  slackTeamId: string,
  slackChannelId: string,
  slackThreadId: string
): string {
  const separator = slackThreadId.lastIndexOf('-');
  const rootTs = separator >= 0 ? slackThreadId.slice(separator + 1) : undefined;
  return (
    `slack://channel?team=${encodeURIComponent(slackTeamId)}` +
    `&id=${encodeURIComponent(slackChannelId)}` +
    (rootTs ? `&message=${encodeURIComponent(rootTs)}` : '')
  );
}
