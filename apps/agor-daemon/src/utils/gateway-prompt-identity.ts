/**
 * Does a Session's originating gateway channel run every prompt as the real
 * sender, or as one shared account?
 *
 * This matters wherever Agor is about to mint a *credential* on behalf of
 * "the user who asked". When a gateway channel has user alignment switched
 * off, `services/gateway.ts` resolves every inbound message to the channel's
 * `agor_user_id` — the "Post messages as" account — so every Slack member with
 * @mention access prompts as that one person. Under alignment, the sender is
 * resolved to their own Agor account or the message is rejected.
 *
 * For ordinary work that is a deliberate, configured trade-off. For an OAuth
 * connect it is not survivable: the grant would be persisted under the channel
 * owner's identity, and the whole channel would then be able to drive it. So
 * the connect path refuses rather than warns, and says which switch to flip.
 *
 * Only inbound-capable platforms have an alignment switch; a channel type
 * without one cannot admit a foreign prompt in the first place, so it is not
 * treated as unaligned.
 */

import type { ChannelType, GatewaySource, Session } from '@agor/core/types';
import { getGatewaySource } from '@agor/core/types';

/**
 * Per-platform alignment config key, matching the flags
 * `GatewayService.emitMessage` reads before deciding whether to fall back to
 * the channel owner. Keep this list in step with that check: a platform that
 * gains alignment and is missing here would be reported as aligned when it is
 * not yet configured to be.
 */
const ALIGNMENT_CONFIG_KEY: Partial<Record<ChannelType, string>> = {
  slack: 'align_slack_users',
  github: 'align_github_users',
  discord: 'align_discord_users',
};

export interface GatewayPromptIdentityVerdict {
  /** True when prompts in this Session are attributed to their real sender. */
  aligned: boolean;
  /** Present when `aligned` is false and the reason is a gateway channel. */
  source?: GatewaySource;
  /** The config key an admin must enable. */
  configKey?: string;
}

/** A gateway channel row, as far as this question needs it. */
export interface GatewayChannelIdentityRow {
  channel_type?: string;
  config?: Record<string, unknown> | null;
}

/**
 * Decide whether `session`'s prompts carry their real actor.
 *
 * A non-gateway Session is always aligned: its prompts come from an
 * authenticated browser or MCP caller who is already the actor.
 *
 * `loadChannel` is a callback so this stays a pure decision the MCP tool, the
 * daemon, and tests can all drive without a live Feathers app. A channel that
 * cannot be loaded is treated as UNALIGNED — the question is "can we prove the
 * actor is real", and an unreadable channel proves nothing.
 */
export async function resolveGatewayPromptIdentity(
  session: Pick<Session, 'custom_context'>,
  loadChannel: (channelId: string) => Promise<GatewayChannelIdentityRow | null | undefined>
): Promise<GatewayPromptIdentityVerdict> {
  const source = getGatewaySource(session);
  if (!source) return { aligned: true };

  const configKey = ALIGNMENT_CONFIG_KEY[source.channel_type];
  // No alignment switch exists for this platform, so there is no shared-account
  // fallback to be caught by.
  if (!configKey) return { aligned: true };

  let channel: GatewayChannelIdentityRow | null | undefined;
  try {
    channel = await loadChannel(source.channel_id);
  } catch {
    channel = null;
  }
  const aligned = channel?.config?.[configKey] === true;
  return aligned ? { aligned: true } : { aligned: false, source, configKey };
}

/**
 * Agent-relayable refusal text for an unaligned gateway Session.
 *
 * Written to be repeated verbatim into a Slack thread: it names the channel,
 * says what would otherwise happen to the credential, and names the setting to
 * change — because the person reading it in Slack is usually not the person who
 * can change it.
 */
export function gatewayIdentityRefusalMessage(
  verdict: GatewayPromptIdentityVerdict,
  action = 'connect an account'
): string {
  const channel = verdict.source?.channel_name ?? 'this channel';
  return (
    `Cannot ${action} from "${channel}": this gateway channel does not align platform users to ` +
    `Agor accounts, so every message here runs as the channel's "Post messages as" user. ` +
    `A sign-in started now would save the credential under that one account and let the whole ` +
    `channel use it. Ask an Agor admin to enable "${verdict.configKey}" on the channel, or ` +
    `${action} from the Agor canvas instead.`
  );
}
