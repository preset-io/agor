import type { ChannelType } from '../types/gateway';
import { markdownToMrkdwn } from './connectors/slack';

/**
 * Format low-volume gateway lifecycle messages for external channels.
 *
 * Slack uses mrkdwn, where wrapping a whole message in `_..._` makes URLs at
 * the boundary easy to render with stray emphasis underscores. Keep system
 * messages plain, and route Slack text through the existing markdown→mrkdwn
 * converter so link formatting and escaping stay centralized.
 */
export function formatGatewaySystemMessage(channelType: ChannelType, text: string): string {
  const sessionCreatedMatch = text.match(/^Session created: (https?:\/\/\S+)$/);

  if (channelType === 'slack') {
    const markdown = sessionCreatedMatch
      ? `[system] Session created: [View session](${sessionCreatedMatch[1]})`
      : `[system] ${text}`;

    return markdownToMrkdwn(markdown);
  }

  return `[system] ${text}`;
}
