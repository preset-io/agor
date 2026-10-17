import type { GatewayChatCommand, GatewayChatCommandReceipt } from '../types/gateway';
import type { SessionStopResult } from '../types/session';
import { DISCORD_METADATA_KEY } from './discord-identifiers';

export const GATEWAY_COMMAND_CHANNEL_TYPES = ['slack', 'discord', 'teams'] as const;

export function supportsGatewayChatCommands(channelType: string): boolean {
  return (GATEWAY_COMMAND_CHANNEL_TYPES as readonly string[]).includes(channelType);
}

export const GATEWAY_COMMAND_AMBIGUOUS =
  'This thread is connected to multiple sessions. Mention the bot you want to control and send the command again. No changes made.';

export const GATEWAY_COMMAND_HINT = 'Type `!help` for commands.';
export const GATEWAY_COMMAND_DOCS_URL = 'https://agor.live/guide/message-gateway#chat-commands';
export const GATEWAY_COMMAND_HELP = [
  'Commands',
  '`!stop`: Stop the current task only if nothing is queued.',
  '`!skip`: Stop the current task; continue queued tasks after termination is confirmed.',
  '`!stop-clear`: Cancel queued tasks and stop the current task. Requires Branch Manager access.',
  '`!help`: Show this menu.',
  'In channels and threads, mention me with the command, e.g. `@MyAgent !stop`. In DMs, just send `!stop`.',
  'Send only the command and any bot mention, without extra text.',
  `[Command guide](${GATEWAY_COMMAND_DOCS_URL})`,
].join('\n');

export function parseGatewayChatCommand(text: string): GatewayChatCommand | undefined {
  switch (text.trim().toLowerCase()) {
    case '!stop':
      return 'stop';
    case '!skip':
      return 'skip';
    case '!stop-clear':
      return 'stop-clear';
    case '!help':
      return 'help';
    default:
      return undefined;
  }
}

/** Only exact, unaddressed controls may bypass the ordinary mention gate. */
export function isImplicitGatewayChatCommand(
  channelType: string,
  text: string,
  metadata: Record<string, unknown> | undefined
): boolean {
  if (!parseGatewayChatCommand(text) || !metadata) return false;
  switch (channelType) {
    case 'discord':
      return (
        metadata[DISCORD_METADATA_KEY.isThread] === true &&
        metadata[DISCORD_METADATA_KEY.hasMention] !== true
      );
    case 'teams':
      return (
        ['channel', 'groupchat'].includes(String(metadata.teams_conversation_type).toLowerCase()) &&
        metadata.teams_has_mention !== true
      );
    default:
      return false;
  }
}

/** Only bounded system copy crosses the provider boundary, never raw exceptions. */
export function formatGatewayCommandReply(
  receipt: GatewayChatCommandReceipt,
  stop?: SessionStopResult
): string {
  switch (receipt.outcome) {
    case 'ambiguous':
      return GATEWAY_COMMAND_AMBIGUOUS;
    case 'not_target':
      return '';
    case 'denied':
      return 'No changes made. You need permission to prompt this session; !stop-clear also requires Branch Manager access.';
    case 'queue_not_empty':
      return `There are ${receipt.queued_count} queued tasks. Use \`!skip\` to stop the current task and continue them, or \`!stop-clear\` to stop the current task and cancel pending tasks.`;
    case 'condition_changed':
      return 'The current task or queue changed. No changes made. Check the session and send the command again.';
  }
  const cancelled =
    receipt.cancelled_count > 0 ? ` Cancelled ${receipt.cancelled_count} queued tasks.` : '';
  if (receipt.outcome === 'idle') return `There is no current task to stop.${cancelled}`;
  switch (stop?.outcome) {
    case 'stopped':
      return `Stopped.${cancelled}`;
    case 'already_idle':
      return `The original task is no longer running.${cancelled}`;
    case 'unverified':
      return `Termination could not be verified. Check the session in Agor; an owner or admin may need to intervene.${cancelled}`;
    case 'condition_changed':
    case 'not_stoppable':
      return `The original task is no longer stoppable. No successor task was stopped.${cancelled}`;
    default:
      return `Stop requested; waiting for the executor to confirm termination.${cancelled}`;
  }
}
