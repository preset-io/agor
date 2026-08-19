import type { GatewayDiscordNoticeCode, GatewayInboundEventID } from '../../types';
import { isCanonicalFullUuid } from '../../types';

const DISCORD_ROUTING_NOTICE_COPY: Record<GatewayDiscordNoticeCode, string> = {
  alignment_missing:
    'Your Discord account is not connected to an Agor user. Ask an Agor administrator to update User alignment.',
  alignment_inactive:
    'Your connected Agor user is not active. Ask an Agor administrator to update User alignment.',
  mapped_owner_mismatch:
    'This thread is connected to another Agor user. Start a new top-level mention to begin your own session.',
  branch_access_denied:
    'You do not have permission to create or continue a session on this branch. Ask an Agor administrator to update branch access.',
  fixed_identity_invalid:
    'This Discord channel does not have a valid Agor Run as user. Ask an Agor administrator to update the channel.',
};

/** Render only reviewed, fixed routing copy. There is deliberately no string escape hatch. */
export function renderDiscordRoutingNotice(code: GatewayDiscordNoticeCode): string {
  return DISCORD_ROUTING_NOTICE_COPY[code];
}

/** Stable across config generations so uncertain/takeover recovery converges. */
export function discordRoutingNoticeNonceSeed(
  inboundEventId: GatewayInboundEventID,
  code: GatewayDiscordNoticeCode
): string {
  if (!isCanonicalFullUuid(inboundEventId) || !DISCORD_ROUTING_NOTICE_COPY[code]) {
    throw new Error('Invalid Discord routing notice identity');
  }
  return `discord-notice:${inboundEventId}:${code}`;
}
