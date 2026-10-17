import type { ChannelType } from '../types/gateway';
import type { SessionID } from '../types/id';
import { shortId } from '../types/id';
import { GATEWAY_COMMAND_HINT, supportsGatewayChatCommands } from './chat-commands';
import type { OutboundPayload } from './connector';
import { markdownToMrkdwn } from './connectors/slack';

const GATEWAY_SYSTEM_PREFIX = 'Agor:';

/**
 * Format a session reference for gateway lifecycle messages as markdown.
 *
 * When the daemon can resolve an Agor UI URL, the reference is markdown so
 * channel-specific formatters can turn it into native links (Slack mrkdwn,
 * GitHub markdown, etc.). Without a URL, fall back to a short ID rather than
 * exposing a full UUID in external chat surfaces.
 */
export function formatGatewayMarkdownSessionReference(
  sessionId: SessionID | string,
  sessionUrl?: string | null
): string {
  return sessionUrl ? `[session](${sessionUrl})` : `session ${shortId(sessionId)}`;
}

export function formatGatewaySessionCreatedMessage(
  sessionId: SessionID | string,
  sessionUrl?: string | null
): string {
  return sessionUrl
    ? `Session created: ${sessionUrl}`
    : `Session ${shortId(sessionId)} created, sending prompt to agent.`;
}

export function formatGatewayFollowUpRoutingMessage(
  sessionId: SessionID | string,
  sessionUrl?: string | null
): string {
  return `Mention received — routing to ${formatGatewayMarkdownSessionReference(sessionId, sessionUrl)}.`;
}

export interface GatewaySystemMessageOptions {
  /**
   * Whether follow-ups need mentions. Defaults to true; false for DMs,
   * Discord forums in `all` response mode, and Teams personal chats.
   */
  followUpHint?: boolean;
}

/**
 * Format low-volume gateway lifecycle messages for external channels.
 *
 * Slack uses mrkdwn, where wrapping a whole message in `_..._` makes URLs at
 * the boundary easy to render with stray emphasis underscores. Keep system
 * messages plain, and route Slack text through the existing markdown→mrkdwn
 * converter so link formatting and escaping stay centralized.
 */
export function formatGatewaySystemMessage(
  channelType: ChannelType,
  text: string,
  options: GatewaySystemMessageOptions = {}
): string {
  const sessionCreatedMatch = text.match(/^Session created: (https?:\/\/\S+)$/);
  const mentionGuidance = 'Mention me again to follow up.';
  const isCreation =
    !!sessionCreatedMatch ||
    (text.startsWith('Session ') && text.includes(' created, sending prompt to agent.'));
  if (isCreation && supportsGatewayChatCommands(channelType)) {
    const guidance =
      options.followUpHint === false
        ? `Reply to follow up. ${GATEWAY_COMMAND_HINT}`
        : 'Mention me again to follow up, or mention me with `!help` for commands.';
    // On Discord, angle brackets suppress the session link preview.
    const url = sessionCreatedMatch?.[1];
    const creation = url
      ? `Session created: [View session](${channelType === 'discord' ? `<${url}>` : url}).`
      : text;
    const formatted = `${GATEWAY_SYSTEM_PREFIX} ${creation} ${guidance}`;
    return channelType === 'slack' ? markdownToMrkdwn(formatted) : formatted;
  }

  const formatted = `${GATEWAY_SYSTEM_PREFIX} ${text}${
    channelType === 'slack' && text.startsWith('Mention received') && options.followUpHint !== false
      ? ` ${mentionGuidance}`
      : ''
  }`;
  return channelType === 'slack' ? markdownToMrkdwn(formatted) : formatted;
}

/**
 * Format gateway lifecycle/debug messages as an outbound payload.
 *
 * Slack renders these as a muted `context` block so transient lifecycle
 * notices match the bottom progress/status row instead of competing with the
 * user's prompt or the agent's final answer.
 */
export function formatGatewaySystemPayload(
  channelType: ChannelType,
  text: string,
  options: GatewaySystemMessageOptions = {}
): OutboundPayload {
  const formatted = formatGatewaySystemMessage(channelType, text, options);

  if (channelType !== 'slack') {
    return { text: formatted };
  }

  return {
    text: formatted,
    blocks: [
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: formatted,
          },
        ],
      },
    ],
  };
}
