import { describe, expect, it } from 'vitest';
import type { GatewayChatCommandReceipt } from '../types/gateway';
import type { SessionID, UserID } from '../types/id';
import { SessionStatus } from '../types/session';
import {
  formatGatewayCommandReply,
  GATEWAY_COMMAND_HELP,
  isImplicitGatewayChatCommand,
  parseGatewayChatCommand,
} from './chat-commands';

const receipt: GatewayChatCommandReceipt = {
  command: 'stop-clear',
  session_id: 'session' as SessionID,
  user_id: 'user' as UserID,
  task_id: null,
  outcome: 'requested',
  queued_count: 3,
  cancelled_count: 3,
};

describe('gateway chat command contract', () => {
  it.each(['stop', 'skip', 'stop-clear', 'help'] as const)(
    'accepts only the whole %s command',
    (command) => {
      expect(parseGatewayChatCommand(`  !${command.toUpperCase()}\n`)).toBe(command);
      for (const text of [
        command,
        `!${command}!`,
        `!${command} do this`,
        `please !${command}`,
        `!${command}\nnext prompt`,
      ]) {
        expect(parseGatewayChatCommand(text)).toBeUndefined();
      }
    }
  );
  it.each(['stop using tabs', 'STOP!', 'stop\nrun tests', 'stopwatch', '!clear', '!queue'])(
    'leaves %s as prose',
    (text) => {
      expect(parseGatewayChatCommand(text)).toBeUndefined();
    }
  );
  it('help explains permission and queue semantics with one direct docs link', () => {
    expect(GATEWAY_COMMAND_HELP).toContain('In channels and threads, mention me with the command');
    expect(GATEWAY_COMMAND_HELP).toContain('In DMs, just send `!stop`');
    expect(GATEWAY_COMMAND_HELP).toContain('only if nothing is queued');
    expect(GATEWAY_COMMAND_HELP).toContain('after termination is confirmed');
    expect(GATEWAY_COMMAND_HELP).toContain('Requires Branch Manager');
    expect(GATEWAY_COMMAND_HELP).toContain('https://agor.live/guide/message-gateway#chat-commands');
  });
  it('pending and unverified replies never promise termination', () => {
    const pending = formatGatewayCommandReply(receipt);
    expect(pending).toContain('Stop requested; waiting');
    expect(pending).not.toContain('Stopped.');
    const unverified = formatGatewayCommandReply(receipt, {
      success: false,
      outcome: 'unverified',
      status: SessionStatus.STOPPING,
      reason: 'private runtime diagnostics',
      stoppedTaskId: 'task' as import('../types/id').TaskID,
    });
    expect(unverified).toContain('could not be verified');
    expect(unverified).not.toContain('private runtime diagnostics');
  });
  it('reports queued, denied and idle outcomes without claiming a stop', () => {
    expect(formatGatewayCommandReply({ ...receipt, outcome: 'queue_not_empty' })).toContain(
      'There are 3 queued tasks.'
    );
    expect(formatGatewayCommandReply({ ...receipt, outcome: 'denied' })).toContain(
      'No changes made.'
    );
    expect(formatGatewayCommandReply({ ...receipt, outcome: 'idle' })).toBe(
      'There is no current task to stop. Cancelled 3 queued tasks.'
    );
  });
});

describe('implicit command boundaries', () => {
  it.each([
    ['discord', { discord_is_thread: true }],
    ['teams', { teams_conversation_type: 'groupChat' }],
    ['teams', { teams_conversation_type: 'channel' }],
  ])('allows exact unmentioned commands on %s threads only', (provider, metadata) => {
    expect(
      isImplicitGatewayChatCommand(provider as string, '!stop', metadata as Record<string, unknown>)
    ).toBe(true);
    expect(
      isImplicitGatewayChatCommand(
        provider as string,
        'great!help me',
        metadata as Record<string, unknown>
      )
    ).toBe(false);
  });
  it.each([
    ['slack', { channel_type: 'channel', slack_is_thread_reply: true }],
    ['slack', { channel_type: 'im', slack_is_thread_reply: true }],
    ['slack', { channel_type: 'channel', slack_is_thread_reply: false }],
    ['slack', { slack_is_thread_reply: true, slack_has_mention: true }],
    ['discord', { discord_is_thread: false }],
    ['discord', { discord_is_thread: true, discord_has_mention: true }],
    ['teams', { teams_conversation_type: 'personal' }],
    ['teams', { teams_conversation_type: 'channel', teams_has_mention: true }],
  ])('does not implicitly route addressed or top-level messages on %s', (provider, metadata) => {
    expect(
      isImplicitGatewayChatCommand(provider as string, '!stop', metadata as Record<string, unknown>)
    ).toBe(false);
  });
  it('formats ambiguity as clarification, and non-targets as silence', () => {
    expect(formatGatewayCommandReply({ ...receipt, outcome: 'ambiguous' })).toContain(
      'Mention the bot'
    );
    expect(formatGatewayCommandReply({ ...receipt, outcome: 'not_target' })).toBe('');
  });
});
