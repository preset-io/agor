/**
 * Does a Session's originating gateway channel run every prompt as the real
 * sender, or as one shared account?
 *
 * This matters wherever Agor is about to mint a *credential* on behalf of
 * "the user who asked". When a gateway channel has user alignment switched
 * off — or the platform has no alignment support at all — `services/gateway.ts`
 * resolves every inbound message to the channel's `agor_user_id` (the "Post
 * messages as" account), so every platform member with @mention access prompts
 * as that one person. Under alignment, the sender is resolved to their own
 * Agor account or the message is rejected.
 *
 * For ordinary work that is a deliberate, configured trade-off. For an OAuth
 * connect it is not survivable: the grant would be persisted under the channel
 * owner's identity, and the whole channel would then be able to drive it. So
 * the connect path refuses rather than warns, and says which switch to flip.
 *
 * ALLOWLIST, not denylist. The question this module answers is "can we PROVE
 * the actor is real", so a platform Agor cannot prove that for — one with no
 * alignment switch, or one added to `ChannelType` since this was written — is
 * unaligned. The earlier polarity (a denylist of platforms known to have a
 * switch) reported Teams and Shortcut as aligned while `gateway.ts` was in
 * fact attributing their prompts to `channel.agor_user_id`.
 */

import type { ChannelType, GatewaySource, Session } from '@agor/core/types';
import { GATEWAY_USER_ALIGNMENT_CONFIG_KEYS, getGatewaySource } from '@agor/core/types';

/**
 * Config key that proves per-user attribution, or `undefined` for a platform
 * that has no such proof.
 *
 * Derived from the same declaration `GatewayService.emitMessage` reads before
 * deciding whether to fall back to the channel owner — the two cannot drift,
 * because there is only one list. A platform gaining alignment is one edit to
 * `GATEWAY_USER_ALIGNMENT_CONFIG_KEYS`; until that edit lands, this returns
 * `undefined` and the caller refuses.
 */
export function gatewayAlignmentConfigKey(channelType: ChannelType): string | undefined {
  return (GATEWAY_USER_ALIGNMENT_CONFIG_KEYS as Partial<Record<ChannelType, string>>)[channelType];
}

export interface GatewayPromptIdentityVerdict {
  /** True when prompts in this Session are attributed to their real sender. */
  aligned: boolean;
  /** Present when `aligned` is false and the reason is a gateway channel. */
  source?: GatewaySource;
  /**
   * The config key an admin must enable, when one exists. Absent when the
   * platform has no alignment support at all — there is no switch to name.
   */
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
 *
 * Known gap, in the safe direction: `gateway.ts` also honours a per-message
 * `data.metadata.align_*` override, which is not visible from a Session row.
 * A channel aligned only by that override reads as unaligned here, which costs
 * a spurious refusal and grants nothing.
 */
export async function resolveGatewayPromptIdentity(
  session: Pick<Session, 'custom_context'>,
  loadChannel: (channelId: string) => Promise<GatewayChannelIdentityRow | null | undefined>
): Promise<GatewayPromptIdentityVerdict> {
  const source = getGatewaySource(session);
  if (!source) return { aligned: true };

  const configKey = gatewayAlignmentConfigKey(source.channel_type);
  // No alignment switch exists for this platform, so `gateway.ts` runs every
  // inbound message as the channel's "Post messages as" account. That is
  // exactly the shared-account exposure this guard exists for.
  if (!configKey) return { aligned: false, source };

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
 * can change it. When the platform has no alignment switch at all there is no
 * setting to name, so the text says so instead of inventing one.
 */
export function gatewayIdentityRefusalMessage(
  verdict: GatewayPromptIdentityVerdict,
  action = 'connect an account'
): string {
  const channel = verdict.source?.channel_name ?? 'this channel';
  const platform = verdict.source?.channel_type ?? 'this platform';
  const remedy = verdict.configKey
    ? `Ask an Agor admin to enable "${verdict.configKey}" on the channel, or ${action} from the Agor canvas instead.`
    : `Agor cannot align ${platform} senders to Agor accounts, so there is no setting that makes this safe here — ${action} from the Agor canvas instead.`;
  return (
    `Cannot ${action} from "${channel}": this gateway channel does not align platform users to ` +
    `Agor accounts, so every message here runs as the channel's "Post messages as" user. ` +
    `A sign-in started now would save the credential under that one account and let the whole ` +
    `channel use it. ${remedy}`
  );
}
